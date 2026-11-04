// open_oura dashboard — fetch /api/summary (Rust computes it) and render.
//
// SIBLING CLIENT: the native iOS app (apps/ios/OuraApp/OuraApp.swift) renders the SAME
// summary JSON. A user-facing change here usually belongs there too — see the feature
// map in docs/clients-web-and-ios.md. New computed fields go in crates/oura-summary.
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const num = (v, d = "—") => (v == null || Number.isNaN(v) ? d : v);
const icon = (name, cls = "") => `<span class="ic ${cls}" style="--i:url(/icons/${name}.svg)"></span>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = (s) => esc(s).replace(/^./, (c) => c.toUpperCase());
const kfmt = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + "万" : Math.round(n).toLocaleString());

// ── Chinese UI ──────────────────────────────────────────────
// The page's own copy is Chinese. Text that comes from the server (oura-summary is
// shared with the English iOS app) is translated here as it is shown: fixed names by
// lookup, the few templated sentences (digest, clock warnings, sync result, errors) by
// pattern. Anything unrecognised is shown as sent.
const ZH_TERMS = {
  // device panel: insights (with their status and reason), data streams, capabilities
  "Sleep stages": "睡眠分期", "Apnea / breathing": "呼吸暂停 / 呼吸", "Cardiovascular age": "心血管年龄",
  "SpO2": "血氧", "Activity sessions": "活动记录", "HRV / resting HR": "HRV / 静息心率", "Steps": "步数",
  "Stress / resilience": "压力 / 恢复力",
  "needs overnight IBI": "需要夜间心跳间期数据", "enable cva_ppg": "需开启 cva_ppg", "enable spo2": "需开启 spo2",
  "enable real_steps": "需开启 real_steps", "needs cloud scores": "需要云端评分",
  live: "可用", gated: "暂不可用",
  "Blood oxygen": "血氧", "Heart beats": "心跳", "Exercise HR": "运动心率", "Motion": "动作",
  "Skin temp": "皮肤温度", "Cardio PPG": "心血管 PPG",
  "Daytime HR": "日间心率", "Real steps": "实时步数", "Cardio PPG (CVA)": "心血管 PPG(CVA)",
  // sleep-debt level
  high: "偏高", moderate: "中等", low: "较低", none: "无",
};
const zhSpan = (n, unit) => `${n} ${unit === "days" ? "天" : "小时"}`;
const ZH_RULES = [
  // make_digest: "HRV -15%, resting HR -2 bpm. Recovery dipping, take it easy."
  [/resting HR ([+-]?\d+) bpm/, "静息心率 $1 bpm"],
  [/, (?=静息心率)/, ","],
  [/\. Recovering well\.$/, "。恢复良好。"],
  [/\. Recovery dipping, take it easy\.$/, "。恢复有所下降,今天放松一点。"],
  [/^Synced\. Not enough history yet for trends\.$/, "已同步。历史数据还不够,暂时看不出趋势。"],
  // clock warnings (ring_time::UndatedReason::warning_message and build_summary)
  [/^(\d+) nights? \[missing_anchor\] could not be placed in time\b.*$/,
    "有 $1 晚 [missing_anchor] 暂时无法确定时间:戒指这次开机后还没有记录到时间同步或 RTC 时间锚点。趁戒指还没重启时同步一次,就能补上时间。"],
  [/^(\d+) nights? \[missing_anchor\] came from an earlier boot epoch\b.*$/,
    "有 $1 晚 [missing_anchor] 来自戒指的上一次开机,那次开机在记录到任何时间同步或 RTC 时间锚点之前就结束了。现有数据无法恢复,再次同步也无法为之前的开机补上时间。"],
  [/^(\d+) nights? \[accelerated_counter\].*$/,
    "有 $1 晚 [accelerated_counter] 落在两个时间锚点之间、戒指计数器比实际时间走得快的区间里。现有数据无法恢复,再次同步也修复不了历史上的计数器跳变。"],
  [/^(\d+) nights? \[ambiguous_reboot_stall\].*$/,
    "有 $1 晚 [ambiguous_reboot_stall] 落在一段时钟停滞区间内的多次重启之间(实际时间超过了计数器时间)。现有数据无法把丢失的时间分配到各次重启,再次同步也解决不了。"],
  [/^About (\d+) (days|hours) of current-boot ring history \[missing_anchor\].*$/,
    (_, n, u) => `戒指这次开机后约有 ${zhSpan(n, u)}的历史数据 [missing_anchor] 还没有时间锚点,暂时无法放到日历上。趁戒指还没重启时同步一次,就能补上时间。`],
  [/^About (\d+) (days|hours) of earlier-boot ring history \[missing_anchor\].*$/,
    (_, n, u) => `戒指上一次开机期间约有 ${zhSpan(n, u)}的历史数据 [missing_anchor] 是在一次没有时间锚点的重启前记录的。现有数据无法恢复,再次同步也无法为之前的开机补上时间。`],
  // the last line of `oura sync`, shown after the Sync button
  [/^Done: (\d+) events received, (\d+) new rows, next cursor (\d+)\.$/, "同步完成:收到 $1 条事件,新增 $2 条(游标 $3)。"],
  // server errors the page passes through
  [/^dashboard was started without --key-file$/, "仪表盘启动时没有指定 --key-file。"],
  [/^auth key must be exactly 16 bytes of hex$/, "认证密钥必须是 16 字节的十六进制。"],
  [/^Live heart rate stopped or timed out\.$/, "实时心率已停止或超时。"],
  [/^Ring is busy; wait for the current operation to finish\.$/, "戒指正忙,请等当前操作完成。"],
  // short dates the summary formats as "Wed 11-04"
  [/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/, (w) => ({ Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" })[w]],
];
const zh = (s) => {
  if (s == null) return s;
  const t = String(s).replace(/\s+/g, " ").trim();
  if (Object.hasOwn(ZH_TERMS, t)) return ZH_TERMS[t];
  return ZH_RULES.reduce((out, [re, rep]) => out.replace(re, rep), t);
};
// activity labels from Oura's activity model (tools/run_activity_model.py BEHAVIOR)
const ZH_ACT = {
  nothing: "无活动", badminton: "羽毛球", boxing: "拳击", crossCountrySkiing: "越野滑雪",
  crossTraining: "交叉训练", cycling: "骑行", dance: "跳舞", elliptical: "椭圆机",
  strengthTraining: "力量训练", hockey: "曲棍球", pilates: "普拉提", rowing: "划船",
  running: "跑步", swimming: "游泳", walking: "步行", yoga: "瑜伽", golf: "高尔夫",
  tennis: "网球", climbing: "攀岩", downhillSkiing: "高山滑雪", snowboarding: "单板滑雪",
  hiking: "徒步", horsebackRiding: "骑马", volleyball: "排球", basketball: "篮球",
  americanFootball: "美式橄榄球", soccer: "足球", baseball: "棒球", coreExercise: "核心训练",
  cricket: "板球", HIIT: "HIIT", diving: "潜水", fitnessClass: "健身课", floorball: "福乐球",
  gymnastics: "体操", handball: "手球", houseWork: "家务", iceSkating: "滑冰",
  jumpingRope: "跳绳", martialArts: "武术", flexibility: "柔韧训练", mountainBiking: "山地骑行",
  nordicWalking: "北欧式健走", stairExercise: "爬楼梯", stretching: "拉伸", surfing: "冲浪",
  waterFitness: "水中健身", yardwork: "庭院劳动", padel: "板式网球", skateboarding: "滑板",
  other: "其他", nap: "小睡", sleep: "睡眠", pause: "暂停", meditation: "冥想",
  eating: "进食", relax: "放松", transport: "交通出行",
};
const zhAct = (label) => (!label ? "活动" : Object.hasOwn(ZH_ACT, label) ? ZH_ACT[label] : label);

let CURRENT_PROFILE = null;
let CURRENT_TZ = 0; // hours from UTC, as the summary reports it
let LAST_DEVICE_SERIAL = null;
const browserTzOffset = () => {
  const off = -new Date().getTimezoneOffset() / 60;
  return Number.isFinite(off) ? off : 0;
};

// ── local dashboard fetch helpers ──────────────────────────────────────────
// Every mutating endpoint is gated by the X-Oura-Dash header; these centralize it
// (and the JSON POST envelope) so the call sites can't drift. They return the raw
// Response, so each caller keeps its own r.ok / body / error handling.
const DASH_HEADERS = { "X-Oura-Dash": "1" };
function postDash(url, body) {
  const opts = { method: "POST", headers: { ...DASH_HEADERS } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts);
}
function getDash(url) {
  return fetch(url, { headers: { ...DASH_HEADERS } });
}

// Smooth curve THROUGH the points using a monotone cubic Hermite spline
// (Fritsch–Carlson). Monotone = the curve never overshoots past a data point, so it
// won't invent peaks/valleys the data doesn't have — the right call for real metrics.
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return "";
  const x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
  if (n === 2) return `M${x[0].toFixed(1)} ${y[0].toFixed(1)} L${x[1].toFixed(1)} ${y[1].toFixed(1)}`;
  const dx = [], dy = [], dd = []; // secant slopes
  for (let i = 0; i < n - 1; i++) { dx[i] = x[i + 1] - x[i]; dy[i] = y[i + 1] - y[i]; dd[i] = dy[i] / dx[i]; }
  const m = new Array(n);
  m[0] = dd[0];
  m[n - 1] = dd[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = dd[i - 1] * dd[i] <= 0 ? 0 : (dd[i - 1] + dd[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (dd[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / dd[i], b = m[i + 1] / dd[i], s2 = a * a + b * b;
    if (s2 > 9) { const t = 3 / Math.sqrt(s2); m[i] = t * a * dd[i]; m[i + 1] = t * b * dd[i]; }
  }
  let d = `M${x[0].toFixed(1)} ${y[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(x[i] + h).toFixed(1)} ${(y[i] + m[i] * h).toFixed(1)} ` +
         `${(x[i + 1] - h).toFixed(1)} ${(y[i + 1] - m[i + 1] * h).toFixed(1)} ` +
         `${x[i + 1].toFixed(1)} ${y[i + 1].toFixed(1)}`;
  }
  return d;
}

// monochrome, thin, with a faint area fill — subtle and elegant
function sparkline(series) {
  const s = (series || []).filter((x) => x != null);
  if (s.length < 2) return "";
  const w = 100, h = 26, min = Math.min(...s), max = Math.max(...s);
  const rng = max - min || 1;
  const pts = s.map((v, i) => [(i / (s.length - 1)) * w, h - ((v - min) / rng) * (h - 5) - 3]);
  const d = smoothPath(pts);
  const area = `${d} L${w.toFixed(1)} ${h} L0 ${h} Z`;
  const last = pts[pts.length - 1];
  // the SVG is stretched non-uniformly (preserveAspectRatio=none), which would
  // squash an in-SVG <circle> into an ellipse — so the end dot is a separate,
  // unstretched element positioned at the last point (vertical axis is 1:1 with px).
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${area}" fill="var(--spark-fill)" stroke="none"/>
    <path d="${d}" fill="none" stroke="var(--spark)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg><i class="spark-dot" style="top:${last[1].toFixed(1)}px"></i>`;
}

// a status pill (colored dot + label); kind ∈ ok | warn | neutral
function pill(label, kind) {
  const p = el("span", "pill " + kind);
  p.append(el("i"), document.createTextNode(label));
  return p;
}

// Normal / attention status from a delta% and which direction is healthy.
function statusFor(deltaPct, good) {
  if (deltaPct == null) return null;
  if (Math.abs(deltaPct) <= 5) return { label: "正常", kind: "ok" };
  const improving = good === "up" ? deltaPct > 0 : deltaPct < 0;
  if (improving) return { label: good === "up" ? "偏高" : "偏低", kind: "ok" };
  return { label: good === "up" ? "偏低" : "升高", kind: "warn" };
}

// baseline comparison bar: current value as a fill, the reference (personal baseline
// or target) as a marker, on a shared 0…(max×1.3) scale — the "your result vs
// reference" pattern from clinical dashboards.
function cmpBar(value, ref, unit, refLabel = "基线") {
  const hi = Math.max(value, ref) * 1.3 || 1;
  const wrap = el("div", "cmp");
  const track = el("div", "cmp-track");
  const fill = el("i", "cmp-fill");
  fill.style.width = Math.max(3, Math.min(100, (value / hi) * 100)) + "%";
  const mark = el("span", "cmp-mark");
  mark.style.left = Math.min(100, (ref / hi) * 100) + "%";
  track.append(fill, mark);
  const dRaw = Math.round((value - ref) * 10) / 10;
  const cap = el("div", "cmp-cap");
  cap.innerHTML = `${refLabel} <b>${num(Math.round(ref * 10) / 10)}</b>${unit} · ${dRaw >= 0 ? "+" : ""}${dRaw}${unit}`;
  wrap.append(track, cap);
  return wrap;
}

function metricCard(label, value, unit, opts = {}) {
  const { deltaPct, ref, refLabel, good = "up", status, sub } = opts;
  const t = el("article", "tile");
  const head = el("div", "tile-head");
  head.append(el("div", "label", label));
  const st = status !== undefined ? status : statusFor(deltaPct, good);
  if (st) head.append(pill(st.label, st.kind));
  t.append(head);
  t.append(el("div", "value", `${num(value)}<span class="unit">${unit || ""}</span>`));
  if (typeof value === "number" && ref != null) t.append(cmpBar(value, ref, unit || "", refLabel));
  else if (sub) t.append(el("div", "sub", sub));
  return t;
}

const relAge = (diff) => {
  const a = Math.abs(Math.round(diff * 10) / 10);
  if (diff < -0.05) return { short: `年轻 ${a} 岁`, long: `比实际年龄年轻 ${a} 岁` };
  if (diff > 0.05) return { short: `大 ${a} 岁`, long: `比实际年龄大 ${a} 岁` };
  return { short: "相当", long: "与实际年龄相当" };
};

function renderTiles(d) {
  const box = $("tiles");
  box.innerHTML = "";
  box.classList.add("reveal");
  const hv = d.vitals?.hrv || {}, rh = d.vitals?.rhr || {};
  const n0 = (d.nights || [])[0] || {};
  box.append(metricCard("HRV (RMSSD)", hv.latest, " ms", { deltaPct: hv.delta_pct, ref: hv.baseline, good: "up" }));
  box.append(metricCard("静息心率", rh.latest, " bpm", { deltaPct: rh.delta_pct, ref: rh.baseline, good: "down" }));
  const eff = n0.efficiency;
  box.append(metricCard("睡眠效率", eff, "%", {
    ref: 85, refLabel: "目标", good: "up",
    status: eff == null ? null : eff >= 85 ? { label: "正常", kind: "ok" } : eff >= 75 ? { label: "一般", kind: "neutral" } : { label: "偏低", kind: "warn" },
  }));
  const cv = d.cardio;
  if (cv && cv.vascular_age != null) {
    const diff = cv.vascular_age - cv.chronological_age;
    box.append(metricCard("血管年龄", cv.vascular_age, " 岁", {
      ref: cv.chronological_age, refLabel: "实际年龄", good: "down",
      status: diff < -0.5 ? { label: "更年轻", kind: "ok" } : diff > 0.5 ? { label: "偏大", kind: "warn" } : { label: "相当", kind: "neutral" },
    }));
  } else {
    box.append(metricCard("血管年龄", "—", "", { sub: cvaMissing(d).short }));
  }
}

function hypnogram(stages) {
  const wrap = el("div", "hyp");
  (stages || []).forEach((s) => wrap.append(el("i", "s" + s)));
  return wrap;
}

// ── the unified "day" (night + activity of the same date) ──────────────────
// A day is keyed by YYYY-MM-DD. The most recent one is the hero card; the rest
// live behind "Show all N days". This mirrors the iOS app's home + AllDaysView.

// The calendar date you WOKE from a night. Nights are labelled by onset date (the
// evening you went to bed), so an overnight sleep that crosses midnight belongs to
// the next day's "morning". Pairing a day with the sleep you woke from — not the
// sleep you started that evening — is what makes "night + activity of the day" read
// as one coherent day. Kept identical to the iOS Summary.wakeYmd.
function wakeYmd(n) {
  if (!n || !n.ymd) return null;
  if (n.wake_ymd) return n.wake_ymd;
  if (n.start && n.end && n.end < n.start) {
    const [y, m, dd] = n.ymd.split("-").map(Number);
    const t = new Date(y, m - 1, dd + 1);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }
  return n.ymd;
}

// every date that has a night (by wake date), a movement profile, daily totals, or a
// session — newest first
function dayKeys(d) {
  const set = new Set();
  (d.nights || []).forEach((n) => { const w = wakeYmd(n); if (w) set.add(w); });
  Object.keys(d.activity_profile || {}).forEach((k) => set.add(k));
  Object.keys(d.activity_daily || {}).forEach((k) => set.add(k));
  (d.activity || []).forEach((s) => { const y = (s.start || "").split(" ")[0]; if (y) set.add(y); });
  return [...set].filter(Boolean).sort().reverse();
}

// the primary sleep you woke from on the morning of `ymd` — the longest in-bed night
// wins over same-morning naps. Falls back to a MM-DD match for older data lacking ymd.
function nightForDay(d, ymd) {
  const cands = (d.nights || []).filter((n) => wakeYmd(n) === ymd);
  if (cands.length) return cands.reduce((a, b) => ((b.in_bed_h || 0) > (a.in_bed_h || 0) ? b : a));
  return (d.nights || []).find((n) => n.ymd == null && (n.date || "").endsWith(ymd.slice(5))) || null;
}

// this day's sessions, start rewritten to minutes-past-midnight so openActDetail()
// (which formats s.start with hhmm()) renders them correctly.
function sessionsForDay(d, ymd) {
  return (d.activity || [])
    .filter((s) => (s.start || "").startsWith(ymd))
    .map((s) => {
      const [h, m] = ((s.start || "").split(" ")[1] || "0:0").split(":").map(Number);
      return { ...s, start: (h || 0) * 60 + (m || 0) };
    })
    .sort((a, b) => a.start - b.start);
}

const dayTitle = (ymd) => {
  const p = (ymd || "").split("-");
  if (p.length !== 3) return ymd;
  const dt = new Date(+p[0], +p[1] - 1, +p[2]);
  return `${WD[dt.getDay()]} · ${fmtDay(ymd)}`;
};

// continuous movement ridge (96 × 15-min MET buckets) as a filled SVG area
const RIDGE_H = 30;
function ridgeSvg(profile) {
  const prof = (profile || []).map((v) => v || 0);
  if (prof.length < 2) return "";
  const peak = Math.max(0.5, ...prof);
  const pts = prof.map((v, i) => [(i / (prof.length - 1)) * 100, RIDGE_H - Math.min(1, v / peak) * RIDGE_H]);
  const d = `${smoothPath(pts)} L100 ${RIDGE_H} L0 ${RIDGE_H} Z`;
  return `<svg class="day-ridge" viewBox="0 0 100 ${RIDGE_H}" preserveAspectRatio="none"><path d="${d}"/></svg>`;
}

// the combined day card: a clickable Sleep region (→ sleep detail) above a clickable
// Activity region (→ activity detail). Used as the hero on the home panel.
function dayCard(d, ymd) {
  const card = el("div", "day-card");
  card.append(el("div", "day-date", dayTitle(ymd)));

  const n = nightForDay(d, ymd);
  if (n) {
    const sp = el("button", "day-part");
    sp.type = "button";
    sp.append(el("div", "dp-head",
      `<span class="dp-tag">睡眠</span><span class="dp-meta">${esc(n.start || "—")}–${esc(n.end || "—")} · ${num(n.in_bed_h)} 小时</span><span class="dp-chev"></span>`));
    if (n.stages && n.stages.length) sp.append(hypnogram(n.stages));
    const comp = el("div", "breakdown");
    const seg = (l, v) => `<span>${l} <b>${num(v)}%</b></span>`;
    comp.innerHTML = seg("深睡", n.deep_pct) + seg("浅睡", n.light_pct) + seg("REM", n.rem_pct) + seg("清醒", n.wake_pct);
    sp.append(comp);
    sp.addEventListener("click", () => openDayPage(d, ymd, "sleep"));
    card.append(sp);
  }

  const ap = el("button", "day-part");
  ap.type = "button";
  const ds = (d.activity_daily || {})[ymd];
  const stat = ds ? `${kfmt(ds.steps)} 步 · ${Math.round(ds.active_kcal)} 千卡` : "暂无活动汇总";
  ap.append(el("div", "dp-head",
    `<span class="dp-tag">活动</span><span class="dp-meta">${stat}</span><span class="dp-chev"></span>`));
  const prof = (d.activity_profile || {})[ymd];
  if (prof && prof.length > 1) ap.insertAdjacentHTML("beforeend", ridgeSvg(prof));
  const sessions = sessionsForDay(d, ymd);
  if (sessions.length) {
    const chips = el("div", "day-sessions");
    sessions.forEach((s) => {
      const chip = el("span", "day-chip" + (s.is_workout >= 0.5 ? " workout" : ""));
      const ico = el("span", "ic");
      ico.style.setProperty("--i", `url(/icons/${actIcon(s.label)}.svg)`);
      const nm = el("span", "day-chip-name");
      nm.textContent = zhAct(s.label);
      chip.append(ico, nm);
      chips.append(chip);
    });
    ap.append(chips);
  }
  ap.addEventListener("click", () => openDayPage(d, ymd, "activity"));
  card.append(ap);

  // heart rate: the tab's 15-minute bars as a strip on the same 24 h as the ridge above
  const hp = el("button", "day-part");
  hp.type = "button";
  hp.append(el("div", "dp-head",
    `<span class="dp-tag">心率</span><span class="dp-meta">加载中…</span><span class="dp-chev"></span>`));
  const strip = el("div", "day-hr");
  hp.append(strip);
  hp.addEventListener("click", () => openDayPage(d, ymd, "heart"));
  card.append(hp);
  fillDayHr(ymd, hp.querySelector(".dp-meta"), strip);
  return card;
}

// The summary doesn't carry per-slot heart rate, so the "Your day" strip fetches it
// on its own and fills in when it arrives.
let HR_QUARTER_LOAD = null;
function fillDayHr(ymd, meta, strip) {
  const request = HR_QUARTER_LOAD ||= fetch(`/api/hourly-hr?minutes=15&tz=${browserTzOffset()}`).then((r) => r.json());
  request
    .then((j) => {
      if (j.error) throw new Error(j.error);
      const { bySlot, rows } = hrDaySlots(j, ymd);
      if (!rows.length) { meta.textContent = "暂无读数"; return; }
      const r0 = Math.round;
      const low = Math.min(...rows.map((r) => r.low)), high = Math.max(...rows.map((r) => r.high));
      const latest = hrLatestOn(j, ymd);
      meta.textContent = (latest != null ? `最新 ${r0(latest)} bpm · ` : "") + `${r0(low)}–${r0(high)} bpm`;
      strip.innerHTML =
        `<div class="day-hr-plot">${hrBinsSvg(bySlot, Math.max(0, low - 5), high + 5, 1000, 44, false)}</div>` +
        `<div class="met-axis">${[0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24 * 100).toFixed(1)}%">${String(h).padStart(2, "0")}</span>`).join("")}</div>`;
    })
    .catch(() => { meta.textContent = "加载失败"; });
}

function renderDay(d) {
  const box = $("day");
  box.innerHTML = "";
  const days = dayKeys(d);
  // Nights the shared brain withheld because the ring clock could not be resolved
  // unambiguously (missing anchor, accelerated counter, or multi-reboot stall).
  const clockWarnings = d.clock?.warnings || [];
  const unanchored = (d.clock?.epochs || []).some((e) => !e.anchors);
  const canSyncFix = unanchored || (d.clock?.undated_nights || []).some((n) => n.recoverable);
  const clockNote = () => {
    if (!clockWarnings.length && !unanchored) return null;
    const note = el("div", "clock-note");
    note.append(el("div", "clock-note-title", "戒指时钟"));
    for (const w of clockWarnings) note.append(el("p", null, esc(zh(w))));
    if (unanchored && !clockWarnings.length) {
      note.append(el("p", null, "戒指的部分历史数据还没有时间锚点,暂时无法放到日历上。"));
      note.append(el("p", "clock-note-fix", "趁戒指还没重启时运行一次 <code>oura sync</code>,就能补上时间。"));
    }
    return note;
  };
  if (!days.length) {
    box.append(el("div", "error", canSyncFix
      ? "还没有能确定日期的数据:这段数据的戒指时钟还没有锚定。"
      : clockWarnings.length
        ? "还没有能确定日期的数据:记录到的夜晚无法准确确定日期。"
        : "还没有数据。戴上戒指并同步。"));
    const note = clockNote();
    if (note) box.append(note);
    $("sleep-legend").hidden = true;
    return;
  }
  const top = days[0];
  $("sleep-legend").hidden = !(nightForDay(d, top) || {}).stages;
  box.append(dayCard(d, top));
  if (days.length > 1) {
    const btn = el("button", "more-toggle");
    btn.textContent = `查看全部 ${days.length} 天`;
    btn.addEventListener("click", () => openDaysBrowser(d, days));
    box.append(btn);
  }
  const note = clockNote();
  if (note) box.append(note);
}

const debtDuration = (minutes) => {
  const m = Math.max(0, Math.round(minutes || 0));
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
};
const debtStateCopy = (state) => ({
  high: "你目前的睡眠债偏高。接下来几晚请规律作息,保证睡够。",
  moderate: "你积累了中等程度的睡眠债。多睡几个长觉有助于恢复。",
  low: "你基本满足了睡眠需求,只剩少量需要补回。",
  none: "过去两周你一直睡够了。",
}[state] || "过去两周你一直睡够了。");

function sleepDebtSvg(sd, mode) {
  const values = (sd.days || []).map((x) => mode === "debt" ? x.cumulative_debt_min : x.total_sleep_min);
  const w = 900, h = 190, max = mode === "debt" ? 600 : Math.max(720, ...values.filter((x) => x != null));
  const x = (i) => i / Math.max(1, values.length - 1) * w;
  const y = (v) => h - Math.min(1, Math.max(0, v / max)) * h;
  let path = "", started = false;
  values.forEach((v, i) => {
    if (v == null) { started = false; return; }
    path += `${started ? " L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; started = true;
  });
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" y1="${h * (1-f)}" x2="${w}" y2="${h * (1-f)}"/>`).join("");
  const need = mode === "sleep" ? `<line class="sd-need" x1="0" y1="${y(sd.need_h * 60)}" x2="${w}" y2="${y(sd.need_h * 60)}"/>` : "";
  return `<svg class="sd-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><g class="sd-grid">${grid}</g>${need}<path class="sd-line" d="${path}"/></svg>`;
}

function openSleepDebt(sd) {
  let dlg = $("sleep-debt-dialog");
  if (!dlg) {
    dlg = el("dialog", "dialog sleep-debt-dialog"); dlg.id = "sleep-debt-dialog";
    document.body.append(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
  const valid = sd.valid;
  dlg.innerHTML = `<form method="dialog">
    <div class="sd-detail-head"><div><h3>睡眠债</h3><div class="dialog-sub">过去 ${sd.window_days || 14} 天</div></div><button class="dd-close" aria-label="关闭">×</button></div>
    ${valid ? `<div class="sd-value">${debtDuration(sd.debt_min)} <span>${esc(zh(sd.state))}</span></div><p class="sd-copy">${debtStateCopy(sd.state)}</p>`
      : `<div class="sd-value small">数据还不够</div><p class="sd-copy">过去两周内有 ${sd.valid_days || 0} 天睡眠数据,至少需要 5 天。</p>`}
    <div class="sd-tabs"><button type="button" data-mode="debt" class="active">累计睡眠债</button><button type="button" data-mode="sleep">总睡眠</button></div>
    <div class="sd-graph">${sleepDebtSvg(sd, "debt")}</div>
    <div class="sd-axis"><span>${esc((sd.days?.[0]?.date || "").slice(5))}</span><span>${esc((sd.days?.at(-1)?.date || "").slice(5))}</span></div>
    <p class="subhead">计算方式</p><p class="sd-copy">睡眠债估算的是过去 14 天少睡的时间。总睡眠包括主睡眠和小睡,越近的日子权重越高;你的睡眠需求(${debtDuration(sd.need_h * 60)})根据你过去 3 个月的典型睡眠个性化计算,并排除异常短或异常长的日子。</p>
  </form>`;
  dlg.querySelectorAll(".sd-tabs button").forEach((button) => button.addEventListener("click", () => {
    dlg.querySelectorAll(".sd-tabs button").forEach((b) => b.classList.toggle("active", b === button));
    dlg.querySelector(".sd-graph").innerHTML = sleepDebtSvg(sd, button.dataset.mode);
  }));
  dlg.showModal();
}

function renderSleepDebt(d) {
  const box = $("sleep-debt"), sd = d.sleep_debt;
  box.innerHTML = "";
  if (!sd) { box.append(el("div", "error", "还没有睡眠数据。")); return; }
  const button = el("button", "sd-card"); button.type = "button";
  if (sd.valid) button.innerHTML = `<div class="sd-card-value">${debtDuration(sd.debt_min)} <span>${esc(zh(sd.state))}</span></div><p>${debtStateCopy(sd.state)}</p><span class="sd-period">过去 ${sd.window_days || 14} 天 · 查看详情 →</span>`;
  else button.innerHTML = `<div class="sd-card-value pending">已有 ${sd.valid_days || 0} / 5 天</div><p>需要过去两周内至少 5 天的睡眠数据。</p><span class="sd-period">查看详情 →</span>`;
  button.addEventListener("click", () => openSleepDebt(sd)); box.append(button);
}

// Symptom Radar: Oura's on-device illness-detection model. Traffic-light state from the
// calibrated decision + the biomarkers (breath / lowest HR / HRV / temp) that deviate
// from your personal baseline. See docs/algorithms/illness-detection.md.
const ILLNESS_COPY = {
  NO_SIGNS: "没有生病的迹象。你的各项生理指标都在正常范围内。",
  MINOR_SIGNS: "有轻微迹象。少数指标超出了你的平常范围,今天可以放轻松一点。",
  MAJOR_SIGNS: "有明显迹象。多项指标升高,你的身体可能正在对抗某种疾病。",
};
const ILLNESS_LIGHT = { NO_SIGNS: "ok", MINOR_SIGNS: "warn", MAJOR_SIGNS: "alert" };
const BIOMARKER_LABEL = {
  AverageBreath: "呼吸频率", LowestHeartRate: "最低心率",
  AverageHrv: "HRV", TemperatureDeviation: "体温",
};
const BIOMARKER_UNIT = {
  AverageBreath: " 次/分", LowestHeartRate: " bpm", AverageHrv: " ms", TemperatureDeviation: "°C",
};

const cvaMissing = (d) => {
  const gated = (d.device?.insights || []).find((i) => i.name === "Cardiovascular age")?.status === "gated";
  return gated
    ? { short: "需开启 cva_ppg", long: "心血管年龄需要开启 cva_ppg 功能。开启后戴着戒指过夜并同步。" }
    : { short: "需要 CVA 模型", long: "心血管年龄需要 CVA 模型运行环境(Python + tools/run_cva_model.py);戒指的 PPG 数据已经有了。" };
};

function renderIllness(d) {
  const box = $("illness");
  box.innerHTML = "";
  // Oura's model when the Python runner produced it, otherwise the shared core's
  // model-free radar (same choice as the iOS app's `symptomRadar`).
  const fromModel = !!d.illness?.available;
  const ill = fromModel ? d.illness : (d.symptoms || d.illness);
  if (!ill) { box.append(el("div", "error", "症状雷达需要几晚的睡眠数据。")); return; }
  // The runner emits snake_case, the core camelCase.
  const trafficLight = ill.traffic_light ?? ill.trafficLight;
  const daysWithData = ill.days_with_data ?? ill.daysWithData;
  if (!ill.available) {
    const why = ill.status === "MISSING_LAST_NIGHT_SLEEP" ? "缺少昨晚的睡眠数据,请戴着戒指过夜并同步。"
      : ill.status === "MISSING_SLEEP_DATA" ? (fromModel || d.illness
        ? "最近缺失的夜晚太多(过去 14 晚里至少需要 7 晚)。"
        : "至少需要 7 晚睡眠数据来学习你的基线。")
      : "历史数据还不够。";
    box.append(el("div", "error", why));
    return;
  }
  const light = ILLNESS_LIGHT[trafficLight] || "ok";
  const head = el("div", `il-status il-${light}`);
  const label = { NO_SIGNS: "无迹象", MINOR_SIGNS: "轻微迹象", MAJOR_SIGNS: "明显迹象" }[trafficLight] || "暂无结果";
  head.innerHTML = `<span class="il-dot"></span><span class="il-label">${label}</span>`;
  box.append(head);
  const flagged = (ill.biomarkers || []).filter((b) => b.indicatesSymptoms);
  // The decision is the model's overall score, not a count of flags: a night can have
  // biometrics out of range and still not add up to strain.
  const copy = ill.status === "NO_SIGNS" && flagged.length
    ? `没有生病的迹象。有 ${flagged.length} 项指标超出了你的平常范围,但综合来看并不符合身体在对抗疾病的模式。`
    : ILLNESS_COPY[ill.status] || "";
  box.append(el("p", "il-copy", copy));

  if (flagged.length) {
    const list = el("div", "il-biomarkers");
    for (const b of flagged) {
      const dir = b.reason === "ELEVATED" ? "↑ 偏高" : "↓ 偏低";
      const unit = BIOMARKER_UNIT[b.type] || "";
      list.append(el("div", `il-bm il-${b.reason === "ELEVATED" ? "up" : "down"}`,
        `<span class="il-bm-name">${BIOMARKER_LABEL[b.type] || b.type}</span>` +
        `<span class="il-bm-val">${b.value}${unit} <em>${dir}</em></span>`));
    }
    box.append(list);
  }
  const basis = fromModel ? `本地疾病模型 · ${daysWithData}/30 天` : `与你自己的基线对比 · ${daysWithData} 晚`;
  box.append(el("div", "il-foot", `${basis} · ${esc(ill.date)}`));
}

function renderCardio(d) {
  const box = $("cardio");
  const cv = d.cardio;
  const vo2 = d.fitness?.vo2max;
  box.innerHTML = "";
  // VO₂max is model-free (from demographics), so it shows even without the CVA model.
  const vo2Kv = vo2 != null ? el("div", "kv", `<div class="k">最大摄氧量(VO₂max)估算</div><div class="v">${vo2} ml/kg/min</div>`) : null;
  if (!cv || cv.vascular_age == null) {
    box.append(el("div", "error", cvaMissing(d).long));
    if (vo2Kv) { const kvs = el("div", "kvs"); kvs.append(vo2Kv); box.append(kvs); }
    return;
  }
  box.append(el("div", "big-metric", `<span class="n">${cv.vascular_age}</span><span class="u">岁 · 血管年龄</span>`));
  box.append(el("div", "sub", `${relAge(cv.vascular_age - cv.chronological_age).long}(实际年龄 ${cv.chronological_age} 岁)`));
  const kvs = el("div", "kvs");
  kvs.append(el("div", "kv", `<div class="k">脉搏波速度</div><div class="v">${cv.pwv_ms != null ? cv.pwv_ms + " m/s" : "—"}</div>`));
  kvs.append(el("div", "kv", `<div class="k">分析片段数</div><div class="v">${num(cv.segments)}</div>`));
  if (vo2Kv) kvs.append(vo2Kv);
  box.append(kvs);
}

function renderSpo2(d) {
  const box = $("spo2");
  box.innerHTML = "";
  const n0 = (d.nights || []).find((n) => n.spo2_mean != null);
  if (!n0) {
    box.append(el("div", "error", "血氧需要在夜间开启 spo2 功能。"));
    return;
  }
  // SpO2 gauge scale: clamp the reading into [SPO2_MIN, 100] and map to 0–100% fill.
  const SPO2_MIN = 85, SPO2_HEALTHY = 95;
  box.append(el("div", "big-metric", `<span class="n">${n0.spo2_mean}</span><span class="u">% 昨晚平均</span>`));
  box.append(el("div", "sub", "由戒指的 R 比值换算(使用 Oura 自己的校准曲线)。"));
  const pct = Math.max(0, Math.min(100, ((n0.spo2_mean - SPO2_MIN) / (100 - SPO2_MIN)) * 100));
  const g = el("div", "gauge");
  const fill = el("i");
  fill.style.width = pct + "%";
  g.append(fill);
  box.append(g);
  box.append(el("div", "scale", `<span>${SPO2_MIN}</span><span>健康 ≥ ${SPO2_HEALTHY}</span><span>100</span>`));
}

const fmtDay = (ymd) => {
  const p = (ymd || "").split("-");
  return p.length === 3 ? `${+p[1]}月${+p[2]}日` : ymd;
};

const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const hhmm = (min) => `${String((min / 60) | 0).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// activity type → vendored glyph (keyword-matched so the ~40 AAD labels resolve to one
// of the clean vendored icons; unknowns fall back to a generic activity mark).
const ACT_ICON = [
  [/run/, "act-running"],
  [/walk|hik|nordic/, "act-walking"],
  [/cycl|bik/, "act-cycling"],
  [/swim|dive/, "act-swimming"],
  [/yoga|pilates|stretch|meditat/, "act-yoga"],
  [/strength|core|cross ?train|hiit|interval|fitness|elliptical|row|box|martial|climb/, "act-strength"],
];
const actIcon = (label) => {
  const l = (label || "").toLowerCase();
  for (const [re, icon] of ACT_ICON) if (re.test(l)) return icon;
  return "act-default";
};

// session detail popover (opened from a day's session row)
function openActDetail(s) {
  let dlg = $("act-dialog");
  if (!dlg) {
    dlg = el("dialog", "dialog act-dialog");
    dlg.id = "act-dialog";
    document.body.append(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
  const work = s.is_workout >= 0.5;
  const conf = s.label_confidence != null ? Math.round(s.label_confidence * 100) + "%" : "—";
  const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const top3 = (s.top3 || [])
    .map(([n, p]) => `<div class="t3"><span class="t3n">${cap(zhAct(n))}</span><span class="t3bar"><i style="width:${Math.round(p * 100)}%"></i></span><span class="t3p">${Math.round(p * 100)}%</span></div>`)
    .join("");
  dlg.innerHTML =
    `<form method="dialog">
      <div class="ad-head">
        <span class="ic" style="--i:url(/icons/${actIcon(s.label)}.svg)"></span>
        <h3>${cap(zhAct(s.label))}</h3>
        ${work ? '<span class="ad-tag">锻炼</span>' : ""}
      </div>
      <div class="ad-grid">
        ${kv("时间", `${hhmm(s.start)}–${s.end}`)}
        ${kv("时长", `${s.duration_min} 分钟`)}
        ${s.active_kcal != null ? kv("活动消耗", `${Math.round(s.active_kcal).toLocaleString()} 千卡`) : ""}
        ${kv("置信度", conf)}
        ${kv("锻炼", work ? "是" : "否")}
      </div>
      <p class="subhead">模型的猜测</p>
      <div class="t3list">${top3 || '<div class="ad-muted">没有其他候选</div>'}</div>
      <p class="ad-foot">由 Oura 的 automatic_activity_detection 模型根据 MET、动作、心率和体温做出的最佳猜测。</p>
      <div class="dialog-actions"><button class="btn-primary">关闭</button></div>
    </form>`;
  dlg.showModal();
}

// ── full-page sleep & activity reports ─────────────────────────────────────
// Detail opens as a full page (not a modal): a scientific report with a stacked
// polysomnograph (hypnogram + aligned signal lanes sharing one night-time axis and a
// hover crosshair), clinical metrics, and interpretation. Activity gets its own page.

const STAGE = {
  1: { name: "深睡", cls: "deep", lvl: 3 },
  2: { name: "浅睡", cls: "light", lvl: 2 },
  3: { name: "REM", cls: "rem", lvl: 1 },
  4: { name: "清醒", cls: "wake", lvl: 0 },
};
const parseHM = (s) => { const [h, m] = (s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
// the night's clock window unwrapped across midnight (end can exceed 1440)
function nightWin(n) {
  let a = parseHM(n.start), b = parseHM(n.end);
  if (b <= a) b += 1440;
  return { a, b, span: Math.max(1, b - a) };
}
const clockAt = (win, f) => {
  const t = Math.round(win.a + f * win.span) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// full-page overlay control
function showPage(node) {
  const p = $("page");
  p.replaceChildren(node);
  p.hidden = false;
  p.scrollTop = 0;
  document.body.classList.add("page-open");
}
function closePage() {
  const p = $("page");
  p.hidden = true;
  p.replaceChildren();
  document.body.classList.remove("page-open");
  DAY_NAV = null;
}
let DAY_NAV = null; // the open day page's ← / → targets
document.addEventListener("keydown", (e) => {
  if ($("page").hidden) return;
  if (e.key === "Escape") closePage();
  else if (DAY_NAV && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const go = e.key === "ArrowLeft" ? DAY_NAV.older : e.key === "ArrowRight" ? DAY_NAV.newer : null;
    if (go) { e.preventDefault(); go(); }
  }
});

// ── day page: one scrolling page — Sleep, Activity, Heart rate — on one time axis ─
// Every chart plots against the same axis (dayAxis) and shares one cursor (dayCursor),
// so a vertical line marks the same moment in all of them. `focus` ("sleep" |
// "activity" | "heart") scrolls to that section on open.
function openDayPage(d, ymd, focus = null, keepScroll = false) {
  const wrap = el("div", "rpt");
  const head = el("div", "rpt-head");
  const back = el("button", "rpt-back", "‹ 返回");
  back.type = "button";
  back.addEventListener("click", closePage);
  const axis = dayAxis(d, ymd);
  const exp = el("button", "rpt-back rpt-export", "导出 JSON");
  exp.type = "button";
  exp.title = "把这一天的睡眠、活动和心率数据下载为 JSON";
  exp.addEventListener("click", () => exportDayJson(d, ymd, axis));
  // ‹ › step through the days that have data (dayKeys, newest first) at the same
  // scroll position — so one chart can be compared across days
  const days = dayKeys(d);
  const older = days.find((k) => k < ymd) || null;
  const newer = days.slice().reverse().find((k) => k > ymd) || null;
  const go = (k) => openDayPage(d, k, null, true);
  const step = (k, label, name, key) => {
    const b = el("button", "rpt-day", label);
    b.type = "button";
    b.title = k ? `${name}:${dayTitle(k)}(${key})` : `没有${name === "前一天" ? "更早" : "更晚"}的一天`;
    b.setAttribute("aria-label", b.title);
    if (k) b.addEventListener("click", () => go(k));
    else b.disabled = true;
    return b;
  };
  const when = el("div", "rpt-when");
  when.append(step(older, "‹", "前一天", "←"), el("div", "rpt-title", dayTitle(ymd)), step(newer, "›", "后一天", "→"));
  head.append(back, when, exp);
  const cursor = dayCursor(axis);
  const body = el("div", "rpt-body");
  body.append(sleepSection(d, ymd, axis, cursor), activitySection(d, ymd, axis, cursor), heartSection(ymd, axis, cursor));
  wrap.append(head, body);
  const top = $("page").scrollTop;
  showPage(wrap);
  if (keepScroll) $("page").scrollTop = top;
  else if (focus) wrap.querySelector(`#sec-${focus}`)?.scrollIntoView({ block: "start" });
  DAY_NAV = { older: older && (() => go(older)), newer: newer && (() => go(newer)) };
}

// The day page's shared time axis, in unix seconds: from the start of this day's night
// (floored to the hour) when it began the evening before, else local midnight, to the
// midnight that ends the day. `frac` maps a time onto it and `at` maps back.
function dayAxis(d, ymd) {
  const tz = d.tz || 0;
  const [y, mo, dd] = ymd.split("-").map(Number);
  const dayStart = Date.UTC(y, mo - 1, dd) / 1000 - tz * 3600;
  const n = nightForDay(d, ymd);
  const t0 = n && n.start_unix != null && n.start_unix < dayStart ? Math.floor(n.start_unix / 3600) * 3600 : dayStart;
  const t1 = dayStart + 86400;
  const pad = (v) => String(v).padStart(2, "0");
  return {
    t0, t1, dayStart,
    frac: (t) => (t - t0) / (t1 - t0),
    at: (f) => t0 + f * (t1 - t0),
    clock: (t) => {
      const s = (((Math.floor(t) + tz * 3600) % 86400) + 86400) % 86400;
      return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
    },
    // 6-hourly ticks on the local clock, plus the axis start when it isn't one
    ticks() {
      const out = [];
      for (let t = Math.ceil(t0 / 3600) * 3600; t <= t1; t += 3600) {
        const h = ((((t + tz * 3600) / 3600) % 24) + 24) % 24;
        if (h % 6 === 0 || t === t0) out.push({ f: (t - t0) / (t1 - t0), label: t === t1 ? "24" : pad(h) });
      }
      return out;
    },
  };
}

// One cursor for the whole day page: hovering any timeline box draws the line at the
// same moment through every box, shows the clock in each box's pill, and swaps each
// row's summary for its value at that time. Boxes register as they render (heart rate
// arrives later and re-renders on the 15 min / 1 h switch); `onMove` hooks extra
// readouts, one per key.
function dayCursor(axis) {
  let boxes = [];
  const hooks = new Map();
  const show = (f) => {
    boxes = boxes.filter((b) => b.el.isConnected);
    const t = axis.at(f);
    for (const b of boxes) {
      b.line.hidden = b.pill.hidden = false;
      b.line.style.setProperty("--f", f);
      b.pill.style.setProperty("--f", f);
      b.pill.textContent = axis.clock(t);
      for (const r of b.rows) r.val.textContent = r.valueAt(t);
    }
    hooks.forEach((fn) => fn(t));
  };
  const hide = () => {
    for (const b of boxes) {
      b.line.hidden = b.pill.hidden = true;
      for (const r of b.rows) r.val.textContent = r.summary;
    }
    hooks.forEach((fn) => fn(null));
  };
  return {
    add(b) {
      boxes.push(b);
      const move = (e) => {
        const r = b.el.querySelector(".tl-plot").getBoundingClientRect();
        show(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      };
      b.plots.addEventListener("pointermove", move);
      b.plots.addEventListener("pointerdown", move);
      b.plots.addEventListener("pointerleave", hide);
    },
    onMove(key, fn) { hooks.set(key, fn); },
  };
}

// A timeline box: labelled rows over the shared axis, faint 6-hour lines, an hour axis,
// and this box's share of the page cursor. Each row: { label, summary, html, height,
// valueAt(t), rticks } — `rticks` is HTML for the right-hand scale column.
function tlBox(axis, cursor, rows) {
  const box = el("div", "tl");
  const plots = el("div", "tl-plots");
  const ticks = axis.ticks();
  plots.insertAdjacentHTML("beforeend", ticks.map((k) => `<i class="tl-vline" style="--f:${k.f.toFixed(4)}"></i>`).join(""));
  const live = [];
  for (const R of rows) {
    const row = el("div", "tl-row");
    if (R.height) row.style.height = R.height + "px";
    const gut = el("div", "tl-gut");
    const val = el("div", "tl-val");
    val.textContent = R.summary || "";
    gut.append(el("div", "tl-label", esc(R.label)), val);
    const plot = el("div", "tl-plot", R.html);
    row.append(gut, plot, el("div", "tl-rgut", R.rticks || ""));
    plots.append(row);
    live.push({ val, summary: R.summary || "", valueAt: R.valueAt });
  }
  const line = el("div", "tl-cursor");
  const pill = el("div", "tl-pill");
  line.hidden = pill.hidden = true;
  plots.append(line, pill);
  const axisRow = el("div", "tl-axis", ticks.map((k) => `<span style="--f:${k.f.toFixed(4)}">${k.label}</span>`).join(""));
  box.append(plots, axisRow);
  cursor.add({ el: box, plots, line, pill, rows: live });
  return box;
}

const secHead = (title, extra) => {
  const h = el("div", "rpt-sec-head");
  h.append(el("h2", "", title));
  if (extra) h.append(extra);
  return h;
};
const statTile = (k, v) => `<div class="ss"><div class="ss-v">${v}</div><div class="ss-k">${k}</div></div>`;

// The whole day as a JSON download: header + the sleep, activity and heart-rate
// sections (iOS `DayExport` exports one tab's section in the same shapes).
function exportDayJson(d, ymd, axis) {
  const n = nightForDay(d, ymd);
  const debt = ((d.sleep_debt || {}).days || []).find((x) => x.date === ymd) || null;
  const hr = HOURLY_HR || {};
  const tzOff = d.tz ?? browserTzOffset();
  const tzName = (typeof Intl !== "undefined" && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone)
    || `UTC${tzOff >= 0 ? "+" : ""}${tzOff}`;
  const payload = {
    day: ymd, kind: "day", generated_at: new Date().toISOString(),
    timezone: tzName,
    tz_offset: tzOff,
    app_version: "web", profile: d.profile || null,
    sleep: n ? { night: n, sleep_debt: debt } : null,
    activity: {
      daily: (d.activity_daily || {})[ymd] || null,
      profile_met: (d.activity_profile || {})[ymd] || [],
      workouts: (Array.isArray(d.activity) ? d.activity : []).filter((w) => String(w.start || "").startsWith(ymd)),
    },
    heart_rate: { minutes: hr.minutes || 60, bins: (hr.bins || []).filter((b) => b.unix >= axis.t0 && b.unix < axis.t1) },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `oura-${ymd}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stageLegend = () => el("div", "legend rpt-legend",
  `<span><i class="sw deep"></i>深睡</span><span><i class="sw light"></i>浅睡</span>` +
  `<span><i class="sw rem"></i>REM</span><span><i class="sw wake"></i>清醒</span>`);

// stepped clinical hypnogram: y = stage level (Awake top → Deep bottom), colored runs
function hypnoSvg(stages, w, h, span = [0, 1]) {
  const n = stages.length;
  const padT = 8, plotH = h - 16;
  const yOf = (lvl) => padT + (lvl / 3) * plotH;
  const xOf = (i) => (span[0] + (i / Math.max(1, n)) * (span[1] - span[0])) * w;
  let grid = "";
  for (let l = 0; l < 4; l++) grid += `<line x1="${xOf(0).toFixed(1)}" y1="${yOf(l).toFixed(1)}" x2="${xOf(n).toFixed(1)}" y2="${yOf(l).toFixed(1)}" stroke="var(--line-soft)" stroke-width="0.5"/>`;
  let runs = "", conn = "", prevLvl = null, i = 0;
  while (i < n) {
    const code = stages[i]; let j = i;
    while (j < n && stages[j] === code) j++;
    if (!STAGE[code]) { prevLvl = null; i = j; continue; }
    const st = STAGE[code];
    const x1 = xOf(i), x2 = xOf(j), y = yOf(st.lvl);
    runs += `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--${st.cls})" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
    if (prevLvl !== null) conn += `<line x1="${x1.toFixed(1)}" y1="${yOf(prevLvl).toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--faint)" stroke-width="0.8" opacity="0.5" vector-effect="non-scaling-stroke"/>`;
    prevLvl = st.lvl; i = j;
  }
  return `<svg class="lane-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}${conn}${runs}</svg>`;
}

// smooth auto-scaled line + faint area + dashed mean, for one signal lane
function laneSvg(v, w, h, color, span = [0, 1], times = null) {
  if (times && times.length === v.length && v.length) {
    const min = Math.min(0, ...v), max = Math.max(min + 1, ...v);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const bars = v.map((value, i) => {
      const x = times[i] * w, y = 5 + (1 - (value - min) / (max - min)) * (h - 10);
      return `<line x1="${x}" x2="${x}" y1="${h - 5}" y2="${y}" stroke="${color}" stroke-width="1.5"/>`;
    }).join("");
    return { mean, min, max, svg: `<svg class="lane-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>` };
  }
  if (v.length < 2) return null;
  const min = Math.min(...v), max = Math.max(...v), rng = (max - min) || 1;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const pad = 5, y = (val) => pad + (1 - (val - min) / rng) * (h - 2 * pad);
  const x0 = span[0] * w, x1 = span[1] * w;
  const pts = v.map((val, i) => [x0 + (i / (v.length - 1)) * (x1 - x0), y(val)]);
  const line = smoothPath(pts), my = y(mean).toFixed(1);
  return {
    mean, min, max,
    svg: `<svg class="lane-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<path d="${line} L${x1} ${h} L${x0} ${h} Z" fill="${color}" opacity="0.09"/>` +
      `<line x1="${x0}" y1="${my}" x2="${x1}" y2="${my}" stroke="${color}" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.45"/>` +
      `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`,
  };
}

// A signal lane from time-true [unix, value] points (nights[].series_t) on the day axis.
// The line breaks wherever the ring recorded nothing for more than LANE_GAP_S, instead
// of being stretched over the gap.
const LANE_GAP_S = 15 * 60;
function timedLaneSvg(pts, axis, w, h, color) {
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const pad = 5, x = (t) => axis.frac(t) * w, y = (v) => pad + (1 - (v - min) / rng) * (h - 2 * pad);
  const segs = [[]];
  pts.forEach((p, i) => {
    if (i && p[0] - pts[i - 1][0] > LANE_GAP_S) segs.push([]);
    segs[segs.length - 1].push([x(p[0]), y(p[1])]);
  });
  let area = "", line = "";
  for (const s of segs) {
    if (s.length === 1) s.push([s[0][0] + 1.5, s[0][1]]); // a lone point still shows
    const d = smoothPath(s);
    line += d + " ";
    area += `${d} L${s[s.length - 1][0].toFixed(1)} ${h} L${s[0][0].toFixed(1)} ${h} Z `;
  }
  const my = y(mean).toFixed(1);
  return {
    mean,
    svg: `<svg class="lane-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<path d="${area}" fill="${color}" opacity="0.09"/>` +
      `<line x1="${x(pts[0][0]).toFixed(1)}" y1="${my}" x2="${x(pts[pts.length - 1][0]).toFixed(1)}" y2="${my}" stroke="${color}" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.45"/>` +
      `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`,
  };
}
// the point nearest `t` within `tol` seconds, else null
function nearestPoint(pts, t, tol) {
  let best = null;
  for (const p of pts) if (Math.abs(p[0] - t) <= tol && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
  return best;
}

// horizontal stage-proportion bar (Deep/Light/REM/Awake)
function stageBar(n) {
  const bar = el("div", "stagebar");
  const parts = [["deep", n.deep_pct], ["light", n.light_pct], ["rem", n.rem_pct], ["wake", n.wake_pct]];
  bar.innerHTML = parts.map(([c, v]) => `<i class="sw-${c}" style="width:${Math.max(0, v || 0)}%" title="${Math.round(v || 0)}%"></i>`).join("");
  return bar;
}

// science-based read of the night → a few plain-language sentences + a sleep-debt note
function sleepInterpretation(d, n, m) {
  if (n.staging_complete === false) return el("p", "error", "睡眠分析不完整:数据有空白,无法据此判断清醒时间或入睡时间。");
  const wrap = el("div", "interp");
  const out = [];
  if (n.efficiency != null)
    out.push(n.efficiency >= 85 ? `睡眠效率 ${n.efficiency}%,表现不错:入睡后很少醒着。`
      : n.efficiency >= 75 ? `睡眠效率 ${n.efficiency}%,一般:睡眠有些零碎,影响了深度休息。`
      : `睡眠效率 ${n.efficiency}%,偏低:躺在床上的很多时间并没有睡着。`);
  if (n.deep_pct != null)
    out.push(n.deep_pct < 10 ? `深睡很少(${n.deep_pct}%)。深睡是身体修复的阶段,深睡偏少常与晚餐太晚、饮酒或压力有关。`
      : `深睡 ${n.deep_pct}%(目标约 13–23%),这是身体修复的阶段。`);
  if (n.rem_pct != null && m.rem_latency_min != null)
    out.push(`REM 占 ${n.rem_pct}%,入睡后 ${Math.round(m.rem_latency_min)} 分钟进入第一次 REM(REM 潜伏期短可能意味着 REM 压力或睡眠债)。`);
  if (m.waso_min != null && m.awakenings != null)
    out.push(`第一次入睡后,你醒了 ${m.awakenings} 次,共清醒 ${Math.round(m.waso_min)} 分钟。`);
  out.forEach((t) => wrap.append(el("p", "interp-p", t)));
  const sd = d.sleep_debt;
  if (sd && sd.valid && sd.debt_min != null) {
    const h = Math.floor(sd.debt_min / 60), mm = Math.round(sd.debt_min % 60);
    const note = el("div", "interp-debt");
    note.innerHTML = `<div class="id-v">${h} 小时 ${mm} 分钟</div><div class="id-k">累计睡眠债(每晚需要 ${sd.need_h} 小时)` +
      `${sd.recent_shortfall_min > 0 ? ` · 昨晚少睡 ${Math.round(sd.recent_shortfall_min)} 分钟` : ""}</div>`;
    wrap.append(note);
  }
  return wrap;
}

// Sleep: stats, then the overnight lanes on the night's slice of the day axis — shown
// with or without a hypnogram (stages need Oura's SleepNet model; the signals don't) —
// then the stage-derived architecture and interpretation when stages exist.
function sleepSection(d, ymd, axis, cursor) {
  const sec = el("section", "rpt-sec");
  sec.id = "sec-sleep";
  const n = nightForDay(d, ymd);
  const canEditBedtime = !!(n && n.start_ds != null && n.end_ds != null);
  const editToggle = canEditBedtime ? el("button", "bedtime-edit-btn", n.bedtime_manual ? "就寝时间 · 已修改" : "调整就寝时间") : null;
  if (editToggle) {
    editToggle.type = "button";
    editToggle.title = "调整这一晚的就寝和起床时间";
  }
  sec.append(secHead("睡眠", editToggle));
  if (!n) {
    sec.append(el("div", "ad-muted", "戒指数据里没有在这一天结束的睡眠。"));
    return sec;
  }
  const m = n.metrics || {}, s = n.series || {};
  const staged = !!(n.stages_full && n.stages_full.length);
  const asleepH = m.asleep_min != null ? m.asleep_min / 60 : null;
  const strip = el("div", "stat-strip");
  strip.innerHTML =
    statTile("在床时间", num(n.in_bed_h) + " 小时") +
    statTile("睡眠时长", asleepH != null ? asleepH.toFixed(1) + " 小时" : "—") +
    statTile("睡眠效率", n.efficiency != null ? n.efficiency + "%" : "—") +
    statTile(n.bedtime_manual ? "就寝时间 · 已修改" : "就寝时间", `${n.start}–${n.end}`);
  sec.append(strip);
  if (canEditBedtime) {
    const editor = el("form", "bedtime-editor");
    editor.hidden = true;
    const rawRange = n.raw_start && n.raw_end ? `${n.raw_start}–${n.raw_end}` : null;
    editor.innerHTML =
      `<label class="be-field"><span>就寝</span><input type="time" name="start" value="${esc(n.start || "23:00")}" required></label>` +
      `<span class="be-sep">→</span>` +
      `<label class="be-field"><span>起床</span><input type="time" name="end" value="${esc(n.end || "07:00")}" required></label>` +
      `<div class="be-actions">` +
      `<button type="submit" class="be-save">应用</button>` +
      (n.bedtime_manual ? `<button type="button" class="be-reset" title="恢复戒指检测到的时间${rawRange ? `(${rawRange})` : ""}">重置</button>` : "") +
      `<button type="button" class="be-cancel">取消</button>` +
      `</div>`;
    const toggleEditor = () => {
      editor.hidden = !editor.hidden;
      editToggle.classList.toggle("active", !editor.hidden);
    };
    editToggle.addEventListener("click", toggleEditor);
    const bedTile = strip.lastElementChild;
    if (bedTile) {
      bedTile.classList.add("ss-interactive");
      bedTile.title = "点击调整就寝和起床时间";
      bedTile.addEventListener("click", toggleEditor);
    }
    editor.querySelector(".be-cancel")?.addEventListener("click", () => {
      editor.hidden = true;
      editToggle.classList.remove("active");
    });
    const submitOverride = async (payload, okMsg) => {
      try {
        const res = await (await postDash("/api/bedtime", payload)).json();
        if (!res.ok) {
          toast(res.error || "无法更新就寝时间。", "error");
          return;
        }
        toast(okMsg, "ok");
        const fresh = await (await fetch(`/api/summary?tz=${browserTzOffset()}`)).json();
        if (!fresh.error) {
          CURRENT_TZ = fresh.tz || 0;
          await load();
          openDayPage(fresh, ymd, null, true);
        }
      } catch (_) {
        toast("连接不上本地服务器。", "error");
      }
    };
    editor.querySelector(".be-reset")?.addEventListener("click", () => {
      submitOverride(
        { raw_start_ds: n.raw_start_ds ?? n.start_ds, captured_unix: n.captured_unix ?? 0, reset: true },
        "已恢复戒指检测到的睡眠时间。"
      );
    });
    editor.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(editor);
      const startHM = String(fd.get("start") || n.start);
      const endHM = String(fd.get("end") || n.end);
      let dStart = parseHM(startHM) - parseHM(n.start);
      if (dStart > 720) dStart -= 1440;
      if (dStart < -720) dStart += 1440;
      let dEnd = parseHM(endHM) - parseHM(n.end);
      if (dEnd > 720) dEnd -= 1440;
      if (dEnd < -720) dEnd += 1440;
      const newStartDs = Math.round(n.start_ds + dStart * 600);
      let newEndDs = Math.round(n.end_ds + dEnd * 600);
      if (newEndDs <= newStartDs) newEndDs += 1440 * 600;
      if (newEndDs - newStartDs < 30 * 600 || newEndDs - newStartDs > 20 * 36000) {
        toast("睡眠时间段必须在 30 分钟到 20 小时之间。", "error");
        return;
      }
      submitOverride(
        { raw_start_ds: n.raw_start_ds ?? n.start_ds, captured_unix: n.captured_unix ?? 0, start_ds: newStartDs, end_ds: newEndDs },
        `已更新睡眠时间段(${startHM}–${endHM})。`
      );
    });
    sec.append(editor);
  }
  if (staged && n.staging_complete === false)
    sec.append(el("p", "error", "睡眠分析不完整。空白处表示没有数据,而不是清醒;睡眠指标暂不显示。"));
  if (staged && n.staging_source === "signals") {
    const note = el("p", "hr-note",
      "这张睡眠分期图来自本地的信号估算(心率、HRV 和动作),不是 Oura 的睡眠分期模型。" +
      "如果想用 Oura 经过验证的模型,请安装 Python + torch,并把模型文件放到 notes/models/ " +
      "(或设置 OURA_MODELS_DIR);详见 dashboard/README.md。");
    sec.append(note);
  }
  if (staged) sec.append(stageLegend());
  else sec.append(el("p", "hr-note", "这一晚没有睡眠分期。下面的曲线是戒指夜间记录的数据。"));

  const W = 1000, a = axis.frac(n.start_unix), b = axis.frac(n.end_unix);
  const rows = [];
  if (staged && n.stages_5min && n.stages_5min.length) {
    // What the official Oura app draws: the same stages in 5-minute blocks, laid
    // from the first NSSA epoch (floor of bedtime start to the 30 s grid).
    const st5 = n.stages_5min, t0 = n.stages_t0_unix || n.start_unix;
    const a5 = axis.frac(t0), b5 = axis.frac(t0 + st5.length * 300);
    rows.push({
      label: "睡眠分期 · 5 分钟(Oura App)", summary: "", height: 96, html: hypnoSvg(st5, W, 92, [a5, b5]),
      valueAt: (t) => {
        const f = axis.frac(t);
        return f < a5 || f >= b5 ? "—" : (STAGE[st5[Math.floor(((f - a5) / Math.max(1e-9, b5 - a5)) * st5.length)]] || {}).name || "";
      },
    });
  }
  if (staged) {
    const st = n.stages_full;
    rows.push({
      label: "睡眠分期", summary: "", height: 96, html: hypnoSvg(st, W, 92, [a, b]),
      valueAt: (t) => {
        const f = axis.frac(t);
        return f < a || f > b ? "—" : (STAGE[st[Math.round(((f - a) / Math.max(1e-9, b - a)) * (st.length - 1))]] || {}).name || "";
      },
    });
  }
  const timed = n.series_t; // real times; the flat `series` is only spread evenly
  const addLane = (key, label, unit, color, dp = 0, span = [0, 1]) => {
    if (timed) {
      const pts = timed[key] || [];
      const L = key === "motion"
        ? laneSvg(pts.map(p => p[1]), W, 50, color, [0, 1], pts.map(p => axis.frac(p[0])))
        : timedLaneSvg(pts, axis, W, 50, color);
      if (!L) return;
      const fmt = (x) => (dp ? x.toFixed(dp) : Math.round(x));
      rows.push({
        label, summary: `${fmt(L.mean)} ${unit}`, html: L.svg,
        valueAt: (t) => { const p = nearestPoint(pts, t, key === "motion" ? 30 : LANE_GAP_S / 2); return p ? `${fmt(p[1])} ${unit}` : "—"; },
      });
      return;
    }
    if (key === "motion") {
      if (Array.isArray(s.motion_time) && s.motion_time.length === (s.motion || []).length) {
        const L = laneSvg(s.motion, W, 50, color, [0, 1], s.motion_time.map(f => a + f * (b - a)));
        if (L) rows.push({label, summary: `${Math.round(L.mean)} ${unit}`, html: L.svg,
          valueAt: t => { const pts = s.motion_time.map((f,i) => [n.start_unix + f * (n.end_unix-n.start_unix), s.motion[i]]);
            const p = nearestPoint(pts,t,30); return p ? `${Math.round(p[1])} ${unit}` : "—"; }});
      }
      return;
    }
    const v = (s[key] || []).filter((x) => x != null);
    const sa = a + span[0] * (b - a), sb = a + span[1] * (b - a);
    const L = laneSvg(v, W, 50, color, [sa, sb]);
    if (!L) return;
    const fmt = (x) => (dp ? x.toFixed(dp) : Math.round(x));
    rows.push({
      label, summary: `${fmt(L.mean)} ${unit}`, html: L.svg,
      valueAt: (t) => {
        const f = axis.frac(t);
        return f < sa || f > sb ? "—" : `${fmt(v[Math.round(((f - sa) / Math.max(1e-9, sb - sa)) * (v.length - 1))])} ${unit}`;
      },
    });
  };
  addLane("hr", "心率", "bpm", "var(--warn)");
  addLane("hrv", "HRV", "ms", "var(--accent)");
  addLane("spo2", "血氧", "%", "var(--rem)");
  addLane("temp", "皮肤温度", "°C", "var(--light)", 1, s.temp_span || [0, 1]);
  addLane("motion", "动作", "秒", "var(--faint)");
  if (rows.length) sec.append(el("p", "subhead", "夜间"), tlBox(axis, cursor, rows));
  if (!staged) return sec;

  // architecture + clinical metrics
  sec.append(el("p", "subhead", "睡眠结构"), stageBar(n));
  const mg = el("div", "metric-grid");
  const mins = (x) => (x != null ? Math.round(x) + " 分钟" : "—");
  const mc = (k, v) => `<div class="mc"><div class="mc-v">${v}</div><div class="mc-k">${k}</div></div>`;
  mg.innerHTML =
    mc("入睡用时", mins(m.sol_min)) +
    mc("REM 潜伏期", mins(m.rem_latency_min)) +
    mc("入睡后清醒(WASO)", mins(m.waso_min)) +
    mc("醒来次数", m.awakenings != null ? m.awakenings : "—") +
    mc("睡眠周期", m.cycles != null ? m.cycles : "—") +
    mc("碎片化指数", m.frag_index != null ? m.frag_index + " 次/小时" : "—");
  sec.append(mg);

  // autonomic recovery resolved by sleep stage. Deep-sleep HRV is the recovery-relevant
  // number; we deliberately don't show a single overnight HRV "slope" — nocturnal HRV is
  // stage-driven (deep ↑, REM ↓), so a slope mostly tracks stage order, not recovery.
  const au = n.autonomic;
  if (au && [au.hrv_deep, au.hrv_light, au.hrv_rem, au.hr_deep, au.hr_light, au.hr_rem].some((x) => x != null)) {
    sec.append(el("p", "subhead", "各睡眠阶段的自主神经恢复"));
    const at = el("div", "metric-grid");
    const val = (x, u) => (x != null ? x + u : "—");
    at.innerHTML =
      mc("HRV · 深睡", val(au.hrv_deep, " ms")) +
      mc("HRV · 浅睡", val(au.hrv_light, " ms")) +
      mc("HRV · REM", val(au.hrv_rem, " ms")) +
      mc("心率 · 深睡", val(au.hr_deep, " bpm")) +
      mc("心率 · 浅睡", val(au.hr_light, " bpm")) +
      mc("心率 · REM", val(au.hr_rem, " bpm"));
    sec.append(at);
  }
  sec.append(el("p", "subhead", "解读"), sleepInterpretation(d, n, m));
  return sec;
}

// 15-minute MET-above-rest buckets across the day's own 24 h, on the day axis
function movementSvg(prof, axis, w, h) {
  const p = (prof || []).map((x) => x || 0);
  if (p.length < 2) return "";
  const x0 = axis.frac(axis.dayStart) * w, peak = Math.max(1, ...p), pad = 6;
  const pts = p.map((v, i) => [x0 + ((i + 0.5) / p.length) * (w - x0), pad + (1 - Math.min(1, v / peak)) * (h - 2 * pad)]);
  const line = smoothPath(pts);
  const [first, last] = [pts[0][0].toFixed(1), pts[pts.length - 1][0].toFixed(1)];
  return `<svg class="lane-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<path d="${line} L${last} ${h} L${first} ${h} Z" fill="var(--accent)" opacity="0.14"/>` +
    `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
}

function activitySection(d, ymd, axis, cursor) {
  const sec = el("section", "rpt-sec");
  sec.id = "sec-activity";
  sec.append(secHead("活动"));
  const ds = (d.activity_daily || {})[ymd];
  const prof = (d.activity_profile || {})[ymd] || [];
  const strip = el("div", "stat-strip");
  strip.innerHTML =
    statTile("步数", ds ? Math.round(ds.steps || 0).toLocaleString() : "—") +
    statTile("活动消耗", ds ? Math.round(ds.active_kcal || 0) + " 千卡" : "—") +
    statTile("总消耗", ds ? Math.round(ds.total_kcal || 0) + " 千卡" : "—") +
    (ds && ds.distance_m != null ? statTile("距离", (ds.distance_m / 1000).toFixed(1) + " km") : "");
  sec.append(strip);

  const svg = movementSvg(prof, axis, 1000, 90);
  if (svg) {
    const p = prof.map((v) => v || 0), bucketS = 86400 / p.length;
    const at = (t) => {
      const i = Math.floor((t - axis.dayStart) / bucketS);
      return i >= 0 && i < p.length ? `${p[i].toFixed(1)} MET` : "—";
    };
    sec.append(el("p", "subhead", "活动量"),
      tlBox(axis, cursor, [{ label: "活动量", summary: `峰值 ${Math.max(...p).toFixed(1)}`, height: 90, html: svg, valueAt: at }]));
  }

  // intensity-derived metrics (buckets are 15-min MET-above-rest)
  const bucketMin = 24 * 60 / (prof.length || 96);
  const activeMin = prof.filter((v) => (v || 0) >= 3).length * bucketMin;
  const lightMin = prof.filter((v) => (v || 0) >= 1.5 && (v || 0) < 3).length * bucketMin;
  const peakMet = prof.length ? Math.max(...prof.map((v) => v || 0)) : 0;
  const sessions = sessionsForDay(d, ymd);
  const mg = el("div", "metric-grid");
  const mc = (k, v) => `<div class="mc"><div class="mc-v">${v}</div><div class="mc-k">${k}</div></div>`;
  mg.innerHTML =
    mc("活跃", Math.round(activeMin) + " 分钟") +
    mc("轻度活跃", Math.round(lightMin) + " 分钟") +
    mc("峰值强度", peakMet.toFixed(1) + " MET") +
    mc("活动次数", sessions.length);
  sec.append(mg);

  sec.append(el("p", "subhead", "活动记录"));
  if (sessions.length) {
    const list = el("div", "dd-sessions");
    sessions.forEach((sess) => {
      const row = el("button", "dd-session" + (sess.is_workout >= 0.5 ? " workout" : ""));
      row.type = "button";
      const ico = el("span", "ic");
      ico.style.setProperty("--i", `url(/icons/${actIcon(sess.label)}.svg)`);
      const nm = el("span", "dd-s-name"); nm.textContent = zhAct(sess.label);
      const meta = el("span", "dd-s-meta"); meta.textContent = `${sess.duration_min} 分钟 · ${hhmm(sess.start)}`;
      row.append(ico, nm, meta);
      row.addEventListener("click", () => openActDetail(sess));
      list.append(row);
    });
    sec.append(list);
  } else {
    sec.append(el("div", "ad-muted", "这一天没有检测到活动。"));
  }
  return sec;
}

// ── heart rate across the day ────────────────────────────────
// Mirror of iOS `HeartRate.swift`, finer: one bar per slot spanning its 5th–95th
// percentile band with a tick at the median, from GET /api/hourly-hr?minutes=
// (oura-summary::hourly_hr::hr_bins). 15-minute slots by default, hourly on the
// switch. Slots built from few values are drawn lighter: while you sleep the ring
// keeps only 5-minute averages, three per quarter hour. Empty slots had no readings.
let HOURLY_HR = null; // last /api/hourly-hr response, for the day's JSON export
let HR_BIN_MIN = 15;
let HR_SEQ = 0;
const HR_FEW_VALUES = 10; // below this a band is a handful of values, not a spread

// One day's slots from an /api/hourly-hr response: `bySlot[i]` is slot i's row (or
// null), for the tab chart and the "Your day" strip alike.
function hrDaySlots(j, ymd) {
  const m = j.minutes || 60;
  const slotOf = (r) => Math.floor((r.hour * 60 + (r.minute || 0)) / m);
  const bySlot = new Array(1440 / m).fill(null);
  for (const r of j.bins || []) if (r.ymd === ymd) bySlot[slotOf(r)] = r;
  return { m, slotOf, bySlot, rows: bySlot.filter(Boolean) };
}

// The newest reading's bpm when it falls on `ymd` (local clock), else null.
function hrLatestOn(j, ymd) {
  if (!j.latest) return null;
  const at = new Date((j.latest.unix + (j.tz_offset || 0) * 3600) * 1000).toISOString().slice(0, 10);
  return at === ymd ? j.latest.bpm : null;
}

function hrBinsSvg(bySlot, lo, hi, w, h, withGrid = true) {
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  const col = w / bySlot.length;
  const bw = col * (bySlot.length > 24 ? 0.6 : 0.5);
  let grid = "";
  for (let v = Math.ceil(lo / 20) * 20; withGrid && v <= hi; v += 20)
    grid += `<line class="hr-grid" x1="0" x2="${w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
  let bars = "";
  bySlot.forEach((b, i) => {
    if (!b) return;
    const x = i * col + (col - bw) / 2, thin = b.count < HR_FEW_VALUES ? " thin" : "";
    bars += `<rect class="hr-bar${thin}" x="${x.toFixed(2)}" y="${y(b.high).toFixed(1)}" width="${bw.toFixed(2)}" ` +
      `height="${Math.max(2, y(b.low) - y(b.high)).toFixed(1)}"/>` +
      `<line class="hr-med${thin}" x1="${(x - col * 0.08).toFixed(2)}" x2="${(x + bw + col * 0.08).toFixed(2)}" ` +
      `y1="${y(b.median).toFixed(1)}" y2="${y(b.median).toFixed(1)}"/>`;
  });
  return `<svg class="hr-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}` +
    `<rect class="hr-hover" x="0" y="0" width="${col.toFixed(2)}" height="${h}" style="display:none"/>${bars}</svg>`;
}


// the slots of an /api/hourly-hr response placed by time on the day axis
function hrTimelineSvg(bins, axis, minutes, lo, hi, w, h) {
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  const slotW = ((minutes * 60) / (axis.t1 - axis.t0)) * w, bw = slotW * (minutes < 60 ? 0.6 : 0.5);
  let grid = "";
  for (let v = Math.ceil(lo / 20) * 20; v <= hi; v += 20)
    grid += `<line class="hr-grid" x1="0" x2="${w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
  let bars = "";
  for (const b of bins) {
    const x = axis.frac(b.unix) * w + (slotW - bw) / 2, thin = b.count < HR_FEW_VALUES ? " thin" : "";
    bars += `<rect class="hr-bar${thin}" x="${x.toFixed(2)}" y="${y(b.high).toFixed(1)}" width="${bw.toFixed(2)}" ` +
      `height="${Math.max(2, y(b.low) - y(b.high)).toFixed(1)}"/>` +
      `<line class="hr-med${thin}" x1="${(x - slotW * 0.08).toFixed(2)}" x2="${(x + bw + slotW * 0.08).toFixed(2)}" ` +
      `y1="${y(b.median).toFixed(1)}" y2="${y(b.median).toFixed(1)}"/>`;
  }
  return `<svg class="hr-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}${bars}</svg>`;
}

function heartSection(ymd, axis, cursor) {
  const sec = el("section", "rpt-sec");
  sec.id = "sec-heart";
  const sw = el("div", "hr-bin");
  sec.append(secHead("心率", sw));
  const strip = el("div", "stat-strip");
  const chart = el("div");
  const readout = el("p", "hr-readout", "&nbsp;");
  sec.append(strip, chart, readout,
    el("p", "hr-note", "每根柱子表示该时段的典型范围(数值的第 5 到第 95 百分位),横线是中位数。" +
      "颜色较浅的柱子只由少量数值得出:睡觉时戒指存的是 5 分钟平均值,而不是每次心跳。" +
      "空白时段没有读数。"));
  const load = () => {
    const seq = ++HR_SEQ; // a slower earlier response must not overwrite a newer one
    sw.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.min === HR_BIN_MIN));
    chart.replaceChildren(el("div", "skeleton skeleton-block"));
    fetch(`/api/hourly-hr?minutes=${HR_BIN_MIN}&tz=${browserTzOffset()}`)
      .then((r) => r.json())
      .then((j) => {
        if (seq !== HR_SEQ) return;
        if (j.error) throw new Error(j.error);
        HOURLY_HR = j;
        renderHeart(j, ymd, axis, cursor, strip, chart, readout);
      })
      .catch((e) => {
        if (seq !== HR_SEQ) return;
        chart.replaceChildren(el("p", "hr-empty", "心率加载失败:" + esc(e.message)));
        readout.innerHTML = "&nbsp;";
      });
  };
  for (const [min, label] of [[15, "15 分钟"], [60, "1 小时"]]) {
    const b = el("button", "", label);
    b.type = "button";
    b.dataset.min = min;
    b.addEventListener("click", () => { if (HR_BIN_MIN !== min) { HR_BIN_MIN = min; load(); } });
    sw.append(b);
  }
  load();
  return sec;
}

function renderHeart(j, ymd, axis, cursor, strip, chart, readout) {
  const span = (j.minutes || 60) * 60;
  const bins = (j.bins || []).filter((b) => b.unix >= axis.t0 && b.unix < axis.t1);
  const day = bins.filter((b) => b.ymd === ymd); // the stats cover the day itself
  if (!bins.length) {
    strip.innerHTML = "";
    chart.replaceChildren(el("p", "hr-empty", "这一天还没有心率读数。戴上戒指并同步。"));
    readout.innerHTML = "&nbsp;";
    cursor.onMove("heart", () => {});
    return;
  }
  const r0 = Math.round;
  const statRows = day.length ? day : bins;
  const low = Math.min(...statRows.map((r) => r.low)), high = Math.max(...statRows.map((r) => r.high));
  const calm = statRows.reduce((a, b) => (b.median < a.median ? b : a));
  const latest = hrLatestOn(j, ymd);
  strip.innerHTML =
    (latest != null ? statTile("最新", `${r0(latest)} bpm`) : "") +
    statTile("范围", `${r0(low)}–${r0(high)} bpm`) +
    statTile(`最低 · ${axis.clock(calm.unix)}`, `${r0(calm.median)} bpm`) +
    statTile("有数据的小时", `${new Set(statRows.map((r) => `${r.ymd} ${r.hour}`)).size} / 24`);

  const allLow = Math.min(...bins.map((r) => r.low)), allHigh = Math.max(...bins.map((r) => r.high));
  const lo = Math.max(0, Math.floor(allLow / 10) * 10 - 10), hi = Math.ceil(allHigh / 10) * 10 + 10;
  const H = 140, rticks = [];
  for (let v = Math.ceil(lo / 20) * 20; v <= hi; v += 20)
    rticks.push(`<span style="top:${(((hi - v) / (hi - lo)) * 100).toFixed(1)}%">${v}</span>`);
  const sorted = statRows.map((r) => r.median).sort((a, b) => a - b);
  const at = (t) => bins.find((b) => t >= b.unix && t < b.unix + span);
  chart.replaceChildren(tlBox(axis, cursor, [{
    label: "心率", summary: `${r0(sorted[Math.floor(sorted.length / 2)])} bpm`, height: H,
    html: hrTimelineSvg(bins, axis, span / 60, lo, hi, 1000, H), rticks: rticks.join(""),
    valueAt: (t) => { const b = at(t); return b ? `${r0(b.median)} bpm` : "—"; },
  }]));

  // the detailed slot line under the chart follows the page cursor from any chart
  const madeOf = (b) => [b.beats ? `${b.beats.toLocaleString()} 次心跳` : "", b.averages ? `${b.averages.toLocaleString()} 个 5 分钟平均值` : ""]
    .filter(Boolean).join(" + ");
  const idle = "把鼠标移到任意图表上,可以同时查看那一刻的睡眠、活动和心率。";
  readout.textContent = idle;
  cursor.onMove("heart", (t) => {
    if (t == null) { readout.textContent = idle; return; }
    const b = at(t), s0 = b ? b.unix : Math.floor(t / span) * span;
    readout.textContent = `${axis.clock(s0)}–${axis.clock(s0 + span)} · ` + (!b ? "无读数" : b.beats
      ? `中位数 ${r0(b.median)} bpm · 典型 ${r0(b.low)}–${r0(b.high)} · 最低 ${r0(b.min)} · 最高 ${r0(b.max)} · ${madeOf(b)}`
      : `中位数 ${r0(b.median)} bpm · 范围 ${r0(b.min)}–${r0(b.max)} · ${madeOf(b)}`);
  });
}

// the "previous days" page: every day as a row (date, mini-hypnogram, totals) that
// opens its full-page report. Uses its own dialog id.
function openDaysBrowser(d, days) {
  let dlg = $("days-dialog");
  if (!dlg) {
    dlg = el("dialog", "dialog day-dialog");
    dlg.id = "days-dialog";
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
  }
  const form = el("form");
  form.method = "dialog";
  const head = el("div", "dd-head");
  const h = el("h3");
  h.textContent = `全部 ${days.length} 天`;
  const close = el("button", "dd-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.addEventListener("click", () => dlg.close());
  head.append(h, close);
  form.append(head);

  const list = el("div", "daylist");
  days.forEach((ymd) => {
    const n = nightForDay(d, ymd);
    const ds = (d.activity_daily || {})[ymd];
    const row = el("button", "daylist-row");
    row.type = "button";
    const left = el("div", "dl-left");
    left.append(el("div", "dl-date", dayTitle(ymd)));
    left.append(el("div", "dl-sub", ds ? `${kfmt(ds.steps)} 步 · ${Math.round(ds.active_kcal)} 千卡` : (n ? "仅睡眠" : "—")));
    row.append(left);
    if (n && n.stages && n.stages.length) {
      const hyp = hypnogram(n.stages);
      hyp.classList.add("dl-hyp");
      row.append(hyp);
    }
    row.append(el("span", "dp-chev"));
    row.addEventListener("click", () => { dlg.close(); openDayPage(d, ymd, "sleep"); });
    list.append(row);
  });
  form.append(list);
  dlg.replaceChildren(form);
  dlg.showModal();
}

// capability → glyph (mix of vendored phosphor + hugeicons)
const CAP_ICON = {
  "Daytime HR": "heartbeat", "SpO2": "wind", "Exercise HR": "person-simple-run",
  "Real steps": "act-walking", "Cardio PPG (CVA)": "heartbeat",
};
const capIcon = (name) => CAP_ICON[name] || "cpu";

async function doFeature(feature, name, currentOn, row) {
  if (row.classList.contains("busy")) return;
  const turnOn = !currentOn;
  row.classList.add("busy");
  row.classList.toggle("on", turnOn); // optimistic
  try {
    const j = await (await postDash("/api/feature", { feature, mode: turnOn ? "automatic" : "off" })).json();
    if (j.ok) {
      toast(`已${turnOn ? "开启" : "关闭"}${zh(name)}。请戴上戒指,数据会在下次同步时出现。`, "ok");
      load(); // refresh dev.measuring so a second tap toggles from the real state
    } else {
      toast(syncHint(j.message), "error");
      row.classList.toggle("on", currentOn); // revert
    }
  } catch (e) {
    toast("连接不上本地服务器。", "error");
    row.classList.toggle("on", currentOn);
  }
  row.classList.remove("busy");
}

// The ring's own battery readings (device.battery_history, [unix, percent]) over the
// days they span. Stretches where the level rises are it charging, which the readings
// show on their own — the event's two flag bytes aren't decoded, so nothing here
// depends on guessing what they mean.
function batteryChart(pts) {
  if (pts.length < 2) return null;
  const wrap = el("div", "batt-chart");
  const head = el("div", "batt-head");
  head.append(el("p", "subhead", "电量"));
  const readout = el("span", "batt-readout");
  head.append(readout);
  wrap.append(head);

  const W = 100, H = 40, t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const span = Math.max(1, t1 - t0);
  // A full battery is the top of the scale, but the bottom follows the data: a ring
  // that has only been 80-100% draws as a flat line against a 0-100 axis. Both ends
  // are labelled so a zoomed axis can't read as a bigger swing than it is.
  const lo = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) / 10) * 10 - 5), hi = 100;
  const x = (t) => ((t - t0) / span) * W, y = (p) => H - ((p - lo) / (hi - lo)) * H;
  // one path per run of the same direction, so charging can be drawn differently
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const up = pts[i][1] > pts[i - 1][1];
    if (!segs.length || segs[segs.length - 1].up !== up) segs.push({ up, pts: [pts[i - 1]] });
    segs[segs.length - 1].pts.push(pts[i]);
  }
  const line = (s) => `<path class="batt-line${s.up ? " up" : ""}" d="${s.pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(2)} ${y(p[1]).toFixed(2)}`).join(" ")}"/>`;
  let grid = "";
  for (let v = Math.ceil((lo + 1) / 10) * 10; v < hi; v += 10)
    grid += `<line class="batt-grid" x1="0" x2="${W}" y1="${y(v).toFixed(2)}" y2="${y(v).toFixed(2)}"/>`;
  const plot = el("div", "batt-plot",
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${segs.map(line).join("")}` +
    `<line class="batt-cursor" x1="0" x2="0" y1="0" y2="${H}" style="display:none"/></svg>` +
    `<i class="batt-max">${hi}%</i><i class="batt-min">${lo}%</i>`);
  wrap.append(plot);

  const days = Math.max(1, Math.round((t1 - t0) / 86400));
  const foot = el("div", "batt-foot");
  foot.append(el("span", "", `${dayTitle(ymdOf(t0, d0TZ()))} → ${hhmmOf(t1)}`), el("span", "", `${days} 天`));
  wrap.append(foot);

  const cursor = plot.querySelector(".batt-cursor");
  const at = (e) => {
    const r = plot.getBoundingClientRect();
    const t = t0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * span;
    const p = pts.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a));
    cursor.setAttribute("x1", x(p[0]).toFixed(2));
    cursor.setAttribute("x2", x(p[0]).toFixed(2));
    cursor.style.display = "";
    readout.textContent = `${hhmmOf(p[0])} · ${Math.round(p[1])}%`;
  };
  plot.addEventListener("pointermove", at);
  plot.addEventListener("pointerdown", at);
  plot.addEventListener("pointerleave", () => { cursor.style.display = "none"; readout.textContent = ""; });
  return wrap;
}
// local-clock helpers for the battery chart's labels (the summary's tz offset)
const d0TZ = () => (CURRENT_TZ || 0);
const ymdOf = (unix, tz) => new Date((unix + tz * 3600) * 1000).toISOString().slice(0, 10);
const hhmmOf = (unix) => {
  const s = new Date((unix + d0TZ() * 3600) * 1000).toISOString();
  return `${s.slice(5, 10).replace("-", "/")} ${s.slice(11, 16)}`;
};

// "Recorded <date> <hm> (Xd/Xh/<1h ago)" for a battery reading, or "" if unknown.
// Shared by the device card and the toolbar battery pill so the two cannot drift.
function batteryRecordedLabel(dev) {
  if (!dev.battery_recorded) return "";
  let rec = `记录于 ${zh(dev.battery_recorded)}${dev.battery_recorded_hm ? " " + dev.battery_recorded_hm : ""}`;
  const h = dev.battery_fresh_hours;
  if (h != null) {
    if (h >= 24) rec += `(${Math.round(h / 24)} 天前)`;
    else if (h >= 1) rec += `(${Math.round(h)} 小时前)`;
    else rec += `(不到 1 小时前)`;
  }
  return rec;
}

function renderDevice(d) {
  const box = $("device");
  const dev = d.device || {};
  box.innerHTML = "";

  const stats = el("div", "dh-stats");
  const stat = (k, v, u) => el("div", "dh-stat", `<div class="k">${k}</div><div class="v">${v}<span class="u">${u || ""}</span></div>`);
  const bpct = dev.battery_pct;
  const bstat = stat("电量", bpct != null ? bpct : "—", "%");
  if (bpct != null && bpct < 20) bstat.classList.add("low");
  if (dev.battery_recorded) {
    bstat.title = `电量:${bpct != null ? bpct + "%" : "—"}${dev.battery_v ? " (" + dev.battery_v + " V)" : ""}\n${batteryRecordedLabel(dev)}`;
  }
  stats.append(bstat);
  const fresh = dev.fresh_hours != null ? (dev.fresh_hours < 1 ? "<1" : Math.round(dev.fresh_hours)) : "—";
  stats.append(stat("上次同步", fresh, " 小时前"));
  stats.append(stat("历史", num(dev.days_of_data), " 天"));
  stats.append(stat("事件", (dev.raw_events ?? dev.total_events ?? 0).toLocaleString()));
  box.append(stats);
  const battery = batteryChart(dev.battery_history || []);
  if (battery) box.append(battery);

  // left = data streams (what the ring is recording)
  const left = el("div");
  const streams = dev.streams || [];
  if (streams.length) {
    left.append(el("p", "subhead", "已采集的数据"));
    const max = Math.max(...streams.map((s) => s.count), 1);
    const sc = el("div", "streams");
    streams.forEach((s) => {
      const row = el("div", "stream");
      const nm = el("span", "s-name");
      nm.textContent = zh(s.name);
      const bar = el("span", "s-bar");
      const fill = el("i");
      fill.style.width = Math.max(3, (s.count / max) * 100) + "%";
      bar.append(fill);
      const val = el("span", "s-val");
      val.textContent = s.count.toLocaleString();
      row.append(nm, bar, val);
      sc.append(row);
    });
    left.append(sc);
  }
  box.append(left);

  // right = insights
  const right = el("div");
  right.append(el("p", "subhead", "可用的分析"));
  const ins = el("div", "insights");
  (dev.insights || []).forEach((i) => {
    const row = el("div", "insight");
    row.append(el("div", null, `${zh(i.name)}${i.status === "gated" && i.why ? `<span class="why"> · ${zh(i.why)}</span>` : ""}`));
    const st = el("span", "status " + i.status);
    st.innerHTML = `<i></i>${zh(i.status)}`;
    row.append(st);
    ins.append(row);
  });
  right.append(ins);
  box.append(right);

  // ── advanced / debugging (collapsed by default) ──────────────────────────
  const adv = el("details", "dh-advanced");
  const sum = el("summary");
  sum.innerHTML = `<span class="ic" style="--i:url(/icons/cpu.svg)"></span>高级与调试<span class="chev"></span>`;
  adv.append(sum);
  const ab = el("div", "adv-body");

  // device identity + sync internals
  ab.append(el("p", "subhead", "设备"));
  const kv = el("div", "adv-kv");
  const kvItem = (k, v) => `<div><i>${k}</i><b>${v}</b></div>`;
  const rawTotal = dev.raw_events ?? dev.total_events ?? 0;
  const decodedTotal = dev.decoded_events ?? dev.total_events ?? 0;
  const historyDetail = `跨度 ${num(dev.days_of_data)} 天` +
    (dev.observed_days != null ? ` · 有数据 ${dev.observed_days} 天` : "") +
    (dev.observed_coverage_days != null ? `(活跃 ${num(dev.observed_coverage_days)} 天)` : "");
  kv.innerHTML =
    kvItem("戒指 ID", esc(dev.serial || "—")) +
    kvItem("固件", esc(dev.firmware || "—")) +
    kvItem("API", esc(dev.api_version || "—")) +
    kvItem("MAC", esc(dev.mac || "—")) +
    kvItem("硬件", esc(dev.hardware_id || "—")) +
    kvItem("电量", dev.battery_v != null ? `${dev.battery_pct != null ? dev.battery_pct + "%" : "—"} · ${dev.battery_v} V` + (dev.battery_recorded ? `<br><span style="color:var(--faint);font-size:11px">记录于 ${zh(dev.battery_recorded)}${dev.battery_recorded_hm ? " " + dev.battery_recorded_hm : ""}</span>` : "") : (dev.battery_pct != null ? `${dev.battery_pct}%` : "—")) +
    kvItem("上次同步", `${esc(zh(dev.synced) || "—")} ${esc(dev.synced_hm || "")}`) +
    kvItem("同步游标", dev.next_cursor != null ? dev.next_cursor.toLocaleString() : "—") +
    kvItem("历史", historyDetail) +
    kvItem("事件", `原始 ${rawTotal.toLocaleString()} · 已解码 ${decodedTotal.toLocaleString()}`);
  ab.append(kv);

  // local auth key portability
  ab.append(el("p", "subhead", "戒指认证密钥"));
  const keyTools = el("div", "key-tools");
  const exportBtn = el("button", "btn-text key-btn", "导出 / 二维码");
  exportBtn.type = "button";
  exportBtn.title = "显示本地戒指认证密钥的复制、下载和二维码选项。";
  exportBtn.addEventListener("click", exportRingKey);
  const importBtn = el("button", "btn-text key-btn", "导入 / 扫描");
  importBtn.type = "button";
  importBtn.title = "粘贴、上传或扫描戒指认证密钥。";
  importBtn.addEventListener("click", openImportKeyDialog);
  keyTools.append(exportBtn, importBtn);
  ab.append(keyTools);

  // capability toggles
  ab.append(el("p", "subhead", "功能 · 点按切换"));
  const caps = el("div", "caps");
  (dev.measuring || []).forEach((m) => {
    const row = el("div", "cap" + (m.on ? " on" : ""));
    const ic = el("span", "ic");
    ic.style.setProperty("--i", `url(/icons/${capIcon(m.name)}.svg)`);
    const nm = el("span", "cap-name");
    nm.textContent = zh(m.name);
    const sw = el("span", "switch", "<i></i>");
    row.append(ic, nm, sw);
    if (m.feature) {
      row.classList.add("interactive");
      row.title = `点按${m.on ? "关闭" : "开启"}(会连接戒指)`;
      row.addEventListener("click", () => doFeature(m.feature, m.name, m.on, row));
    }
    caps.append(row);
  });
  ab.append(caps);

  const ev = dev.event_counts || [];
  if (ev.length) {
    ab.append(el("p", "subhead", `事件流 · ${ev.length} 种`));
    const emax = Math.max(...ev.map((e) => e.count), 1);
    const tbl = el("div", "ev-table");
    ev.forEach((e) => {
      const row = el("div", "ev-row");
      const nm = el("span", "ev-n");
      nm.textContent = e.name;
      const bar = el("span", "ev-bar");
      const fi = el("i");
      fi.style.width = Math.max(2, (e.count / emax) * 100) + "%";
      bar.append(fi);
      const c = el("span", "ev-c");
      c.textContent = e.count.toLocaleString();
      row.append(nm, bar, c);
      tbl.append(row);
    });
    ab.append(tbl);
  }
  adv.append(ab);
  box.append(adv);
}

function ringKeyFilename() {
  const serial = (LAST_DEVICE_SERIAL || "oura-ring").replace(/[^A-Za-z0-9_.-]+/g, "-");
  return `${serial}.key`;
}

async function exportRingKey() {
  try {
    const j = await fetchRingKey();
    if (!j) return;
    if (!j.ok) {
      toast(zh(j.message) || "没有配置密钥文件。请用 --key-file 启动仪表盘。", "error");
      return;
    }
    openExportKeyDialog(j.key);
  } catch {
    toast("无法导出戒指认证密钥。", "error");
  }
}

async function fetchRingKey() {
  const r = await getDash("/api/ring-key");
  if (!r.ok) {
    toast("重启仪表盘服务器后才能导出密钥。", "error");
    return null;
  }
  return await r.json();
}

async function copyText(text, ok = "已复制。") {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok, "ok");
  } catch {
    toast("无法写入剪贴板。", "error");
  }
}

function downloadRingKey(key) {
  const blob = new Blob([key + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = ringKeyFilename();
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast("已下载戒指认证密钥。", "ok");
}

function openExportKeyDialog(key) {
  let dlg = $("key-export-dialog");
  if (!dlg) {
    dlg = el("dialog", "dialog key-dialog");
    dlg.id = "key-export-dialog";
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
  }
  dlg.innerHTML = `
    <form method="dialog">
      <h3>戒指认证密钥</h3>
      <p class="dialog-sub">在另一台运行 open_oura、连接同一枚戒指的电脑上使用。</p>
      <div class="qr-wrap"><canvas id="key-qr" width="232" height="232" aria-label="戒指认证密钥二维码"></canvas></div>
      <input id="key-export-value" class="key-field" readonly value="${esc(key)}" />
      <div class="dialog-actions key-actions">
        <button type="button" id="key-copy" class="btn-primary">复制</button>
        <button type="button" id="key-download" class="btn-text">下载</button>
        <button class="btn-text">关闭</button>
      </div>
    </form>`;
  dlg.querySelector("#key-copy").addEventListener("click", () => copyText(key, "已复制戒指认证密钥。"));
  dlg.querySelector("#key-download").addEventListener("click", () => downloadRingKey(key));
  dlg.showModal();
  drawQr($("key-qr"), key.toUpperCase());
}

function openImportKeyDialog() {
  let dlg = $("key-import-dialog");
  if (!dlg) {
    dlg = el("dialog", "dialog key-dialog");
    dlg.id = "key-import-dialog";
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeImportKeyDialog(); });
    document.body.append(dlg);
  }
  const canScan = "BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  dlg.innerHTML = `
    <form method="dialog">
      <h3>导入戒指密钥</h3>
      <p class="dialog-sub">粘贴 32 位十六进制密钥、上传 .key 文件,或扫描导出的二维码。</p>
      <textarea id="key-import-value" class="key-field key-textarea" spellcheck="false" autocomplete="off" placeholder="32 位十六进制字符"></textarea>
      <video id="key-scan-video" class="key-video" playsinline muted hidden></video>
      <div class="dialog-actions key-actions">
        <button type="button" id="key-import-save" class="btn-primary">导入</button>
        <button type="button" id="key-import-file" class="btn-text">文件</button>
        <button type="button" id="key-import-scan" class="btn-text"${canScan ? "" : " disabled"}>扫描</button>
        <button type="button" id="key-import-close" class="btn-text">关闭</button>
      </div>
      <input id="key-import-file-input" class="key-input" type="file" accept=".key,text/plain" />
    </form>`;
  dlg.querySelector("#key-import-save").addEventListener("click", () => importRingKeyText($("key-import-value").value));
  dlg.querySelector("#key-import-file").addEventListener("click", () => $("key-import-file-input").click());
  dlg.querySelector("#key-import-file-input").addEventListener("change", (e) => importRingKeyFile(e.target));
  dlg.querySelector("#key-import-scan").addEventListener("click", startKeyScan);
  dlg.querySelector("#key-import-close").addEventListener("click", closeImportKeyDialog);
  dlg.showModal();
}

function closeImportKeyDialog() {
  stopKeyScan();
  const dlg = $("key-import-dialog");
  if (dlg) dlg.close();
}

let KEY_SCAN_STREAM = null;
let KEY_SCAN_STOP = false;

async function startKeyScan() {
  try {
    const video = $("key-scan-video");
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    KEY_SCAN_STOP = false;
    KEY_SCAN_STREAM = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = KEY_SCAN_STREAM;
    video.hidden = false;
    await video.play();
    const scan = async () => {
      if (KEY_SCAN_STOP) return;
      const codes = await detector.detect(video).catch(() => []);
      const raw = codes[0] && codes[0].rawValue;
      if (raw) {
        $("key-import-value").value = raw.trim();
        stopKeyScan();
        toast("已扫描二维码。", "ok");
        return;
      }
      requestAnimationFrame(scan);
    };
    scan();
  } catch {
    toast("这个浏览器不支持用摄像头扫描二维码。", "error");
    stopKeyScan();
  }
}

function stopKeyScan() {
  KEY_SCAN_STOP = true;
  if (KEY_SCAN_STREAM) KEY_SCAN_STREAM.getTracks().forEach((t) => t.stop());
  KEY_SCAN_STREAM = null;
  const video = $("key-scan-video");
  if (video) {
    video.pause();
    video.srcObject = null;
    video.hidden = true;
  }
}

async function importRingKeyFile(input) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  try {
    await importRingKeyText(await file.text());
  } catch {
    toast("无法读取这个密钥文件。", "error");
  }
}

async function importRingKeyText(text) {
  const key = (text || "").trim();
  if (!/^[0-9a-fA-F]{32}$/.test(key)) {
    toast("认证密钥必须正好是 32 位十六进制字符。", "error");
    return;
  }
  try {
    const j = await (await postDash("/api/ring-key", { key })).json();
    if (j.ok) {
      closeImportKeyDialog();
      toast("已导入戒指认证密钥。", "ok");
    }
    else toast(zh(j.message) || "无法导入戒指认证密钥。", "error");
  } catch {
    toast("连接不上本地仪表盘服务器。", "error");
  }
}

// Fixed QR Code version 2-L generator, enough for this 32-char hex key.
function drawQr(canvas, text) {
  const n = 25, modules = Array.from({ length: n }, () => Array(n).fill(false));
  const reserved = Array.from({ length: n }, () => Array(n).fill(false));
  const set = (x, y, v, r = true) => { if (x >= 0 && y >= 0 && x < n && y < n) { modules[y][x] = v; if (r) reserved[y][x] = true; } };
  const finder = (x, y) => {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const xx = x + dx, yy = y + dy;
      const on = dx >= 0 && dy >= 0 && dx <= 6 && dy <= 6 && (dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(xx, yy, on);
    }
  };
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(18 + dx, 18 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  set(8, n - 8, true);
  reserveFormatAreas(reserved);
  const data = qrDataCodewords(text), ecc = qrRs(data, 10), bits = [];
  data.concat(ecc).forEach((b) => { for (let i = 7; i >= 0; i--) bits.push(((b >>> i) & 1) === 1); });
  let k = 0, up = true;
  for (let x = n - 1; x > 0; x -= 2) {
    if (x === 6) x--;
    for (let yy = 0; yy < n; yy++) {
      const y = up ? n - 1 - yy : yy;
      for (let dx = 0; dx < 2; dx++) {
        const xx = x - dx;
        if (reserved[y][xx]) continue;
        let bit = bits[k++] || false;
        if ((xx + y) % 2 === 0) bit = !bit;
        set(xx, y, bit, false);
      }
    }
    up = !up;
  }
  placeFormat(modules, reserved, 1, 0);
  const ctx = canvas.getContext("2d"), scale = Math.floor(canvas.width / (n + 8)), off = Math.floor((canvas.width - n * scale) / 2);
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules[y][x]) ctx.fillRect(off + x * scale, off + y * scale, scale, scale);
}

function reserveFormatAreas(reserved) {
  const n = reserved.length;
  for (let i = 0; i <= 5; i++) reserved[i][8] = true;
  reserved[7][8] = true; reserved[8][8] = true; reserved[8][7] = true;
  for (let i = 9; i < 15; i++) reserved[8][14 - i] = true;
  for (let i = 0; i < 8; i++) reserved[8][n - 1 - i] = true;
  for (let i = 8; i < 15; i++) reserved[n - 1 - (14 - i)][8] = true;
}

function qrDataCodewords(text) {
  const alpha = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(2, 4); push(text.length, 9);
  for (let i = 0; i < text.length; i += 2) {
    const a = alpha.indexOf(text[i]), b = alpha.indexOf(text[i + 1]);
    if (b >= 0) push(a * 45 + b, 11); else push(a, 6);
  }
  push(0, Math.min(4, 272 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let p = 0; out.length < 34; p++) out.push(p % 2 ? 0x11 : 0xec);
  return out;
}

function qrRs(data, count) {
  const mul = (x, y) => { let z = 0; for (; y; y >>>= 1) { if (y & 1) z ^= x; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); } return z & 255; };
  let gen = [1];
  for (let i = 0, root = 1; i < count; i++, root = mul(root, 2)) {
    const next = Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { next[j] ^= mul(c, root); next[j + 1] ^= c; });
    gen = next;
  }
  const rem = Array(count).fill(0);
  data.forEach((b) => {
    const factor = b ^ rem.shift();
    rem.push(0);
    gen.slice(0, count).forEach((c, i) => { rem[i] ^= mul(c, factor); });
  });
  return rem;
}

function placeFormat(modules, reserved, ecl, mask) {
  let data = (ecl << 3) | mask, rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const set = (x, y, i) => { modules[y][x] = ((bits >>> i) & 1) === 1; reserved[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, i);
  set(8, 7, 6); set(8, 8, 7); set(7, 8, 8);
  for (let i = 9; i < 15; i++) set(14 - i, 8, i);
  for (let i = 0; i < 8; i++) set(24 - i, 8, i);
  for (let i = 8; i < 15; i++) set(8, 24 - (14 - i), i);
}

function renderActions(d) {
  const dev = d.device || {};
  const b = $("batt");
  if (dev.battery_pct != null) {
    b.innerHTML = icon("battery-high") + `<span>${dev.battery_pct}%</span>`;
    b.classList.toggle("low", dev.battery_pct < 20);
    b.hidden = false;
    let title = `戒指电量 ${dev.battery_pct}%`;
    if (dev.battery_v) title += ` · ${dev.battery_v} V`;
    const rec = batteryRecordedLabel(dev);
    if (rec) title += `\n${rec}`;
    b.title = title;
  } else {
    b.hidden = true;
  }
  $("foot-meta").textContent = `${dev.nights || 0} 晚 · ${(dev.total_events || 0).toLocaleString()} 条事件`;
}

// ── profile dialog ──────────────────────────────────────────
function openProfile() {
  const p = CURRENT_PROFILE || {};
  $("f-sex").value = p.sex || "M";
  $("f-age").value = p.age ?? 30;
  $("f-height").value = p.height_m ?? 1.78;
  $("f-weight").value = p.weight_kg ?? 75;
  $("profile-dialog").showModal();
}
async function saveProfile(e) {
  e.preventDefault();
  const body = {
    sex: $("f-sex").value,
    age: +$("f-age").value,
    height_m: +$("f-height").value,
    weight_kg: +$("f-weight").value,
    ring_size: (CURRENT_PROFILE && CURRENT_PROFILE.ring_size) || 10, // not on the ring; kept default
  };
  $("profile-save").disabled = true;
  try {
    const r = await postDash("/api/profile", body);
    const j = await r.json().catch(() => ({}));
    // the server replies 200 with an { error } body on write failures — surface it
    // and keep the dialog open instead of pretending the save succeeded.
    if (!r.ok || j.error) {
      toast(j.error || "无法保存个人资料。", "error");
      return;
    }
    $("profile-dialog").close();
    await load(); // re-runs CVA with the new demographics
  } catch {
    toast("连接不上本地服务器。", "error");
  } finally {
    $("profile-save").disabled = false;
  }
}

// ── sync ────────────────────────────────────────────────────
function toast(msg, kind = "info") {
  let t = $("toast");
  if (!t) { t = el("div", "toast"); t.id = "toast"; document.body.append(t); }
  t.className = "toast " + kind;
  // status dot + message (textContent on the span keeps the message injection-safe)
  const dot = el("span", "toast-dot");
  const text = el("span", "toast-msg");
  text.textContent = msg;
  t.replaceChildren(dot, text);
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), kind === "error" ? 8000 : 3800);
}

// turn a backend sync error into something actionable
function syncHint(msg) {
  msg = msg || "";
  if (/no matching|not found|no device|no ring/i.test(msg))
    return "找不到你的戒指。把它从充电器上取下,放在附近再试一次。";
  if (/key|auth|unauthor/i.test(msg))
    return "戒指需要认证密钥。请用 --key-file 启动仪表盘。";
  if (/timed out|timeout/i.test(msg))
    return "蓝牙连接超时。确认戒指已唤醒且在附近,然后重试。";
  if (/stopped responding/i.test(msg))
    return "戒指没有响应,这次同步已放弃(已同步的数据会保留)。请稍后再试。";
  return "同步失败:" + zh(msg);
}

async function doSync() {
  const btn = $("sync-btn");
  if (btn.classList.contains("syncing")) return;
  btn.classList.add("syncing");
  $("sync-label").textContent = "同步中";
  btn.title = "正在通过蓝牙连接戒指…";
  try {
    const j = await (await postDash("/api/sync")).json();
    if (j.ok) {
      $("sync-label").textContent = "已同步";
      toast(j.message && !/^synced$/i.test(j.message) ? zh(j.message) : "戒指已同步。", "ok");
      await load();
    } else {
      $("sync-label").textContent = "失败";
      toast(syncHint(j.message), "error");
    }
  } catch (e) {
    $("sync-label").textContent = "失败";
    toast("连接不上本地仪表盘服务器。", "error");
  }
  btn.classList.remove("syncing");
  setTimeout(() => { $("sync-label").textContent = "同步"; btn.title = "通过蓝牙同步戒指"; }, 3000);
}

// ── live heart rate ─────────────────────────────────────────
// POST /api/live-hr streams newline-delimited JSON while the ring is connected:
// {"status":"live"}, then {"bpm":..,"ibi_ms":..} per beat, then {"done":true} or
// {"error":".."}. Aborting the request (Stop) ends the session on the server.
let LIVE_ABORT = null;

function liveHint(msg) {
  msg = msg || "";
  if (/no matching|not found|no device|no ring/i.test(msg))
    return "找不到你的戒指。请戴在手指上、靠近 Mac,再试一次。";
  if (/key|auth|unauthor/i.test(msg))
    return "戒指需要认证密钥。请用 --key-file 启动仪表盘。";
  return "实时心率失败:" + zh(msg);
}

function liveSummary(beats) {
  if (!beats.length) return "没有捕捉到心跳。请确认戒指戴在手指上。";
  const avg = Math.round(beats.reduce((a, b) => a + b, 0) / beats.length);
  return `${beats.length} 次心跳 · 平均 ${avg} · 最低 ${Math.min(...beats)} · 最高 ${Math.max(...beats)} bpm`;
}

async function toggleLive() {
  if (LIVE_ABORT) { LIVE_ABORT.abort(); return; }
  const abort = (LIVE_ABORT = new AbortController());
  const beats = [];
  const status = $("live-status");
  $("live-btn").classList.add("live-on");
  $("live-label").textContent = "停止";
  $("live-bpm").textContent = "—";
  $("live-spark").innerHTML = "";
  status.textContent = "正在连接戒指… 请把手放在 Mac 附近(最多 2 分钟)。";
  let end = null;
  try {
    const r = await fetch("/api/live-hr", { method: "POST", headers: { ...DASH_HEADERS }, signal: abort.signal });
    if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.status === "live") status.textContent = "正在实时读取。戒指检测到心跳就会显示。";
        else if (m.bpm != null) {
          beats.push(m.bpm);
          $("live-bpm").textContent = m.bpm;
          $("live-spark").innerHTML = sparkline(beats.slice(-60));
          status.textContent = liveSummary(beats);
          const dot = $("live-dot");
          dot.classList.remove("beat");
          void dot.offsetWidth; // restart the pulse animation
          dot.classList.add("beat");
        } else if (m.error) end = liveHint(m.error);
        else if (m.done) end = beats.length ? "完成。" + liveSummary(beats) : liveSummary(beats);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") end = beats.length ? "已停止。" + liveSummary(beats) : "已停止。";
    else end = "连接不上本地仪表盘服务器。";
  }
  status.textContent = end || liveSummary(beats);
  LIVE_ABORT = null;
  $("live-btn").classList.remove("live-on");
  $("live-label").textContent = "开始";
}

// ── load ────────────────────────────────────────────────────
// show the error in the headline and stop every panel's loading shimmer, so the
// page reads as "errored" rather than stuck mid-load.
function showLoadError(msg) {
  document.querySelectorAll(".skeleton").forEach((el) => {
    if (el.id === "digest") return; // handled below — keep it for the message
    el.remove();
  });
  const dg = $("digest");
  dg.classList.remove("skeleton", "skeleton-text");
  dg.classList.add("reveal");
  dg.textContent = msg;
}

// ── auto-refresh: data synced behind the page's back (`oura watch`, a terminal sync) ──
// Poll the server's cheap version stamp — not the summary — and reload when it moves.
// Only while the page is in view and the user isn't mid-task (a day page, a dialog,
// a sync or a live session), so a refresh never yanks something out from under them.
let DATA_VERSION = null; // the version the current render reflects
async function dataVersion() {
  try {
    return (await (await fetch("/api/data-version")).json()).version ?? null;
  } catch (_) {
    return null; // an older server without the endpoint: just no auto-refresh
  }
}
async function autoRefresh() {
  const busy = document.hidden || document.body.classList.contains("page-open") ||
    document.querySelector("dialog[open]") || $("sync-btn").classList.contains("syncing") || LIVE_ABORT;
  if (busy || DATA_VERSION == null) return;
  const v = await dataVersion();
  if (v != null && v !== DATA_VERSION) load();
}

let LOAD_SEQ = 0;
async function load() {
  // guard against overlapping loads (sync/profile-save during an in-flight build):
  // a slower earlier response must not overwrite a newer one.
  const seq = ++LOAD_SEQ;
  // read before the summary, so a sync landing mid-load reads as newer on the next poll
  const version = await dataVersion();
  let d;
  try {
    d = await (await fetch(`/api/summary?tz=${browserTzOffset()}`)).json();
  } catch (e) {
    if (seq === LOAD_SEQ) showLoadError("连接不上本地服务器。");
    return;
  }
  if (seq !== LOAD_SEQ) return; // a newer load() superseded this response — drop it
  DATA_VERSION = version; // also on an error, so the page recovers once data arrives
  if (d.error) {
    showLoadError(d.error);
    return;
  }
  CURRENT_PROFILE = d.profile || null;
  CURRENT_TZ = d.tz || 0;
  LAST_DEVICE_SERIAL = d.device && d.device.serial;
  $("digest").classList.remove("skeleton", "skeleton-text");
  $("digest").classList.add("reveal");
  $("digest").innerHTML = zh(d.digest || "").replace(/([+-]?\d[\d.]*\s?(?:%|bpm|ms|m\/s))/g, '<span class="metric">$1</span>');
  renderActions(d);
  renderTiles(d);
  HR_QUARTER_LOAD = null;
  renderDay(d);
  renderSleepDebt(d);
  renderIllness(d);
  renderCardio(d);
  renderSpo2(d);
  renderDevice(d);
  document.querySelectorAll(".panel").forEach((p, i) => {
    p.classList.add("reveal");
    p.style.setProperty("--d", i * 60 + "ms");
  });
}

$("sync-btn").addEventListener("click", doSync);
$("live-btn").addEventListener("click", toggleLive);
$("profile-btn").addEventListener("click", openProfile);
$("profile-form").addEventListener("submit", saveProfile);
$("profile-cancel").addEventListener("click", () => $("profile-dialog").close());
load();
setInterval(autoRefresh, 60 * 1000);
document.addEventListener("visibilitychange", autoRefresh);

// ── research export: raw CSVs for a window, built by oura-summary::research_export ──
(function researchExport() {
  const form = document.getElementById("research-form");
  if (!form) return;
  const pad = (n) => String(n).padStart(2, "0");
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const start = new Date(); start.setDate(start.getDate() - 1); start.setHours(20, 0, 0, 0);
  const end = new Date(); end.setHours(12, 0, 0, 0);
  form.querySelector("#rx-start").value = local(start);
  form.querySelector("#rx-end").value = local(end);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const status = form.querySelector("#rx-status");
    const s = new Date(form.querySelector("#rx-start").value);
    const t = new Date(form.querySelector("#rx-end").value);
    const streams = [...form.querySelectorAll("#rx-streams input:checked")].map((i) => i.value);
    if (!(t > s)) { status.textContent = "结束时间必须晚于开始时间。"; return; }
    if (!streams.length) { status.textContent = "请至少选择一种数据。"; return; }
    const q = new URLSearchParams({
      start: String(s.getTime() / 1000), end: String(t.getTime() / 1000),
      streams: streams.join(","), tz: String(-s.getTimezoneOffset() / 60),
    });
    const a = document.createElement("a");
    a.href = `/api/research-export?${q}`;
    document.body.append(a); a.click(); a.remove();
    status.textContent = "正在准备 ZIP,准备好后浏览器会自动保存。";
  });
  form.querySelector("#rx-mark").addEventListener("click", async () => {
    const status = form.querySelector("#rx-status");
    const label = form.querySelector("#rx-label").value;
    try {
      const r = await fetch("/api/research-marker", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Oura-Dash": "1" },
        body: JSON.stringify({ label }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      status.textContent = `已在 ${new Date(j.unix * 1000).toLocaleTimeString("zh-CN")} 打上标记,会出现在 markers.csv 里。`;
    } catch (err) {
      status.textContent = `无法保存标记:${err.message}`;
    }
  });
})();
