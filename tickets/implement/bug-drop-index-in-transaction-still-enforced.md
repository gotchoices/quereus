----
description: Dropping a unique index or constraint inside an open transaction should stop enforcing it for the rest of that transaction; today the transaction keeps rejecting rows against a constraint that no longer exists.
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # adoptSchema — add the removal path
  - packages/quereus/src/vtab/memory/layer/manager.ts        # dropIndex / dropConstraint — call adoptSchemaOnOpenLayers
  - packages/quereus/docs/memory-table.md                    # §"DDL and transactions" — retire the carve-out at lines ~250-252
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic  # sibling additive test — mirror its structure
difficulty: medium
----

# `DROP INDEX` / `DROP CONSTRAINT` inside a transaction keeps enforcing

## Confirmed reproduction (memory backend, on `main`)

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');
drop index ix;
insert into t values (2, 'a');   -- REJECTED: "UNIQUE constraint failed: t (v)"
```

Verified failing at HEAD via a scratch `.sqllogic` run through `test/logic.spec.ts`: the second
insert raises `UNIQUE constraint failed: t (v)`. It should be accepted — `ix`, and the UNIQUE
constraint derived from it, no longer exist.

## Root cause

A `TransactionLayer` freezes the table schema at construction (`tableSchemaAtCreation`) and
enforces UNIQUE off that frozen schema: `performInsert` reads `schema = targetLayer.getSchema()`
and `checkUniqueConstraints` iterates `schema.uniqueConstraints`. When DDL changes the table's
schema mid-transaction, the manager updates its own `tableSchema` and the base layer, but the
open transaction layers keep their frozen schema unless someone hands them the new one.

`MemoryTableManager.adoptSchemaOnOpenLayers` is that hand-off: it walks the DDL connection's
pending layer plus every savepoint snapshot beneath it, oldest-first, calling
`TransactionLayer.adoptSchema(newSchema)` on each. `createIndex` and `addUniqueConstraint`
already call it — which is why the *additive* half of this class of bug
(`bug-memory-ddl-validation-ignores-pending-rows`, now in `complete/`) is fixed.

Two gaps remain, both subtractive:

1. `dropIndex` (manager.ts ~2392) and `dropConstraint` (manager.ts ~2452) update
   `this.tableSchema` and the base layer but **never call `adoptSchemaOnOpenLayers`**. So the
   open layers keep the dropped constraint in their frozen schema and go on enforcing it.
2. `TransactionLayer.adoptSchema` (transaction.ts ~186) only **adds/replaces** indexes present
   in `newSchema.indexes`; it has no path to **remove** a `MemoryIndex` whose name is gone from
   `newSchema`. Its own doc-comment says it "never removes them."

Fixing both closes the enforcement gap. Enforcement stops the moment the layer's frozen schema
loses the derived `uniqueConstraints` entry, because `checkUniqueConstraints` iterates that list;
removing the orphaned `MemoryIndex` additionally stops an index scan from reaching the dropped
index via `getSecondaryIndexTree(name)`.

## Store backend and isolation layer

The store backend does **not** freeze schema per transaction layer — `StoreTable.getSchema()`
returns the live `this.tableSchema`, updated by `updateSchema`, and `checkUniqueConstraints`
reads from it directly. So once the store's DDL path updates the schema, enforcement stops with
no per-layer adoption needed. The cross-backend test below is expected to pass on store as-is; if
it does not, that is a *separate* store-side defect — file it, don't fold it in here.

The isolation layer (`quereus-isolation`) wraps the memory table; its enforcement bottoms out in
the wrapped table's `checkUniqueConstraints`, so the memory fix carries through. The cross-backend
test running under both modes pins this.

## Scope decision — enforcement only, NOT DROP reversibility

This ticket fixes in-transaction **enforcement** and nothing more. It deliberately does not make
`DROP` reversible.

The original fix ticket flagged the savepoint question:

```sql
begin;
insert into t values (1, 'a');
savepoint s;
drop index ix;
rollback to s;   -- under SQL, ix is enforced again
```

`adoptSchemaOnOpenLayers` rewrites *every* layer in the savepoint chain (that is exactly what
makes the additive case survive `rollback to savepoint`). Applied to a removal, it means the
dropped index stays dropped in the restored snapshot too — after `rollback to s`, `ix` is *not*
enforced again.

**That is the correct, in-scope behavior here, not a defect to fix.** The memory module's DDL is
not transactional at all today: a plain `ROLLBACK` after `DROP INDEX` does not bring the index
back either. This is documented (`docs/memory-table.md` §"DDL and transactions" → "DDL does not
roll back") and tracked as the larger feature `feat-ddl-transaction-capability` (in `backlog/`).
Making `DROP` reversible belongs to that feature, alongside making `CREATE` reversible — do not
attempt it here.

Note the direction matters and is safe: rolling back rows while the constraint stays *dropped*
can never manufacture a UNIQUE violation (there is no constraint left to violate). The only
divergence from SQL is that a post-`rollback-to-savepoint` insert of a would-be duplicate is
accepted where SQL would reject it — the same DDL-not-transactional divergence already accepted
for the additive side. Record it as a tripwire in the review handoff, not as a new ticket.

## TODO

### Phase 1 — fix

- In `TransactionLayer.adoptSchema` (transaction.ts): after the add/replace loop over
  `newSchema.indexes`, remove from `this.secondaryIndexes` every entry whose name is absent from
  `newSchema.indexes` (an empty/undefined `newSchema.indexes` means remove all). Update the
  method's doc-comment: it now handles a third kind of change — **removal** (`DROP INDEX` /
  `DROP CONSTRAINT`) — and no longer "never removes." Keep the existing additive/re-key paths
  intact; identity-based `previous === indexSchema` skip is unchanged.
- In `MemoryTableManager.dropIndex` (manager.ts): after `this.tableSchema = finalNewTableSchema;`
  add `this.adoptSchemaOnOpenLayers(finalNewTableSchema);`, mirroring `createIndex`. Keep it
  inside the try so the catch's schema restore still covers it.
- In `MemoryTableManager.dropConstraint` (manager.ts): after
  `this.tableSchema = newSchema; this.initializePrimaryKeyFunctions();` add
  `this.adoptSchemaOnOpenLayers(newSchema);`. (`dropConstraint` handles CHECK / FK / UNIQUE; the
  adoption is harmless for CHECK/FK — those layers simply re-freeze an equivalent schema — and
  necessary for UNIQUE.)

### Phase 2 — tests

- Add a new cross-backend sqllogic file (suggest `10.1.3-ddl-drop-in-transaction.sqllogic`),
  mirroring the structure of `10.1.2-ddl-in-transaction.sqllogic` (one statement per block; runs
  under both memory and store). Cover:
  - `drop index` on a unique index inside a transaction → a subsequently-inserted duplicate is
    accepted; `commit`; both rows present.
  - `alter table … drop constraint <u>` inside a transaction → same.
  - after commit, the constraint is genuinely gone (a fresh duplicate insert still accepted).
  - a non-dropped sibling unique index/constraint on the same table is still enforced (guard
    against over-broad removal).
  - **Pin the DDL-not-transactional behavior explicitly, with a comment referencing
    `feat-ddl-transaction-capability`:** after `savepoint s; drop index ix; rollback to s;`, an
    insert of a would-be duplicate is still accepted (index stays dropped). This pins current
    intended behavior so a future reader doesn't mistake it for a regression.
- Optional (nice-to-have, not required): a `test/plan/` assertion that an index scan is no longer
  planned against the dropped index within the transaction. Harder to express; skip if it balloons
  scope — the functional test above already proves the index is not enforced.

### Phase 3 — docs

- In `docs/memory-table.md` §"DDL and transactions": remove the carve-out paragraph (~lines
  250-252, "One carve-out remains: `DROP INDEX` / `DROP CONSTRAINT` … never removes them; see
  `tickets/backlog/bug-drop-index-in-transaction-still-enforced.md`"). Replace with one sentence
  folding removal into rule 2: `adoptSchema` now also **removes** a structure a `DROP INDEX` /
  `DROP CONSTRAINT` deleted, alongside its add/replace behavior — and note that removal, like the
  additive side, is not undone by `ROLLBACK` / `ROLLBACK TO SAVEPOINT` (DDL is not transactional;
  `feat-ddl-transaction-capability`).

### Validation

- `yarn test` (memory) — must pass, including the new file.
- `yarn lint`.
- Confirm the new file under store mode: `yarn test:store` (or scope to the one file). Store is
  expected green; if it fails, file a separate store ticket per the note above rather than folding
  it in.
