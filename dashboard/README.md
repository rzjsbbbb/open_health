# open_health web dashboard

A local, single-page health dashboard that turns your synced ring data into the
few numbers that matter. Follows the product vision in
`notes/dashboard-v2-brainstorm.md`: a calm, baseline-aware view across **sleep,
cardiovascular, blood-oxygen, activity**, and a **Device & Data Health** panel.
Everything is computed and served locally; nothing leaves the machine.

## Run

```bash
oura sync                                    # refresh your data first
oura dashboard --tz-offset 1 --age 30 --sex M --height 1.78 --weight 75
# → open http://127.0.0.1:8090
```

Default port `8090`; loopback-only.

### Keep it current without the Sync button

Run `oura watch` beside the dashboard. It repeats `oura sync` every `--interval`
seconds (default 300), so the ring needn't sit on its charger, and an open dashboard
page reloads by itself within a minute of each pass:

```bash
oura watch                                   # in its own terminal; Ctrl-C to stop
```

It finds the auth key the way `sync` does (`--key-file`, `$OURA_KEY_FILE`, or an
`oura.key` next to the DB). A worn ring is often out of reach — a weak signal, or a
phone holding its single link — so such a pass backs off (`--retry` seconds, doubling
up to `--max-backoff`) and the next good one catches up from the saved cursor; nothing
is lost. A pass that stops responding is abandoned after 10 minutes. `watch` and the
dashboard's Bluetooth buttons share that one link: a button pressed mid-pass connects
once the pass lets go.

## Enable Oura's models on desktop

Without the private model files the dashboard still works — each night falls back to
the built-in **signal estimate** (heart rate, HRV and motion), and the day view says
so. To stage with Oura's own validated model instead:

1. **Place the models.** Put your locally-decrypted desktop `.pt` files (plus the
   sleep classifier) in `notes/models/` at the repo root — the first place the runners
   look. Use the desktop `.pt` / `.bin` files, not the `mobile/*.ptl` (those are for
   iOS). At minimum, for the hypnogram:

   ```
   notes/models/
     sleepstaging_2_6_0.pt
     sleepstaging_2_6_0_classifier.bin   # required — the NSSA stager loads both
   ```

   and, for the other panels, `cva_2_1_0.pt`, `daily_medians_1_1_0.pt`,
   `sleepnet_bdi_0_4_0.pt`, `automatic_activity_detection_3_1_11.pt`,
   `illness_detection_0_5_1.pt`. `notes/models/` is gitignored. Any other layout:
   `export OURA_MODELS_DIR=/absolute/path/to/models` (a sibling
   `../open_oura/notes/models/` is detected automatically).

2. **Create a venv with torch** (torch is *not* in `requirements.txt`):

   ```bash
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt   # bleak + pycryptodome (BLE sync)
   .venv/bin/pip install torch numpy           # torch 2.9 recommended
   ```

   The CLI auto-discovers `./.venv/bin/python` (or `.venv/Scripts/python.exe` on
   Windows); override with `OURA_PYTHON=/absolute/path/to/python`.

3. **Verify** the model is actually running:

   ```bash
   .venv/bin/python tools/run_sleep_model.py oura.db 1 --json
   ```

   A hypnogram with no error means NSSA is live; a complaint names the missing file.
   In the dashboard, a night with no "signal estimate" note is staged by Oura's model.

## In the dashboard

- **Sync button** (header): drains the ring over Bluetooth without leaving the page
  (runs `oura sync` for you, then refreshes). Pass `--name`/`--key-file` so it can
  reach your ring, e.g. `--name "Oura Ring 5" --key-file captures/android/oura-android-auth.key`.
  A sync that stops responding gives up after 10 minutes instead of holding the ring.
- **Battery**: read offline from the ring's stored `battery_level_changed` debug
  events; shown in the header and the Device panel.
- **Your details** (the person icon): edit age / sex / height / weight / ring size.
  The ring can't measure these, so they live in an editable, gitignored
  `profile.json` next to `oura.db` and feed the cardiovascular-age model (the runners
  read it too). `--age/--sex/--height/--weight` only seed it on first run.
- **Activity**: detected sessions (Oura's `automatic_activity_detection`) plotted on a
  per-day actogram over a continuous MET "movement ridge"; tap a session for its time,
  duration, model label, and **estimated active calories** (Σ(MET−1)·weight/60).
- **Advanced & debugging** (collapsed, in the Device panel):
  - **Ring auth key — Export / Import.** *Export* shows the 16-byte key (copy, `.key`
    download, or QR) so you can move it to another device — e.g. set up the native iOS
    app without re-pairing. *Import* takes a pasted hex key, an uploaded `.key`, or a
    scanned QR and writes it to the `--key-file` (`0600`, lowercased, validated as
    32 hex chars). Both need `--key-file` set; the key is only read/written locally.
  - **Capabilities — tap to toggle.** Turn on-ring features (Daytime HR, SpO2, Exercise
    HR, Real steps, Cardio PPG) on/off over Bluetooth (`SetFeatureMode`, auth-gated).
    The on/off state is the **real on-ring mode** snapshotted at the last sync (see
    below), not just "events seen recently".
  - **Event stream**: per-type counts of what the ring is actually recording.

On each sync the CLI snapshots the real on-ring feature modes to a gitignored
`feature_modes.json` next to `oura.db`, so the capability toggles reflect the device's
actual state. It's best-effort — a failed read never fails the sync.

## How it's built

- **Rust does the work** (`crates/oura-cli/src/dashboard.rs`): reads `oura.db`, and
  computes per-night HRV / resting-HR / skin-temp, SpO2 % (Oura's R→% calibration),
  baselines + deltas, per-day movement profile + active calories, the
  device/data-health panel, and the one-line digest. It serves the page plus a small
  JSON API: `GET /api/summary`, `GET /api/data-version` (the cheap change stamp the
  page polls to reload after a background sync), `GET/POST /api/profile` (demographics plus the optional hypertension-risk answers and
  heart-rate alert limits), `GET/POST /api/workouts` (logged workouts in
  `workouts.json`: `{"op":"add", type, start, end, intensity}` / `{"op":"delete", id}`),
  `POST /api/meals` (logged meals in `meals.json`: `{"op":"add", t, tz}` / `{"op":"delete", id}`),
  `POST /api/sync`, `POST /api/feature` (toggle a capability), and
  `GET/POST /api/ring-key`. Mutating
  endpoints require a same-origin `X-Oura-Dash` header (CSRF guard) and the server is
  loopback-only with a Host-header check.
- **The AI models run via the Python runners**, shelled out exactly like
  `oura sessions`: the sleep hypnogram (`run_sleep_model.py`), activity sessions
  (`run_activity_model.py`), and cardiovascular age (`run_cva_model.py`). Each is
  invoked with `--json`. `/api/summary` runs them **concurrently** (sleep scores every
  night in one batched process) and **caches** the result, recomputing only when
  `oura.db` or `profile.json` changes — so the first load pays the cost and refreshes
  are instant.
- **Frontend** (`dashboard/web/`): vanilla HTML/CSS/JS, no build step, no external
  fonts or libraries. Auto light/dark via `prefers-color-scheme` (force one with
  `?` … set `document.documentElement.dataset.theme = 'dark' | 'light'`). The web
  files are read from disk at request time, so you can edit and refresh without
  recompiling (a copy is also embedded in the binary as a fallback).

## Folder

```
dashboard/
  web/                 # the static UI (served by the Rust server)
    index.html
    styles.css
    app.js
  README.md
```

Models are Oura's proprietary IP and are **not** committed; the runners reference
your own locally-decrypted copies under `notes/models/`. After a split checkout,
the sibling `../open_oura/notes/models/` is detected automatically; set
`OURA_MODELS_DIR=/absolute/path/to/models` for any other layout. The sibling
`../open_oura/.venv` is likewise reused when present; override its interpreter
with `OURA_PYTHON=/absolute/path/to/python`.

Icons are from [Phosphor](https://phosphoricons.com) (MIT), vendored under
`dashboard/web/icons/` so the dashboard stays fully offline.
