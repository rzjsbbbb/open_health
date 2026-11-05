#!/usr/bin/env python3
"""Real step counts with Oura's `step_counter_1_3_0` model ("realsteps").

What the model does (read from its TorchScript, `AppStepCounterModel`):
  * each 10-second gait row (steps_motion_decoder output, the 11 columns in the
    AAD / Android TimeseriesDbStepMotion order) is paired with the motion_event row
    (8 columns) whose window start is within 30 s of its own (both stamps are window
    ends: gait − 10 s, motion − 30 s),
  * an eligibility network decides whether those 10 s were stepping, a counter network
    how many steps, and a sigmoid of the eligibility scales the count,
  * with `output_sampling_interval_ms` the 10-s counts are split proportionally into
    fixed blocks (here one minute).
The column order was confirmed from the first BatchNorm's running means (the two
large acceleration amplitudes sit at gait columns 7 and 8, as in AAD order). Missing
values are filled with the model's own per-column defaults.

Distance uses the same 0.762 m/step as the summary (ecore's actinfo_steps_to_meters).

Usage: python tools/run_step_counter.py [DB] [--tz H] [--json]
"""
import argparse
import datetime
import json
import sys
import time
from pathlib import Path

import torch

from _common import resolve_db, resolve_models_dir
from ring_signals import Signals

REPO = Path(__file__).resolve().parent.parent
MODEL_NAME = "step_counter_1_3_0.pt"
MODEL = resolve_models_dir(REPO, MODEL_NAME) / MODEL_NAME
METERS_PER_STEP = 0.762


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def count_steps(sig):
    """[(minute_start_unix, steps)] over all synced gait data."""
    gait = sig.stepmotion()
    if not gait:
        return []
    motion = sig.motion
    model = torch.jit.load(str(MODEL), map_location="cpu").eval()
    with torch.no_grad():
        ts, steps = model(
            torch.tensor([int(round(t * 1000)) for t, _ in gait], dtype=torch.int64),
            torch.tensor([v for _, v in gait], dtype=torch.float32),
            torch.tensor([int(round(t * 1000)) for t, _ in motion] or [0], dtype=torch.int64),
            torch.tensor([v for _, v in motion] or [[float("nan")] * 8], dtype=torch.float32),
            torch.tensor(60000.0),
        )
    return [(start / 1000.0, max(0.0, n)) for (start, _end), n in zip(ts.tolist(), steps.flatten().tolist())]


def main():
    p = argparse.ArgumentParser(description="Step counts with Oura's step_counter model")
    p.add_argument("db", nargs="?", default=None)
    p.add_argument("--tz", type=float, default=None)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz
    sig = Signals(resolve_db(args.db, REPO))
    minutes = count_steps(sig)
    if not minutes:
        sys.exit("no gait (real_step) data yet — wear the ring and sync")

    daily, hourly = {}, {}
    for t, n in minutes:
        local = datetime.datetime.utcfromtimestamp(t + tz * 3600)
        day = local.date().isoformat()
        daily[day] = daily.get(day, 0.0) + n
        hourly.setdefault(day, [0.0] * 24)[local.hour] += n
    days = {d: {"steps": round(s), "distance_m": round(s * METERS_PER_STEP),
                "hourly": [round(h) for h in hourly[d]]} for d, s in sorted(daily.items())}
    if args.json:
        print(json.dumps({"model": MODEL.stem, "meters_per_step": METERS_PER_STEP,
                          "first": minutes[0][0], "last": minutes[-1][0], "daily": days}))
        return
    print(f"Steps — {MODEL.stem} ({len(minutes)} minutes of gait data)")
    for d, v in days.items():
        busiest = max(range(24), key=lambda h: v["hourly"][h])
        print(f"  {d}: {v['steps']:>6} steps  {v['distance_m'] / 1000:.2f} km   busiest hour {busiest:02d}:00 ({v['hourly'][busiest]})")


if __name__ == "__main__":
    main()
