----
description: The persistent store now builds a hidden per-constraint index behind every plain UNIQUE column, so enforcing uniqueness is a fast index lookup instead of a whole-table scan — bulk inserts under a UNIQUE go from O(n²) to O(n log n).
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts    # withImplicitUniqueIndexes + implicitUniqueIndexName helpers; materializedSchema field; ctor + updateSchema; findIndexForUniqueConstraint; updateSecondaryIndexes; getMaterializedSchema
  - packages/quereus-store/src/common/store-module.ts    # alterTable dispatch + reconcileImplicitUniqueIndexStores + tearDownImplicitUniqueIndexStore + implicitUniqueIndexNameMap; rebuild-site materialization; ADD/DROP/RENAME constraint comment updates
  - packages/quereus-store/README.md                     # "How a UNIQUE constraint is enforced" + new implicit-index note
  - packages/quereus-store/test/unique-constraints.spec.ts   # updated scaling test + new lifecycle/coexistence/reopen/collation tests
  - packages/quereus/src/schema/manager.ts               # finalizeCreatedTableSchema (READ ONLY — the reason the engine-facing schema must stay non-materialized)
difficulty: hard
----

# Review: store materializes an implicit index for every non-derived UNIQUE

## What landed

A plain column/table-level `UNIQUE` in the persistent store used to have **no
backing index**, so enforcing it full-scanned the table for every constrained row
written (a bulk load of *n* rows ≈ *n²*). Now the store synthesizes a hidden
per-constraint index — named after the constraint (`<name>`) or, when unnamed,
`_uc_<columns>` — and enforcement routes through the existing index point-seek
(`findUniqueConflictViaIndex`), the same route that already served
`CREATE UNIQUE INDEX`. Bulk inserts under a plain `UNIQUE` are now O(n log n).

This brings the store to parity with the memory backend
(`MemoryTableManager.ensureUniqueConstraintIndexes`).

## The one design decision the reviewer must scrutinize

**The ticket said "materialize into `this.tableSchema` (StoreTable-local)" and
asserted the engine would never see `_uc_*`. That assertion is FALSE and I did
NOT follow the ticket literally here** — please verify my alternative is sound:

- `SchemaManager.finalizeCreatedTableSchema` (packages/quereus/src/schema/manager.ts:2284)
  registers `tableInstance.tableSchema` with the engine. `StoreTable.tableSchema`
  IS that field. So materializing into it leaks `_uc_*` into the engine-registered
  schema — which broke the exposed-implicit-index catalog tag machinery (the engine
  then routes `ALTER INDEX … SET TAGS` to a materialized index instead of the
  constraint's `exposedIndexTags`) and would let the read-query planner see `_uc_*`.
  The ticket itself elsewhere says **"do not register `_uc_*` with the engine."**
- **Resolution:** `StoreTable.tableSchema` stays engine-facing / non-materialized;
  a NEW private field `StoreTable.materializedSchema` holds the `_uc_*`-augmented
  copy and drives ONLY enforcement (`findIndexForUniqueConstraint`), maintenance
  (`updateSecondaryIndexes`), and validation (`validateKeyCollations`). Read-query
  resolution (`resolveIndexFromIdxStr`) still reads the non-materialized
  `tableSchema`, so the planner never picks `_uc_*` — matching memory.
- **Verify:** the memory backend actually DOES put `_uc_*` in its VirtualTable's
  `tableSchema` (`MemoryTable.tableSchema = manager.tableSchema`, table.ts:60), so
  memory's engine schema carries `_uc_*` while the store's now does not. This is a
  deliberate divergence — the store persists a catalog and the exposed-tag round
  trip depends on the engine schema staying clean; memory doesn't persist. Confirm
  this asymmetry is acceptable (I judged it is: it preserves ALL pre-feature store
  catalog behavior and the tag-persistence suite passes unchanged).

## The second structural choice to check

**Physical `_uc_*` store lifecycle is reconciled in ONE place**
(`reconcileImplicitUniqueIndexStores`, called once at the end of
`StoreModule.alterTable`), not scattered across the constraint arms as the ticket
sketched. It diffs the implicit-index NAME set (derived from `uniqueConstraints`)
before vs after the arm and: builds a newly-present name's store from effective
rows, tears down a newly-absent one. This uniformly covers:
- `ADD CONSTRAINT UNIQUE` → build,
- `DROP CONSTRAINT UNIQUE` → teardown,
- `RENAME CONSTRAINT` (named UNIQUE) → teardown+build,
- **`RENAME COLUMN` of an unnamed UC's column** → teardown+build (the implicit
  name changes; the ticket did not call this out — verify it is handled and
  correct; test `physical store lifecycle › RENAME CONSTRAINT …` is the named
  analogue but the column-rename path is exercised only indirectly by
  tag-persistence's `tags on an unnamed UC follow the implicit name across a column
  rename`).
- PK / collation / data-type ALTERs: name set unchanged → reconcile is a no-op;
  the physical re-encode is handled by the existing `rebuildSecondaryIndexes`,
  which I made materialize its schema arg (`withImplicitUniqueIndexes(updatedSchema)`)
  at all three rebuild sites so `_uc_*` is rebuilt alongside explicit indexes.

## Use cases to test / validate (this is a floor, not a ceiling)

Covered by new/updated tests in `test/unique-constraints.spec.ts`:
- **Structural O(n log n)** — `scaling › a plain UNIQUE now seeks its implicit index`:
  bulk-insert 100 rows into `t(id pk, v UNIQUE)`; the counting KV store shows **0**
  data-store iterations (down from Θ(n²)). This is the headline win.
- **ADD → DROP → re-ADD** the same UNIQUE — no stale/phantom entries after re-ADD.
- **RENAME CONSTRAINT** moves the physical store and keeps enforcing.
- **ADD CONSTRAINT bulk insert** seeks the built index (0 extra scans post-build).
- **Explicit + implicit coexistence** — both maintained; `DROP INDEX` of the
  explicit one leaves the implicit enforcing.
- **Multiple NULLs** coexist; non-NULL dup rejected via the implicit seek.
- **Collation guard** — plain UNIQUE in a `collation='BINARY'` store over a NOCASE
  column degrades to the full scan and still rejects (K finer than C).
- **Catalog is derive-on-open** — persisted bundle for `t(email UNIQUE)` has NO
  `create index` / `_uc_` line; engine-registered schema shows no `_uc_*`.
- **Close → reopen keeps enforcing** (`… — reopen` describe, persistent provider).

Pre-existing tests that now silently route through the implicit index (behavior
unchanged, path changed): all of `single-column UNIQUE`, `NULL semantics`,
`UPDATE same-PK`, `composite UNIQUE`, `PK-change UPDATE`, `covering MV`,
`collation-aware UNIQUE`, `internal-eviction reporting`.

## Known gaps / things I did NOT do (be adversarial here)

- **Reuse of an explicit index is NOT done** (deliberate, v1 scope). Every
  non-derived UNIQUE always materializes its own `_uc_*` even when a
  collation-compatible `CREATE INDEX` already covers the columns → redundant double
  maintenance (never wrong, since store index bytes are byte-identical). Deferred to
  `tickets/backlog/debt-store-implicit-unique-index-reuse` (prereq already set to
  this ticket).
- **Behavioral change worth a second look:** a plain **text** UNIQUE now makes the
  table's key collation K a *keyable* requirement at CREATE (the `_uc_*` text column
  is validated by `validateKeyCollations`). A comparator-only custom K + plain text
  UNIQUE that "worked" pre-feature (full-scan enforcement needed no keyable K) would
  now throw at CREATE. Correct (the index genuinely can't be keyed), but it is a
  behavior change; no existing test hits it (full suites green).
- **Reconcile build is not atomic on IO failure** (tripwire — `NOTE:` at the build
  site in `reconcileImplicitUniqueIndexStores`): an IO error mid-build leaves a
  partial `_uc_*` store while the constraint schema is already committed. Mirrors
  `rebuildSecondaryIndexes`' documented non-atomicity; a re-run/reopen rebuilds.
- **No `assertStoreNameFree` on the implicit build** (tripwire — `NOTE:` at the same
  site): the name is engine-derived/deterministic and the lazy first-write path
  doesn't assert either. A pathological store-name collision is not newly guarded.
- **Table-level partial UNIQUE (`unique(...) where p`) does not parse** (checked the
  grammar — a UNIQUE table constraint takes no WHERE), so a non-derived UC never
  carries a predicate. The `predicate === uc.predicate` matcher in
  `findIndexForUniqueConstraint` is therefore exact for the full case and *defensive*
  for a future partial; the derived-partial path (`CREATE UNIQUE INDEX … WHERE`) is
  unchanged and still tested. If you think a partial non-derived UC can arise, that
  matcher is the place to scrutinize.
- **RENAME/DROP mid-transaction**: reconcile teardown mirrors `dropIndex`
  (release+delete the store) with no special handling of coordinator pending ops on
  the torn-down store handle. Unusual (ALTER with queued index ops on that exact
  index); not specifically tested.

## Validation run (all green)

- `yarn workspace @quereus/store run build` — exit 0.
- `@quereus/store` unit suite — **957 passing**, 0 failing.
- `@quereus/isolation` suite — **245 passing** (covers the wrapper `EffectiveRowSource`
  ADD CONSTRAINT path).
- Store-path SQL logic — `node test-runner.mjs --store` — **6962 passing**.
- `yarn lint` — exit 0.
