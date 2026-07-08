----
description: The engine tracks the "current row" for each part of a query in a shared, mutable place where the most recent write wins; if a streaming operator forgets to set it correctly, a query can silently read the wrong row with no error — add an optional debug-mode check that catches this class of mistake.
files: packages/quereus/src/runtime, packages/quereus/docs/runtime.md
difficulty: hard
----
Attribute-based row context is simultaneously one of the runtime's strongest and most fragile designs. Stable attribute IDs are the right call, but at runtime they resolve against a shared, mutable `RowContextMap` with last-set-wins semantics. The failure mode: a streaming emitter that fails to set (or restore) the correct context for its output attributes leaves a stale parent context in place, and a downstream read silently resolves to the wrong row. There is no error — just wrong results. This footgun is documented in `docs/runtime.md` and today is mitigated only by hand-applied, per-emitter discipline that differs from emitter to emitter. Every new streaming emitter is a fresh opportunity to reintroduce a silent wrong-row bug.

The project already has precedent for exactly this style of guardrail: `QUEREUS_FORK_STRICT` plus a static allowlist of mutation sites turns the parallel-runtime concurrency contract from "discipline" into an enforced, debug-mode-checkable invariant. This ticket applies the same philosophy to row context.

Goal: a debug-mode (env-gated, off by default, like `QUEREUS_FORK_STRICT`) runtime assertion that detects stale-context / last-set-wins wrong-row wins — i.e. flags when an attribute is read whose context was set by an operator that should no longer be the active provider for that attribute, or when an expected context write did not happen.

This is a design ticket — the mechanism needs to be worked out before implementation. Resolve:
- **What exactly to assert.** Candidate signals: an attribute read resolving to a context whose "generation"/epoch is older than the current operator's expected provider; a write that overwrites a context still expected to be live; reads of attributes no operator in the current scope claims to provide.
- **How to know the expected provider.** The planner knows which node produces which attribute IDs; determine what provenance metadata must be threaded to runtime so the assertion can compare actual-vs-expected provider cheaply.
- **Cost and gating.** It must be zero-cost when the env flag is off (mirror `QUEREUS_FORK_STRICT`'s gating), and cheap enough to run across the full logic-test suite in CI when on.
- **Diagnostic quality.** When it trips, it must name the attribute, the reading operator, the operator that last set the context, and the operator that should have — otherwise it is not actionably better than the wrong results it replaces.

Reference the existing `QUEREUS_FORK_STRICT` implementation and its mutation-site allowlist as the model. Update `docs/runtime.md` (which already documents the shadowing footgun) to describe the new assertion once designed. Output one or more implement tickets once the assertion's signal and provenance-threading approach are settled.
