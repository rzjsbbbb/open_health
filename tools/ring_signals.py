"""Wall-clock ring signals shared by the model runners (energy, hi/lo HR, dHRV, halite).

Every series is in unix seconds, dated through the ring's own time anchors
(`epoch_time`), like the summary and the other runners; events whose boot clock
can't be dated belong to no day and are dropped.

* `met`       {unix_minute: MET}            activity_information (0x50), one value per minute
* `motion`    [(unix, [8 cols])]            motion_event (0x47) every 30 s, in the column
                                            order Oura's movement models use: orientation,
                                            motion_seconds, acm x/y/z, regular_motion (not
                                            decoded → 0), low/high-intensity counts
* `temp`      [(unix, °C)]                  temp_event (0x46) skin temperature, first sensor
* `hr`        [(unix, bpm)]                 green_ibi_quality_event (0x80), the beats the
                                            firmware accepted (quality == 1), one mean per packet
* `ibi`       [(unix_ms, ibi_ms, valid)]    the same packets beat by beat, `valid` = quality == 1
* `hrv`       [(unix, rmssd_ms, hr_bpm)]    hrv_event (0x5d) 5-minute averages; the event stamp
                                            marks the packet's LAST average (as nssa_inputs and
                                            the research export place them)
* `bedtimes`  [(start_unix, end_unix)]      bedtime_period (0x76), de-duplicated
"""
import json
import sqlite3
from pathlib import Path

from epoch_time import build_epochs, is_dated, make_unix_s

TAG_MOTION, TAG_TEMP, TAG_MET, TAG_HRV, TAG_BEDTIME, TAG_GREEN = 0x47, 0x46, 0x50, 0x5D, 0x76, 0x80


class Signals:
    def __init__(self, db):
        self.db = Path(db)
        con = sqlite3.connect(str(db))
        self.rows = con.execute(
            "SELECT ring_timestamp, tag, decoded_json, captured_unix FROM events "
            "WHERE decoded_json IS NOT NULL ORDER BY captured_unix, id").fetchall()
        con.close()
        self.epochs = build_epochs(self.rows)
        self._unix = make_unix_s(self.epochs)
        self.met, self.motion, self.temp, self.hr, self.ibi, self.hrv = {}, [], [], [], [], []
        beds = set()
        for ds, tag, payload, captured in self.rows:
            if tag not in (TAG_MOTION, TAG_TEMP, TAG_MET, TAG_HRV, TAG_BEDTIME, TAG_GREEN):
                continue
            if not is_dated(self.epochs, ds, captured):
                continue
            try:
                v = json.loads(payload)
            except ValueError:
                continue
            t = self._unix(ds, captured)
            if tag == TAG_MET and isinstance(v.get("met"), list):
                minute = round(t / 60)
                for i, m in enumerate(v["met"]):
                    self.met[minute + i] = float(m)  # a resent minute keeps one value
            elif tag == TAG_MOTION:
                self.motion.append((t, [
                    float(v.get("orientation", 0)), float(v.get("motion_seconds", 0)),
                    float(v.get("avg_x", 0)), float(v.get("avg_y", 0)), float(v.get("avg_z", 0)),
                    0.0, float(v.get("low_intensity", 0)), float(v.get("high_intensity", 0)),
                ]))
            elif tag == TAG_TEMP and v.get("temps_c"):
                self.temp.append((t, float(v["temps_c"][0])))
            elif tag == TAG_GREEN and v.get("ibi_ms"):
                ibis, quality = v["ibi_ms"], v.get("quality") or []
                good = [ms for ms, q in zip(ibis, quality) if q == 1 and 300 <= ms <= 2000]
                if good:
                    self.hr.append((t, 60000.0 * len(good) / sum(good)))
                # beats end at the packet's time: walk back by the intervals after each
                end_ms = t * 1000.0
                for k in range(len(ibis) - 1, -1, -1):
                    ok = k < len(quality) and quality[k] == 1 and 300 <= ibis[k] <= 2000
                    self.ibi.append((end_ms, float(ibis[k]), 1.0 if ok else 0.0))
                    end_ms -= ibis[k]
            elif tag == TAG_HRV:
                rm, hb = v.get("rmssd_ms") or [], v.get("hr_bpm") or []
                step = 60 * (v.get("interval_min") or 5)
                n = len(rm)
                for k, r in enumerate(rm):
                    h = hb[k] if k < len(hb) else None
                    self.hrv.append((t - (n - 1 - k) * step, float(r) if r and r > 0 else None,
                                     float(h) if h and h > 0 else None))
            elif tag == TAG_BEDTIME:
                s, e = v.get("bedtime_start_ds"), v.get("bedtime_end_ds")
                if s is not None and e is not None and e > s and is_dated(self.epochs, s, captured):
                    beds.add((round(self._unix(s, captured)), round(self._unix(e, captured))))
        for series in (self.motion, self.temp, self.hr, self.ibi, self.hrv):
            series.sort(key=lambda row: row[0])
        self.bedtimes = merge_overlaps(sorted(beds))

    def unix(self, ds, captured):
        return self._unix(ds, captured) if is_dated(self.epochs, ds, captured) else None

    def asleep(self, t):
        return any(s <= t <= e for s, e in self.bedtimes)

    def met_series(self):
        """Sorted [(unix_seconds, MET)] — one value per minute."""
        return [(m * 60.0, v) for m, v in sorted(self.met.items())]

    def stepmotion(self):
        """Decoded gait rows [(unix, [11 cols])] in the AAD/energy column order (needs the decoder)."""
        if not hasattr(self, "_steps"):
            import run_activity_model as aad
            con = sqlite3.connect(str(self.db))
            try:
                rows = aad.decode_stepmotion(con, self._unix, True, self.epochs)
            finally:
                con.close()
            self._steps = [(minute * 60.0, values) for minute, values in rows]
        return self._steps


def merge_overlaps(spans):
    out = []
    for s, e in spans:
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def load_profile(db):
    try:
        return json.loads((Path(db).parent / "profile.json").read_text())
    except (OSError, ValueError):
        return {}


def nightly(sig):
    """Per-bedtime (resting HR = lowest 5-min HR, mean RMSSD) from hrv_event — Oura's
    night definitions. Returns [(bed_end_unix, rhr or None, hrv or None)]."""
    out = []
    for s, e in sig.bedtimes:
        inside = [(r, h) for t, r, h in sig.hrv if s <= t <= e]
        hrs = [h for _, h in inside if h]
        rms = [r for r, _ in inside if r]
        if hrs or rms:
            out.append((e, min(hrs) if hrs else None, sum(rms) / len(rms) if rms else None))
    return out


def mean_sd(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None, None
    m = sum(xs) / len(xs)
    sd = (sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5 if len(xs) > 1 else None
    return m, sd
