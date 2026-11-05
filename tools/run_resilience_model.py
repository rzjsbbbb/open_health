#!/usr/bin/env python3
"""Stress resilience with Oura's `stress_resilience_2_2_2` model.

What the model does (read from its TorchScript, `Resilience`):
  * per day: resamples that day's daytime stress intensity (ms vs baseline) to
    10-minute buckets outside sleep, quantizes it with the stress model's limits and
    saturations (needs ≥ 4 h of daytime stress), and turns it into three daily
    indices — stress load, daytime restorative time, and sleep recovery (the night's
    sleep score 0.4, HRV balance 0.2, recovery index 0.2, resting HR 0.2 contributors);
  * over the last 14 days (the 13 previous days' indices are inputs, today weighted ×2;
    ≥ 5 days needed) it fits recovery against stress and returns a level 1–5 —
    Oura's Limited / Adequate / Solid / Strong / Exceptional — plus a confidence.

Inputs come from the dashboard summary (stdin, or `--summary FILE`): `stress.samples`
(run_stress_model.py) and `nights`. Oura's readiness contributors are not computed
locally, so the sleep-recovery side is approximate:
  * sleep score     — the summary's evidence-based sleep score of the night you woke from,
  * HRV balance     — not available: passed as NaN, which the model accepts,
  * recovery index  — 100 when the night's lowest heart rate falls in the first half of
                      the sleep (Oura's own description), falling linearly to 0 at the end,
  * resting HR      — 100 at or below your average of the previous (up to 14) nights,
                      10 points less per bpm above it.

Usage: python tools/run_resilience_model.py [--summary FILE] [--tz H] [--json]  (summary on stdin)
"""
import argparse
import datetime
import json
import sys
import time
from pathlib import Path

import torch

from _common import resolve_models_dir

REPO = Path(__file__).resolve().parent.parent
MODEL_NAME = "stress_resilience_2_2_2.pt"
MODEL = resolve_models_dir(REPO, MODEL_NAME) / MODEL_NAME
LEVELS = {1: "limited", 2: "adequate", 3: "solid", 4: "strong", 5: "exceptional"}
HISTORY = 13
NAN = float("nan")


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def recovery_index(night):
    hr = [(t, v) for t, v in (night.get("series_t") or {}).get("hr") or [] if v]
    s, e = night.get("start_unix"), night.get("end_unix")
    if not hr or not s or not e or e <= s:
        return None
    t_min = min(hr, key=lambda p: p[1])[0]
    frac = min(1.0, max(0.0, (t_min - s) / (e - s)))
    return 100.0 if frac <= 0.5 else round(100.0 * (1.0 - frac) / 0.5, 1)


def rhr_contributor(night, prior):
    rhr = night.get("rhr")
    if not rhr:
        return None
    base = [n["rhr"] for n in prior if n.get("rhr")][-14:]
    if not base:
        return 100.0
    avg = sum(base) / len(base)
    return max(0.0, min(100.0, 100.0 - 10.0 * max(0.0, rhr - avg)))


def main():
    p = argparse.ArgumentParser(description="Stress resilience (Oura stress_resilience model)")
    p.add_argument("--summary", help="summary JSON file (default: stdin)")
    p.add_argument("--tz", type=float, default=None)
    p.add_argument("--json", action="store_true")
    args, _ = p.parse_known_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz
    summary = json.loads(Path(args.summary).read_text() if args.summary else sys.stdin.read())
    stress = summary.get("stress") or {}
    samples = [s for s in stress.get("samples") or [] if s.get("unix") is not None]
    nights = sorted((n for n in summary.get("nights") or [] if n.get("start_unix") and n.get("end_unix")),
                    key=lambda n: n["start_unix"])
    if not samples or not nights:
        sys.exit("needs daytime stress and at least one night")

    day_of = lambda u: datetime.datetime.utcfromtimestamp(u + tz * 3600).date().isoformat()
    by_day = {}
    for s in samples:
        by_day.setdefault(day_of(s["unix"]), []).append(s)
    night_for = {n.get("wake_ymd"): n for n in nights}
    limits = samples[0]
    f = lambda v: torch.tensor([[v]], dtype=torch.float32)
    sleep_s = torch.tensor([n["start_unix"] * 1000.0 for n in nights], dtype=torch.float64)
    sleep_e = torch.tensor([n["end_unix"] * 1000.0 for n in nights], dtype=torch.float64)
    model = torch.jit.load(str(MODEL), map_location="cpu").eval()

    hist = {"stress": [], "restorative": [], "sleep": []}
    days = []
    for day in sorted(by_day):
        night = night_for.get(day)
        prior = [n for n in nights if night and n["end_unix"] < night["start_unix"]]
        score = ((night or {}).get("sleep_score") or {}).get("score")
        ri = recovery_index(night) if night else None
        rc = rhr_contributor(night, prior) if night else None
        entry = {"date": day, "stress_hours": round(len(by_day[day]) * 5 / 60, 1),
                 "contributors": {"sleep_score": score, "hrv_balance": None, "recovery_index": ri, "resting_hr": rc}}
        pad = lambda xs: torch.tensor(([NAN] * HISTORY + xs)[-HISTORY:], dtype=torch.float32).reshape(-1, 1)
        out = None
        if score is not None and ri is not None and rc is not None:
            rows = by_day[day]
            try:
                with torch.no_grad():
                    out = model(
                        sleep_s, sleep_e, f(score), f(NAN), f(ri), f(rc),
                        f(limits["stress_limit"]), f(limits["saturation_stress_deviation"]),
                        f(limits["saturation_recovery_deviation"]), f(limits["recovery_limit"]),
                        torch.tensor([s["intensity"] for s in rows], dtype=torch.float32),
                        torch.tensor([s["unix"] * 1000.0 for s in rows], dtype=torch.float64),
                        pad(hist["stress"]), pad(hist["restorative"]), pad(hist["sleep"]))
            except Exception as e:  # "1, Condition, Sleep score is missing or out of bounds." …
                entry["error"] = str(e).strip().splitlines()[-1][:160]
        else:
            entry["error"] = "no night (sleep score / heart rate) for this day"
        if out is not None:
            v = [float(x.flatten()[0]) for x in out]
            num = lambda x, nd=1: None if x != x else round(x, nd)
            entry.update(daily_stress=num(v[0]), daily_restorative_time=num(v[1]), daily_sleep_recovery=num(v[2]),
                         long_term_stress=num(v[9]), long_term_recovery=num(v[8]),
                         level=LEVELS.get(int(v[10])) if v[10] == v[10] else None,
                         granular_level=num(v[11], 2), confidence=num(v[12], 2))
            hist["stress"].append(v[0]); hist["restorative"].append(v[1]); hist["sleep"].append(v[2])
        else:
            for k in hist:
                hist[k].append(NAN)
        days.append(entry)

    scored = [d for d in days if d.get("daily_stress") is not None]
    latest = next((d for d in reversed(days) if d.get("level")), None)
    result = {"model": MODEL.stem, "days": days, "days_with_indices": len(scored), "days_needed": 5,
              "latest": latest, "approximate": ["recovery_index", "resting_hr", "sleep_score"], "hrv_balance": None}
    if args.json:
        print(json.dumps(result))
        return
    print(f"Stress resilience — {MODEL.stem}: {len(scored)} day(s) with daily indices (level needs 5)")
    for d in days:
        if "error" in d:
            print(f"  {d['date']}: {d['error']}")
        else:
            print(f"  {d['date']}: stress {d['daily_stress']}  restorative {d['daily_restorative_time']}  "
                  f"sleep recovery {d['daily_sleep_recovery']}  level {d['level']} (confidence {d['confidence']})")


if __name__ == "__main__":
    main()
