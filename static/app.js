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
  histBase: null,      // per metric: engine-native {edges,cum} at the last baseline
                       // reset (page load / engine restart / native shape drift)
  histEdges: {},       // per metric: {edges, lo, hi} — current adaptive display
                       // edge set + the p1/p99 range it was derived from; kept so
                       // re-derivation only fires on a meaningful distribution shift
  lastEdgeKeys: {},    // per-metric key of last rendered native bucket edge set
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
  // Histogram baseline: seed on first good poll, reset after an engine
  // restart. Store the FULL edgeCum() result ({edges, cum}) — renderHistograms
  // compares base.edges against the live edge set to detect shape drift.
  // Bars then show NEW samples since load/reset, diffed at NATIVE engine
  // resolution and re-binned into adaptive display edges (see renderHistograms).
  if (!S.histBase) {
    S.histBase = {};
    S.histEdges = {};                   // left unset per metric until the first
                                        // real sample batch lands (the baseline
                                        // equals the current buckets, so newCum
                                        // is zero and no scale can be derived)
    S.lastEdgeKeys = {};
    for (const k of ["ttft", "itl", "queue"]) {
      const secName = k === "itl" ? "output_interval" : k === "queue" ? "native_queue" : "ttft";
      const ec = edgeCum(st.latency && st.latency[secName]);
      if (!ec) { S.histBase[k] = null; continue; }
      S.histBase[k] = ec;               // baseline = what the engine already has
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
  S.histEdges = {};
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

/* ---------------- latency histograms (client-diffed, adaptive edges) -----
 * The engine reports CUMULATIVE buckets since its start, at 18 fixed native
 * edges (0.001 … 1800 s + Inf) — far finer than any single fixed display
 * scale: ITL is sub-second (100 ms-ish), TTFT is multi-second/minute, queue
 * is tens of ms to minutes. Rendering one static edge set for all three
 * collapsed ITL into a single "<1s" bar, so the histogram conveyed nothing.
 *
 * Instead we diff the engine's native cumulative buckets (cumulative → delta,
 * as before) to get the NEW samples since the last baseline reset (page load
 * / engine restart / native shape drift), then derive ADAPTIVE display edges
 * from that observed distribution: the 1st–99th percentile range, log-spaced
 * into 8 bars, anchored at 0 and ∞ (adaptiveEdges below). The three metrics
 * each get their own scale + labels. The edges are re-derived only when the
 * observed p1/p99 range shifts ≥3× (concurrency rising → ITL stretches; a
 * quieting engine → ITL tightens), and a re-derivation re-anchors the "since
 * load/reset" baseline (the task's documented re-derive semantics). Bars are
 * redrawn from the native intervals each poll; the count of new samples is
 * the panel's total, and largest-remainder rounding keeps the integer bar
 * heights summing exactly to it. A metric that has <30 new samples in its
 * window renders one honest "all: N" bar until enough samples arrive to
 * judge a scale (no noise-fit buckets).
 */
const HIST_DEFS = [
  { key: "ttft",  label: "TTFT",  unit: "s",  ms: null },
  { key: "itl",   label: "ITL",   unit: "s",  ms: 1000 },
  { key: "queue", label: "Queue", unit: "s",  ms: null },
];
const ADAPT_BARS = 7;           // 7 log-spaced edges between 0 and Infinity = 8
                                // display bars (same count as the old static set)
const ADAPT_LO_Q = 0.01;        // first display edge = the 1st percentile of the
                                // new samples (anchors the informative low end)
const ADAPT_HI_Q = 0.99;        // last display edge = the 99th percentile (the
                                // sliver above it goes into the terminal ≥ bar,
                                // so a lone tail outlier cannot stretch the scale)
const ADAPT_MIN_SAMPLES = 30;   // below this many new samples the edge set is not
                                // re-derived (too few to judge a real shift)
const ADAPT_SHIFT = 3;          // re-derive once the observed p1/p99 range moves
                                // ≥ this factor (in log space) from the range the
                                // current edges were derived from

function edgeCumKey(edges) { return edges.join(","); }

/* Invert the new-sample CDF: the value v such that ~q of the new samples are
 * <= v. Interpolates in log space between the engine's native cumulative
 * edges (the native buckets are themselves a log grid, so this is the
 * honest density assumption). Returns Infinity when the target quantile
 * falls in the +Inf tail (samples past 30 min — unbounded). */
function quantileAt(edges, cum, q) {
  const total = cum.length ? cum[cum.length - 1] || 0 : 0;
  if (total <= 0) return null;
  const target = q * total;
  for (let i = 0; i < edges.length; i++) {
    if (cum[i] >= target) {
      const e = edges[i];
      if (!Number.isFinite(e)) return Infinity;            // +Inf tail
      if (i === 0) return e * (target / cum[i]);          // [0, e]: linear
      const lo = edges[i - 1];
      const c0 = cum[i - 1];
      const f = cum[i] > c0 ? (target - c0) / (cum[i] - c0) : 0;
      return lo * Math.pow(e / lo, f);
    }
  }
  return Infinity;                                          // past the last edge
}

/* Choose adaptive display edges for one metric from the NEW samples since the
 * baseline: the 1st–99th percentile range, log-spaced into ADAPT_BARS bars,
 * anchored at 0 and Infinity. This is the task's primary approach — and it is
 * REQUIRED (not just convenient) because the engine's native buckets can put
 * most of the mass into a single bucket (e.g. ITL: ~80% of new samples in the
 * one (0.25, 0.5] bucket), which any merge-of-native-edges scheme would
 * collapse into one >70% bar. Interpolated edges can subdivide that bucket.
 *
 * Layout: [0] + (ADAPT_BARS edges spanning p1..p99, geometric) + [Infinity].
 * So the first bar holds the bottom 1%, the middle ADAPT_BARS-1 bars hold the
 * middle 98%, the last bar the top 1% — 8 bars total with ADAPT_BARS=7.
 *
 * Pure function of the distribution (no clock / RNG): a given payload always
 * yields the same edges.
 *
 * @param nativeEdges  engine edge upper-bounds, ascending; last = Infinity
 * @param newCum       cumulative count of NEW samples per native edge (monotone)
 * @return {edges:[0,…,Infinity], lo, hi} or null when there are no new samples
 */
function adaptiveEdges(nativeEdges, newCum) {
  const total = newCum.length ? newCum[newCum.length - 1] || 0 : 0;
  if (!nativeEdges.length || total <= 0) return null;       // no data yet
  const finite = nativeEdges.filter((e) => Number.isFinite(e));
  if (!finite.length) return null;
  const lo = quantileAt(nativeEdges, newCum, ADAPT_LO_Q);
  let hi = quantileAt(nativeEdges, newCum, ADAPT_HI_Q);
  if (hi === Infinity) hi = finite[finite.length - 1];      // clamp the tail
  if (hi == null || !(hi > 0)) {
    return { edges: [0, Infinity], lo: 0, hi: 0 };         // single bucket
  }
  if (lo == null || lo <= 0 || hi / lo < 2) {
    // Mass within a <2× range (or starting from 0): one bar + the ≥ bar.
    return { edges: [0, hi, Infinity], lo: lo || 0, hi };
  }
  const out = [0];
  const r = Math.pow(hi / lo, 1 / (ADAPT_BARS - 1));        // log step ratio
  for (let k = 0; k < ADAPT_BARS; k++) out.push(lo * Math.pow(r, k));
  out.push(Infinity);
  // strictly-ascending safety (a duplicate edge would create a zero bar)
  const edges = out.filter((e, i, a) => i === 0 || e > a[i - 1]);
  return { edges, lo, hi };
}

/* Human label for a display edge upper-bound (seconds): 120ms, 2s, 15s, 1m…
 * Rounding happens only here, for display — the edges stay exact. */
function edgeLabel(sec) {
  if (sec == null || !Number.isFinite(sec)) return "≥";       // terminal bar
  if (sec < 0.001) return "<1ms";
  if (sec < 1) return Math.round(sec * 1000) + "ms";
  if (sec < 60) return (Number.isInteger(sec) ? sec : sec.toFixed(1)) + "s";
  if (sec < 3600) {
    const m = sec / 60;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + "m";
  }
  return (sec / 3600).toFixed(1) + "h";
}

/* Project the new-sample counts onto the display edges. Each native interval
 * (a, b] may span several display bars (the display edges are interpolated,
 * not a native subset), so its mass is split across the overlapping bars in
 * proportion to their log lengths — the same log-uniform density the CDF
 * inversion assumes. Fractional remainders land on the last overlap, so the
 * floating-point split sums to exactly the interval's count.
 *
 * Display rounding is then LARGEST-REMINDER: bar heights are integers that
 * sum to EXACTLY round(total) — so the rendered bars always reconcile with
 * the caption's total (per-bar Math.round would drift by ±1-2 samples).
 * Returns { dist: int counts parallel to dispEdges, total: exact sum }. */
function mapNativeToDisplay(nativeEdges, newCum, dispEdges) {
  const n = dispEdges.length;
  const dist = zeros(n);
  for (let i = 0; i < newCum.length; i++) {
    const m = newCum[i] - (i > 0 ? newCum[i - 1] : 0);
    if (m <= 0) continue;
    const a = i > 0 ? nativeEdges[i - 1] : 0;
    const b = nativeEdges[i];
    // Collect the display bins overlapping (a, b].
    const overlaps = [];
    for (let d = 0; d < n - 1; d++) {
      const x = dispEdges[d];
      const y = dispEdges[d + 1];
      const oLo = Math.max(a, x);
      const oHi = Number.isFinite(y) ? Math.min(b, y) : b;
      if (oHi > oLo) {
        // log length of the overlap; a=0 needs a floor (log is undefined at 0)
        const lo = oLo > 0 ? oLo : Math.max(b * 1e-6, 1e-9);
        overlaps.push([Math.log(oHi) - Math.log(lo), d]);
      }
    }
    if (!overlaps.length) continue;                 // unreachable in practice
    const totalLen = overlaps.reduce((s, o) => s + o[0], 0);
    if (totalLen <= 0) {
      dist[overlaps[0][1]] += m;                    // degenerate: whole interval
      continue;
    }
    let assigned = 0;
    for (let k = 0; k < overlaps.length; k++) {
      const frac = overlaps[k][0] / totalLen;
      // Last overlap takes the exact remainder so the split sums to m.
      const v = (k === overlaps.length - 1) ? m - assigned : m * frac;
      if (k < overlaps.length - 1) assigned += m * frac;
      dist[overlaps[k][1]] += Math.max(0, v);
    }
  }
  // Largest-remainder rounding (see doc).
  const total = dist.reduce((a, b) => a + b, 0);
  const target = Math.round(total);
  const ints = dist.map((v) => Math.floor(v + 1e-9));
  let deficit = target - ints.reduce((a, b) => a + b, 0);
  if (deficit > 0) {
    const order = dist.map((v, i) => [v - Math.floor(v + 1e-9), i])
      .sort((p, q) => q[0] - p[0] || q[1] - p[1]);
    for (let k = 0; k < order.length && deficit > 0; k++, deficit--) {
      ints[order[k][1]]++;
    }
  }
  return { dist: ints, total };
}

/* Has the observed new-sample distribution shifted enough that the display
 * edges should be re-derived (and the "since load/reset" baseline re-anchored)?
 * Shape-based, not a wall clock: the current p1/p99 range must move by at
 * least ADAPT_SHIFT× (log space) from the range the current edges were derived
 * from. A rising concurrency (ITL stretches) or a quieting engine (ITL
 * tightens) crosses that; normal sample-by-sample churn does not, so the bars
 * don't reset on every poll. */
function edgesStale(nativeEdges, newCum, dispEdges, derived) {
  const total = newCum.length ? newCum[newCum.length - 1] || 0 : 0;
  if (total < ADAPT_MIN_SAMPLES || !dispEdges) return false;
  if (!derived) return false;                       // first derivation handled elsewhere
  const lo = quantileAt(nativeEdges, newCum, ADAPT_LO_Q);
  const hi = quantileAt(nativeEdges, newCum, ADAPT_HI_Q);
  if (!Number.isFinite(lo) || lo <= 0) return false;
  if (!(derived.lo > 0) || !(derived.hi > 0)) return false;
  // p99 in the +Inf tail (> 30 min): the scale is already at its widest
  // possible form (adaptiveEdges clamps hi to the last native edge, 1800 s)
  // and the tail sits in the ≥ bar — re-deriving would be a no-op that only
  // clears the counter, so stay put.
  if (!Number.isFinite(hi)) return false;
  const shift = Math.max(
    Math.abs(Math.log(lo / derived.lo)),
    Math.abs(Math.log(hi / derived.hi)));
  return shift > Math.log(ADAPT_SHIFT);
}

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
    // Rebuilding all three is trivially cheap (3 metrics × ≤8 bars every 5 s).
    S.lastEdgeKeys[def.key] = edgeCumKey(cur.edges) + "|" + cur.cum.join(",");
    any = true;
    // The engine reports CUMULATIVE buckets (count of samples <= edge).
    // Diff vs the baseline native shape, then take per-interval deltas so each
    // NEW sample is counted exactly once, in the bin of its (native) upper edge.
    //
    // Baseline semantics (unchanged from the static-bucket version):
    //   - on first good poll, base = the engine's current cumulative buckets,
    //     so the panel starts at zero "since load";
    //   - if the native edge SET drifted (engine changed bucket shape), the
    //     base is no longer comparable -> treat base = current (show everything).
    const base = (S.histBase[def.key] &&
                  S.histBase[def.key].edges.join(",") === cur.edges.join(","))
      ? S.histBase[def.key] : cur;
    // NEW samples since the baseline, as a per-native-edge CUMULATIVE count
    // (count of new samples <= edge_i). The per-interval delta (cur-base) is
    // running-summed into a cumulative, which is what the adaptive edge
    // chooser, the mapper, and the staleness check all consume.
    const newCum = zeros(cur.edges.length);
    let run = 0;
    cur.edges.forEach((edge, i) => {
      const interval = Math.max(0, cur.cum[i] - base.cum[i] -
        (i > 0 ? (cur.cum[i - 1] - base.cum[i - 1]) : 0));
      run += interval;
      newCum[i] = run;
    });
    const newTotal = run;
    // Adaptive display edges for THIS metric. First batch with ≥30 new
    // samples: derive (below that, no scale — the "all" bar). Afterwards:
    // keep the current scale (bars don't jiggle on every poll) until the
    // observed p1/p99 range shifts ≥ ADAPT_SHIFT× — then re-derive AND
    // re-anchor the "since load/reset" baseline, so the counter restarts
    // with the new scale (the task's documented re-derive semantics).
    let rederived = false;
    if (!S.histEdges[def.key]) {
      // Floor here too: a scale derived from <30 samples (e.g. a TTFT that
      // logged 3 requests in 30 s) would anchor its bars to noise. Until the
      // window accumulates enough to judge, one "all: N" bar is the honest
      // rendering — and once 30 land, the scale derives and holds.
      // No baseline re-anchor here: the window is still the page-load window
      // ("since load/reset" stays truthful — the counter keeps the samples the
      // user watched accumulate through the placeholder phase). Re-anchoring
      // happens only on a mid-life re-derivation below.
      S.histEdges[def.key] = newTotal >= ADAPT_MIN_SAMPLES
        ? adaptiveEdges(cur.edges, newCum) : null;
    } else if (newTotal >= ADAPT_MIN_SAMPLES &&
               edgesStale(cur.edges, newCum, S.histEdges[def.key].edges,
                          S.histEdges[def.key])) {
      S.histEdges[def.key] = adaptiveEdges(cur.edges, newCum);
      // Re-ANCHOR the baseline (task's documented re-derive semantics): the
      // "since load/reset" window restarts with the new scale, so every native
      // cum value in this very poll is now pre-window. Zeroing newCum is
      // EXACT, not a shortcut: re-anchored base = cur, so the true
      // cumulative→delta diff against the new baseline is 0 for this poll.
      // (The samples that triggered the shift were already shown last poll,
      // under the old scale — they are pre-window now, by design.)
      S.histBase[def.key] = { edges: cur.edges, cum: cur.cum.slice() };
      newCum.fill(0);
      rederived = true;
    }
    const disp = S.histEdges[def.key];
    const mapped = disp ? mapNativeToDisplay(cur.edges, newCum, disp.edges)
      : { dist: [0], total: 0 };                   // single "all" bar, awaiting
                                                   // enough samples to derive a scale
    const dist = mapped.dist;
    const total = mapped.total;
    const max = Math.max(1, ...dist);
    // dist is INTERVAL-indexed: dist[i] = count of bar i = interval
    // (dEdges[i], dEdges[i+1]]. Iterate the bars (all but the last edge) —
    // indexing dist by the raw edge array would read one interval off (the
    // final bar would always show 0) and mislabel every range.
    const dEdges = disp ? disp.edges : [0, Infinity];
    let bars = "", labs = "";
    dEdges.slice(0, -1).forEach((lo, i) => {
      const de = dEdges[i + 1];
      const v = dist[i];
      const h = Math.max(2, Math.round(v / max * 100));
      const hic = v === max && v > 0 ? " hi" : "";
      const label = Number.isFinite(de)
        ? (lo === 0 ? "0" : edgeLabel(lo)) + "…" + edgeLabel(de)
        : (lo === 0 ? "all" : "≥" + edgeLabel(lo));   // terminal tail bar
      bars += `<div class="b" title="${esc(label)}: ${fmtInt(v)} new"><i style="height:${h}%" class="${hic}"></i></div>`;
      labs += `<span>${esc(label)}</span>`;
    });
    const m = p.metrics || {};
    // ttft_ms/itl_ms can be null on idle polls — humanMs(null) prints "—"
    const rt = def.key === "itl" ? m.itl_ms : m.ttft_ms;
    const rtTxt = def.key === "queue" ?
      `count ${fmtInt(sec.count)}` :
      `p50 ${humanMs(rt && rt.p50)}`;
    const el = document.createElement("div");
    el.className = "hist";
    const since = rederived ? "since scale re-anchored" : "since load/reset";
    el.innerHTML = `<div class="hcap"><span>${def.label} · new samples ${since}: <b style="color:var(--fg)">${fmtInt(total)}</b></span><span class="rt">${rtTxt}</span></div>
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
