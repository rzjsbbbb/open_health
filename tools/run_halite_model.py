#!/usr/bin/env python3
"""Hypertension risk with Oura's `halite_1_2_0` model ("Halite").

What the model is (read from its TorchScript):
  PulseNet foundation model 0.4.0 (an EfficientNet encoder on band-passed PPG,
  256-d embeddings, aggregated over segments by weighted mean)
  → a logistic regressor → `ppg_score` (0..1)
  → a gradient-boosted tree (hummingbird) over [user_info, baselines, ppg score]
  → age/sex calibration → probability, risk level (< 0.45 low, < 0.6 moderate, else high).
Output row: [calibrated probability, risk level 0 / 0.5 / 1, ppg_score, raw tree score].

Inputs:
  ppg_input          [n, 1500] float32 — the same 30-second, ~50 Hz `cva_raw_ppg_data`
                     segments the CVA runner decodes (cva_ppg must be enabled)
  user_info  [1, 8]  biological_sex (-1 F / 1 M / 0), age, height_m, weight_kg (the model
                     turns it into BMI), cardiovascular_disease_family_history (0/1),
                     alcohol_consumption_frequency (0..4), smoking_history (0/1),
                     current_smoking_frequency (0..2); -999 = not answered
  baselines  [1, 4]  activity_distance_avg (m/day), resting_hr_avg, sleep_time_avg (s),
                     hrv_avg; -999 = unknown
  ppg_score_history  [n, 2] (days since that assessment, ppg_score) — the earlier days;
                     the model averages them in 7-day bins together with today's score.

Baselines come from the ring, as the summary defines them: resting HR = each night's
lowest 5-minute HR, HRV = the night's mean RMSSD, sleep time = NSSA-staged asleep time
(nssa_cache.json; time in bed when no night is staged), daily distance = MET-derived
steps × 0.762 m (the summary's rule). The four questionnaire answers come from
profile.json (the dashboard's profile dialog); unanswered ones stay -999.

Usage: python tools/run_halite_model.py [DB] [--tz H] [--json]
"""
import argparse
import datetime
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

from _common import resolve_db, resolve_models_dir
from ring_signals import Signals, load_profile, mean_sd, nightly
from run_cva_model import load_segments

REPO = Path(__file__).resolve().parent.parent
MODEL_NAME = "halite_1_2_0.pt"
MODEL = resolve_models_dir(REPO, MODEL_NAME) / MODEL_NAME
NA = -999.0
LEVEL = {0.0: "low", 0.5: "moderate", 1.0: "high"}
QUESTIONS = (("cvd_family_history", (0, 1)), ("alcohol_frequency", (0, 1, 2, 3, 4)),
             ("smoking_history", (0, 1)), ("smoking_current", (0, 1, 2)))
HISTORY_DAYS = 90


def answer(profile, key, allowed):
    v = profile.get(key)
    try:
        v = int(v)
    except (TypeError, ValueError):
        return NA
    return float(v) if v in allowed else NA


def sleep_seconds(db, sig):
    """Mean asleep seconds per staged night (NSSA cache), else mean time in bed."""
    try:
        nights = json.loads((Path(db).parent / "nssa_cache.json").read_text()).get("nights", {})
        per_bed = {}
        for v in nights.values():
            if v and v.get("t") and v.get("s"):
                per_bed[v["t"][0]] = sum(30 for c in v["s"] if c in (1, 2, 3))
        main = [s for s in per_bed.values() if s >= 3 * 3600]  # whole nights, not naps
        if main:
            return sum(main) / len(main)
    except (OSError, ValueError):
        pass
    beds = [e - s for s, e in sig.bedtimes if e - s >= 3 * 3600]
    return sum(beds) / len(beds) if beds else None


def distance_per_day(sig, tz):
    """Mean daily walking distance over complete days, by the summary's MET→steps rule."""
    days = {}
    for minute, met in sig.met.items():
        day = int((minute * 60 + tz * 3600) // 86400)
        rate = 150.0 if met >= 7 else 105.0 if met >= 2.5 else 0.0
        n, steps = days.get(day, (0, 0.0))
        days[day] = (n + 1, steps + rate)
    full = [round(steps / 100) * 100 * 0.762 for n, steps in days.values() if n >= 20 * 60]
    return sum(full) / len(full) if full else None


def bounded(v, lo, hi):
    return float(v) if v is not None and lo <= v <= hi else NA


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def main():
    p = argparse.ArgumentParser(description="Hypertension risk (Oura halite model)")
    p.add_argument("db", nargs="?", default=None)
    p.add_argument("--tz", type=float, default=None)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz
    db = resolve_db(args.db, REPO)
    profile = load_profile(db)

    segs, _ = load_segments(db)
    if not segs:
        sys.exit("no full 1500-sample PPG segment — enable cva_ppg and wear the ring overnight")
    by_day = {}
    for t, seg in segs:
        day = datetime.datetime.utcfromtimestamp(t + tz * 3600).date()
        by_day.setdefault(day, []).append(seg)

    sex = {"M": 1.0, "F": -1.0}.get(str(profile.get("sex", "M")).upper(), 0.0)
    user_info = [sex, float(profile.get("age") or 30), float(profile.get("height_m") or 1.78),
                 float(profile.get("weight_kg") or 75)] + [answer(profile, k, a) for k, a in QUESTIONS]
    sig = Signals(db)
    nights = nightly(sig)
    rhr, _ = mean_sd([r for _, r, _ in nights])
    hrv, _ = mean_sd([h for _, _, h in nights])
    baselines = [bounded(distance_per_day(sig, tz), 50, 50000), bounded(rhr, 30, 150),
                 bounded(sleep_seconds(db, sig), 10800, 54000), bounded(hrv, 5, 300)]

    model = torch.jit.load(str(MODEL), map_location="cpu").eval()
    ui = lambda: torch.tensor([user_info], dtype=torch.float32)  # forward edits it in place
    bl = torch.tensor([baselines], dtype=torch.float32)
    ppg = lambda day: torch.tensor(np.stack(by_day[day]), dtype=torch.float32)

    days = sorted(by_day)
    scores = {}
    with torch.no_grad():
        for day in days:  # each day's own PPG score (what the app stores as history)
            scores[day] = float(model(ppg(day), ui(), bl)[0].flatten()[2])
        today = days[-1]
        past = [((today - d).days, scores[d]) for d in days[:-1] if (today - d).days <= HISTORY_DAYS]
        history = torch.tensor(past, dtype=torch.float32) if past else None
        out = model(ppg(today), ui(), bl, history)[0].flatten().tolist()
    probability, level, ppg_score, raw = out
    answered = sum(1 for v in user_info[4:] if v != NA)
    result = {
        "model": MODEL.stem, "date": today.isoformat(),
        "risk_probability": round(probability, 3), "risk_level": LEVEL.get(level, str(level)),
        "thresholds": [0.45, 0.6], "ppg_score": round(ppg_score, 3), "raw_score": round(raw, 3),
        "days": len(days), "segments": len(by_day[today]),
        "weeks": len({(today - d).days // 7 for d in days}),
        "baselines": dict(zip(("distance_m", "resting_hr", "sleep_s", "hrv_ms"),
                              [None if b == NA else round(b, 1) for b in baselines])),
        "questions_answered": answered, "questions_total": len(QUESTIONS),
        "history": [{"date": d.isoformat(), "ppg_score": round(scores[d], 3)} for d in days],
    }
    if args.json:
        print(json.dumps(result))
        return
    print(f"Hypertension risk — {MODEL.stem} (PulseNet {model.pulsenet_version})")
    print(f"  {today}: risk {result['risk_level']}  probability {probability:.2f}  "
          f"(ppg score {ppg_score:.2f}, {len(by_day[today])} segments, {len(days)} day(s))")
    print(f"  baselines: {result['baselines']}   questions answered: {answered}/{len(QUESTIONS)}")
    for h in result["history"]:
        print(f"    {h['date']}: ppg score {h['ppg_score']}")


if __name__ == "__main__":
    main()
