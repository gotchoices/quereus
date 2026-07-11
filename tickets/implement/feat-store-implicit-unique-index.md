----
description: A plain UNIQUE column in the persistent store has no index behind it, so enforcing it still scans the whole table and bulk inserts stay slow; build a hidden per-constraint index so the check becomes a fast lookup like it already is for explicitly-indexed columns.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts    # StoreTable ctor + updateSchema (materialize); findIndexForUniqueConstraint (~2072); updateSecondaryIndexes (~1814); checkUniqueConstraints (~1967)
  - packages/quereus-store/src/common/store-module.ts    # alterAddConstraint (~1747); alterDropConstraint (~1818); alterRenameConstraint (~1859); rebuildSecondaryIndexes call sites (~1730/2021/2033); buildIndexEntries (~1089); createIndex/dropIndex (~869/996)
  - packages/quereus/src/vtab/memory/layer/manager.ts    # ensureUniqueConstraintIndexes (~161) — the reference naming + shape to mirror
  - packages/quereus/src/schema/catalog.ts               # implicitIndexName / isHiddenImplicitIndex / exposedImplicitIndexes — name convention to match; NOT changed
  - packages/quereus-store/README.md                     # "How a UNIQUE constraint is enforced" — update
  - packages/quereus-store/test/unique-constraints.spec.ts   # new enforcement + lifecycle tests
difficulty: hard
----

# Store: materialize an implicit index for every non-derived UNIQUE constraint

## What this is about

The persistent store keeps a plain column/table-level `UNIQUE` as a
`uniqueConstraints` entry with **no backing index store**, so enforcing it means
a full table scan for every constrained row written — a bulk load of *n* rows
costs about *n²*. The sibling work (`store-index-scan-read-primitive`,
`store-unique-check-via-index`, both landed) taught the store to enforce a UNIQUE
through an index point-seek **when an index already exists**. This ticket makes
one exist for every plain UNIQUE, so the same O(n log n) enforcement applies.

The memory backend already does this (`MemoryTableManager.ensureUniqueConstraintIndexes`):
it synthesizes a hidden `_uc_*` secondary index per non-derived UNIQUE constraint
and enforces through it. This ticket brings the store to parity.

## The design, resolved

### Where the implicit index lives — StoreTable-local `schema.indexes`

Materialize a synthetic `TableIndexSchema` per non-derived UNIQUE constraint into
the **StoreTable's own** `this.tableSchema.indexes`, via a shared pure helper
applied in the `StoreTable` constructor and in `StoreTable.updateSchema`. This
mirrors memory (which materializes into the *manager-local* schema, not the
engine-registered one) and has these consequences, all verified against the
current code:

- **Enforcement picks it up for free.** `findIndexForUniqueConstraint` and
  `updateSecondaryIndexes` both iterate `this.tableSchema.indexes` — the
  StoreTable-local copy. Once `_uc_*` is in that list, DML maintains the physical
  index and the UNIQUE check seeks it, with **no new enforcement code path**
  (route 2 of `findUniqueConflictFor` already exists).
- **The planner stays blind — deliberately, and this matches memory.** The engine
  planner reads `db.schemaManager.getTable(...).indexes` (the engine-registered
  schema), which never carries `_uc_*` (`buildTableSchemaFromAST` synthesizes
  none). So neither backend uses its `_uc_*` for *read-query* planning; both use
  it only for enforcement/maintenance. Read-side speedup for plain UNIQUE is out
  of scope here (and equally absent in memory) — do not register `_uc_*` with the
  engine.
- **Persistence needs no change.** `buildCatalogEntry` (store-module.ts ~2897)
  already skips `isHiddenImplicitIndex(schema, idx.name)` when emitting the
  catalog bundle, and the alter arms pass their *non-materialized* module-local
  `updatedSchema` to `saveTableDDL`, so `_uc_*` is never written as a `CREATE
  INDEX`. It is fully **derived on open**: reconstructing the StoreTable
  re-materializes `_uc_*` from `uniqueConstraints`; the physical index store
  persists on its own because `updateSecondaryIndexes` maintained it continuously
  under a deterministic name.

### The shared helper

```ts
// store-table.ts (exported so store-module.ts can reuse the naming)
export function withImplicitUniqueIndexes(schema: TableSchema): TableSchema
```

Idempotent, returns a frozen schema. For each `uc` in `schema.uniqueConstraints`:
- **skip** `uc.derivedFromIndex` (its explicit index is already in
  `schema.indexes`);
- **skip** if an index of the implicit name already exists in `schema.indexes`
  (idempotency);
- otherwise append
  ```ts
  {
    name: uc.name ?? `_uc_${uc.columns.map(i => schema.columns[i]?.name ?? String(i)).join('_')}`,
    columns: uc.columns.map(idx => ({ index: idx, collation: schema.columns[idx]?.collation })),
    predicate: uc.predicate,   // SAME reference as uc.predicate — load-bearing, see below
  }
  ```
  The name convention **must** equal `catalog.ts`'s `implicitIndexName`
  (`uc.name ?? '_uc_<colNames>'`) so `isHiddenImplicitIndex` recognizes it as
  hidden if it ever reaches the bundle generator.

### v1 scope decision: always materialize, no reuse of explicit indexes

Materialize a `_uc_*` for **every** non-derived UC, even when an explicit
`create index` already covers the same columns. Rationale and tradeoff:

- Store index-column bytes are encoded under the **table key collation K** for
  *any* index (`buildIndexKey` uses `this.encodeOptions`), so a `_uc_email` and an
  explicit `create index ix on t(email)` produce **byte-identical** structures.
  A duplicate is therefore purely wasteful (double maintenance writes), never
  wrong, and `findIndexForUniqueConstraint` seeking either is sound.
- Making the `_uc_*` lifecycle a pure function of the **UC set alone**
  (independent of explicit indexes) keeps physical build/teardown confined to the
  constraint arms (ADD/DROP/RENAME CONSTRAINT) and out of `createIndex`/`dropIndex`
  — a materially smaller, safer change than memory's reuse-with-collation-match.
- The rare waste (a user who declares *both* a `unique` constraint and a separate
  `create index` on the same column) is filed as `backlog/debt-store-implicit-unique-index-reuse`
  (skip the `_uc_*` when a collation-compatible explicit full index already
  covers the columns; requires reconciliation in `createIndex`/`dropIndex` to
  build/tear down on the reuse transition).

### Enforcement matcher — extend for partial UNIQUE

`findIndexForUniqueConstraint` (store-table.ts ~2072) today matches a non-derived
UC only against a **full** (`!ix.predicate`) same-column index. A *partial*
`unique(...) where p` has `uc.predicate` set, and its `_uc_*` carries that same
predicate — so the current matcher would never find it and partial UNIQUE would
stay on the full scan.

Change the non-derived branch to match an index whose columns positionally equal
`uc.columns` **and whose `predicate === uc.predicate`** (reference identity — the
helper sets the same object). This:
- subsumes the existing full-UC case (`undefined === undefined`);
- soundly admits the partial `_uc_*` (it holds exactly the in-scope rows, and
  `checkUniqueConstraints` already skips an out-of-scope new row via `compileFor(uc)`
  before the seek);
- does **not** wrongly admit an arbitrary user *partial* index whose predicate is a
  different object (stays conservative → full scan, as today). Keep the review
  note from the sibling ticket accurate: an arbitrary partial index still cannot
  serve a UC; only the co-scoped `_uc_*` can.

The collation guard `indexSeekHonorsEnforcementCollation(uc)` is unchanged and
still gates the final decision.

### Physical index-store lifecycle — reconcile in the constraint arms

The `_uc_*` **schema** entry appears/disappears automatically via the helper on
`updateSchema`. The **physical** index store must be reconciled explicitly:

| Path | Today | Required change |
|---|---|---|
| `create table t (… unique)` | validates nothing (empty) | none — `_uc_*` store is created lazily on first write by `ensureIndexStore` in `updateSecondaryIndexes`; empty table → empty store |
| bulk `insert` | full scan per row | none — first write creates the store, every subsequent row's UNIQUE check seeks it |
| `alterAddConstraint` (unique) | validates existing rows, **builds nothing** (comment at ~1760 now obsolete) | after `updateSchema` materializes `_uc_*`: **populate** its physical store from `iterateEffectiveEntries` via `buildIndexEntries(…, skipDuplicateCheck=true)` (dups already rejected by the existing `validateUniqueOverExistingRows`) |
| `alterDropConstraint` (non-derived unique) | schema-only, **no teardown** (comment at ~1825 now obsolete) | tear down the now-absent `_uc_*` physical store (`releaseIndexStore` + `provider.deleteIndexStore`) |
| `alterRenameConstraint` (named unique) | schema-only | the implicit name is `uc.name ?? …`, so a rename **moves** the store: tear down old-named `_uc_*`, build new-named from effective rows |
| `alterColumnSetCollate` / `alterPrimaryKey` | `rebuildSecondaryIndexes` rebuilds all `schema.indexes` | make rebuild iterate the **materialized** list — see below |

Prefer a single **reconciliation routine** keyed on the diff of implicit-index
names between the old and new materialized schemas — "build each newly-present
`_uc_*` from effective rows; tear down each newly-absent one" — and call it from
the ADD/DROP/RENAME-constraint arms. ADD = one build, DROP = one teardown,
RENAME = teardown+build fall out uniformly.

### rebuildSecondaryIndexes must see the materialized list

`rebuildSecondaryIndexes` is called (store-module.ts ~1730, ~2021, ~2033) with the
module-local `updatedSchema`, which is **not** materialized. After
`table.updateSchema(updatedSchema)` runs, `table.getSchema()` returns the
materialized superset (new columns/PK **and** `_uc_*`). Ensure these ALTER arms
call `table.updateSchema(updatedSchema)` **before** the rebuild and pass
`table.getSchema()` (or its `.indexes`) as the index list to rebuild, so a
PK/collation change re-encodes the `_uc_*` PK suffix too. Verify the call order at
each site; fix any that rebuild before updating.

## TODO

### Phase 1 — materialize + enforce (the core win)
- Add `withImplicitUniqueIndexes(schema)` to store-table.ts (exported). Idempotent,
  frozen output, skips `derivedFromIndex` UCs and already-present names.
- Apply it in the `StoreTable` constructor and in `updateSchema` (after
  `validateKeyCollations`, before adopting — validate the *materialized* schema so
  a `_uc_*` over a text column that needs K is caught).
- Extend `findIndexForUniqueConstraint` to match `predicate === uc.predicate`
  (covers full + partial). Update its doc comment (the "unlike the memory backend,
  which auto-builds…" paragraph at ~2054 is now false).
- Confirm `updateSecondaryIndexes` maintains the new `_uc_*` (it iterates
  `schema.indexes` — should be free; add a test).
- Verify `checkUniqueConstraints` → `findUniqueConflictViaIndex` now routes plain
  UNIQUE through the seek (add the counting-KV structural test below).

### Phase 2 — physical lifecycle
- Reconciliation routine (build newly-present / tear down newly-absent implicit
  index stores) + wire into `alterAddConstraint`, `alterDropConstraint`,
  `alterRenameConstraint`. Delete/replace the two obsolete "nothing physical to
  build/drop" comments.
- Make the `alterColumnSetCollate` / `alterPrimaryKey` arms rebuild the
  **materialized** index list (`table.getSchema().indexes`) — verify order.
- Confirm `createIndex`/`dropIndex` need **no** change under the no-reuse rule
  (explicit-index lifecycle is independent of `_uc_*`); add a coexistence test.

### Phase 3 — docs, backlog, validate
- Update `packages/quereus-store/README.md` "How a UNIQUE constraint is enforced".
- File `backlog/debt-store-implicit-unique-index-reuse`.
- `yarn workspace @quereus/store run build` (the store's only typecheck),
  `@quereus/store` unit suite, `@quereus/isolation` suite, and the store-path SQL
  logic suite (`packages/quereus && node test-runner.mjs --store 2>&1 | tee /tmp/store.log; tail -n 60 /tmp/store.log`),
  then `yarn lint`. Stream long output with `tee`.

## Edge cases & interactions

- **Empty table.** `create table t (email text unique)` with no rows: `_uc_*`
  materialized, no physical store yet. First insert lazily creates it; enforcement
  before any insert finds an empty/absent store and correctly reports no conflict.
- **Reopen (feature-written table with data).** Physical `_uc_*` store persisted on
  disk under its deterministic name; reconstruction re-materializes the schema
  entry, `ensureIndexStore` reopens the store. Sound. Add a close→reopen→enforce
  test.
- **Reopen of a PRE-feature store** (no `_uc_*` store on disk): materialized schema
  trusts an empty index → would MISS conflicts. Backwards compat is waived
  project-wide (AGENTS.md), but call it out in the README and confirm
  `ensureIndexStore` on a missing store yields empty rather than throwing.
- **ADD CONSTRAINT over existing duplicates** must throw CONSTRAINT before building
  the store and leave the transaction intact (existing `validateUniqueOverExistingRows`
  runs first; build only after it passes).
- **ADD then DROP then re-ADD** the same UNIQUE: DROP must tear down the physical
  store, or the re-ADD's `ensureIndexStore` reopens **stale** entries and enforces
  against phantom rows. Test this exact sequence.
- **RENAME CONSTRAINT of a named UNIQUE** moves the implicit index name → moves the
  physical store. Without teardown+rebuild, enforcement seeks a new empty store and
  accepts duplicates. Test.
- **Partial UNIQUE (`unique(...) where p`).** `_uc_*` carries the predicate;
  `updateSecondaryIndexes` and `buildIndexEntries` already filter partial indexes by
  predicate; enforcement matches via `predicate === uc.predicate`. Test insert of an
  out-of-scope duplicate (allowed) and an in-scope duplicate (rejected).
- **Multi-NULL.** A row with NULL in any covered column is not indexed and never
  conflicts — `checkUniqueConstraints` skips it, `updateSecondaryIndexes`/
  `buildIndexEntries` skip NULL keys. Test many NULLs coexisting.
- **Collation (K vs enforcement C).** `_uc_*` bytes use K; the guard
  `indexSeekHonorsEnforcementCollation` degrades to full scan when K is finer than
  C. Test `email text collate binary unique` in a NOCASE-key table and the reverse,
  asserting correct conflicts either way.
- **UPDATE that changes a covered column**, including a PK-changing UPDATE (passes
  `[oldPk, newPk]` to `updateSecondaryIndexes`) — the `_uc_*` entry must move and
  enforcement must see the moved state. Test.
- **REPLACE / IGNORE / ABORT** conflict actions resolve identically whether the
  conflict came from the seek or the scan (same `{pk,row}` shape). Test REPLACE
  eviction identity through the implicit index.
- **Explicit index coexistence.** `create table t(email text unique)` then
  `create index ix on t(email)`: both `_uc_email` and `ix` maintained (byte-identical,
  redundant, sound). `drop index ix` leaves `_uc_email` enforcing. Test no crash /
  correct enforcement across both.
- **Read-your-own-writes inside a transaction.** A duplicate inserted earlier in the
  same open transaction must be caught: `createIndex`-style builds use
  `iterateEffectiveEntries`, and `updateSecondaryIndexes` queues pending index ops
  through the coordinator. Test `begin; insert dup1; insert dup2` rejected.
- **Isolation-layer wrapper.** ADD CONSTRAINT under the isolation layer passes a
  wrapper `EffectiveRowSource`; the physical build must populate from **this
  module's** committed rows (as `createIndex` does with `skipDuplicateCheck`), not
  the wrapper's, while validation judges the wrapper's rows. Mirror
  `createIndex`'s split.
- **Index-store name collision.** `_uc_<cols>` feeds `buildIndexStoreName`; a
  sibling table or user index whose physical name collides is already guarded for
  explicit indexes (`assertStoreNameFree`) — confirm the lazy implicit build path is
  not a new uncaught collision surface (note-level; rare).

## Key tests & expected outputs

- **Structural O(n log n), not wall-clock.** Using the counting KV store the sibling
  tickets pin against, bulk-insert *n* rows into `create table t(id integer primary
  key, email text unique)` and assert the data-store read count is ~O(n log n), not
  ~O(n²) — the same structural assertion `store-unique-check-via-index` used, now
  reaching plain UNIQUE.
- **Parity with memory.** For each DDL above, the store raises the *same* conflict
  (or accepts the same row) as the memory backend — same NULL/partial/collation
  semantics.
- **Reopen keeps enforcing:** close, reopen, insert a duplicate of a pre-close row →
  rejected.
- **Catalog bundle unchanged:** assert the persisted DDL for `create table
  t(email text unique)` contains **no** `create index _uc_…` line (derive-on-open).

## Deferred / backlog

- `backlog/debt-store-implicit-unique-index-reuse` — skip the `_uc_*` when a
  collation-compatible explicit full index already covers the UC columns, with
  reconciliation in `createIndex`/`dropIndex` for the reuse transition.
