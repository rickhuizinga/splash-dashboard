/* Splash Engine dashboard — frontend (vanilla JS, no framework, no build).
 * Polls /api/status every 5 s; consumes /api/log SSE. All history is
 * client-side (ring buffers / histogram base) — the engine has no time
 * series. Engine down => explicit DOWN banner, last-known-good values
 * dimmed, never silent zeros.
 */
"use strict";
const $ = (id) => document.getElementById(id);
const GIB = 1073741824;

/* Fit-on-screen mode. "1"/absent = fit (default, panels compress to the
 * viewport, no page scroll); "0" = full (panels at natural height, page
 * scrolls). The <head> script in index.html applies the persisted class to
 * <html> BEFORE first paint (no flash); here we only (re)sync the control
 * and handle live toggling. Key name must match index.html's head script. */
const FIT_KEY = "splashDashFitMode";
function fitMode() { return localStorage.getItem(FIT_KEY) === "0" ? "full" : "fit"; }
function applyFitMode(mode) {
  document.documentElement.classList.toggle("full", mode === "full");
}
function setFitMode(mode) {
  localStorage.setItem(FIT_KEY, mode === "full" ? "0" : "1");
  applyFitMode(mode);
  const tgl = $("fitTgl");
  if (tgl) tgl.checked = mode === "fit";
}

const S = {
  status: null,        // last good /status payload
  engine: "unknown",   // unknown | ok | down | auth
  startedAt: null,     // last-seen instance.started_at (restart detection)
  prev: {},            // previous poll values (delta arrows)
  histBase: null,      // cumulative buckets at reset (per metric) — see below
  histSamples: {},     // diffed counts since reset (per metric)
  lastEdgeKeys: {},    // per-metric key of last rendered bucket edge set
  lastPollAt: null,
  // log pane
  atBottom: true,
  paused: false,       // manual pause (button / "p")
  newLines: 0,         // lines added while not at bottom
  logBuf: [],
};

/* ---------------- formatting helpers ---------------- */
function fmtInt(n) { return (n == null) ? "—" : Math.round(n).toLocaleString("en-US"); }
function fmtGiB(b) { return (b == null) ? "—" : (b / GIB).toFixed(1) + " GiB"; }
function fmtPct(x, dp = 1) { return (x == null) ? "—" : (x * 100).toFixed(dp) + "%"; }
function fmtTps(x) { return (x == null) ? "—" : x.toFixed(1) + " tok/s"; }
function humanMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return (ms / 60000).toFixed(1) + "m";
}
function humanDur(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
function shortModel(m) {
  if (!m) return "—";
  const i = m.indexOf("/");
  return i >= 0 ? m.slice(i + 1) : m;
}
function shortMacos(v) {
  if (!v) return "—";
  let p = v.split(".");
  while (p.length > 2 && p[p.length - 1] === "0") p.pop();
  return p.join(".");
}
function trendArrow(cur, prev, tol = 1) {
  if (cur == null || prev == null) return "";
  const d = cur - prev;
  if (d > tol) return `<span class="trend up">▲</span>`;
  if (d < -tol) return `<span class="trend down">▼</span>`;
  return `<span class="trend">·</span>`;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------------- status poll ---------------- */
async function pollStatus() {
  let body = null;
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (r.ok) body = await r.json();
  } catch (e) { /* offline / backend restart — keep last state */ }
  if (!body) {
    if (S.engine !== "down") setEngineState("down", "dashboard backend unreachable");
    return;
  }
  if (!body.ok) {
    setEngineState(body.payload && body.payload.code || "down",
                    body.payload && body.payload.detail || "unknown");
    return;
  }
  const st = body.payload;
  const prevStarted = S.startedAt;
  S.status = st;
  setEngineState("ok");
  const sa = (st.instance || {}).started_at;
  if (S.startedAt != null && sa != null && sa !== S.startedAt) {
    onEngineRestart(sa);
  }
  S.startedAt = sa;
  // histogram base: seed on first good poll; reset after a restart.
  // Store the FULL edgeCum() result ({edges, cum}) — renderHistograms reads
  // base.edges.join(",") to detect shape drift, so a bare cum array would
  // throw on every bucket change and leave the panel empty.
  if (!S.histBase) {
    S.histBase = {};
    S.histSamples = {};
    for (const k of ["ttft", "itl", "queue"]) {
      const secName = k === "itl" ? "output_interval" : k === "queue" ? "native_queue" : "ttft";
      const ec = edgeCum(st.latency && st.latency[secName]);
      if (!ec) { S.histBase[k] = null; continue; }
      S.histBase[k] = ec;               // baseline = what the engine already has
      S.histSamples[k] = { count: 0, dist: zeros(BUCKET_EDGES.length) };
    }
  }
  renderAll(st);
  S.lastPollAt = Date.now();
}

function setEngineState(state, detail) {
  S.engine = state;
  const dot = $("hdot"), txt = $("readyTxt"), banner = $("banner");
  dot.className = "dot " + (state === "ok" ? "on" : state === "auth" ? "warn" : "off");
  if (state === "ok" && S.status) {
    txt.textContent = S.status.ready ? "READY" : "NOT READY";
    txt.style.color = S.status.ready ? "var(--green)" : "var(--amber)";
    banner.className = ""; banner.textContent = "";
    document.body.classList.remove("stale");
  } else if (state === "auth") {
    txt.textContent = "AUTH?";
    txt.style.color = "var(--amber)";
    banner.className = "auth show";
    banner.innerHTML = `SPLASH_API_KEY mismatch — the engine rejected the dashboard's key (HTTP 401/403). ` +
      `Check $SPLASH_API_KEY in the dashboard environment matches the engine's --api-key ` +
      `(plist: <code>~/Library/LaunchAgents/ai.splash.serve.plist</code>), then restart the dashboard.`;
    document.body.classList.add("stale");
  } else {
    txt.textContent = "DOWN";
    txt.style.color = "var(--red)";
    banner.className = "show";
    banner.innerHTML = `ENGINE DOWN — launchd will restart it (KeepAlive). ` +
      `Check <code>launchctl print gui/501/ai.splash.serve</code> and ` +
      `<code>~/Library/Logs/splash/splash.err.log</code>. Last known-good values shown below (stale).`;
    document.body.classList.add("stale");
  }
  $("hLastPoll").textContent = "last poll " + (S.lastPollAt ?
    new Date(S.lastPollAt).toLocaleTimeString() : "—") +
    (state !== "ok" ? " · " + (detail || "") : "");
}

function onEngineRestart(sa) {
  // counters & latency buckets are engine-lifetime: reset client history.
  S.histBase = null;
  S.histSamples = {};
  S.lastEdgeKeys = {};
  S.prev = {};
  insertDivider("⟳ engine restarted " +
    (sa ? new Date(sa * 1000).toLocaleTimeString() + " — " : "") +
    "<b>counters &amp; histograms reset to engine lifetime</b>", "");
  S.newLines = 0;
}

function zeros(n) { return new Array(n).fill(0); }

/* The engine reports cumulative buckets keyed by upper edge (seconds) plus a
 * "+Inf" terminal. Returns {edges:[...sorted, Inf], cum:[...counts]} or null. */
function edgeCum(sec) {
  if (!sec || !sec.buckets) return null;
  const keys = Object.keys(sec.buckets)
    .map((e) => (e === "+Inf" ? Infinity : parseFloat(e)))
    .sort((a, b) => a - b);
  if (!keys.length) return null;
  return { edges: keys,
           cum: keys.map((e) => sec.buckets[Number.isFinite(e) ? String(e) : "+Inf"] || 0) };
}

/* ---------------- render ---------------- */
function renderAll(st) {
  const p = st || S.status || {};
  renderHeader(p);
  renderKpis(p);
  renderLive(p);
  renderCounters(p);
  renderMemory(p);
  renderHistograms(p);
  if (st) {
    $("rawPre").textContent = JSON.stringify(st, null, 2);
    S.prev = {
      decode: (p.metrics || {}).decode_tokens_per_second,
      prefill: (p.metrics || {}).prefill_tokens_per_second,
    };
  }
}

function renderHeader(p) {
  const ins = p.instance || {};
  if (ins.model) $("hModel").textContent = "— " + shortModel(ins.model);
  if (ins.port != null) $("hPort").textContent = ins.port;
  if (ins.pid != null) $("hPid").textContent = ins.pid;
  $("hSchema").textContent = "v" + (p.schema_version != null ? p.schema_version : "—");
  const b = p.identity && p.identity.cache && p.identity.cache.build_id;
  $("hBuild").textContent = b ? b.slice(0, 8) : "—";
  $("hCtx").textContent = "context " + fmtInt(p.maximum_context_tokens) + " tokens";
  // uptime ticks every second
  tickUptime();
  // device line
  const d = p.memory_plan && p.memory_plan.device;
  const dev = [];
  if (d && d.device_name) dev.push(d.device_name);
  if (d && d.gpu_core_count != null) dev.push(d.gpu_core_count + " GPU cores");
  if (d && d.macos_version) dev.push("macOS " + shortMacos(d.macos_version));
  $("devline").textContent = dev.join(" · ");
}

let _upTimer = null;
function tickUptime() {
  if (_upTimer) clearInterval(_upTimer);
  const upd = () => {
    const ins = (S.status || {}).instance || {};
    const el = $("hUp");
    if (ins.started_at) {
      const s = Math.max(0, Date.now() / 1000 - ins.started_at);
      el.textContent = humanDur(s);
    } else {
      el.textContent = "—";
    }
  };
  upd();
  _upTimer = setInterval(upd, 1000);
}

function renderKpis(p) {
  const m = p.metrics || {}, c = p.cache || {};
  const dDec = m.decode_tokens_per_second, dPre = m.prefill_tokens_per_second;
  $("vDecode").innerHTML = dDec != null
    ? dDec.toFixed(1) + ' <span class="unit">tok/s</span>' : "—";
  $("tDecode").innerHTML = trendArrow(dDec, S.prev.decode);
  $("sDecode").textContent = "engine-lifetime";
  $("vPrefill").innerHTML = dPre != null
    ? dPre.toFixed(1) + ' <span class="unit">tok/s</span>' : "—";
  $("tPrefill").innerHTML = trendArrow(dPre, S.prev.prefill);
  $("sPrefill").textContent = "engine-lifetime";
  $("vDraft").textContent = m.draft_acceptance_rate != null
    ? fmtPct(m.draft_acceptance_rate) : "—";
  $("sDraft").textContent = (m.drafted_tokens != null ?
    `${fmtInt(m.accepted_draft_tokens)}/${fmtInt(m.drafted_tokens)} drafted` : "") +
    (m.metal_failures ? ` · ${m.metal_failures} metal fails` : "");
  $("vCache").textContent = c.hit_rate != null ? fmtPct(c.hit_rate) : "—";
  $("sCache").textContent = `${fmtInt(c.hits)}/${fmtInt(c.lookups)} lookups · ` +
    `${fmtInt(c.kv_hit_tokens)} tok reused`;
  const tt = m.ttft_ms || {};
  $("vTtft").textContent = tt.p50 != null ? humanMs(tt.p50) : "—";
  $("sTtft").textContent = "p50 · p95 " + humanMs(tt.p95) +
    ` · n=${tt.samples != null ? tt.samples : "—"}`;
  const it = m.itl_ms || {};
  $("vItl").textContent = it.p50 != null ? humanMs(it.p50) : "—";
  $("sItl").textContent = "p50 · p95 " + humanMs(it.p95) +
    ` · n=${it.samples != null ? it.samples : "—"}`;
}

function rows(pairs) {
  return pairs.map(([k, v, cls]) =>
    `<tr><td class="k">${k}</td><td class="v ${cls || ""}">${v}</td></tr>`).join("");
}

function renderLive(p) {
  const sc = p.scheduler || {}, m = p.metrics || {};
  $("schedT").innerHTML = rows([
    ["prefilling", fmtInt(sc.prefilling)],
    ["decoding", fmtInt(sc.decoding)],
    ["queued", fmtInt(sc.queued), sc.queued ? "warn" : ""],
    ["waiting_prefix", fmtInt(sc.waiting_prefix)],
    ["waiting_resources", fmtInt(sc.waiting_resources)],
    ["terminal", fmtInt(sc.terminal)],
    ["decode batches by width",
     `b1 ${fmtInt(sc.decode_batches_by_width && sc.decode_batches_by_width.b1)} · ` +
     `b2 ${fmtInt(sc.decode_batches_by_width && sc.decode_batches_by_width.b2)} · ` +
     `b3 ${fmtInt(sc.decode_batches_by_width && sc.decode_batches_by_width.b3)} · ` +
     `b4 ${fmtInt(sc.decode_batches_by_width && sc.decode_batches_by_width.b4)}`],
  ]);
  const db = m.current_decode_batch || {};
  $("dbatchT").innerHTML = db.valid ? rows([
    ["width", fmtInt(db.width)],
    ["output tok", fmtInt(db.output_tokens)],
    ["drafted / accepted", `${fmtInt(db.drafted_tokens)} / ${fmtInt(db.accepted_draft_tokens)}`],
    ["rate", (db.tokens_per_second != null ? db.tokens_per_second.toFixed(1) : "—") + " tok/s"],
  ]) : '<tr><td class="k">no active decode batch</td></tr>';
}

function renderCounters(p) {
  const rq = p.requests || {}, m = p.metrics || {}, g = p.memory_governor || {},
    st = p.state || {};
  $("cntT").innerHTML = rows([
    ["submitted", fmtInt(rq.submitted)],
    ["completed", fmtInt(rq.completed)],
    ["cancelled", fmtInt(rq.cancelled)],
    ["failed", fmtInt(rq.failed), rq.failed ? "bad" : ""],
    ["capacity failures", fmtInt(m.capacity_failures), m.capacity_failures ? "bad" : ""],
    ["denied reservations", fmtInt(g.denied_reservations), g.denied_reservations ? "warn" : ""],
    ["state evictions", fmtInt(st.evictions)],
  ]);
}

function renderMemory(p) {
  const a = p.memory_actual || {}, g = p.memory_governor || {}, kv = p_kv(p);
  const cur = a.current_bytes, lim = g.limit_bytes;
  const pct = (cur != null && lim) ? Math.min(100, cur / lim * 100) : 0;
  const press = (g.system_pressure || p.memory_pressure || "normal");
  const cls = press === "critical" ? "bad" : press === "warning" ? "warn" : "";
  $("memLine").innerHTML =
    `resident <b>${(cur / GIB).toFixed(1)}</b> / ${lim ? (lim / GIB).toFixed(1) : "—"} GiB ` +
    `<b>${pct.toFixed(0)}%</b> &nbsp;·&nbsp; pressure: <span class="pressure ${press}">${press.toUpperCase()}</span>`;
  const fill = $("memBarFill");
  fill.style.width = pct.toFixed(1) + "%";
  fill.className = cls;
  $("memTag").textContent = `peak ${(a.peak_bytes / GIB).toFixed(1)} GiB`;
  $("kvT").innerHTML = rows([
    ["KV pages", `${fmtInt(kv.pages_active)} active · ${fmtInt(kv.pages_cache)} cache · ` +
      `${fmtInt(kv.pages_free)} free (of ${fmtInt(kv.pages_total)})`],
    ["KV cache bytes", fmtGiB(kv.cache_bytes) + " · backing " + fmtGiB(kv.resident_backing_bytes)],
    ["reclaim", `pending unmaps ${fmtInt(kv.pending_unmaps)} · completed ${fmtInt(kv.unmaps_completed)}`],
    ["governor headroom", fmtGiB(g.headroom_bytes) + " · host " + fmtGiB(g.host_headroom_bytes)],
  ]);
  const ad = p.admission || {};
  $("admT").innerHTML = rows([
    ["admission waiting", fmtInt(ad.waiting) +
      ` (mem ${fmtInt(ad.waiting_memory)} · conc ${fmtInt(ad.waiting_concurrency)})`],
    ["suspended / draining", `${fmtInt(ad.suspended)} / ${ad.draining ? "yes" : "no"}`,
      (ad.suspended || ad.draining) ? "warn" : ""],
    ["oldest wait", humanMs(ad.oldest_wait_ms)],
  ]);
}

function p_kv(p) {
  return p.kv || {};
}

/* ---------------- latency histograms (client-diffed) ----------------
 * The engine reports cumulative buckets since its start. We seed a base on
 * first poll (after any restart) and diff subsequent polls, so the bars show
 * NEW samples observed since page load / engine restart. 10 hand-rolled
 * buckets (no chart lib).
 */
const HIST_DEFS = [
  { key: "ttft",  label: "TTFT",  unit: "s",  ms: null },
  { key: "itl",   label: "ITL",   unit: "s",  ms: 1000 },
  { key: "queue", label: "Queue", unit: "s",  ms: null },
];
const BUCKET_EDGES = [1, 5, 30, 120, 300, 900, 1800, Infinity];
const BUCKET_LABELS = ["<1s", "1-5s", "5-30s", "30-2m", "2-5m", "5-15m", "15-30m", "≥30m"];

function renderHistograms(p) {
  const box = $("histBox");
  box.textContent = "";
  if (!S.histBase || !p || !p.latency) {
    box.innerHTML = '<div style="color:var(--faint)">waiting for first good poll…</div>';
    return;
  }
  let any = false;
  for (const def of HIST_DEFS) {
    const secName = def.key === "itl" ? "output_interval" :
      def.key === "queue" ? "native_queue" : "ttft";
    const sec = p.latency[secName];
    if (!sec || !sec.buckets) continue;
    const cur = edgeCum(sec);
    if (!cur) continue;
    // Re-render EVERY metric that has data. The box is cleared at the top of
    // each poll, so a "skip if cumulative unchanged" gate would leave only the
    // metric(s) that gained samples in that exact poll — i.e. a near-empty
    // panel in steady state (ITL ticks every poll; TTFT/Queue are often quiet).
    // Rebuilding all three is trivially cheap (3 metrics × 8 bars every 5 s).
    S.lastEdgeKeys[def.key] = cur.edges.join(",") + "|" + cur.cum.join(",");
    any = true;
    // The engine reports CUMULATIVE buckets (count of samples <= edge).
    // Diff vs the base, then take per-interval deltas so each sample is
    // counted exactly once, in the bin of its upper edge.
    const base = (S.histBase[def.key] &&
                  S.histBase[def.key].edges.join(",") === cur.edges.join(","))
      ? S.histBase[def.key] : cur;   // shape drifted -> show everything
    const dist = zeros(BUCKET_EDGES.length);
    cur.edges.forEach((edge, i) => {
      // per-interval: samples landing in (edges[i-1], edges[i]]
      const interval = Math.max(0, cur.cum[i] - base.cum[i] -
        (i > 0 ? (cur.cum[i - 1] - base.cum[i - 1]) : 0));
      let bi = BUCKET_EDGES.findIndex((be) =>
        (!Number.isFinite(be) && !Number.isFinite(edge)) ||
        (Number.isFinite(be) && edge <= be));
      if (bi < 0) bi = BUCKET_EDGES.length - 1;  // +Inf edge -> last bin
      dist[bi] += interval;
    });
    const total = dist.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...dist);
    let bars = "", labs = "";
    dist.forEach((v, i) => {
      const h = Math.max(2, Math.round(v / max * 100));
      const hi = v === max && v > 0 ? " hi" : "";
      bars += `<div class="b" title="${BUCKET_LABELS[i]}: ${fmtInt(v)} new"><i style="height:${h}%" class="${hi}"></i></div>`;
      labs += `<span>${BUCKET_LABELS[i]}</span>`;
    });
    const m = p.metrics || {};
    // ttft_ms/itl_ms can be null on idle polls — humanMs(null) prints "—"
    const rt = def.key === "itl" ? m.itl_ms : m.ttft_ms;
    const rtTxt = def.key === "queue" ?
      `count ${fmtInt(sec.count)}` :
      `p50 ${humanMs(rt && rt.p50)}`;
    const el = document.createElement("div");
    el.className = "hist";
    el.innerHTML = `<div class="hcap"><span>${def.label} · new samples since load/reset: <b style="color:var(--fg)">${fmtInt(total)}</b></span><span class="rt">${rtTxt}</span></div>
      <div class="bars">${bars}</div><div class="hlab">${labs}</div>`;
    box.appendChild(el);
  }
  if (!any) {
    box.innerHTML = '<div style="color:var(--faint)">no latency data</div>';
  }
}

/* ---------------- log pane ----------------
 * tail -f behavior: newest at bottom, auto-follows while the user is at the
 * bottom; any scroll up pauses follow and shows a "N new lines" chip; clicking
 * the chip (or the pause button) resumes. Buffer capped at 5,000 nodes.
 *
 * Level coloring (spec): Ready=green Done=default Cancelled=yellow
 * Error=red Loading=blue; anything else dim. Log-line grammar:
 *   HH:MM:SS <Level> · key value · key value …
 * Metric-like tokens (TTFT 135.6s · 4.1 tok/s) are right-aligned.
 */
const LOG_MAX = 5000;
const LINE_RE = /^(\d{2}:\d{2}:\d{2})\s+(\S+)\s*(.*)$/;
const LEVELS = { "Ready": "ready", "Done": "done", "Cancelled": "cancelled",
  "Error": "error", "Loading": "loading" };

function renderLine(raw) {
  const m = raw.match(LINE_RE);
  let ts = "", lv = "", cls = "lv-raw", body = esc(raw);
  if (m) {
    ts = m[1];
    lv = m[2];
    const lk = LEVELS[lv];
    cls = lk ? "lv-" + lk : "lv-raw";
    body = `<span class="lv">${esc(lv)}</span> <span class="rest">${fmtRest(m[3])}</span>`;
  }
  const div = document.createElement("div");
  div.className = "l " + cls;
  div.innerHTML = (ts ? `<span class="ts">${ts}</span> ` : "") + body;
  return div;
}

function fmtRest(rest) {
  // right-align the trailing metric segment (e.g. "TTFT 135.6s · 4.1 tok/s")
  // at the end of the line; everything before it stays left.
  const s = (rest || "").trim();
  let cut = -1;
  // Prefer splitting before "TTFT" so both TTFT and tok/s sit on the right.
  const tt = s.search(/\bTTFT\b/);
  if (tt > 0) {
    const dot = s.lastIndexOf("·", tt);
    cut = dot > 0 ? dot : tt;
  } else {
    const tk = s.search(/\btok\/s\b/);
    if (tk > 0) cut = s.lastIndexOf("·", tk) > 0 ? s.lastIndexOf("·", tk) : tk;
  }
  if (cut <= 0) return esc(s);
  const head = s.slice(0, cut).trim();
  const tail = s.slice(cut + 1).trim();
  return `${esc(head)} <span class="num">${esc(tail)}</span>`;
}

function insertDivider(text, cls) {
  const log = $("log");
  const div = document.createElement("div");
  div.className = "div " + (cls || "");
  div.innerHTML = text;
  log.appendChild(div);
  capLog();
}

function appendLog(item) {
  const log = $("log");
  if (item.type === "rotation") {
    insertDivider(`↻ log rotated (${esc(item.file || "log")}) — stream continued`, "rot");
  } else if (item.type === "restart") {
    insertDivider("⟳ engine restarted");
  } else {
    log.appendChild(renderLine(item.line || ""));
  }
  capLog();
  const atBottom = isAtBottom();
  if (atBottom && !S.paused) {
    log.scrollTop = log.scrollHeight;
    S.newLines = 0;
  } else {
    S.newLines++;
    updateChip();
  }
}

function isAtBottom() {
  const log = $("log");
  return log.scrollHeight - log.scrollTop - log.clientHeight < 24;
}

function capLog() {
  const log = $("log");
  const n = log.childElementCount - LOG_MAX;
  if (n > 0) {
    let removed = 0;
    while (removed < n && log.firstElementChild) {
      log.firstElementChild.remove();
      removed++;
    }
  }
}

function updateChip() {
  const chip = $("pauseChip");
  const shouldShow = (S.paused || !isAtBottom()) && S.newLines > 0;
  if (shouldShow) {
    chip.textContent = `⏸ paused — ${S.newLines} new line${S.newLines > 1 ? "s" : ""} ↓`;
    chip.classList.add("show");
  } else {
    chip.classList.remove("show");
  }
}

function resumeLog() {
  S.paused = false;
  const log = $("log");
  log.scrollTop = log.scrollHeight;
  S.newLines = 0;
  updateChip();
  $("btnPause").classList.remove("active");
  $("btnPause").textContent = "⏸ pause";
}

/* ---------------- SSE ---------------- */
function openLogStream() {
  const es = new EventSource("/api/log?since=tail:200");
  es.addEventListener("open", () => { $("sseState").textContent = "live"; });
  es.addEventListener("error", () => {
    $("sseState").textContent = "reconnecting…";
    es.close();
    setTimeout(openLogStream, 2000);
  });
  es.addEventListener("log", (e) => {
    try { appendLog(JSON.parse(e.data)); } catch (err) { /* skip bad frame */ }
  });
  es.addEventListener("rotation", (e) => {
    try { appendLog(JSON.parse(e.data)); } catch (err) { /* ignore */ }
  });
  es.addEventListener("restart", (e) => {
    try { appendLog(JSON.parse(e.data)); } catch (err) { /* ignore */ }
  });
  // ping keeps the browser from ever seeing a dead connection silently
  es.addEventListener("ping", () => { $("sseState").textContent = "live"; });
}

/* ---------------- init ---------------- */
function init() {
  const log = $("log");
  log.addEventListener("scroll", () => {
    if (isAtBottom()) {
      S.newLines = 0;
      if (S.paused) resumeLog();
    } else {
      S.newLines = Math.max(S.newLines, 1);
      updateChip();
    }
  });
  $("pauseChip").addEventListener("click", resumeLog);
  $("btnPause").addEventListener("click", () => {
    if (S.paused) { resumeLog(); }
    else {
      S.paused = true;
      $("btnPause").classList.add("active");
      $("btnPause").textContent = "▶ resume";
      updateChip();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "p" && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      $("btnPause").click();
    }
  });
  // Fit-on-screen toggle (checked = fit mode = default). The head script in
  // index.html already applied the persisted mode to <html> pre-paint; here
  // we sync the checkbox and persist live changes.
  const fitTgl = $("fitTgl");
  fitTgl.checked = (fitMode() === "fit");
  fitTgl.addEventListener("change", () => {
    setFitMode(fitTgl.checked ? "fit" : "full");
  });
  openLogStream();
  pollStatus();
  setInterval(pollStatus, 5000);
}
document.addEventListener("DOMContentLoaded", init);
