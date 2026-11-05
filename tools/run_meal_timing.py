#!/usr/bin/env python3
"""Meal-time regularity with Oura's `meal_timing_0_1_0` model.

What the model does (read from its TorchScript, `MealWindowClustering`): it localizes
each logged meal (unix seconds + the UTC offset in seconds), counts meals in
half-hour bins of the day (with a wrap-around extension past midnight), keeps the
bins logged at least 20 % as often as the busiest one, joins bins closer than two
hours into windows, and returns each window as [start minute past midnight,
duration in minutes] plus a 0–1 consistency: the share of all logged meals that fall
inside those windows (it needs ≥ 10 logged meals, else NaN).

Meals come from `meals.json` next to the DB, logged from the dashboard. Each meal
keeps the UTC offset it was logged with (`tz`, hours).

Usage: python tools/run_meal_timing.py [DB] [--tz H] [--json]
"""
import argparse
import json
import sys
import time
from pathlib import Path

import torch

from _common import resolve_db, resolve_models_dir

REPO = Path(__file__).resolve().parent.parent
MODEL_NAME = "meal_timing_0_1_0.pt"
MODEL = resolve_models_dir(REPO, MODEL_NAME) / MODEL_NAME
MIN_MEALS = 10


def local_tz_hours():
    return -(time.altzone if time.localtime().tm_isdst > 0 else time.timezone) / 3600.0


def read_meals(db):
    try:
        data = json.loads((Path(db).parent / "meals.json").read_text())
        return [m for m in data.get("meals", []) if isinstance(m, dict) and m.get("t")]
    except (OSError, ValueError):
        return []


def main():
    p = argparse.ArgumentParser(description="Meal-time windows (Oura meal_timing model)")
    p.add_argument("db", nargs="?", default=None)
    p.add_argument("--tz", type=float, default=None)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if not MODEL.exists():
        sys.exit(f"model not found: {MODEL}")
    tz = local_tz_hours() if args.tz is None else args.tz
    meals = sorted(read_meals(resolve_db(args.db, REPO)), key=lambda m: m["t"])
    result = {"model": MODEL.stem, "meals": meals, "count": len(meals), "min_meals": MIN_MEALS,
              "windows": [], "consistency": None}
    if meals:
        model = torch.jit.load(str(MODEL), map_location="cpu").eval()
        with torch.no_grad():
            windows, consistency = model(
                torch.tensor([float(m["t"]) for m in meals], dtype=torch.float64),
                torch.tensor([float(m.get("tz", tz)) * 3600 for m in meals], dtype=torch.float64))
        result["windows"] = [{"start_min": int(a) % 1440, "minutes": int(b)} for a, b in windows.tolist()]
        c = float(consistency.flatten()[0])
        result["consistency"] = round(c, 2) if c == c else None
    if args.json:
        print(json.dumps(result))
        return
    print(f"Meal timing — {MODEL.stem}: {len(meals)} logged meals")
    for w in result["windows"]:
        s, e = w["start_min"], w["start_min"] + w["minutes"]
        print(f"  window {s // 60:02d}:{s % 60:02d}–{e // 60 % 24:02d}:{e % 60:02d}")
    print(f"  consistency: {result['consistency']}" if result["consistency"] is not None
          else f"  consistency needs {MIN_MEALS} meals")


if __name__ == "__main__":
    main()
