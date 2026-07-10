description: Fixes a persistent-store bug where a failed commit leaves stale row-count estimates that leak into the next transaction, makes table rename carry its statistics along instead of throwing them away, and folds three copies of a byte-to-hex helper (plus a per-call encoder allocation) into one.
prereq: store-tablekey-split-mis-routes-dotted-identifiers
files:
  - packages/quereus-store/src/common/transaction.ts        # commit() (~215) — failed write fires neither callback
  - packages/quereus-store/test/transaction.spec.ts          # add commit-failure stats-clear test
  - packages/quereus-store/src/common/store-module.ts        # renameTable (~1970-2085) — migrate stats instead of delete
  - packages/quereus-store/src/common/serialization.ts       # hoist shared TextEncoder (24, 41, 159)
  - packages/quereus-store/src/common/bytes.ts               # single fast bytesToHex home
  - packages/quereus-store/src/common/cached-kv-store.ts     # private toHex (~31) — route through bytes.ts
  - packages/quereus-store/src/common/memory-store.ts        # private keyToHex (~18) — route through bytes.ts
difficulty: medium
----

# Store: codec + lifecycle cleanups (one correctness bug + hygiene)

Four store-package cleanups grouped into one coherent pass. **Item 1 is a real
correctness bug and the priority** — it gets its own test and must not be dropped
even if a hygiene item slips. Items 2–4 are safe, mostly-mechanical.

Item 5 (streaming large rewrites) and item 6 (decompose the 565-line
`alterTable`) from the original grab-bag are split into their own chained
tickets (`store-stream-large-rewrites`, `store-altertable-decompose`) — see the
Notes section.

## 1. CORRECTNESS — a failed commit leaks the stats delta into the next transaction

`TransactionCoordinator.commit` (`transaction.ts:215`) writes the buffered ops,
fires pending events, then notifies lifecycle callbacks:

```
try {
  … batch.write() / atomicBatch.write() …   // <-- can throw
  for (const event of this.pendingEvents) this.eventEmitter?.emitDataChange(event);
  for (const cb of this.callbacks) cb.onCommit();
} finally {
  this.clearTransaction();
}
```

Each `StoreTable` registers `{ onCommit: applyPendingStats, onRollback:
discardPendingStats }` (`store-table.ts` `attachCoordinator`, ~769). During a
transaction, row-count deltas accumulate in `StoreTable.pendingStatsDelta`
(`trackMutation(delta, /*inTransaction*/ true)`). `applyPendingStats` folds the
delta into `cachedStats` and zeroes it; `discardPendingStats` just zeroes it.

If the write **throws**, control jumps to `finally` → `clearTransaction()` runs,
but **neither** `onCommit` nor `onRollback` fires. The `pendingStatsDelta` on
every participating `StoreTable` is left non-zero. It is never cleared by
`begin()` either (which resets coordinator state, not per-table deltas), so the
delta **carries into the next transaction** on the same module coordinator and
is double-counted or misattributed. Row-count estimates drift, feeding the
planner's cost model wrong numbers.

The existing test `a rejected atomic write propagates, clears state, and leaks
no ops` (`transaction.spec.ts` ~713) proves the *ops* clear on write failure —
but says nothing about the stats callbacks, which is exactly the gap.

**Fix (recommended shape).** Guarantee that a commit which does not reach a
clean `onCommit` fires `onRollback` semantics for every callback before the
transaction is cleared, so no delta survives:

```
async commit(): Promise<void> {
  if (!this.inTransaction) return;
  let notified = false;
  try {
    … writes …
    … fire events …
    for (const cb of this.callbacks) cb.onCommit();
    notified = true;
  } finally {
    if (!notified) {
      // Commit failed before/while notifying: discard pending per-callback
      // state (stats deltas) so nothing carries into the next transaction.
      for (const cb of this.callbacks) cb.onRollback();
    }
    this.clearTransaction();
  }
}
```

Note the deliberate tradeoff on the partial-`onCommit` path: if `onCommit`
throws on callback k, callbacks `0..k-1` already applied their delta (and zeroed
it — a subsequent `onRollback` is a harmless no-op on them) while `k..n` are
discarded. `applyPendingStats` does not throw in normal operation, so this is a
defensive corner; leaving *some* deltas cleared and consistent beats leaking all
of them. Document the choice inline. The implementer may choose an equivalent
structure (e.g. separating the write phase from the notify phase) as long as the
invariant holds: **a commit that throws leaves every coordinator callback's
pending state clean.**

**Test (required, `transaction.spec.ts`).** Register a callback pair backed by a
counter/flag. Using the existing atomic spy with `failWrite = true`, begin a
transaction, queue a put, and assert `commit()` rejects. Then assert the
`onRollback` side ran (or, more directly, drive a `StoreTable` end-to-end: a DML
statement whose commit is forced to fail must leave the next transaction's
`getEstimatedRowCount()` starting from the pre-failure baseline, not
pre-failure + leaked delta). A coordinator-level unit test that asserts a
registered `onRollback` fires (and `onCommit` does not) on write failure is the
minimum; an end-to-end `StoreTable` stats assertion is the stronger form —
include it if it fits the run.

## 2. `renameTable` discards statistics instead of moving them

`renameTable` (`store-module.ts` ~1970–2085) does, in order:
`ddlCommitPendingOps()` → `existing.dispose()` (which flushes any buffered stats
to the OLD stats key, `buildStatsKey(schemaName, oldName)`) → physical
relocation + catalog rewrite → then:

```
const statsStore = await this.provider.getStatsStore(schemaName, newName);
const oldStatsKey = buildStatsKey(schemaName, oldName);
await statsStore.delete(oldStatsKey);   // <-- deletes, never re-keys
```

So the stats are **deleted, not migrated**. A freshly-renamed table reports
`getEstimatedRowCount() === 0` until stats are re-gathered — the planner costs it
blind in the meantime. (The unified `__stats__` store is keyed by
`schema.table`, so the entry must be re-keyed, not physically moved with the
directory.)

**Fix.** Migrate the entry: after `dispose()` (so the flushed value is on disk
under the old key), read the value at `oldStatsKey`; if present, `put` it under
`buildStatsKey(schemaName, newName)`; then `delete` the old key. Preserve the
existing "stats are advisory" tolerance — wrap in the same best-effort try/catch
so a stats hiccup never blocks the rename.

**Test.** Create a table, insert N rows (commit), `ALTER TABLE … RENAME TO …`,
assert `getEstimatedRowCount()` on the new name is N (not 0). A store-backed
integration test in the same style as `coordinator-callback-leak.spec.ts`'s
persistent provider is the right vehicle.

## 3. Per-call `TextEncoder` in the row/stats codec

`serialization.ts` allocates `new TextEncoder()` on every call at three sites:
`serializeRow` (24), `serializeValue` (41), `serializeStats` (159).
`TextEncoder` is stateless and reusable. Hoist a single module-level
`const textEncoder = new TextEncoder();` and reuse it. (Leave the `TextDecoder`
sites alone unless trivially symmetric — the ticket scope is the encoder churn.)

## 4. Consolidate three slow `bytesToHex` implementations

Three byte→hex-string helpers exist in the store package, all slow (per-byte
`toString(16)` + `padStart`/concat):
- `bytes.ts:9` `bytesToHex` — the exported one; all *external* callers already
  import it (`store-table.ts`, `transaction.ts`, `backing-host.ts`).
- `cached-kv-store.ts:31` `toHex` — private dup.
- `memory-store.ts:18` `keyToHex` — private dup.

Replace the body of `bytes.ts`'s `bytesToHex` with one fast lookup-table
implementation (precompute a 256-entry `string[]` of two-char hex, index by
byte), and route the two private helpers through it (import + delete the local
functions, or keep a one-line local alias if a rename ripples too far).

**Ordering invariant — do not break it.** `memory-store.ts` relies on the hex
alphabet being lowercase `[0-9a-f]` so `String.localeCompare` on hex strings
matches unsigned-byte order (see the `compareHex` comment at
`memory-store.ts:23`). The lookup table **must** emit lowercase, zero-padded,
two chars per byte — byte-for-byte identical output to today's implementations.
A test that hex-encodes `[0x00, 0x0f, 0xa0, 0xff]` and asserts `"000fa0ff"`
guards this.

Out of scope: the ~10 other hex encoders in `packages/quereus` (e.g.
`util/serialization.ts`, `util/key-tuple-codec.ts`, `vtab/memory/utils/
primary-key-encode.ts`, `planner/analysis/*`). They live in a different package
and their consolidation is a separate concern — do **not** pull them in. Leave a
one-line `NOTE:` in `bytes.ts` pointing at that broader duplication as a future
cleanup, and mention it in the review handoff.

## Edge cases & interactions

- **Commit-failure path (item 1).** Fallback (per-store) commit loop can throw on
  any store's `batch.write()` after an earlier store already wrote — the
  coordinator is already non-atomic across stores in that mode; item 1 only fixes
  the *stats-state* leak, not that pre-existing partial-write behavior. Don't
  widen scope. Assert the leak fix holds on BOTH paths (atomic-batch factory
  present and absent).
- **Multiple participating tables.** A module-wide coordinator holds one callback
  pair per live table. A commit failure must clear the delta on *every* table
  that mutated in the transaction, not just one — the fix loops all callbacks, so
  this is covered; add an assertion with two tables mutated in one transaction if
  practical.
- **onCommit already ran, then a later callback throws.** See the documented
  partial-apply tradeoff in item 1 — assert it does not *leak* (deltas end at 0),
  even if apply/discard is mixed across callbacks.
- **rollback() unchanged.** The explicit `rollback()` path already fires
  `onRollback`; item 1 must not double-fire it (rollback isn't a failed commit).
  Keep the two paths distinct.
- **Rename with never-flushed stats (item 2).** If the table was renamed with a
  pending delta but `mutationCount === 0` at dispose (delta applied but below the
  flush threshold), `dispose()` still flushes when `mutationCount > 0`;
  `applyPendingStats` increments `mutationCount`, so a table that did work
  flushes before delete. Migration reading the old key after dispose therefore
  sees the current value. Confirm with the item-2 test using a row count below
  `STATS_FLUSH_INTERVAL`.
- **Rename of a table with no stats yet.** `oldStatsKey` read returns undefined →
  skip the `put`, still delete (no-op). No spurious zero-count entry under the
  new name.
- **hex output stability (item 4).** Uppercase or unpadded output silently
  mis-orders `InMemoryKVStore` and corrupts every store test's oracle. The
  round-trip/ordering test is mandatory, not optional.
- **Cross-platform (item 3/4).** No `Buffer`, no Node-only APIs in the hoisted
  encoder or the hex table — this package runs in browser/RN too.

## TODO

- [ ] **Item 1 (priority):** restructure `commit()` so a throwing write/notify
      fires `onRollback` for all callbacks before `clearTransaction()`; keep the
      explicit `rollback()` path distinct. Add the coordinator-level stats-clear
      test (and end-to-end `StoreTable` variant if it fits).
- [ ] **Item 2:** migrate the stats entry old-key → new-key in `renameTable`
      (read after dispose, put under new key, then delete old), preserving the
      best-effort tolerance. Add the rename-keeps-rowcount test.
- [ ] **Item 3:** hoist one module-level `TextEncoder` in `serialization.ts`,
      reuse at the three serialize sites.
- [ ] **Item 4:** make `bytes.ts` `bytesToHex` a lookup-table impl (lowercase,
      2-char, zero-padded); route `cached-kv-store.ts` `toHex` and
      `memory-store.ts` `keyToHex` through it; add the hex ordering test; drop
      the `NOTE:` about the main-package duplicates.
- [ ] Run `yarn test` (memory-backed) and `yarn lint`. If store-path behavior is
      touched enough to warrant it, spot-run `yarn test:store` for the rename and
      stats paths (document if skipped for time).
- [ ] Write the review handoff honest about what was and wasn't verified
      (especially any deferred `yarn test:store`), and note the main-package hex
      duplication tripwire.

## Notes

- **Split-out siblings:**
  - `store-altertable-decompose` (implement, seq 4) — item 6, the 565-line
    `alterTable` refactor. Split off so a risky behavior-preserving refactor is
    not mixed with the item-1 correctness fix. Chained after this ticket because
    both edit `store-module.ts`.
  - `store-stream-large-rewrites` (plan, seq 5) — item 5, streaming CREATE INDEX
    / ALTER PK / column-rewrite instead of buffering the whole table. Routed to
    **plan**, not implement, because chunked flushing trades away the current
    all-or-nothing batch semantics for in-place rewrites (`rekeyRows`,
    `mapRowsAtIndex`) — a genuine atomicity design question, not a mechanical
    change. Chained after the decompose ticket.
- The related `tableKey.split('.')` mis-routing (`prereq`) is a separate
  correctness bug with its own repro — do not duplicate it here.
