#!/usr/bin/env python3
"""Training load ("OTS") with Oura's `training_stress_score_0_2_2` model.

What the model does (read from its TorchScript, `stress_ots.OTS`):
  * takes a per-minute MET series (≥ 720 minutes) from `start_timestamp`; values
    under 0.9 MET count as missing (non-wear),
  * for every minute, a 12-hour window of METs is weighted — recent minutes more
    (a linear ramp), higher intensities more (gamma 1.0, M 8.0) — and averaged; a
    window needs ≥ 360 valid minutes,
  * the load is scaled by resting-HR (age/sex percentile category) and VO₂max
    category weights; above 5.3 is "high" (10 % lower when readiness < 60).
Outputs: load per minute, its timestamps (ms), and the high/low flag.

Inputs here: the ring's per-minute MET (gaps filled with 0 → missing), age and sex
from profile.json, resting HR = mean of each night's lowest 5-minute HR, VO₂max from
the same Jackson non-exercise formula the summary uses. There is no local readiness
score, so readiness is passed as 75 (the standard threshold).

Usage: python tools/run_training_load.py [DB] [--tz H] [--json]
"""
import argparse
import datetime
import json
import sys
import time
from pathlib import Path

import torch

from _common import resolve_db, resolve_models_dir
from ring_signals import Signals, load_profile, mean_sd, nightly

REPO = Path(__file__).resolve().parent.parent
MODEL_NAME = "training_stress_score_0_2_2.pt"
MODEL = resolve_models_dir(REPO, MODEL_NAME) / MODEL_NAME
READINESS_UNKNOWN = 75.0


def vo2max_jackson(age, female, weight_kg):
    return max(0.0, 79.9 - 0.39 * age - 13.7 * (1 if female else 0) - 0.127 * weight_kg * 2.20462)


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def main():
    p = argparse.ArgumentParser(description="Training load (Oura training_stress_score model)")
    p.add_argument("db", nargs="?", default=None)
    p.add_argument("--tz", type=float, default=None)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz
    db = resolve_db(args.db, REPO)
    sig = Signals(db)
    profile = load_profile(db)
    if not sig.met:
        sys.exit("no MET data yet")
    first, last = min(sig.met), max(sig.met)
    mets = [sig.met.get(m, 0.0) for m in range(first, last + 1)]
    if len(mets) < 720:
        sys.exit(f"needs 12 hours of MET minutes, have {len(mets)}")
    age = float(profile.get("age") or 30)
    sex_code = str(profile.get("sex", "M")).upper()
    sex = {"M": 1.0, "F": -1.0}.get(sex_code, 0.0)
    rhr, _ = mean_sd([r for _, r, _ in nightly(sig)])
    rhr = min(100.0, max(30.0, rhr if rhr else 60.0))
    vo2 = vo2max_jackson(age, sex_code == "F", float(profile.get("weight_kg") or 75))

    model = torch.jit.load(str(MODEL), map_location="cpu").eval()
    f = lambda v: torch.tensor([v], dtype=torch.float32)
    with torch.no_grad():
        ots, ts, high = model(
            torch.tensor([first * 60 * 1000], dtype=torch.int64), torch.tensor(mets, dtype=torch.float32),
            f(age), f(sex), f(rhr), f(0.0), f(0.0), f(READINESS_UNKNOWN), f(vo2))
    rows = [(t / 1000, v, h) for t, v, h in zip(ts.tolist(), ots.tolist(), high.tolist()) if v == v]
    if not rows:
        sys.exit("not enough worn minutes in any 12-hour window yet (needs ≥ 6 h)")
    series = [{"unix": round(t), "load": round(v, 2), "high": bool(h)} for t, v, h in rows[::15]]  # 15-min points
    by_day = {}
    for t, v, h in rows:
        day = datetime.datetime.utcfromtimestamp(t + tz * 3600).date().isoformat()
        d = by_day.setdefault(day, {"peak": 0.0, "high_minutes": 0})
        d["peak"] = max(d["peak"], round(v, 2))
        d["high_minutes"] += 1 if h else 0
    latest = rows[-1]
    result = {
        "model": MODEL.stem, "threshold": round(float(model.high_ots_threshold.flatten()[0]), 2),
        "latest": {"unix": round(latest[0]), "load": round(latest[1], 2), "high": bool(latest[2])},
        "inputs": {"age": age, "resting_hr": round(rhr, 1), "vo2max": round(vo2, 1), "readiness": READINESS_UNKNOWN},
        "daily": by_day, "series": series,
    }
    if args.json:
        print(json.dumps(result))
        return
    print(f"Training load — {MODEL.stem} (high above {result['threshold']:.1f}); inputs {result['inputs']}")
    for day, d in by_day.items():
        print(f"  {day}: peak {d['peak']:.2f}  high for {d['high_minutes']} min")
    print(f"  latest: {latest[1]:.2f} ({'high' if latest[2] else 'normal'})")


if __name__ == "__main__":
    main()
