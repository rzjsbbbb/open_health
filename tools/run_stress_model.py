#!/usr/bin/env python3
"""Compute Oura's *daytime stress* timeseries locally and run the decrypted
`stress_daytime_sensing_1_1_0` model on our stored ring data — no cloud.

The model is a small deterministic transform (recovered from its TorchScript):

    intensity            = dhrv_value - dhrv_baseline          # HRV vs daytime baseline
    neutral_zone_half    = f(night_hrv_baseline)               # 2 / 3 / 4 ms dead-zone
    stress_threshold     = -neutral_zone_half                  # below -> "stressed"
    recovery_threshold   = +neutral_zone_half                  # above -> "restored"
    stress_saturation    = lut(night_hrv_baseline)             # negative clamp
    recovery_saturation  = lut(night_hrv_baseline)             # positive clamp
    scaled_*             = scale_output(intensity, thresholds, saturations)

The 8 outputs map 1:1 onto `TimeseriesDbDaytimeStress` (intensity / intensity_scaled
/ stress_limit{,_scaled} / recovery_limit{,_scaled} / saturation_stress_deviation /
saturation_recovery_deviation).

INPUT GATE (enforced by the model's own `validator`): each sample needs a single
*awake, sedentary* daytime HRV reading — outside every bedtime window, ring MET
<= 1.8, positive dhrv and baselines.

dhrv source, as in the app:
  * measured — the ring's own 5-min RMSSD (`hrv_event`, 0x5d) outside bedtime;
  * imputed  — for every other awake 5-minute slot, Oura's `dhrv_imputation_1_1_0`
    predicts the HRV from what the ring did record: the slot's heart rate
    (min / median / max of its per-minute green-LED rates), the last 30 min of skin temperature,
    the last 60 min of MET, and the personal daytime HRV / HR / skin-temperature
    baselines. Its own gate skips slots that are asleep, active (MET > 1.8) or too
    restless (MET std over 15 min >= 3.3).
Acute stress / restoration events: Oura's `astd_event_detection_0_1_1` reads the
scaled intensity (−1 … +1) in 15-minute bins and, over ~1-hour windows of 4 bins,
marks an event where at least 2 bins are fully stressed (≤ −0.5) or fully restored
(≥ +0.5); events closer than 30 min merge. It runs per local day (≥ 4 bins).

Personal baselines, as the app builds them:
  * `daily_medians_1_1_0` turns each day's *measured* daytime HRV (accuracy ≥ 20,
    awake, MET ≤ 1.8 within the minute) into the day's dHRV / min-HR / skin-temperature
    medians — imputed values are left out, or the baseline would feed on itself;
  * `daily_short_term_baselines_1_1_0` takes the last 5–21 days of those medians
    (Gaussian-weighted) plus the nights (sleep ≥ 4 h, plausible HR / temperature /
    HRV) and returns the dHRV, skin-temperature, min-HR and night-HRV baselines.
  The imputer uses the first three; the stress model the dHRV and night-HRV ones.
  With 1–4 days of medians the same quantities are averaged provisionally
  (`baseline_source` "provisional"). With none yet, the fallbacks are: imputer HRV
  baseline = the night baseline, HR / temperature = medians over the sedentary awake
  slots, stress baseline = the median of recent daytime dHRV (`"approximate"`).

Usage: python tools/run_stress_model.py [DB] [--tz N] [--no-impute] [--json]
"""
import argparse
import datetime
import json
import sys
import time
from pathlib import Path
from statistics import median

import torch

from _common import resolve_db, resolve_models_dir
from ring_signals import Signals

REPO = Path(__file__).resolve().parent.parent
MODEL = resolve_models_dir(REPO, "stress_daytime_sensing_1_1_0.pt") / "stress_daytime_sensing_1_1_0.pt"
IMPUTER = resolve_models_dir(REPO, "dhrv_imputation_1_1_0.pt") / "dhrv_imputation_1_1_0.pt"
EVENTS = resolve_models_dir(REPO, "astd_event_detection_0_1_1.pt") / "astd_event_detection_0_1_1.pt"
MEDIANS = resolve_models_dir(REPO, "daily_medians_1_1_0.pt") / "daily_medians_1_1_0.pt"
BASELINES = resolve_models_dir(REPO, "daily_short_term_baselines_1_1_0.pt") / "daily_short_term_baselines_1_1_0.pt"
MIN_DAYS_FOR_BASELINES = 5    # the baseline model's minimum of daily medians
MAX_DAYS_FOR_BASELINES = 21
BIN_S = 900                   # the event model's 15-minute bins
SLOT_S = 300                  # 5-minute stress slots
MIN_DAYTIME_FOR_BASELINE = 3  # below this, dhrv_baseline falls back to the night baseline
MAX_SEDENTARY_MET = 1.8
BASELINE_DAYS = 14            # short-term baseline window for the stress model
MIN_SLOTS_FOR_BASELINE = 12   # an hour of daytime slots before the baseline tracks them
OUT_LABELS = ["intensity", "stress_limit", "recovery_limit",
              "saturation_stress_deviation", "saturation_recovery_deviation",
              "intensity_scaled", "stress_limit_scaled", "recovery_limit_scaled"]


def run(model, dhrv, ts, bedtimes, dhrv_baseline, night_baseline, ring_met):
    """Call the stress model for one sample; return (ok, result_or_errcode)."""
    bs = torch.tensor([s for s, _ in bedtimes], dtype=torch.float64)
    be = torch.tensor([e for _, e in bedtimes], dtype=torch.float64)
    try:
        out = model(
            torch.tensor([dhrv], dtype=torch.float32),
            torch.tensor([float(ts)], dtype=torch.float64),
            bs, be,
            torch.tensor([dhrv_baseline], dtype=torch.float32),
            torch.tensor([night_baseline], dtype=torch.float32),
            torch.tensor([ring_met], dtype=torch.float32),
        )
        return True, {l: float(o.flatten()[0]) for l, o in zip(OUT_LABELS, out)}
    except Exception as e:  # validator raised "<code>, <message>"
        return False, str(e).strip().splitlines()[-1]


def zone(intensity, stress_lim, recovery_lim):
    if intensity <= stress_lim:
        return "stressed"
    if intensity >= recovery_lim:
        return "restored"
    return "neutral"


def window(series, start, end):
    return [v for t, v in series if start <= t <= end]


def personal_baselines(sig, daytime, tz):
    """Oura's dHRV / HR / skin-temperature / night-HRV baselines from the daily-medians
    and short-term-baselines models, or `None` while no day has measured daytime HRV."""
    if not MEDIANS.exists():
        return None
    medians_model = torch.jit.load(str(MEDIANS), map_location="cpu").eval()
    day_of = lambda t: datetime.datetime.utcfromtimestamp(t + tz * 3600).date()
    by_day = {}
    for t, r, h in daytime:
        by_day.setdefault(day_of(t), []).append((t, r, h))
    met = sig.met_series()
    sleep = torch.tensor([x for s, e in sig.bedtimes for x in (int(s), int(e))], dtype=torch.int64)
    medians = []  # (day, dhrv, hr_min, skin_temp)
    for day in sorted(by_day)[-MAX_DAYS_FOR_BASELINES:]:
        rows = by_day[day]
        temps = [(t, c) for t, c in sig.temp if day_of(t) == day]
        mets = [(t, m) for t, m in met if day_of(t) == day]
        if not temps or not mets:
            continue
        try:
            with torch.no_grad():
                d, h, c = medians_model(
                    torch.tensor([r for _, r, _ in rows], dtype=torch.float32),
                    torch.full((len(rows),), 100.0),  # the ring's own RMSSD: full accuracy
                    torch.tensor([int(t) for t, _, _ in rows], dtype=torch.int64),
                    torch.tensor([h or float("nan") for _, _, h in rows], dtype=torch.float32),
                    torch.tensor([v for _, v in temps], dtype=torch.float32),
                    torch.tensor([int(t) for t, _ in temps], dtype=torch.int64),
                    torch.tensor([v for _, v in mets], dtype=torch.float32),
                    torch.tensor([int(t) for t, _ in mets], dtype=torch.int64),
                    sleep)
        except Exception:  # "6, Condition, No good quality sedentary awake HRV measurements …"
            continue
        vals = [float(x.flatten()[0]) for x in (d, h, c)]
        if all(v == v for v in vals):
            medians.append((day.isoformat(), *vals))
    if not medians:
        return None
    from ring_signals import nightly
    nights = nightly(sig)
    night_hrvs = [hv for _, _, hv in nights if hv and 5 <= hv <= 150]
    out = {"days": len(medians), "days_needed": MIN_DAYS_FOR_BASELINES,
           "daily_medians": [{"date": d, "dhrv": round(a, 1), "hr_min": round(b, 1), "skin_temp": round(c, 2)}
                             for d, a, b, c in medians]}
    if len(medians) >= MIN_DAYS_FOR_BASELINES and BASELINES.exists():
        model = torch.jit.load(str(BASELINES), map_location="cpu").eval()
        col = lambda xs: torch.tensor(xs, dtype=torch.float32)
        recent = nights[-MAX_DAYS_FOR_BASELINES:]
        beds = {round(e): e - s for s, e in sig.bedtimes}
        try:
            with torch.no_grad():
                d, c, h, n = model(
                    col([m[1] for m in medians]), col([m[3] for m in medians]), col([m[2] for m in medians]),
                    col([beds.get(round(e), 0.0) for e, _, _ in recent] or [float("nan")]),
                    col([r or float("nan") for _, r, _ in recent] or [float("nan")]),
                    col([max((c for t, c in sig.temp if s <= t <= e), default=float("nan"))
                         for s, e in sig.bedtimes][-MAX_DAYS_FOR_BASELINES:] or [float("nan")]),
                    col([hv or float("nan") for _, _, hv in recent] or [float("nan")]))
            vals = [float(x.flatten()[0]) for x in (d, h, c, n)]
            out.update(source="oura", dhrv=vals[0], hr=vals[1], temp=vals[2],
                       night_hrv=vals[3] if vals[3] == vals[3] and vals[3] > 0 else (median(night_hrvs) if night_hrvs else None))
            return out
        except Exception:
            pass
    avg = lambda i: sum(m[i] for m in medians) / len(medians)
    out.update(source="provisional", dhrv=avg(1), hr=avg(2), temp=avg(3),
               night_hrv=median(night_hrvs) if night_hrvs else None)
    return out


def impute_slots(sig, measured_slots, dhrv_baseline, hr_baseline=None, temp_baseline=None):
    """[(slot_end_unix, imputed_dhrv, met)] for awake, sedentary slots with no measured HRV."""
    if not IMPUTER.exists():
        return [], {"model missing": 1}
    imputer = torch.jit.load(str(IMPUTER), map_location="cpu").eval()
    met = sig.met_series()
    awake_hr = [(t, b) for t, b in sig.hr if not sig.asleep(t)]
    awake_temp = [(t, c) for t, c in sig.temp if not sig.asleep(t) and 24 <= c <= 40]
    if not met or not awake_hr or not awake_temp:
        return [], {"no daytime HR/MET/temperature": 1}
    first, last = met[0][0], met[-1][0]
    slots = []
    slot = (int(first) // SLOT_S + 1) * SLOT_S
    while slot <= last:
        t0, t1 = slot - SLOT_S, slot
        slot += SLOT_S
        if t1 // SLOT_S in measured_slots or sig.asleep(t1):
            continue
        # The model takes 1–3 HR readings per slot (the app's daytime HR samples). Raw
        # per-packet rates spread ~±10 % and read as "very relaxed"; per-minute means
        # match its training spread (min/median/max ≈ 1.01/1.04/1.07 of the baseline).
        per_min = {}
        for t, b in awake_hr:
            if t0 <= t <= t1:
                per_min.setdefault(int(t // 60), []).append(b)
        hrs = sorted(sum(v) / len(v) for v in per_min.values())
        mets = window(met, t1 - 3600, t1)[-60:]
        temps = window(awake_temp, t1 - 1800, t1)[-30:]
        if hrs and mets and temps:
            slots.append((t1, hrs, mets, temps))
    # personal baselines over the slots the imputer can score (sedentary, awake)
    sedentary = [x for x in slots if x[2][-1] <= MAX_SEDENTARY_MET]
    if not sedentary:
        return [], {"no sedentary awake slots": 1}
    if hr_baseline is None:
        hr_baseline = median(h[len(h) // 2] for _, h, _, _ in sedentary)
    if temp_baseline is None:
        temp_baseline = median(tp[-1] for _, _, _, tp in sedentary)
    bs = torch.tensor([[s] for s, _ in sig.bedtimes] or [[0.0]], dtype=torch.float64)
    be = torch.tensor([[e] for _, e in sig.bedtimes] or [[0.0]], dtype=torch.float64)
    out, skipped = [], {}
    for t1, hrs, mets, temps in slots:
        hr_values = [hrs[0], hrs[len(hrs) // 2], hrs[-1]] if len(hrs) >= 3 else hrs[:1]  # per-minute means
        try:
            with torch.no_grad():
                (pred,) = imputer(
                    torch.tensor(temps, dtype=torch.float32),
                    torch.tensor(mets, dtype=torch.float32),
                    torch.tensor(mets, dtype=torch.float32),
                    torch.tensor(hr_values, dtype=torch.float32),
                    torch.tensor(float(t1), dtype=torch.float64),
                    bs, be,
                    torch.tensor([dhrv_baseline], dtype=torch.float32),
                    torch.tensor([hr_baseline], dtype=torch.float32),
                    torch.tensor([temp_baseline], dtype=torch.float32),
                )
        except Exception as e:  # "6, Silent Condition, Latest MET value is greater than 1.8 …"
            code = str(e).strip().splitlines()[-1].split(",")[0]
            skipped[code] = skipped.get(code, 0) + 1
            continue
        out.append((t1, float(pred.flatten()[0]), mets[-1]))
    return out, skipped


def stress_events(series, tz):
    """Acute stress / restoration events per local day (Oura's astd model)."""
    if not EVENTS.exists() or not series:
        return None
    model = torch.jit.load(str(EVENTS), map_location="cpu").eval()
    bins = {}
    for s in series:  # a slot ending at t belongs to the bin ending at ceil(t / 15 min)
        end = -(-s["unix"] // BIN_S) * BIN_S
        bins.setdefault(end, []).append(s["intensity_scaled"])
    by_day = {}
    for end in sorted(bins):
        day = datetime.datetime.utcfromtimestamp(end - 1 + tz * 3600).date().isoformat()
        by_day.setdefault(day, []).append(end)
    out = []
    for day, ends in by_day.items():
        span = range(ends[0], ends[-1] + BIN_S, BIN_S)  # keep gaps as NaN bins
        values = [sum(bins[e]) / len(bins[e]) if e in bins else float("nan") for e in span]
        values = [max(-1.0, min(1.0, v)) if v == v else v for v in values]
        try:
            with torch.no_grad():
                _ns, _nr, _ts, _tr, kinds, starts, ends_ms, mins = model(
                    torch.tensor(values, dtype=torch.float32),
                    torch.tensor([e * 1000 for e in span], dtype=torch.int64))
        except Exception:  # "1, Condition, insufficient data: n_bins < 4."
            continue
        for k, a, b, m in zip(kinds.tolist(), starts.tolist(), ends_ms.tolist(), mins.tolist()):
            out.append({"kind": "stressed" if k == -1 else "restored", "start": a / 1000, "end": b / 1000,
                        "minutes": round(m)})
    return sorted(out, key=lambda e: e["start"])


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def main():
    ap = argparse.ArgumentParser(description="Local daytime-stress timeseries from ring HRV")
    ap.add_argument("db", nargs="?", help="events DB (default: ./oura.db)")
    ap.add_argument("--tz", type=float, default=None, help="hours offset for printed clock times")
    ap.add_argument("--no-impute", action="store_true", help="only the measured daytime HRV samples")
    ap.add_argument("--json", action="store_true", help="emit the timeseries as JSON")
    args = ap.parse_args()
    tz = local_tz_hours() if args.tz is None else args.tz

    if not MODEL.exists():
        sys.exit(f"error: model not found: {MODEL} (decrypt notes/models first)")
    model = torch.jit.load(str(MODEL), map_location="cpu").eval()

    sig = Signals(resolve_db(args.db, REPO))
    if not sig.bedtimes:
        sys.exit("no bedtime_period events — can't separate awake vs sleep HRV")
    samples = [(t, r) for t, r, _ in sig.hrv if r]
    if not samples:
        sys.exit("no hrv_event (tag 0x5d) samples — is HRV being captured?")

    night = [r for t, r in samples if sig.asleep(t)]
    daytime = [(t, r) for t, r in samples if not sig.asleep(t)]
    if not night:
        sys.exit("no nocturnal HRV — can't form night_hrv_baseline")
    night_baseline = median(night)
    enough = len(daytime) >= MIN_DAYTIME_FOR_BASELINE
    base = personal_baselines(sig, [(t, r, h) for t, r, h in sig.hrv if r and not sig.asleep(t)], tz)
    if base:  # Oura's definitions (daily medians → short-term baselines, or provisional)
        dhrv_baseline, hr_baseline, temp_baseline = base["dhrv"], base["hr"], base["temp"]
        night_baseline = base["night_hrv"] or night_baseline
    else:
        dhrv_baseline = median([r for _, r in daytime]) if enough else night_baseline
        hr_baseline = temp_baseline = None

    met = sig.met
    met_at = lambda t: met.get(round(t / 60), 1.0)
    candidates = [(t, r, met_at(t), False) for t, r in daytime]
    skipped = {}
    if not args.no_impute:
        imputed, skipped = impute_slots(sig, {int(t) // SLOT_S + 1 for t, _ in daytime}, dhrv_baseline,
                                        hr_baseline, temp_baseline)
        candidates += [(t, r, m, True) for t, r, m in imputed]

    if base:
        stress_baseline, baseline_source = dhrv_baseline, base["source"]
    else:  # no measured daytime HRV yet: your typical daytime dHRV lately
        recent = [r for t, r, _, _ in candidates if t >= max(c[0] for c in candidates) - BASELINE_DAYS * 86400]
        approx = len(recent) >= MIN_SLOTS_FOR_BASELINE
        stress_baseline = median(recent) if approx else dhrv_baseline
        baseline_source = "approximate" if approx else ("measured daytime" if enough else "night")

    series, rejected = [], {}
    for ts, dhrv, ring_met, is_imputed in sorted(candidates):
        ok, res = run(model, dhrv, ts, sig.bedtimes, stress_baseline, night_baseline, min(ring_met, MAX_SEDENTARY_MET))
        if ok:
            res.update(unix=round(ts), dhrv=round(dhrv, 1), imputed=is_imputed,
                       zone=zone(res["intensity"], res["stress_limit"], res["recovery_limit"]))
            series.append(res)
        else:
            rejected[res] = rejected.get(res, 0) + 1

    zones = [s["zone"] for s in series]
    if args.json:
        print(json.dumps({
            "model": MODEL.stem,
            "imputer": IMPUTER.stem if IMPUTER.exists() and not args.no_impute else None,
            "night_hrv_baseline": night_baseline,
            "dhrv_baseline": round(stress_baseline, 1),
            "baseline_source": baseline_source,
            "baselines": base and {k: (round(v, 2) if isinstance(v, float) else v) for k, v in base.items()},
            "awake_samples": len(daytime),
            "imputed_samples": sum(1 for s in series if s["imputed"]),
            "slot_minutes": SLOT_S // 60,
            "counts": {z: zones.count(z) for z in ("restored", "neutral", "stressed")},
            "events": stress_events(series, tz),
            "samples": series,
        }))
        return

    print(f"Daytime stress — {MODEL.stem}: {len(samples)} measured HRV samples "
          f"({len(night)} nocturnal, {len(daytime)} awake) + {sum(1 for s in series if s['imputed'])} imputed slots")
    print(f"  baselines ({baseline_source}): dHRV {stress_baseline:.1f} ms · night HRV {night_baseline:.1f} ms"
          + (f" · HR {base['hr']:.1f} · skin {base['temp']:.2f} °C · {base['days']}/{base['days_needed']} days of medians" if base else ""))
    print(f"  restored {zones.count('restored')}  neutral {zones.count('neutral')}  stressed {zones.count('stressed')}")
    clock = lambda u: datetime.datetime.utcfromtimestamp(u + tz * 3600).strftime("%m-%d %H:%M")
    for s in series:
        print(f"    {clock(s['unix'])}  dhrv={s['dhrv']:5.1f}{'*' if s['imputed'] else ' '}  "
              f"intensity={s['intensity']:+5.1f}  [{s['zone']}]")
    events = stress_events(series, tz) or []
    for e in events:
        print(f"  EVENT {e['kind']:<8} {clock(e['start'])}–{clock(e['end'])[6:]}  {e['minutes']} min")
    if skipped:
        print(f"  imputer skipped (by condition code): {skipped}")
    if rejected:
        print(f"  stress model rejected: {rejected}")
    print("  (* = imputed by dhrv_imputation)")


if __name__ == "__main__":
    main()
