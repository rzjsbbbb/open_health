#!/usr/bin/env python3
"""High / low resting heart-rate episodes with Oura's `high_low_hr_1_1_0` model.

What the model does (read from its TorchScript, `HiloHRv1_1Module`):
  * slides a 10-minute window in 5-minute steps over the MET timeline,
  * keeps only *resting* windows: the max MET over the window and the 5 minutes
    before it must stay below 1.8 (non-wear minutes, MET == 0.1, void a window),
  * inside a window, splits the beats into the ring's measurement periods (a ≥ 60 s
    gap starts a new one), keeps periods of 30 s–2 min with ≥ 4 valid beats and
    enough quality (valid fraction ≥ max(avg_ibiq × 0.5, 0.2)), and turns each into
    a heart rate from its median IBI,
  * flags the window when the mean of those rates is above `high_thr` or below
    `low_thr` (one period alone must also pass quality ≥ max(avg_ibiq, 0.4)); after
    a flagged window it jumps a full 10 minutes.
Outputs per evaluated window: [win_id, start_ms, end_ms, periods] · [high, low] ·
[mean HR, max MET, mean quality].

Beats are the green-LED IBI stream (0x80) with the firmware's quality flag
(quality == 1 → valid); MET is the per-minute activity_information stream.
`avg_ibiq` is the overall valid-beat fraction. Thresholds come from profile.json
(`hr_alert_high` / `hr_alert_low`, set in the dashboard's profile dialog), default
120 / 40 bpm.

Usage: python tools/run_hilo_hr.py [DB] [--high BPM] [--low BPM] [--tz H] [--json]
"""
import argparse
import datetime
import json
import sys
import time
from pathlib import Path

import torch

from _common import resolve_db, resolve_models_dir
from ring_signals import Signals, load_profile

REPO = Path(__file__).resolve().parent.parent
MODEL_NAME = "high_low_hr_1_1_0.pt"
MODEL = resolve_models_dir(REPO, MODEL_NAME) / MODEL_NAME
DEFAULT_HIGH, DEFAULT_LOW = 120.0, 40.0


def episodes(windows, key):
    """Merge flagged windows that touch or overlap into episodes."""
    out = []
    for w in windows:
        if not w[key]:
            continue
        if out and w["start"] <= out[-1]["end"]:
            e = out[-1]
            e["end"] = max(e["end"], w["end"])
            e["hrs"].append(w["hr"])
        else:
            out.append({"kind": key, "start": w["start"], "end": w["end"], "hrs": [w["hr"]]})
    for e in out:
        hrs = e.pop("hrs")
        e["hr"] = round(max(hrs) if key == "high" else min(hrs), 1)
        e["minutes"] = round((e["end"] - e["start"]) / 60)
    return out


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def main():
    p = argparse.ArgumentParser(description="High/low resting HR episodes (Oura high_low_hr model)")
    p.add_argument("db", nargs="?", default=None)
    p.add_argument("--high", type=float, default=None)
    p.add_argument("--low", type=float, default=None)
    p.add_argument("--tz", type=float, default=None)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz
    db = resolve_db(args.db, REPO)
    profile = load_profile(db)
    high = float(args.high if args.high is not None else profile.get("hr_alert_high") or DEFAULT_HIGH)
    low = float(args.low if args.low is not None else profile.get("hr_alert_low") or DEFAULT_LOW)
    if low >= high:
        sys.exit(f"low threshold {low} must be below high {high}")

    sig = Signals(db)
    beats = sorted(sig.ibi)
    met = sig.met_series()
    if not beats or not met:
        sys.exit("no IBI or MET data yet — sync after wearing the ring")
    avg_ibiq = sum(v for _, _, v in beats) / len(beats)
    model = torch.jit.load(str(MODEL), map_location="cpu").eval()
    with torch.no_grad():
        meta, flags, metrics = model(
            torch.tensor([int(t) for t, _, _ in beats], dtype=torch.int64),
            torch.tensor([ms for _, ms, _ in beats], dtype=torch.float32),
            torch.tensor([v for _, _, v in beats], dtype=torch.float32),
            torch.tensor([int(t * 1000) for t, _ in met], dtype=torch.int64),
            torch.tensor([m for _, m in met], dtype=torch.float32),
            torch.tensor([avg_ibiq], dtype=torch.float32),
            torch.tensor([high], dtype=torch.float32),
            torch.tensor([low], dtype=torch.float32),
        )
    windows = [{
        "start": m[1] / 1000.0, "end": m[2] / 1000.0, "periods": int(m[3]),
        "high": bool(f[0]), "low": bool(f[1]),
        "hr": round(x[0], 1), "max_met": round(x[1], 2), "quality": round(x[2], 3),
    } for m, f, x in zip(meta.tolist(), flags.tolist(), metrics.tolist())]
    eps = sorted(episodes(windows, "high") + episodes(windows, "low"), key=lambda e: e["start"])
    hrs = sorted(w["hr"] for w in windows)
    result = {
        "model": MODEL.stem, "high_threshold": high, "low_threshold": low,
        "avg_ibiq": round(avg_ibiq, 3), "windows": len(windows),
        "resting_hr_range": [hrs[0], hrs[-1]] if hrs else None,
        "resting_hr_median": hrs[len(hrs) // 2] if hrs else None,
        "first": windows[0]["start"] if windows else None, "last": windows[-1]["end"] if windows else None,
        "episodes": eps,
    }
    if args.json:
        print(json.dumps(result))
        return
    clock = lambda u: datetime.datetime.utcfromtimestamp(u + tz * 3600).strftime("%m-%d %H:%M")
    print(f"High/low resting HR — {MODEL.stem}, thresholds {low:.0f}/{high:.0f} bpm, avg IBI quality {avg_ibiq:.2f}")
    print(f"  {len(windows)} resting 10-min windows evaluated"
          + (f", HR {hrs[0]}–{hrs[-1]} bpm (median {result['resting_hr_median']})" if hrs else ""))
    for e in eps:
        print(f"  {e['kind'].upper():4} {clock(e['start'])}–{clock(e['end'])[6:]}  {e['minutes']} min  {e['hr']} bpm")
    if not eps:
        print("  no episodes above/below the thresholds")


if __name__ == "__main__":
    main()
