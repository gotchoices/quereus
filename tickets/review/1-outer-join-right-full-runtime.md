description: Review RIGHT/FULL outer-join runtime execution added to the nested-loop join emitter (read path only). Verify the right-driven + full-trailing loop correctness, the generalized existence-flag rule, edge-case coverage, and that no write-through behavior changed. Build + full quereus suite (memory) and a store-mode spot-check pass.
files: packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/join-output.ts, packages/quereus/test/logic/90.5-unsupported-join-types.sqllogic, packages/quereus/test/logic/90.5.1-right-full-join-read.sqllogic, packages/quereus/test/logic/11-joins.sqllogic, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, packages/quereus/test/optimizer/rule-join-elimination.spec.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/src/planner/mutation/multi-source.ts, docs/view-updateability.md
----

## What landed

RIGHT and FULL outer joins now **execute** (read path) in `runtime/emit/join.ts`.
Previously the emitter threw `RIGHT/FULL JOIN is not supported yet`; everything
upstream (parser → `buildJoin` → `join-utils` nullability → physical-selection
bail) already tolerated the join, so this was the single missing runtime step.

### Emitter design (`emitLoopJoin`)

Two loop shapes share slot setup, the condition decision, and the flag spreads:

- **`conditionMet(leftRow, rightRow)`** — one local helper for both drivers:
  `conditionCallback` (ON) / `evaluateUsingCondition` (USING) / unconditional
  (cross or predicate-less). Evaluated against the runtime context after **both**
  slots are set, so it is agnostic to which side drives.
- **`driveFromLeft()`** — the pre-existing inner/left/cross/semi/anti loop, kept
  byte-equivalent (still uses `joinOutputRow` for the post-row). LEFT unmatched
  flags now come from `flagsForDroppedSide('right')`, which is value-identical to
  the old `spec.side === 'left'`.
- **`driveFromRight()`** — RIGHT/FULL. Buffers `leftSource` once into an array,
  iterates `rightCallback` **once** as the outer driver, scans the buffered left
  rows as the inner. `rightMatched` gates the null-left extension. FULL adds a
  `leftMatched` bitset and a **trailing pass** emitting unmatched left rows with
  the right side null-extended.
- **`flagsForDroppedSide(dropped)`** generalizes the existence flag: a flag is
  true iff its side survives the null-extension (`spec.side !== dropped`). Matched
  rows → all true; right-row-unmatched drops `left`; left-row-unmatched drops `right`.

Output row order is invariant: `[...leftRow, ...rightRow (, ...flags)]` (the
JoinNode attribute order), so `select *` returns `a.*` then `b.*` regardless of
which side drives. The throw block and the now-unused `QuereusError`/`StatusCode`
imports were removed.

## How to validate (use cases)

Primary coverage (run `node test-runner.mjs --grep "90.5|11-joins"` from
`packages/quereus`, or the file names below):

- **`test/logic/90.5-unsupported-join-types.sqllogic`** — the four RIGHT / RIGHT
  OUTER / FULL OUTER / FULL cases flipped from `-- error` to real rows; NATURAL
  kept as `-- error` (still unparsed, out of scope).
- **`test/logic/90.5.1-right-full-join-read.sqllogic`** (new) — `select *` column
  order; the empty-side matrix (left-empty RIGHT, right-empty RIGHT, both-empty
  FULL, left-only FULL, right-only FULL); no-match RIGHT/FULL; many-to-many
  fan-out (duplicate keys — one row per match, no spurious null-extension);
  `right/full join … using (id)`; `exists as` on RIGHT (non-preserved = left);
  `exists left/right as` on FULL (both sides).
- **`test/logic/11-joins.sqllogic`** — the general-joins file's RIGHT case flipped
  to rows + a FULL case added; uses `:N` column disambiguation (`id`, `id:1`),
  which encodes positional order (left = unsuffixed), pinning column order more
  strongly than the distinct-name cases.

Optimizer interactions:

- **`rule-join-elimination.spec.ts`** — the RIGHT-under-`count(*)` elimination test
  now asserts the un-eliminated RIGHT join **executes** to the same answer instead
  of throwing (elimination is an optimization, not a correctness crutch).
- **`parallel-async-gather-zip-by-key.spec.ts`** — the two "does NOT fold" tests
  (correlated subquery declines the fold; USING full join declines) now assert the
  declined-fold FULL join runs via nested-loop with correct results, including a
  **correlated subquery over the null-extended side** (`a.k` is null → count 0).
  All 21 gather tests pass; the high-latency gather path is still preferred when
  the cost gate fires.

Build + lint clean; full memory suite **5115 passing / 9 pending / 0 failing**;
store-mode spot-check of 90.5 / 90.5.1 / 11-joins passes (pure-emit change, no
store code touched — both vtab scans yield distinct per-row arrays so buffering
references is safe).

## Honest gaps / things to scrutinize

- **Slot reactivation on null-extended yields is defensive.** `driveFromRight`
  sets `leftSlot`/`rightSlot` to the null padding before the unmatched yields
  (mirroring `joinOutputRow`), but downstream operators rebind from the yielded
  row array, so this is belt-and-suspenders. Correctness of in-loop condition
  evaluation relies on the buffered-left child scan **closing its slot on
  exhaustion** (so the context map rebuilds the left attr ids back to the join's
  own `leftSlot`). This holds for the memory/store scans exercised here; an exotic
  source that leaves its slot installed after exhaustion could in principle shadow
  the join's left slot. Worth a skeptical read of the context-map interaction.
- **FULL buffers the entire left side in memory** (an array), and RIGHT buffers it
  too — non-streaming on the left, analogous to how inner/left materialize the
  inner side via cache. No spill; large left inputs are memory-heavy. No hash/merge
  variant exists (physical-selection bails on right/full), so it is O(L·R).
- **MV materialization of RIGHT/FULL is untested.** `collectBodyRows` runs the same
  runtime, so a materialized view over a right/full body should now refresh, but no
  test asserts it. `covering-structure.spec.ts` still proves coverage against the
  parsed AST via the `proveUnmaterialized` stub (kept deliberately scoped to the
  prover). A reviewer may want an MV-over-right-join refresh test.
- **`select *` column order via distinct names is order-independent** in the
  object-comparison harness (deep-equal ignores key order). The `:N` cases in
  11-joins pin order more strictly; if stronger positional assertions are wanted,
  add a `plan/` or column-name-sequence check.
- **Write-through is explicitly NOT touched.** RIGHT stays excluded from
  write-through recognition and FULL self-conservatizes (`multi-source.ts`); the
  static surfaces still report RIGHT/FULL views all-`NO`, and write attempts still
  reject `cannot write through view` (pinned by `06.3.4-view-info.sqllogic` and
  `93.2-view-mutation-pending.sqllogic`). Re-admission is the downstream
  `view-write-right-join-readmit` ticket (sequence 2, prereq = this).
- **Stale-comment cleanups** rode along (no behavior change): the semijoin-existence
  recovery rule header, the two `multi-source.ts` rationale comments, and the
  view-info test comments no longer cite "the runtime throws on RIGHT/FULL". Verify
  the reasoning is still accurate.
- **Pre-existing, unrelated:** `covering-structure.spec.ts:1383` carries a
  pre-existing TS diagnostic (a `db.watch` callback returning `push()`'s number) in
  an events test untouched by this ticket; it does not block the suite. Not mine.
