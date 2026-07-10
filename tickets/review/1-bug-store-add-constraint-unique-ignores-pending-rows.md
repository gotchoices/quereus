----
description: On persistent-store tables, adding a UNIQUE constraint (or changing a column's text-comparison rule) now checks both committed rows and rows written earlier in the same still-open transaction, closing a hole where such a duplicate could survive.
files:
  - packages/quereus-store/src/common/store-module.ts   # validateUniqueOverExistingRows (~1130), call sites in addConstraint (~1456) and SET COLLATE (~1714)
  - packages/quereus-store/test/unique-constraints.spec.ts # new describe block: 'ADD CONSTRAINT UNIQUE / SET COLLATE validate pending rows'
difficulty: easy
----

# Store `ADD CONSTRAINT … UNIQUE` / `SET COLLATE` now validate effective rows

## What changed

`validateUniqueOverExistingRows` (`store-module.ts`) took a `KVStore` and scanned
`dataStore.iterate(...)` directly — committed rows only. Both call sites now pass
`table.iterateEffectiveEntries(buildFullScanBounds())` instead (an `AsyncIterable<KVEntry>`
of committed rows merged with the current transaction's own pending puts/deletes),
mirroring how `createIndex` already feeds `buildIndexEntries`. The method signature
changed from `(dataStore: KVStore, …)` to `(entries: AsyncIterable<KVEntry>, …)`; its
body is otherwise unchanged (same per-column collation-aware `seen`-set dedup, same
partial-predicate and NULL handling).

Two call sites updated:
- `alterTable` → `case 'addConstraint'` → `constraint.type === 'unique'`: dropped the
  now-unused `getStore(...)` call, passes the effective stream directly.
- `alterTable` → `case 'alterColumn'` → `SET COLLATE` non-PK re-validation: the
  `iterateEffectiveEntries(...)` call is now made fresh INSIDE the
  `for (const uc of coveringConstraints)` loop (it's a fresh async generator each
  time — can't be hoisted and reused across iterations).

Neither call site mutates the store before the validation call returns, so the
existing "throws BEFORE any mutation/persist" guarantee is untouched — a rejected
`ADD CONSTRAINT` or `SET COLLATE` still leaves the table exactly as it was.

## Use cases / how to validate

The bug: inside an open transaction, insert two rows that collide on a column, then
`ALTER TABLE … ADD CONSTRAINT … UNIQUE (col)` — before the fix this was silently
accepted because the validator never saw the transaction's own pending inserts. Same
hole for `ALTER TABLE … ALTER COLUMN … SET COLLATE …` when the new collation makes two
already-inserted-but-uncommitted values collide (e.g. `'a'` / `'A'` under `NOCASE`).

New tests in `packages/quereus-store/test/unique-constraints.spec.ts`, describe block
`'ADD CONSTRAINT UNIQUE / SET COLLATE validate pending rows'` (exercises `StoreModule`
directly, no isolation-layer overlay — same posture as the rest of that file):

- `ADD CONSTRAINT UNIQUE rejects when a pending duplicate is still uncommitted` — begin,
  insert two colliding rows, `ADD CONSTRAINT … UNIQUE` now throws `UNIQUE constraint
  failed` instead of being silently accepted.
- `ADD CONSTRAINT UNIQUE with non-colliding pending rows is accepted and then enforced`
  — begin, insert two non-colliding pending rows, constraint is accepted, and a
  subsequent colliding insert in the SAME transaction is rejected (proves the
  constraint is live immediately, not just after commit).
- `SET COLLATE NOCASE rejects when pending rows collide under the new collation` — begin,
  insert `'a'` / `'A'` into a column already covered by a UNIQUE constraint, `SET
  COLLATE NOCASE` now throws instead of accepting a collation change that would leave
  a live duplicate.
- `SET COLLATE NOCASE with non-colliding pending rows revalidates and keeps enforcing` —
  mirrors the ADD CONSTRAINT non-colliding case for the collation-change path.

Validation run: `yarn workspace @quereus/store test` (803 passing, includes the 4 new
cases), `yarn test` (full monorepo, 6708+ passing in `@quereus/quereus` plus all other
workspaces, no failures), `yarn lint` (clean — `@quereus/quereus`'s eslint + `tsc -p
tsconfig.test.json --noEmit` pass; every other package's no-op lint reached).

## Known gaps / things the reviewer should know

- **No sqllogic coverage added here, deliberately.** The ticket explicitly called this
  out: the logic suite (`packages/quereus/test/logic/`) runs against the MEMORY backend
  by default, which has the identical hole. That's tracked as a separate sibling ticket,
  `bug-memory-ddl-validation-ignores-pending-rows` (still sitting in `tickets/implement/`
  as of this writing, not yet landed) — it is the one that will add the shared sqllogic
  file. Until it lands, the memory backend still silently accepts this same duplicate.
- **Adjacent hazard intentionally left alone**: the `SET COLLATE`-on-a-PK-column arm
  (`rekeyRows` + `rebuildSecondaryIndexes`) still re-encodes the COMMITTED data store in
  place while the coordinator holds pending ops keyed under the OLD bytes — a distinct
  defect, already tracked as `bug-store-alter-rekey-ignores-pending-ops` in
  `tickets/fix/`. `rebuildSecondaryIndexes` was not touched.
- Only the store-module full-scan `uniqueConstraints` path was in scope. The
  index-backed path (`CREATE UNIQUE INDEX` over existing rows via `buildIndexEntries`)
  was already fixed previously and has its own pending-rows test coverage
  (`unique-constraints.spec.ts` → `'an index created mid-transaction indexes the
  pending rows'`) — not re-touched, just used as the template for this fix and its
  tests.
- No new tripwires identified during this change; the doc comment on
  `validateUniqueOverExistingRows` was updated to state the effective-stream contract
  so a future caller doesn't regress it back to a committed-only stream.
