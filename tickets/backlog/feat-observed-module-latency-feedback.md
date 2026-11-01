description: Measure how long a module's reads actually take while queries run, and correct a module's declared (or preset) latency the way cardinality feedback corrects a wrong row count, so a distributed module whose real latency varies by deployment is still priced right.
prereq: module-cost-profile-and-presets
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/vtab/module.ts, docs/progressive-optimizer.md
tradeoffs: Wall-clock timings are noisy (event-loop contention, GC, caching) and device-specific, so an observed latency needs smoothing and hysteresis before it moves a plan; and it makes plans depend on machine load as well as on what ran earlier in the session.
----

# Observed module latency feedback

Follow-on to `module-cost-profile-and-presets`. A preset (e.g. `distributed`) is a category, not a measurement; the real latency of a network-backed module varies by deployment and over time.

Idea: at the scan leaf, read the clock twice per scan invocation (open → first row, open → exhaustion), never per row, and record per module (or per table) an observed first-row latency and per-row (or per-request) time. Feed it through the same publish / shift / cooldown machinery cardinality feedback uses (`docs/progressive-optimizer.md` §3.4–3.6), overriding the declared profile only after a consequential, repeated divergence.

Open questions: keying (module vs table — tables on one module may live on different nodes); smoothing (moving average vs median of recent N); whether time spent downstream of the scan (consumer back-pressure in a pull pipeline) contaminates the measurement and how to exclude it; interaction with `runtime_metrics`, which already times instructions; the `cardinality_feedback` switch or a separate one.
