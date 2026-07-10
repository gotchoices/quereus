----
description: Add an off-by-default debug check that catches a whole class of silent wrong-row bugs in the query engine, where a streaming operator forgets to update its "current row" bookkeeping and a later read quietly returns the wrong row instead of raising an error.
prereq:
files: packages/quereus/src/runtime/context-helpers.ts, packages/quereus/src/runtime/strict-fork.ts, packages/quereus/src/runtime/emit/aggregate.ts, packages/quereus/src/runtime/emit/hash-aggregate.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/runtime/emit/asof-scan.ts, packages/quereus/test/runtime/fork-contract.spec.ts, packages/quereus/test-runner.mjs, packages/quereus/package.json, docs/runtime.md
difficulty: hard
----

## Background — what silently breaks today

At runtime a column reference resolves by attribute ID against a **shared, mutable**
`RowContextMap` (`packages/quereus/src/runtime/context-helpers.ts`). Its
`attributeIndex[attrId] → { rowGetter, columnIndex }` uses **last-`set`-wins**
semantics: whichever context most recently called `context.set(descriptor, …)` for
that attribute ID wins. Crucially, `slot.set(row)` — the per-row cheap field write a
streaming emitter does for each output row — does **not** touch the index.

The footgun (documented in `docs/runtime.md` § "Invariant: source-attr contexts and
child pulls"): a streaming operator that sets a context built from its source's
attribute IDs, then pulls its child for the next input row, leaves its **stale** row
winning the index. The child updates its own slot for the same IDs, but because
`slot.set` doesn't reclaim the index, the parent's previous row keeps winning. A
downstream read then resolves to the parent's stale row — **wrong result, no error.**

Today this is mitigated only by hand-applied, per-emitter discipline (tear-down-before-pull
in `emit/aggregate.ts` / `emit/window.ts`; `reactivate()`-before-yield in
`emit/asof-scan.ts`). Every new streaming emitter is a fresh chance to reintroduce a
silent wrong-row bug.

## What to build

An **env-gated, off-by-default** runtime assertion — `QUEREUS_CONTEXT_STRICT` — that
detects the *stale-shadow* form of this bug directly, modeled on the existing
`QUEREUS_FORK_STRICT` harness (`src/runtime/strict-fork.ts`). Same philosophy:
zero-cost when the flag is off, cheap enough to run the whole logic-test suite in CI
when on, and when it trips it names enough to be actionably better than the wrong
result it replaces.

### The signal: index-winner must be the most-recently-`set` live context for that attr

In a correct execution the `attributeIndex` winner for an attribute ID is, by the
last-`set`-wins rule, the live context whose row was updated most recently for that ID.
The stale-shadow bug is exactly the state where that stops holding: the index still
points at operator P's context (older row-update), while a *different* live context C
carries the same attribute ID with a **strictly newer** row update. That mismatch is
the assertion.

Concretely, maintain a monotonic clock and, per descriptor, a `lastTouchEpoch` bumped
on **both** `set()` and each `slot.set(row)`. Track, per attribute ID, which descriptor
currently wins the index (`set()`/`delete()` already rebuild the index — update the
winner map in lockstep). Then in `resolveAttribute`, under the flag only:

```
assertNoShadow(attrId):
  winnerDesc  = winnerByAttr[attrId]                 // whoever owns the index entry
  winnerEpoch = lastTouchEpoch[winnerDesc]
  for each live descriptor D carrying attrId with a POPULATED row (skip unpopulated):
    if lastTouchEpoch[D] > winnerEpoch and D !== winnerDesc:
      throw ContextShadowError(attrId, columnName, winnerDesc, D, rctx)
```

This fires precisely when a newer same-attr row is being shadowed by a stale index
entry — i.e. the operator-shadows-child / missing-tear-down bug. It does **not** fire
for correct tear-down (the stale entry is `delete`d, so it is not live) or correct
`reactivate()` (the operator's re-`set` makes it the winner and the newest epoch).

**Out of scope (deliberately):** the mirror direction — child-shadows-operator, where
an operator forgets `reactivate()` before yielding and a child cursor's genuinely-newer
look-ahead `set` wins. Recency cannot distinguish that wrong-but-newest state from a
correct newest write; catching it needs per-operator declared intent (provenance
threading) which is unresolved. Parked in backlog ticket
`debt-context-shadow-reactivate-direction`. Do not attempt it here.

### Zero-cost when off

- Add a module-level `CONTEXT_STRICT` boolean read once from
  `process.env.QUEREUS_CONTEXT_STRICT` (cross-platform guard: `typeof process !==
  'undefined'`, exactly like `strict-fork.ts`). Off ⇒ everything below is a no-op /
  never allocated.
- `resolveAttribute`'s only change on the hot path is a single leading
  `if (CONTEXT_STRICT) rctx.context.assertNoShadow?.(attributeId, columnName, rctx);`
  guard. When off, the branch is not taken and no epoch bookkeeping exists.
- The epoch/winner side-tables live **only** on a strict subclass of `RowContextMap`
  (mirror `StrictRowContextMap` in `strict-fork.ts`). The base `RowContextMap` keeps its
  current shape and hot-path allocation — do **not** add epoch fields to the base index
  entry. Construction flows through the existing `createStrictRowContextMap()`
  chokepoint (already called at all 7 RuntimeContext sites — statement.ts, database.ts
  `_executeSingleStatement`, database-assertions.ts, database-materialized-views-apply.ts
  `runScheduler`, derived-row-validator.ts, deferred-constraint-queue.ts,
  const-evaluator.ts, plus `ParallelDriver.fork`), so wiring the flag there reaches every
  context automatically. Fold context-strict into that same factory/subclass, each concern
  gated by its own env flag, rather than duplicating construction sites.

### `slot.set` → epoch bump

`createRowSlot` (context-helpers.ts) returns the slot whose `set(row)` is `ref.current =
row`. Under the flag, `set` must also bump the map's epoch for its descriptor
(`rctx.context.noteRowSet?.(descriptor)`). Per-row Map write is acceptable in strict/CI
mode. `withRowContext` / `withAsyncRowContext` one-shot contexts get a fixed install
epoch (row never changes for their lifetime).

### Diagnostic quality (required)

When it trips, the error must name: the **attribute ID + column name**; the **descriptor
that won the index** (stale) and its installer; the **descriptor with the newer row**
(shadow) and its installer; and — best-effort — the reading operator. To supply installer
identity, thread an optional lightweight installer label (e.g. `{ nodeType, id }` or a
string) into `createRowSlot` / `withRowContext` / `withAsyncRowContext` and the three
direct-`set` emitters (`aggregate.ts`, `hash-aggregate.ts`, `window.ts`). Detection does
**not** depend on the label — it degrades to the descriptor's attribute-ID list when a
label is absent, so threading labels can be incremental. For the reading operator, use
`rctx.planStack` top when populated; do not add planStack maintenance to the hot path
just for this (note it as a best-effort field).

Throw a `QuereusError(StatusCode.INTERNAL, …)` whose message starts with
`context-strict:` and points at `docs/runtime.md § Invariant: source-attr contexts and
child pulls` — mirroring the `strict-fork:` message convention so tests can match on the
prefix.

## Edge cases & interactions

- **Zero-cost-off proof.** With the flag unset, `RowContextMap` (base) and
  `resolveAttribute` must be byte-for-byte behaviorally unchanged: no epoch side-tables,
  no extra allocation per index entry, the strict branch not taken. Add a test asserting
  `createStrictRowContextMap()` returns a plain `RowContextMap` (not the strict subclass)
  when the flag is off, matching the existing fork-strict expectation.
- **Fallback scan path.** `resolveAttribute` falls back to a newest→oldest scan when the
  index entry's row is not yet populated (slot created, not `set`). The shadow check must
  skip unpopulated rows on **both** the winner and the candidate side, or a
  created-but-unset slot will false-positive.
- **Correct `reactivate()` (asof-scan).** `emit/asof-scan.ts` calls
  `rightSlot.reactivate()` (a re-`set`) before yield. Re-`set` must bump the winner and
  epoch so this path does **not** trip. Cover with the full logic suite under the flag.
- **Correct tear-down (aggregate/window).** `emit/aggregate.ts` and `emit/window.ts`
  `delete` the stale context before pulling. `delete` must remove the descriptor from the
  live set (and rebuild `winnerByAttr` for the affected IDs from remaining contexts,
  newest-wins) so the torn-down entry cannot be flagged.
- **`delete()` index rebuild.** The existing `delete()` rebuilds `attributeIndex` for
  affected IDs by iterating remaining contexts forward (last wins). `winnerByAttr` and the
  epoch bookkeeping must be rebuilt in the same pass and agree with the rebuilt index —
  boundary where a stale winner pointer would itself cause false positives/negatives.
- **Same attr ID legitimately in two live descriptors.** A base column can be installed by
  a leaf scan and re-installed by a join over the same IDs. In correct code the one that
  should win was `set` most recently ⇒ winner == max-epoch ⇒ passes. This is the case the
  check must NOT false-positive on; verify via the join/aggregate logic tests.
- **Parallel forks.** Each fork builds its own strict map via `createStrictRowContextMap()`
  and seeds it by copying parent entries through `set()` — the seed loop must initialize
  `winnerByAttr` and epochs so a post-fork read in a branch is checkable. Verify
  `QUEREUS_CONTEXT_STRICT` and `QUEREUS_FORK_STRICT` both enabled together do not interfere
  (independent concerns on the same subclass).
- **One-shot contexts (constraint checks, deferred queue, MV maintenance, const-eval).**
  These construct contexts via the same factory and run real emitters; they must not
  spuriously trip. Nested `withRowContext` over overlapping attribute IDs must keep
  last-set-wins consistency.
- **Cost.** The per-read check is O(live contexts carrying the attr). Live context count is
  small in practice. NOTE it in `resolveAttribute` as a tripwire: if a pathological plan
  makes strict-mode CI slow, index the per-attr candidate list instead of scanning all
  entries.

## Validation gate

- New focused unit test (mirror the strict-fork tests in
  `test/runtime/fork-contract.spec.ts`): under `QUEREUS_CONTEXT_STRICT`, construct a
  deliberate stale-shadow (parent slot `set`, child slot `set` same IDs without reclaiming
  the index) and assert `resolveAttribute` throws with a `context-strict:` message; and a
  positive test that correct tear-down / `reactivate()` does **not** throw. Skip the body
  when the flag is unset (same `this.skip()` pattern the strict-fork tests use).
- Add `--context-strict` to `test-runner.mjs` (sets `QUEREUS_CONTEXT_STRICT=1`, mirroring
  `--fork-strict`) and a `test:context-strict` script in `packages/quereus/package.json`.
  Wire it into the root `yarn check` gate alongside `test:fork-strict`.
- **Run the full logic suite under the flag** (`yarn workspace @quereus/quereus test:context-strict`,
  streamed via `2>&1 | tee`). Any trip is either (a) a real latent wrong-row bug — if so,
  stop and file a `fix/` ticket with the reproduction rather than silencing it, or (b) a
  false positive — refine the assertion (usually a fallback/unpopulated-row or
  delete-rebuild boundary above). Do not loosen the check to force green.
- `yarn lint` and `yarn build` clean.

## Docs

Update `docs/runtime.md` § "Invariant: source-attr contexts and child pulls" (and/or a new
subsection near the strict-fork docs at ~line 1484) to document `QUEREUS_CONTEXT_STRICT`:
what it asserts (stale-shadow / operator-shadows-child), what it deliberately does not
(the reactivate direction → point at the backlog ticket), how it is gated, and the
`--context-strict` / `test:context-strict` entry points.

## TODO

### Phase 1 — mechanism
- Add `QUEREUS_CONTEXT_STRICT` flag + `CONTEXT_STRICT` boolean (guarded `process` read) in the strict harness module.
- Extend the strict `RowContextMap` subclass with monotonic clock, per-descriptor `lastTouchEpoch`, per-attr `winnerByAttr`, `noteRowSet(descriptor)`, and `assertNoShadow(attrId, columnName, rctx)`. Keep the base class unchanged.
- Update `set()` / `delete()` to maintain `winnerByAttr` + epochs in lockstep with the existing index rebuild.
- Bump epoch from `slot.set` (strict-only, via `noteRowSet`).
- Add the single guarded `assertNoShadow` call at the top of `resolveAttribute`.

### Phase 2 — diagnostics
- Thread optional installer labels into `createRowSlot` / `withRowContext` / `withAsyncRowContext` and the direct-`set` emitters (aggregate, hash-aggregate, window).
- Build the `context-strict:` error message (attr, column, winner+installer, shadow+installer, best-effort reader from planStack).

### Phase 3 — wiring + validation
- `--context-strict` in `test-runner.mjs`; `test:context-strict` script; wire into `yarn check`.
- Focused unit tests (deliberate shadow trips; correct tear-down / reactivate does not).
- Run full logic suite under the flag; resolve every trip (fix real bug via new ticket, or refine assertion for false positives).
- Update `docs/runtime.md`.
