----
description: A batch of small runtime cleanups landed — dead code and a no-op GC hook removed, a wasteful dedup structure and type-safety escape hatches replaced, a mis-timed diagnostic fixed, and formatting normalized; two heavier items were spun off. Reviewed and confirmed clean.
files: packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/src/runtime/scheduler.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/module.ts, docs/module-authoring.md
----
Low-severity runtime cleanup bundle from the code review. Six items landed; three were deferred (two spun into backlog tickets, one delegated to an in-flight fix ticket). Build, lint, and the full logic-test suite are green.

## What landed

1. Dead `shadowName` module hook removed (`vtab/module.ts`, `docs/module-authoring.md`).
2. No-op `global.gc()` / `cleanupUnreferencedLayers` removed (`vtab/memory/layer/manager.ts`).
3. Multi-seek dedup: full `inheritree` BTree → `Set<string>` keyed on the lossless, type-aware PK encoding (`vtab/memory/layer/scan-layer.ts`).
4. Context-leak diagnostic re-timed to run on Promise settle / AsyncIterable drain, gated behind `contextLog.enabled` (`runtime/scheduler.ts`).
5. File-wide `eslint-disable no-explicit-any` removed; `any`s typed directly (`runtime/emitters.ts`, `runtime/utils.ts`).
6. Mixed tabs/spaces normalized to tabs per `.editorconfig` (`runtime/emit/scan.ts`).

## Deferred (spun off)
- `tickets/backlog/feat-and-or-short-circuit.md` — AND/OR short-circuit is a real perf feature, not a cleanup; CASE does not short-circuit today either, so there is no existing pattern to copy.
- `tickets/backlog/debt-instruction-generic-args.md` — the 68 `run as InstructionRun` casts; a naive generic does not remove them (parameter contravariance), so it is a structural refactor across 56 files.
- Delegated to `tickets/fix/1-runtime-scan-async-generator-stack.md` — the ~60 duplicated primary/secondary scan branches in `scan-layer.ts`; that ticket reworks exactly those branches and explicitly claims it may subsume the dedup, so it lands there (last-toucher wins).

## Review findings

Adversarial pass over commit `b3e842dc`. Read the full implement diff (all 8 source/doc files) before the handoff summary. Checked correctness, DRY, type-safety, resource cleanup, error handling, test coverage, and doc accuracy.

**Correctness — item 3 (BTree → `Set<string>` dedup).** CONFIRMED correct. The seen-set keys on `encodePk(primaryKeyExtractorFromRow(row))` — i.e. the *extracted primary key of the stored row*, not the seek column value. Traced `getPkExtractorsAndComparators` (`layer/base.ts:207`) back to the same `createPrimaryKeyFunctions` (`utils/primary-key.ts:32`) that produces `encode`; extractor and encoder therefore share one arity/schema, so encode-equal ⟺ comparator-equal for any pair of PKs that can coexist as distinct rows. Collation-independence of the encoder is irrelevant here because dedup identity is the PK, and comparator-equal PKs cannot coexist as separate rows. No over- or under-dedup possible. The old BTree's ordered iteration was never consumed — `Set` membership is sufficient.

**Correctness — item 4 (re-timed context-leak diagnostic).** CONFIRMED. Deferring the size check to Promise settle / AsyncIterable drain fixes a genuine false-positive/missed-leak bug (the old check fired before any row/table slot could close). Promise rejection and mid-iteration throw both still run the check (via `.finally` / generator `finally`) and re-propagate. Gating the whole thing behind `contextLog.enabled` means production/CI pay nothing. No double-wrap conflict with `runWithTracing` (that instruments per-instruction runs; this wraps the scheduler-level result).

**Type-safety — item 5.** CONFIRMED behavior-preserving. `emitters.ts` tracing wrapper now types `...args: RuntimeValue[]` / `OutputValue` with `isAsyncIterable<Row>` narrowing and a `PromiseLike` duck-check (unchanged vs the old `any` semantics — deliberately did **not** switch to `instanceof Promise` there). `utils.ts` `.catch((e: unknown))`. Both file-wide disables deleted; lint (eslint + `tsc -p tsconfig.test.json`) passes.

**Dead-code removal — items 1, 2.** CONFIRMED. Grepped `shadowName` across `src/` + `docs/`: the only residuals are the *live, unrelated* rekey-shadow-table locals in `runtime/emit/alter-table.ts` (correctly untouched). `docs/module-authoring.md` rows/note removed consistently. `cleanupUnreferencedLayers` + its single `collapseLayers` call site gone; the surrounding `logger.operation('Collapse Layers', …)` preserved.

**Formatting — item 6.** Pure whitespace (2-space/tab mix → tabs); no logic change in the diff.

**Test coverage.** Verified — NOT a gap. `test/logic/07.9-in-value-list.sqllogic` already exhaustively exercises the item-3 multi-seek dedup path: duplicate literals (`in (5,5)`), NULL elements, two distinct dup'd values, IN-on-PK, composite-index cross-product with dedup + NULL collapse, REAL-unique fuzz shape, and the non-indexed residual-filter path. All pass on the new `Set` mechanism, so the swap is regression-covered. The PK encoder itself is unit-tested in `test/vtab/memory-index-pk-value-identity.spec.ts`. No dedicated NOCASE-variant test is needed: dedup identity is the (integer, here) PK, not the collated seek column, so seek-column collation cannot affect it. **Item 4 is genuinely unexercised by CI** (debug-only, `contextLog.enabled` off in normal runs) — a test would need to enable the logger and assert log timing, brittle for a log-only diagnostic; left as a stated known gap rather than a brittle test. This is the one explicitly-empty test category, with reason.

**Deferrals audited.** All three spun-off tickets are well-formed with plain-language descriptions and accurate technical bodies; correct prefixes (`feat-`, `debt-`); the fix-ticket delegation is real (`fix/1-runtime-scan-async-generator-stack.md` lists `scan-layer.ts` in `files:` and explicitly notes it may subsume the dup lines). Legit deferrals, not scope-dodging.

**Tripwire noted (no code change).** In `scheduler.ts checkContextLeaksOnSettle`, the Promise branch uses `result instanceof Promise` whereas `emitters.ts` duck-types the thenable. If the runtime ever returns a non-native thenable *and* `contextLog` is enabled, the leak check would fire synchronously (mis-timed) again — but runtime results are native Promises and this path is debug-only, so it is below the threshold to change now. Recorded here only; not filed as a ticket, not commented at the site (too marginal to warrant site noise).

**Minor findings fixed inline:** none — nothing warranted a change.
**Major findings (new tickets):** none beyond the three deferrals the implementer already filed.

## Validation performed (review)
- `yarn workspace @quereus/quereus run build` → exit 0.
- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn workspace @quereus/quereus run test` → 6479 passing, 9 pending, exit 0.
