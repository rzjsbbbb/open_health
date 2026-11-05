#!/usr/bin/env python3
"""Workout calories with Oura's `energy_expenditure_2_4_1` model.

The model estimates the *active* energy of one workout — an activity type
(`workout_details[0]`, the app's activity ids 1..81 / 65535 "other") and an
intensity (-1 auto, 0 easy, 1 moderate, 2 hard) over `[start_ms, end_ms]` — from
the ring signals inside that window. It splits the workout into 10-minute chunks
and picks a mode per chunk from the data it finds (read from its TorchScript):

  1  heart rate + motion   (a network on HR and gait features)
  2  motion only           (HR grid too sparse)
  4  heart rate only       (not enough motion rows: < 1.5/min or gait < 5/min)
  3  static MET            (neither: the activity's MET table × BMR, auto = moderate)

Inputs, all wall-clock milliseconds (int64), shapes [n, k]:
  demographic [5] = [sex (+1 M / -1 F), height_m, age, weight_kg, ring_size]
  ring_met [n,1] per minute · motion [n,8] (motion_event, every 30 s) ·
  step_motion [n,11] (steps_motion_decoder rows) · hr [n,2] (bpm, 1) ·
  temperature [n,1] · trends [15] (NaN → the model's population defaults) ·
  location [0,5] (none)
Outputs: active kcal, MET, intensity (0/1/2), kcal at that intensity, mode,
upscaled ring MET, cardio effort and its source.

Workouts come from `workouts.json` next to the DB (logged from the dashboard),
plus — with `--with-detected` — the sessions Oura's activity model detects. Each one
also gets its step count from `step_counter_1_3_0` (tools/run_step_counter.py) and a
walking distance at the summary's 0.762 m/step. (Oura's `locomotion` distance model
is not used: run on this ring's data it reports kilometres for windows where the step
counter finds almost no steps, so its input layout can't be trusted yet.)

Usage: python tools/run_energy_model.py [DB] [--tz H] [--json] [--with-detected]
       python tools/run_energy_model.py [DB] --start "YYYY-MM-DD HH:MM" --minutes N
                                        --type ID [--intensity -1|0|1|2] [--tz H] [--json]
"""
import argparse
import datetime
import json
import math
import sys
import time
import warnings
from pathlib import Path

import torch

from _common import resolve_db, resolve_models_dir
from ring_signals import Signals, load_profile, mean_sd, nightly

warnings.filterwarnings("ignore", message=".*searchsorted.*")

REPO = Path(__file__).resolve().parent.parent
MODEL_NAME = "energy_expenditure_2_4_1.pt"
MODEL = resolve_models_dir(REPO, MODEL_NAME) / MODEL_NAME
MODE = {1: "hr+motion", 2: "motion", 3: "static_met", 4: "hr"}
INTENSITY = {0: "easy", 1: "moderate", 2: "hard"}
NAN = float("nan")


def workouts_path(db):
    return Path(db).parent / "workouts.json"


def read_workouts(db):
    try:
        data = json.loads(workouts_path(db).read_text())
        return [w for w in data.get("workouts", []) if isinstance(w, dict)]
    except (OSError, ValueError):
        return []


def trends(sig):
    """The 15 `trends` the model takes; what the ring can't give stays NaN, which the
    model replaces with its own population defaults."""
    nights = nightly(sig)
    hrv_avg, hrv_sd = mean_sd([h for _, _, h in nights])
    rhr_avg, rhr_sd = mean_sd([r for _, r, _ in nights])
    awake = [(t, r, h) for t, r, h in sig.hrv if not sig.asleep(t)]
    awake_hrv = sorted(r for _, r, _ in awake if r)
    awake_hr = [h for _, _, h in awake if h]
    v = lambda x: NAN if x is None else float(x)
    return [
        v(hrv_avg), v(hrv_sd), v(rhr_avg), v(rhr_sd),
        NAN, NAN,                         # long-term temperature avg / deviation
        NAN, NAN, NAN, NAN, NAN, NAN,     # activity distance / sedentary / vigorous
        v(awake_hrv[len(awake_hrv) // 2] if awake_hrv else None),
        v(min(awake_hr) if awake_hr else None),
        NAN,                              # short-term awake sedentary temperature
    ]


def rows_in(series, start, end, width):
    """Rows of `series` [(unix, value(s))] inside [start, end) → (data [n,width], ts_ms [n,1])."""
    sel = [(t, v if isinstance(v, list) else [v]) for t, v in series if start <= t < end]
    if not sel:
        return torch.empty((0, width), dtype=torch.float32), torch.empty((0, 1), dtype=torch.int64)
    data = torch.tensor([v for _, v in sel], dtype=torch.float32)
    ts = torch.tensor([[int(round(t * 1000))] for t, _ in sel], dtype=torch.int64)
    return data, ts


def estimate(model, sig, profile, trend, w):
    start, end = float(w["start"]), float(w["end"])
    sex = 1.0 if str(profile.get("sex", "M")).upper() == "M" else -1.0
    demographic = torch.tensor([sex, float(profile.get("height_m") or 1.78), float(profile.get("age") or 30),
                                float(profile.get("weight_kg") or 75), float(profile.get("ring_size") or 10)],
                               dtype=torch.float32)
    met, met_ts = rows_in(sig.met_series(), start, end, 1)
    motion, motion_ts = rows_in(sig.motion, start, end, 8)
    steps, steps_ts = rows_in(sig.stepmotion(), start, end, 11)
    steps = torch.nan_to_num(steps, nan=0.0)
    hr, hr_ts = rows_in([(t, [b, 1.0]) for t, b in sig.hr], start, end, 2)
    temp, temp_ts = rows_in(sig.temp, start, end, 1)
    with torch.no_grad():
        out = model(
            demographic,
            torch.tensor([float(w.get("type", 65535)), float(w.get("intensity", -1))], dtype=torch.float32),
            torch.tensor([int(start * 1000), int(end * 1000)], dtype=torch.int64),
            met, met_ts, motion, motion_ts, steps, steps_ts, hr, hr_ts, temp, temp_ts,
            torch.tensor(trend, dtype=torch.float32),
            torch.empty((0, 5), dtype=torch.float32), torch.empty((0, 1), dtype=torch.int64),
        )
    kcal, met_avg, level, kcal_at_level, mode, _scaled, effort, effort_src = (o.flatten() for o in out)
    num = lambda x, nd=1: None if x != x else round(float(x), nd)
    return {
        "kcal": num(kcal[0].item(), 0), "met": num(met_avg[0].item(), 1),
        "intensity": INTENSITY.get(int(level[0].item())), "kcal_at_intensity": num(kcal_at_level[0].item(), 0),
        "mode": MODE.get(int(mode[0].item()), str(int(mode[0].item()))),
        "cardio_effort": num(effort[0].item(), 1), "cardio_effort_source": int(effort_src[0].item()),
        "samples": {"met": int(met.shape[0]), "motion": int(motion.shape[0]),
                    "gait": int(steps.shape[0]), "hr": int(hr.shape[0])},
    }


def detected_sessions(db, tz):
    """Oura's activity model's sessions as workouts (activity id + window)."""
    import run_activity_model as aad
    by_label = {label: i for i, label in aad.BEHAVIOR.items() if 0 < i < 65536}
    sys.argv = [sys.argv[0], str(db), "--tz", str(tz), "--json"]
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        aad.main()
    out = []
    for s in json.loads(buf.getvalue()).get("sessions", []):
        if s.get("label") not in by_label or s.get("is_workout", 0) < 0.5:
            continue
        start = datetime.datetime.strptime(s["start"], "%Y-%m-%d %H:%M") - datetime.timedelta(hours=tz)
        start_unix = start.replace(tzinfo=datetime.timezone.utc).timestamp()
        out.append({"id": f"aad-{int(start_unix)}", "type": by_label[s["label"]], "intensity": -1,
                    "start": start_unix, "end": start_unix + 60 * s["duration_min"], "source": "detected"})
    return out


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def main():
    p = argparse.ArgumentParser(description="Workout calories with Oura's energy model")
    p.add_argument("db", nargs="?", default=None)
    p.add_argument("--tz", type=float, default=None)
    p.add_argument("--start", help='local start "YYYY-MM-DD HH:MM" (one-off estimate)')
    p.add_argument("--minutes", type=float, default=30)
    p.add_argument("--type", type=int, default=65535, help="activity id (14 walking, 12 running, 5 cycling, …)")
    p.add_argument("--intensity", type=int, default=-1, choices=[-1, 0, 1, 2])
    p.add_argument("--with-detected", action="store_true")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz
    db = resolve_db(args.db, REPO)
    model = torch.jit.load(str(MODEL), map_location="cpu").eval()
    types = {k: v[0] for k, v in model.activity_type_dict.items()}

    if args.start:
        local = datetime.datetime.strptime(args.start, "%Y-%m-%d %H:%M") - datetime.timedelta(hours=tz)
        start = local.replace(tzinfo=datetime.timezone.utc).timestamp()
        workouts = [{"id": "cli", "type": args.type, "intensity": args.intensity,
                     "start": start, "end": start + args.minutes * 60, "source": "cli"}]
    else:
        workouts = [dict(w, source=w.get("source", "logged")) for w in read_workouts(db)]
        if args.with_detected:
            logged = [(w["start"], w["end"]) for w in workouts]
            for d in detected_sessions(db, tz):  # a logged workout wins over the detected copy
                if not any(s < d["end"] and d["start"] < e for s, e in logged):
                    workouts.append(d)

    sig = Signals(db)
    profile = load_profile(db)
    trend = trends(sig)
    try:  # per-minute steps for each workout's step count and distance
        from run_step_counter import METERS_PER_STEP, count_steps
        step_minutes = count_steps(sig) if workouts else []
    except Exception:
        step_minutes, METERS_PER_STEP = [], 0.762
    results = []
    for w in sorted(workouts, key=lambda w: w.get("start", 0)):
        entry = {k: w.get(k) for k in ("id", "type", "intensity", "start", "end", "source", "note")}
        entry["type_name"] = types.get(int(w.get("type", 65535)), "other")
        entry["minutes"] = round((float(w["end"]) - float(w["start"])) / 60)
        if step_minutes:
            n = sum(c for t, c in step_minutes if float(w["start"]) <= t < float(w["end"]))
            entry["steps"] = round(n)
            entry["distance_m"] = round(n * METERS_PER_STEP)
        try:
            entry.update(estimate(model, sig, profile, trend, w))
        except Exception as e:  # the model's own checks ("10, Error, workout length less than 10 minutes", …)
            entry["error"] = str(e).strip().splitlines()[-1][:160]
        results.append(entry)

    if args.json:
        print(json.dumps({"model": MODEL.stem, "workouts": results}))
        return
    print(f"Workout energy — {MODEL.stem}")
    if not results:
        print("  no workouts (log one in the dashboard, or pass --start/--minutes/--type)")
    for r in results:
        when = datetime.datetime.utcfromtimestamp(r["start"] + tz * 3600).strftime("%Y-%m-%d %H:%M")
        if "error" in r:
            print(f"  {when}  {r['type_name']:<18} {r['minutes']:>3} min  → {r['error']}")
            continue
        print(f"  {when}  {r['type_name']:<18} {r['minutes']:>3} min  {r['kcal']:>5} kcal active  "
              f"MET {r['met']}  {r['intensity']}  mode {r['mode']}  cardio effort {r['cardio_effort']}  {r['samples']}")


if __name__ == "__main__":
    main()
