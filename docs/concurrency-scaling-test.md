# Splash Concurrency Scaling Test — Interactive Spec

**Purpose:** Determine how Splash's aggregate decode throughput scales with concurrent
request width (1→4), and locate the crossover where memory bandwidth stops being the
limiting factor and compute takes over.

**Status:** DRAFT — do not run until (a) no Kanban tasks are sharing the Splash engine,
and (b) an idle window of ~45–60 minutes is available.

**Context:** Observational data from real workload (991 requests, widths b1/b2/b3/b4 =
200091/85007/23960/253 batches) confounds concurrency with request size — bigger
requests arrive when more agents run. This test controls for that: same prompt, same
context size, only concurrency varies.

---

## Background / Hypothesis

Rick's model (2026-09-26): at width 1, decode is **memory-bandwidth-bound** — every
decode step streams the full 4-bit weight set (~15 GB) through the memory bus once,
regardless of batch width. Adding streams reuses that same weight pass, so aggregate
should climb near-linearly until compute (per-step attention + head overhead across N
sequences) becomes the per-step bottleneck.

Predictions to falsify:

- **H1 (bandwidth-bound regime):** width 1→2 roughly doubles aggregate tok/s.
- **H2 (crossover):** aggregate stops climbing meaningfully somewhere in width 2–4.
  The last width where aggregate still gains ≥10% over the previous width is the
  crossover estimate.
- **H3 (per-stream decay):** per-stream rate (aggregate ÷ width) decays monotonically
  with width; the decay curve's shape tells us how "expensive" each marginal stream is.

## Test Design

### Variables

| Variable | Value | Notes |
|---|---|---|
| Concurrency (width) | 1, 2, 3, 4 | one test per width, run in ascending order |
| Prompt/context | fixed, ~32K tokens | synthetic filler + a short instruction |
| max_tokens per request | 512 | short enough to keep each run <2 min |
| Sampling params | temp 0.7, top_p 0.80, top_k 20, min_p 0.0, repetition_penalty 1.0, reasoning_effort none | match nothink block in LiteLLM config — no reasoning trace, keeps output clean and fast |
| Runs per width | 3 | take median, discard outliers (engine warmup, batch-boundary noise) |

### Engine State Prerequisites

1. **No active Kanban work** — check `kanban_list(status='running')` is empty and no
   agent loops are active (Hermes sessions with live tool loops count — check the
   Hermes dashboard for active sessions before starting).
2. **Engine has been idle ≥2 minutes** before each width test (lets KV pressure
   settle; check `/status` → `scheduler.queued == 0`, `scheduler.decoding == 0`).
3. **Do not restart the engine mid-test** — SSD prefix cache warm state is part of the
   measurement; a restart resets it and invalidates comparisons across widths.
4. **Record engine uptime** before starting (from dashboard header or
   `/status.instance.started_at`) — goes into the results table.

### Execution

Run from the Mac Mini directly (not via LiteLLM proxy) to eliminate proxy timeout and
routing variables. Use `curl` against `http://127.0.0.1:8200/v1/chat/completions` with
the API key from the LaunchAgent plist (same extraction one-liner as the dashboard).

For each width N in [1, 2, 3, 4]:

1. Fire N simultaneous `curl` requests (background jobs + `wait`, or a small shell
   loop with `&`). Each request: same prompt, `max_tokens: 512`, `stream: false`.
2. Wait for all N to finish.
3. Immediately snapshot `/status` → record:
   - `metrics.current_decode_batch` — width, tokens_per_second (this is the cleanest
     per-step aggregate number; it reflects the batch that just ran)
   - `metrics.decode_tokens_per_second` (engine-lifetime aggregate — use the
     *delta* between pre- and post-test snapshots ÷ wall time for a per-test figure)
   - `scheduler.decode_batches_by_width` — confirm the batch actually ran at width N
     (the bN counter should have incremented by ~the number of decode steps)
   - `latency.output_interval` bucket counts — for per-interval token math
4. Cool down: wait for `scheduler.decoding == 0` and ≥30 s idle before next width.

### Data Capture Template

For each (width, run) triple, record:

```
width: __
run: __
start_time: __
end_time: __
wall_s: __
tokens_out_total: __          # sum across N requests (sum usage.completion_tokens)
aggregate_tok_s: __           # tokens_out_total / wall_s
per_stream_tok_s: __          # aggregate / N
batch_width_confirmed: __     # from decode_batches_by_width delta
current_decode_batch_tps: __  # instantaneous, from post-run snapshot
notes: __                     # anything odd: retracts, evictions, TTFT spikes
```

### Where to put results

Save the filled template + a short analysis as
`~/Projects/splash-dashboard/docs/concurrency-scaling-results.md` (same repo, so the
numbers live next to the README screenshot and the spec). Optional: add a section to
the README's benchmark notes once results are in.

## Analysis Plan

1. **Aggregate scaling curve:** plot aggregate tok/s vs width (median of 3 runs).
   The crossover width = last width where aggregate gain over previous width is ≥10%.
2. **Per-stream decay:** per-stream vs width; fit reveals marginal stream cost.
3. **Cross-check vs observational data:** compare the width-2/3 numbers against the
   soak's derived figures (per-stream ≈ 9.3 tok/s at time-avg width 2.3) — if the
   controlled numbers are much higher, real-workload contention (prefill bursts,
   larger contexts) is the gap.
4. **Bandwidth-bound sanity check:** at width 1, compare measured tok/s against the
   theoretical bandwidth limit (weight bytes × bandwidth⁻¹). If measured ≈ theory at
   width 1 but aggregate stops scaling by width 3–4, the crossover is compute-bound,
   not bandwidth-bound — confirming H2's mechanism.

## Success Criteria

- Clean aggregate-vs-width curve from width 1 through 4, 3 runs each
- A defensible answer to: "at what width does adding another concurrent request stop
  improving aggregate throughput?"
- Numbers comparable to (and explaining) the soak-derived observational figures

## Risks / Notes

- **Test load is synthetic** — real workload arrives as 64K–140K contexts with agent
  tool-call patterns, not 32K/512 fixed pairs. The controlled numbers are the *shape*
  of the curve, not the absolute numbers under real load.
- **oMLX rollback engine sits idle** at `172.16.0.179:8100` — if Splash misbehaves
  mid-test, cutover is a config flip away (LiteLLM block change).
- **KV memory pressure:** at 58 GiB wired ceiling with 32K×4 concurrent, memory
  should be fine (~4×32K×~200KB/token int8 KV ≈ 25 GB); if the governor evicts
  mid-test, note it — that's a result, not a failure.
- If width 4 shows aggregate still climbing ≥10%, consider extending to width 5–6
  (Splash may allow >4 given memory headroom) — the scheduler caps at whatever the
  config allows; check `--max-concurrent` or equivalent flag first.

## Rollback / Cleanup

Nothing persistent changes during this test — no config edits, no restarts, no deploys.
Engine state returns to baseline when test traffic stops. If anything goes sideways:
stop firing requests, let the engine drain (`scheduler.decoding == 0`), and it's done.
