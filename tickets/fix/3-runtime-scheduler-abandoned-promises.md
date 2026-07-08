----
description: If a step of a running query throws an error, other background tasks the query already kicked off are left dangling and never waited on, which can crash the whole process; separately, the scheduler's core loop is copy-pasted six times.
files: packages/quereus/src/runtime/scheduler.ts
difficulty: medium
----
Two issues in the scheduler (`runtime/scheduler.ts`, roughly lines 105-438):

**Abandoned in-flight promises on throw (the real bug).** In `runAsync`, instruction arguments that are still-pending promises are parked in `instrArgs`. If an earlier instruction throws before those promises are awaited, they are never awaited or handled — becoming unhandled promise rejections. Under Node's strict/`--unhandled-rejections=strict` mode (and the project's strict harness) an unhandled rejection is process-fatal. So an ordinary query error can escalate into a process crash depending on timing.

Expected behavior: when the scheduler unwinds due to a throw, it must account for every promise it already launched — awaiting/settling them (e.g. `Promise.allSettled` over the parked `instrArgs`) so none becomes an unhandled rejection — before propagating the original error. The original error must still be the one that surfaces; swept promise results/rejections are drained, not swallowed silently (log if a swept promise itself rejected).

**Six near-identical loops (cleanliness, note for the same pass).** The core dispatch loop is duplicated across `runOptimized`, `runWithTracing`, `runWithMetrics`, and their async twins — six copies. The promise-sweep fix must therefore be applied in all six places, which is exactly why they should collapse into one loop parameterized by the tracing/metrics hooks. Fold the variants into a single hook-parameterized loop so this fix (and future ones) lands once. Verify tracing and metrics output is unchanged after the collapse.
