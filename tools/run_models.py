#!/usr/bin/env python3
"""Run the runnable Oura models on our stored ring data (oura.db).

Harness that maps decoded events -> each model's forward() inputs. Only the
models whose inputs we can supply from synced data are wired here; see
docs/model-usage-map / the feasibility matrix for what's blocked and why.

Usage: python tools/run_models.py <model> [DB] [--tz H] [--json]
  model = bdi | daily_medians | all
(sleepnet_moonstone has its own runner: tools/run_sleep_model.py)
"""
import datetime
import json
import sys
import sqlite3
from pathlib import Path

import torch

from _common import resolve_db, resolve_models_dir

REPO = Path(__file__).resolve().parent.parent
JSON = "--json" in sys.argv
_print = print


def print(*a, **k):  # human-readable progress; silenced under --json
    if not JSON:
        _print(*a, **k)


def load(name):
    path = resolve_models_dir(REPO, f"{name}.pt") / f"{name}.pt"
    return torch.jit.load(str(path), map_location="cpu").eval()


def events(db):
    con = sqlite3.connect(db)
    rows = con.execute(
        "SELECT ring_timestamp, name, decoded_json, captured_unix FROM events "
        "WHERE decoded_json IS NOT NULL ORDER BY ring_timestamp"
    ).fetchall()
    con.close()
    return rows


def anchor(rows):
    max_ds, anchor_unix = max(((r[0], r[3]) for r in rows), key=lambda x: x[0])
    def unix_s(ds):  # ring deciseconds -> unix seconds
        return anchor_unix - (max_ds - ds) / 10.0
    return unix_s


def f32(x):
    return torch.tensor(x, dtype=torch.float32)


def last_bedtime(rows):
    """Most recent bedtime_period dict, or a clear error if none were synced."""
    beds = [json.loads(j) for ds, n, j, _ in rows if n == "bedtime_period"]
    if not beds:
        sys.exit("no bedtime_period (tag 0x76) in DB — sync overnight data first")
    return beds[-1]


# ---- sleepnet_bdi_0_4_0: bedtime_input, ibi_values, ibi_timestamps ----
MIN_NIGHT_S = 3 * 3600  # the model's own sleep-quality gate wants >= 180 min asleep
MAX_NIGHTS = 14


def bedtimes(rows, unix_s):
    """Merged ring bedtimes [(start_unix, end_unix)] (a night split into pieces is one)."""
    spans = sorted({(unix_s(b["bedtime_start_ds"]), unix_s(b["bedtime_end_ds"]))
                    for b in (json.loads(j) for ds, n, j, _ in rows if n == "bedtime_period")
                    if b.get("bedtime_start_ds") is not None and b.get("bedtime_end_ds", 0) > b["bedtime_start_ds"]})
    out = []
    for a, b in spans:
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def ibi_stream(rows, unix_s):
    """[(beat_ms, [ibi_ms, amplitude, valid])] from the raw (0x60) and green (0x80) IBI
    streams — on Ring 5 the green stream carries most overnight beats."""
    beats = []
    for ds, n, j, _ in rows:
        if n not in ("ibi_and_amplitude_event", "green_ibi_quality_event"):
            continue
        t0 = unix_s(ds)
        d = json.loads(j)
        ibis = d.get("ibi_ms", [])
        amps = d.get("amplitude", [0] * len(ibis))
        acc = 0.0
        for k, ms in enumerate(ibis):
            if ms and ms > 0:
                amp = amps[k] if k < len(amps) else 0
                valid = 1.0 if 300 <= ms <= 2000 else 0.0  # quality flag (matches run_sleep_model.py)
                acc += ms  # a beat occurs at the END of its interval
                beats.append((t0 * 1000.0 + acc, [float(ms), float(amp), valid]))
    beats.sort(key=lambda b: b[0])
    return beats


def bdi_night(m, beats, bstart, bend):
    """One night through SleepNet-BDI: (summary dict, stage tensor, apnea tensor, metrics) or None."""
    sel = [b for b in beats if (bstart - 600) * 1000 <= b[0] <= (bend + 600) * 1000]  # ±10 min margin
    if not sel:
        return None
    bedtime_input = torch.tensor([int(bstart * 1000), int(bend * 1000)], dtype=torch.long)
    # outputs (names from app SleepNetBdiPyTorchV04Model.ModelOutput):
    #   timestamps, sleepStages[N,5], apneaEvents[N,2], outputMetrics[6], debugMetrics[10]
    _ts, sleep_stages, apnea_events, out_metrics, dbg = m(
        bedtime_input, f32([v for _, v in sel]), torch.tensor([int(t) for t, _ in sel], dtype=torch.long))
    # sleepStages: col0 marker, cols1-4 = 4-class softmax. Order confirmed by
    # cross-checking moonstone on the same night: [AWAKE, LIGHT, REM, DEEP].
    stage = sleep_stages[:, 1:5].argmax(dim=1)
    if stage.shape[0] == 0:
        return None
    apnea = apnea_events[:, 0]
    # outputMetrics, from the model's compute_output_metrics: [bdi_status (2 when bdi >=
    # 15, else 0), sleep-quality flag (1 = enough sleep + IBI coverage), total sleep min,
    # bdi, bdi_nrem, bdi_rem]. use_events_per_hour is False in 0.4.0, so bdi = % of sleep
    # epochs with a breathing disturbance.
    om = out_metrics.flatten().tolist()
    pct = lambda v: round(v, 2) if v == v else None  # NaN -> null
    summary = {
        "bedtime_start_unix": round(bstart), "bedtime_end_unix": round(bend), "ibis": len(sel),
        "sleep_min": round(om[2], 1), "bdi_pct": pct(om[3]), "bdi_nrem_pct": pct(om[4]), "bdi_rem_pct": pct(om[5]),
        "elevated": om[0] >= 2, "quality_ok": om[1] == 1,
        "flagged_epochs": int((apnea > 0.5).sum()), "epochs": int(stage.shape[0]),
    }
    return summary, stage, apnea, (om, dbg.flatten().tolist())


def run_bdi(db, tz):
    rows = events(db)
    unix_s = anchor(rows)
    beds = [b for b in bedtimes(rows, unix_s) if b[1] - b[0] >= MIN_NIGHT_S][-MAX_NIGHTS:]
    if not beds:
        sys.exit("no night of at least 3 h (bedtime_period, tag 0x76) in DB — sync overnight data first")
    beats = ibi_stream(rows, unix_s)
    m = load("sleepnet_bdi_0_4_0")
    nights, last = [], None
    for bstart, bend in beds:
        try:
            res = bdi_night(m, beats, bstart, bend)
        except Exception as e:  # the model's own input checks
            print(f"  night ending {bend}: {str(e).splitlines()[-1][:120]}")
            continue
        if res:
            nights.append(res[0])
            last = (bstart, bend, res)
    if JSON:
        latest = nights[-1] if nights else {}
        _print(json.dumps({"model": "sleepnet_bdi_0_4_0", **latest, "nights": nights}))
        return
    if not last:
        sys.exit("no valid IBI in any sleep window — sync overnight IBI (0x60/0x80) data first")
    local = lambda s: datetime.datetime.utcfromtimestamp(s + tz * 3600).strftime("%Y-%m-%d %H:%M")
    for n in nights:
        print(f"night {local(n['bedtime_start_unix'])} → {local(n['bedtime_end_unix'])}: "
              f"BDI {n['bdi_pct']}% ({n['flagged_epochs']} of {n['epochs']} epochs), {n['ibis']} IBIs")
    bstart, bend, (summary, stage, apnea, (om, dbg)) = last
    n = stage.shape[0]
    labels = ["awake", "light", "REM", "deep"]
    print(f"\nLatest night — hypnogram: {n} epochs x 30s = {n*30/60:.0f} min")
    for s in range(4):
        c = int((stage == s).sum())
        print(f"  col{s+1} {labels[s]:8}: {c:4d} epochs ({c*30/60:5.1f} min, {100*c/n:4.1f}%)")
    print(f"\napneaEvents: {int((apnea > 0.5).sum())} epochs flagged (>0.5) of {n}")
    print(f"outputMetrics: {[round(x, 3) for x in om]}")
    print(f"debugMetrics:  {[round(x, 3) for x in dbg]}")


# ---- daily_medians_1_1_0: HRV/HR/temp/MET medians over a day ----
def run_daily_medians(db, _tz):  # no wall-clock output → tz unused here
    import json
    rows = events(db)
    unix_s = anchor(rows)
    hrv, hrv_t, hr_min = [], [], []
    temp, temp_t = [], []
    met, met_t = [], []
    for ds, n, j, _ in rows:
        t = unix_s(ds)
        d = json.loads(j)
        if n == "hrv_event":
            iv = d.get("interval_min", 5) * 60
            rm = d.get("rmssd_ms", []); hb = d.get("hr_bpm", [])
            # The event stamp `t` marks the packet's LAST average; earlier ones walk
            # back by `iv` each (same rule as nssa_inputs/research_export). Placing them
            # forward would shift the series late by the packet span (~30 min for 7).
            n = len(rm)
            for k, v in enumerate(rm):
                if v and v > 0:
                    hrv.append(float(v)); hrv_t.append(int((t - (n - 1 - k) * iv) * 1000))
                    hr_min.append(float(hb[k]) if k < len(hb) and hb[k] else 0.0)
        elif n == "temp_event":
            for v in d.get("temps_c", []):
                temp.append(float(v)); temp_t.append(int(t * 1000))
        elif n == "activity_information":
            for k, v in enumerate(d.get("met", [])):
                met.append(float(v)); met_t.append(int((t + k * 60) * 1000))
    bp = last_bedtime(rows)
    sleep_ts = [int(unix_s(bp["bedtime_start_ds"]) * 1000), int(unix_s(bp["bedtime_end_ds"]) * 1000)]
    print(f"hrv={len(hrv)} temp={len(temp)} met={len(met)} hr_min={len(hr_min)}")
    m = load("daily_medians_1_1_0")
    L = torch.long
    out = m(
        f32(hrv), f32([1.0] * len(hrv)), torch.tensor(hrv_t, dtype=L),
        f32(hr_min),
        f32(temp), torch.tensor(temp_t, dtype=L),
        f32(met), torch.tensor(met_t, dtype=L),
        torch.tensor(sleep_ts, dtype=L),
    )
    print("OUTPUT:", [tuple(o.shape) for o in out])
    for i, o in enumerate(out):
        print(f"  [{i}]", o.flatten()[:8].tolist())


# Note: sleepnet_moonstone (full overnight sleep staging + apnea) already has a
# working, validated runner in tools/run_sleep_model.py — use that. It produces a
# DEEP/LIGHT/REM/WAKE hypnogram + sleep efficiency.

RUNNERS = {"bdi": run_bdi, "daily_medians": run_daily_medians}


def main():
    argv = sys.argv[1:]
    tz = 1
    if "--tz" in argv:  # strip "--tz H" so its value isn't mistaken for the DB path
        i = argv.index("--tz")
        if i + 1 >= len(argv):
            sys.exit("--tz requires a value")
        tz = int(argv[i + 1])
        del argv[i:i + 2]
    model = argv[0] if argv else "bdi"
    argv = [a for a in argv if a != "--json"]
    db_arg = next((a for a in argv[1:] if not a.startswith("-")), None)
    db = str(resolve_db(db_arg, REPO))
    if model == "all":
        for k, fn in RUNNERS.items():
            print("=" * 70, k)
            try:
                fn(db, tz)
            except Exception as e:
                print(f"  FAILED: {type(e).__name__}: {e}")
        return
    if model not in RUNNERS:
        sys.exit(f"unknown model '{model}' (choose: {', '.join(RUNNERS)} | all)")
    RUNNERS[model](db, tz)


if __name__ == "__main__":
    main()
