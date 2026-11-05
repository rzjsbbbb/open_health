# Running Oura's on-device models on your synced data

The ring ships Oura's analysis as encrypted on-device PyTorch models. Once
decrypted locally (into the gitignored `notes/models/`), several of them run on
the signals we already sync into `oura.db`. This page indexes the runners and what
each can and can't do.

## Tools

| tool | model(s) | output | status |
| --- | --- | --- | --- |
| `oura sessions` / `tools/run_activity_model.py` | `automatic_activity_detection_3_1_11` | activity/workout segments + type label | ✅ runs |
| `tools/run_sleep_model.py` | `sleepstaging_2_6_0` (NSSA, the official app's stager) | DEEP/LIGHT/REM/WAKE hypnogram per ring bedtime + efficiency | ✅ runs (custom ops + classifier, see [sleep-staging.md](algorithms/sleep-staging.md)) |
| `tools/run_models.py bdi` | `sleepnet_bdi_0_4_0` | hypnogram + apnea/breathing-disturbance (`--json`: % of sleep epochs flagged, the model's ≥ 15 % flag) | ✅ runs |
| `tools/run_cva_model.py` | `cva_2_1_0`, else `cva_1_3_0`; then `cva_calibrator_1_3_0` | cardiovascular (vascular) age + pulse-wave velocity, one value per local day; the calibrator's 30-day median once 14 days are in | ✅ runs (needs `cva_ppg` on — see [cva-cardiovascular-age.md](cva-cardiovascular-age.md)) |
| `tools/run_stress_model.py` | `stress_daytime_sensing_1_1_0` + `dhrv_imputation_1_1_0` | daytime stress per 5-minute awake slot; the imputer fills the slots without a measured HRV from HR / skin temperature / MET | ✅ runs |
| `tools/run_energy_model.py` | `energy_expenditure_2_4_1` | active kcal, MET, intensity and cardio effort of a workout (logged in `workouts.json`, or detected with `--with-detected`) | ✅ runs |
| `tools/run_hilo_hr.py` | `high_low_hr_1_1_0` | resting 10-minute windows whose heart rate is above / below the profile's limits (default 120 / 40 bpm) | ✅ runs |
| `tools/run_halite_model.py` | `halite_1_2_0` (PulseNet 0.4.0 + tree model) | hypertension-risk probability and level from the PPG, demographics, ring baselines and four optional questionnaire answers | ✅ runs (needs `cva_ppg` on) |
| `tools/run_step_counter.py` | `step_counter_1_3_0` | real step counts per minute / hour / day from gait + motion (replaces the summary's MET-band estimate) | ✅ runs |
| `tools/run_training_load.py` | `training_stress_score_0_2_2` | 12-hour weighted MET training load; > 5.3 is high (readiness unknown → standard threshold) | ✅ runs |
| `tools/run_resilience_model.py` | `stress_resilience_2_2_2` | daily stress / restorative / sleep-recovery indices; level 1–5 after 5 days. Runs on the finished summary (stdin). Sleep-recovery contributors are approximated (see its docstring) | ✅ runs |
| `tools/run_meal_timing.py` | `meal_timing_0_1_0` | regular meal windows + consistency from meals logged in `meals.json` (≥ 10 meals) | ✅ runs |
| (inside `run_stress_model.py`) | `astd_event_detection_0_1_1`, `daily_medians_1_1_0`, `daily_short_term_baselines_1_1_0` | stress / restoration events in 15-min bins; the app's personal dHRV / HR / skin-temp / night-HRV baselines (≥ 5 days of measured daytime HRV; provisional before) | ✅ runs |
| `tools/run_spo2.py` | (no model — Oura's calibration) | overnight SpO2 % | ✅ runs (see [spo2-calibration.md](spo2-calibration.md)) |
| `tools/run_models.py daily_medians` | `daily_medians_1_1_0` | HRV/HR/temp/MET daily medians | ⚠️ runs but needs **awake** HRV (ours is nocturnal) |
| `tools/inspect_models.py` | all | dump each model's `forward()` schema | helper |

The two sleep models cross-validate (close DEEP/LIGHT/REM/WAKE %); that agreement
also fixes the BDI stage-column order to `[AWAKE, LIGHT, REM, DEEP]`.

## What's blocked, and why (data availability, not wiring)

Of the ~26 newest-version models, most are blocked on a signal we can't get:

- **raw PPG waveform** — `cva_*` and `halite` run on `cva_raw_ppg_data` (0x81) since
  `cva_ppg` was enabled. `cva_2_1_5` is the "cva-from-emb" build: it wants 128-d
  embeddings from an encoder we don't have (halite's PulseNet gives 256-d), so it stays
  unused. Still blocked: `whr` (needs raw PPG + raw accel).
- **raw ACM / stepmotion gait** — `step_counter`, `steps_motion_decoder`,
  `awhr_imputation`, `awhr_profile_selector` (RData-gated; entitlement-locked).
- **bioZ + EDA sensors** — `atlas` (not in our event stream).
- **cloud-computed scores** — `stress_resilience`, `training_stress_score`.
- **cycle / pregnancy inputs** — `popsicle`, `pregnancy_biometrics`.
- **not used, on purpose**:
  - `locomotion_0_0_10` (workout distance/pace): runs without GPS, but on this ring's
    data it reports kilometres for windows where the step counter finds almost no steps;
    its motion / gait column order (inferred from its standardizer) can't be validated
    without a real recorded walk. Workout distance comes from the step counter instead.
  - `awhr_imputation_1_2_0`: fills gaps in *workout* heart rate (continuous workout-HR
    mode); this ring records no such stream and the dashboard draws no workout HR curve.
  - `cumulative_stress_2_0_0`: needs 30–31 days of history plus several Oura-internal
    nightly features (`normalised_iqr`, `norm_temp_wake`, …) whose definitions aren't
    in the model.
  - `whr_2_7_1` (raw PPG + raw accel), `atlas_3_0_0` / `atlas_trendline_1_1_0` (bioZ +
    EDA sensors), `cva_2_1_5` (128-d embeddings), `popsicle` / `pregnancy_biometrics`
    (cycle / pregnancy), `awhr_profile_selector` (internal sampling choice).
  (`cva_calibrator` now runs on the per-day CVA values, `stress_daytime_sensing` on
  measured + imputed daytime HRV.)

Input layouts recovered from each model's TorchScript are documented in the runner's
docstring (`tools/run_*.py`); the wall-clock signal loading they share is
`tools/ring_signals.py`.

(The full per-model matrix lives in the local-only `notes/model-usage-map.md`.)

## Notes
- All runners read `oura.db` by default and reference `notes/models/` (both
  gitignored — no model weights or personal data are committed).
- The models are Oura's proprietary, decrypted artifacts; they are **not** included
  in the repo. You supply your own locally.
