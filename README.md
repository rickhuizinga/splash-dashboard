# Splash Engine Dashboard

A single-page local dashboard for the [Splash inference engine](https://github.com/incoai/splash)
on Apple silicon. Replaces "ssh into the Mac, curl `/status`, tail the log"
with one always-open page: engine health, what it's doing right now, speed,
and a live log tail (`tail -f`-style).

Works with any model Splash serves; developed against
`incoai/Qwen3.8-27B-Splash` on a Mac Mini M4 Pro (macOS 27).

![dashboard](https://placeholder-no-screenshot-yet)

## Requirements

- macOS (Apple silicon) running the Splash engine: `brew install incoai/tap/splash`
- Python 3.9+ — **stdlib only**, no pip installs
- The Splash engine serving on `127.0.0.1:8200` (default) with an API key set

## Files

- `dash.py` — backend. **Python 3 stdlib only** (no pip). Binds
  `127.0.0.1:8280` (localhost only — the splash API key is proxied here and
  must never be LAN-reachable). Routes:
  - `GET /` → `static/index.html`
  - `GET /api/status` → proxies engine `/status`, injects bearer key, 2 s
    cache. Emits explicit `engine_down` / `auth` states — never silent zeros.
  - `GET /api/log?since=tail:N` → SSE stream following
    `~/Library/Logs/splash/splash.out.log` **and** `splash.err.log`
    (incremental; rotation/truncation detected and survived; 15 s keepalive
    pings).
- `static/index.html` + `static/app.js` — the whole UI. Vanilla JS, no
  framework, no build step, hand-rolled bar charts.
- `launchd/ai.splash.dash.plist` — LaunchAgent to run the dashboard under
  launchd (optional; a plain `python3 dash.py` in a tmux session works too).

## Run

The backend needs the engine API key in its environment. The key lives in
the engine's LaunchAgent plist (`~/Library/LaunchAgents/ai.splash.serve.plist`,
`EnvironmentVariables/SPLASH_API_KEY` — the same value as its `--api-key`
flag). **Never hardcode it** — load it from the plist at launch:

```bash
git clone https://github.com/rickhuizinga/splash-dashboard.git
cd splash-dashboard
export SPLASH_API_KEY=$(plutil -extract EnvironmentVariables.SPLASH_API_KEY raw ~/Library/LaunchAgents/ai.splash.serve.plist)
python3 dash.py            # → http://127.0.0.1:8280
```

Then open <http://127.0.0.1:8280>.

## Run under launchd (optional)

`launchd/ai.splash.dash.plist` is a template. Copy it into place, fix the
cd-path inside it to your clone location, then:

```bash
launchctl bootstrap gui/501 ~/Library/LaunchAgents/ai.splash.dash.plist
launchctl print gui/501/ai.splash.dash   # state = running
```

The plist reads `SPLASH_API_KEY` from the *engine* plist at launch time via a
small `ProgramArguments` wrapper (`plutil -extract …`), so a key rotation in
the engine plist is picked up the next dashboard restart. If the key drifts
between the two plists the dashboard shows an amber **SPLASH_API_KEY
mismatch** banner (engine HTTP 401/403) rather than fake data.

## What it shows

- **Header** — ready state, uptime (ticks every 1 s, client-computed from
  `instance.started_at`), pid, port, schema version, build id, device.
- **6 KPI cards** (5 s refresh, 2 s backend cache): decode tok/s, draft
  acceptance, cache hit, prefill tok/s, TTFT p50, ITL p50 — with ▲/▼ delta
  vs last poll and humanized values ("8.0m", "273ms").
- **Live state** — scheduler counts (prefilling/decoding/queued/…), current
  decode batch (width, drafted/accepted, rate), batch-width history.
- **Memory** — resident vs governor limit bar, system pressure color
  (green/amber/red), KV pages, reclaim, admission.
- **Counters** — requests submitted/completed/cancelled/failed, capacity
  failures, denied reservations, evictions (all engine-lifetime).
- **Latency histograms** — client-side diff of the engine's cumulative
  `latency.*` buckets between polls: bars show *new* samples since page load
  or engine restart (8 buckets, seconds).
- **Log pane** — SSE tail of both log files, level-colored
  (Ready green / Done default / Cancelled yellow / Error red / Loading blue),
  TTFT & tok/s right-aligned, tail-f scroll behavior (scroll up pauses,
  "N new lines" chip resumes), 5,000-line in-memory cap.

## Failure-mode behavior

- **Engine down** (port closed / non-200): red **ENGINE DOWN** banner with
  `launchctl print gui/501/ai.splash.serve` + err-log hints; last known-good
  panels dimmed to 40% and labeled stale; polling continues; log stream is
  unaffected (it follows the files, not the engine).
- **Auth drift** (401/403): amber SPLASH_API_KEY mismatch banner.
- **Engine restart** (`instance.started_at` changed): divider line in the log
  pane; counters & histogram baselines reset (they are engine-lifetime).
- **Log rotation** (newsyslog, 1 MB trigger): inode/truncate detected, old
  handle drained, file reopened — the SSE stream never stops; a "↻ log
  rotated" marker is inserted.

## Known limitations

- The engine has no time series — sparklines/histories are client ring
  buffers only and reset on page reload or engine restart.
- Two log files are merged by backend poll order (0.5 s tick), not by the
  `HH:MM:SS` timestamp; lines within a single file are in order.
- `maximum_context_tokens` and device info are shown in the header footer
  rather than as a KPI card (spec §5 KPI row lists 6 cards; context is
  context, not a rate).
