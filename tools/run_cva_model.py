#!/usr/bin/env python3
"""Estimate cardiovascular age + pulse-wave velocity from the ring's raw PPG.

Decodes the `cva_raw_ppg_data` events (BLE tag 0x81) the ring emits when the
`cva_ppg` (CAP_CVA_PPG_SAMPLER, id 13) feature is enabled, reconstructs the PPG
waveform, segments it the way the app does (groups of 1500 samples), and runs
Oura's decrypted `cva_2_1_0.pt` model, or `cva_1_3_0.pt` when 2.1.0 is absent.
(`cva_2_1_5.pt` is the "cva-from-emb" build: it takes 128-d PPG embeddings from
a separate encoder, not raw PPG, so it can't be used here.)

Decode: each 0x81 body is a stateful delta stream. Byte 0x80 marks the next
three bytes as a signed 24-bit absolute ADC sample; every other byte is a signed
int8 delta from the previous sample. A measurement = a run of events <2 s apart
(~1500 samples ≈ 30 s @ ~50 Hz, measured on this ring). The model wants segments
of exactly 1500 samples.

Model I/O (from CardiovascularAgeV2Model in the decompiled app):
  forward(ppg_segments [n,1500] f32, demographics [1,5] f32)
    demographics = [sex(-1 F / +1 M / 0 other), height_m, age_years, ring_size, weight_kg]
  -> (daily_cva, quality, raw_quality, daily_pwv, ppg_segment_metrics[n,11])
cva_1_3_0 (validator read from the TorchScript):
  forward(ppg_segments [n,1500], sampling_rates [n] (all 50), timestamps [n],
          demographics [1,4] = [sex, height_m, age_years (15..120), ring_size (4..15)])
  -> (daily_cva, quality, variance, daily_pwv, ppg_segment_metrics)

Like the app, the model runs once per local day on that day's measurements, and
`cva_calibrator_1_3_0` then walks the days in order. Its state per day is
(calibrated value, offset, offset-frozen flag, timestamp); the arrays it is given
are the *previous* days' outputs (an empty history is its "first day" branch).
With one ring the offset stays 0, so calibrated == daily; the number Oura shows is
the calibrator's smoothed value — the median of the last 30 days once at least 14
daily values exist. Until then `smoothed_vascular_age` is null.

NOTE: daily_cva tracks the input age (it is a *vascular* age anchored to your
chronological age and adjusted by PPG morphology), so pass real demographics for a
meaningful number. daily_pwv (m/s) is PPG-only.

Usage: python tools/run_cva_model.py [DB] [--sex M|F|O] [--age Y] [--height M]
                                      [--weight KG] [--ring N] [--tz H]
                                      [--since-cursor DS] [--json]
"""
import argparse
import datetime
import json
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import torch

from _common import resolve_db, resolve_models_dir

REPO = Path(__file__).resolve().parent.parent
# Raw-PPG builds, newest first; the first one present is used.
MODEL_NAMES = ("cva_2_1_0.pt", "cva_1_3_0.pt")
MODEL = next(
    (path for path in (resolve_models_dir(REPO, n) / n for n in MODEL_NAMES) if path.exists()),
    resolve_models_dir(REPO, MODEL_NAMES[0]) / MODEL_NAMES[0],
)
LEGACY_V1 = MODEL.name.startswith("cva_1_")
CALIBRATOR_NAME = "cva_calibrator_1_3_0.pt"
CALIBRATOR = resolve_models_dir(REPO, CALIBRATOR_NAME) / CALIBRATOR_NAME
SEG_LEN = 1500          # samples per segment (hard model constant)
GAP_DS = 20             # >2 s (deciseconds) splits two PPG measurements
SMOOTHING_DAYS = 14     # calibrator: daily values needed (within 30 days) for the smoothed age


def decode_cva_ppg_bodies(bodies):
    samples = []
    acc = 0
    for body in bodies:
        data = bytes(body)
        i = 0
        while i < len(data):
            b = data[i]
            if b == 0x80 and i + 3 < len(data):
                raw = data[i + 1] | (data[i + 2] << 8) | (data[i + 3] << 16)
                if raw & 0x800000:
                    raw -= 0x1000000
                acc = raw
                samples.append(acc)
                i += 4
            else:
                acc += np.int8(np.uint8(b)).item()
                samples.append(acc)
                i += 1
    return np.asarray(samples, dtype=np.float32)


def wall_clock(db):
    """`f(ds, captured_unix) -> unix seconds or None` from the ring's time anchors."""
    from epoch_time import build_epochs, is_dated, make_unix_s
    con = sqlite3.connect(str(db))
    rows = con.execute(
        "SELECT ring_timestamp, tag, decoded_json, captured_unix FROM events "
        "WHERE decoded_json IS NOT NULL ORDER BY captured_unix, id").fetchall()
    con.close()
    epochs = build_epochs(rows)
    unix_s = make_unix_s(epochs)
    return lambda ds, cu: unix_s(ds, cu) if is_dated(epochs, ds, cu) else None


def load_segments(db, since_ds=0):
    """PPG segments as `[(unix_seconds, ndarray[1500])]` plus the measurement count.

    A segment's time is its measurement's start on the wall clock; measurements the
    ring's clock can't date are dropped (they belong to no calendar day)."""
    con = sqlite3.connect(str(db))
    rows = con.execute(
        "SELECT ring_timestamp, body, captured_unix FROM events WHERE tag=129 AND ring_timestamp>? "
        "ORDER BY ring_timestamp",
        (since_ds,),
    ).fetchall()
    con.close()
    if not rows:
        return [], 0
    at = wall_clock(db)
    ts = np.array([r[0] for r in rows])
    runs, cur = [], [0]
    for i in range(1, len(rows)):
        if ts[i] - ts[i - 1] > GAP_DS:
            runs.append(cur)
            cur = []
        cur.append(i)
    runs.append(cur)
    out = []
    for run in runs:
        start = at(rows[run[0]][0], rows[run[0]][2])
        if start is None:
            continue
        wave = decode_cva_ppg_bodies([rows[k][1] for k in run])
        for s in range(0, len(wave) - SEG_LEN + 1, SEG_LEN):
            out.append((start, wave[s : s + SEG_LEN]))
    return out, len(runs)


def build_segments(db, since_ds):
    """Back-compat wrapper: (segments, measurement count); stamps on the function."""
    segs, n_runs = load_segments(db, since_ds)
    build_segments.stamps = [t for t, _ in segs]
    return [s for _, s in segs], n_runs


def load_profile(db):
    # profile.json (editable, gitignored) sits next to the DB; CLI args override it.
    try:
        return json.loads((Path(db).parent / "profile.json").read_text())
    except Exception:
        return {}


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def run_day(model, segs, stamps, sex, args):
    """One day's (daily_cva, quality, variance_or_raw_quality, pwv); raises on model rejection."""
    ppg = torch.tensor(np.stack(segs), dtype=torch.float32)
    with torch.no_grad():
        if LEGACY_V1:
            n = ppg.shape[0]
            demo = torch.tensor([[sex, args.height, args.age, args.ring]], dtype=torch.float32)
            out = model(ppg, torch.full((n,), 50.0), torch.tensor(stamps, dtype=torch.float64), demo)
        else:
            demo = torch.tensor([[sex, args.height, args.age, args.ring, args.weight]], dtype=torch.float32)
            out = model(ppg, demo)
    cva, quality, raw_quality, pwv, _ = out
    return cva.item(), quality.item(), raw_quality.item(), pwv.item()


def calibrate(days, sex):
    """Walk the daily values through Oura's calibrator; adds calibrated/smoothed keys."""
    if not CALIBRATOR.exists():
        return False
    cal = torch.jit.load(str(CALIBRATOR), map_location="cpu").eval()
    col = lambda xs, dt=torch.float32: torch.tensor(xs, dtype=dt).reshape(-1, 1)
    hist_ts, hist_cal, hist_off, hist_frozen = [], [], [], []
    for day in days:
        with torch.no_grad():
            calibrated, offset, frozen, _pwv, smoothed, smoothed_pwv = cal(
                torch.tensor([day["vascular_age"]], dtype=torch.float32),
                torch.tensor([[0.0]], dtype=torch.float64),  # one ring: no hardware change
                col(hist_cal), col(hist_off), col(hist_frozen), col(hist_ts, torch.float64),
                torch.tensor([[sex]], dtype=torch.float32),
            )
        c, s = calibrated.flatten()[0].item(), smoothed.flatten()[0].item()
        day["calibrated"] = round(c, 1)
        day["smoothed"] = round(s, 1) if s == s else None
        day["smoothed_pwv_ms"] = (round(smoothed_pwv.flatten()[0].item(), 2)
                                  if day["smoothed"] is not None else None)
        hist_ts.append(day["t"])
        hist_cal.append(c)
        hist_off.append(offset.flatten()[0].item())
        hist_frozen.append(frozen.flatten()[0].item())
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("db", nargs="?", default=None)
    # default None → fall back to profile.json, then to a built-in default
    p.add_argument("--sex", default=None, choices=["M", "F", "O"])
    p.add_argument("--age", type=float, default=None)
    p.add_argument("--height", type=float, default=None, help="meters")
    p.add_argument("--weight", type=float, default=None, help="kg")
    p.add_argument("--ring", type=float, default=None, help="ring size")
    p.add_argument("--tz", type=float, default=None, help="UTC offset in hours for day grouping (default: this Mac's)")
    p.add_argument("--since-cursor", type=int, default=0, help="only events with ring_timestamp > this")
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = p.parse_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz

    db = resolve_db(args.db, REPO)
    prof = load_profile(db)
    pick = lambda cli, key, dflt: cli if cli is not None else prof.get(key, dflt)
    args.sex = pick(args.sex, "sex", "M")
    args.age = float(pick(args.age, "age", 30.0))
    args.height = float(pick(args.height, "height_m", 1.78))
    args.weight = float(pick(args.weight, "weight_kg", 75.0))
    args.ring = float(pick(args.ring, "ring_size", 10.0))

    segs, n_runs = load_segments(db, args.since_cursor)
    if not segs:
        sys.exit("no full 1500-sample PPG segment — is cva_ppg enabled? (oura feature-status)"
                 if n_runs == 0 else f"no full {SEG_LEN}-sample PPG segment ({n_runs} measurement runs, all too short)")
    sex = {"F": -1.0, "M": 1.0, "O": 0.0}[args.sex]
    model = torch.jit.load(str(MODEL), map_location="cpu").eval()

    by_day = {}
    for t, seg in segs:
        day = datetime.datetime.utcfromtimestamp(t + tz * 3600).date().isoformat()
        by_day.setdefault(day, []).append((t, seg))
    days, rejected = [], {}
    for day in sorted(by_day):
        items = by_day[day]
        try:
            cva, quality, raw_quality, pwv = run_day(model, [s for _, s in items], [t for t, _ in items], sex, args)
        except Exception as e:  # the model's validator: "<code>, Error, ..."
            rejected[day] = str(e).strip().splitlines()[-1][:120]
            continue
        days.append({
            "date": day, "t": max(t for t, _ in items), "segments": len(items),
            "vascular_age": round(cva, 1), "pwv_ms": round(pwv, 2),
            "quality": round(quality), "raw_quality": round(raw_quality, 2),
        })
    if not days:
        sys.exit(f"the CVA model rejected every day ({rejected})")
    calibrated = calibrate(days, sex)
    latest = days[-1]
    window = [d for d in days if d["t"] >= latest["t"] - 30 * 86400]

    if args.json:
        print(json.dumps({
            "model": MODEL.stem,
            "calibrator": CALIBRATOR.stem if calibrated else None,
            "date": latest["date"],
            # newest day's calibrated (== daily with one ring) value; the smoothed one
            # is what the app shows once SMOOTHING_DAYS days are in.
            "vascular_age": latest.get("calibrated", latest["vascular_age"]),
            "smoothed_vascular_age": latest.get("smoothed"),
            "smoothed_pwv_ms": latest.get("smoothed_pwv_ms"),
            "chronological_age": args.age,
            "pwv_ms": latest["pwv_ms"],
            "quality": latest["quality"], "raw_quality": latest["raw_quality"],
            "segments": latest["segments"], "measurements": n_runs,
            "days_with_data": len(window), "days_needed": SMOOTHING_DAYS,
            "history": [{k: d.get(k) for k in ("date", "vascular_age", "calibrated", "smoothed", "pwv_ms", "segments", "quality")}
                        for d in days],
            "rejected_days": rejected,
        }))
        return

    print(f"CVA (cardiovascular age) — {len(segs)} PPG segments from {n_runs} measurements, {len(days)} day(s)")
    print(f"  demographics: sex={args.sex} age={args.age:.0f} height={args.height} weight={args.weight} ring={args.ring}")
    for d in days:
        sm = f"   smoothed {d['smoothed']}" if d.get("smoothed") is not None else ""
        print(f"  {d['date']}: vascular age {d['vascular_age']:.1f}  pwv {d['pwv_ms']:.2f} m/s  "
              f"({d['segments']} segments, quality {d['quality']}){sm}")
    for day, why in rejected.items():
        print(f"  {day}: rejected — {why}")
    if latest.get("smoothed") is None:
        print(f"  smoothed (the app's number): needs {SMOOTHING_DAYS} days within 30 — have {len(window)}")


if __name__ == "__main__":
    main()
