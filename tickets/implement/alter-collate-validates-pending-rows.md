----
description: Changing a text column's sort/compare rule inside an open transaction ignores the rows that transaction just wrote, so rows that become duplicates under the new rule are wrongly accepted — and once the change is accepted, the rest of the transaction (and everything after it commits) keeps comparing under the old rule.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn, effectiveDdlRows, validateUniqueOverEffectiveRows, adoptSchemaOnOpenLayers
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildAllSecondaryIndexesStrict, populateNewIndex, indexEnforcesUnique, populateIndexFromRows
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # adoptSchema, reindexOwnWrites
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts   # home for the new cases
  - packages/quereus/docs/memory-table.md                    # § DDL and transactions (names this bug today)
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic  # committed-rows coverage — must keep passing
difficulty: hard
----

# `alter column … set collate` must see, and then govern, the issuing transaction's own rows

## Background in one paragraph

A `unique` requirement on a text column is enforced under that column's *collation* — the rule
deciding whether two strings are the same value. `binary` says `'a'` and `'A'` differ; `nocase`
says they are equal. So changing a column's collation changes which rows count as duplicates,
and the memory backend must re-check uniqueness when it changes.

The memory backend stores committed rows in a **base layer** and each open transaction's
un-committed writes in a **transaction layer** stacked on top (copy-on-write). `alter column …
set collate` today rebuilds *only* the base layer's structures. Everything below follows from
that.

## What actually goes wrong

All four behaviors below were reproduced against `main` (memory backend, `packages/quereus`).

**1. Pending rows are invisible to the uniqueness re-check.** The duplicates commit:

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');
insert into t values (2, 'A');
alter table t alter column v set collate nocase;   -- accepted; must raise "UNIQUE constraint failed"
commit;
-- table holds both 'a' and 'A' under a nocase unique index
```

**2. A row the transaction *deleted* wrongly blocks the change.** The base tree still physically
holds it, so the strict rebuild raises a false `UNIQUE constraint failed`:

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
insert into t values (1, 'a'), (2, 'A');
begin;
delete from t where id = 2;
alter table t alter column v set collate nocase;   -- rejected; must be accepted
```

**3. An *accepted* change never reaches the open transaction.** The transaction layer froze the
old schema at construction and its secondary indexes inherit the base's *pre-rebuild* trees, so
the rest of the transaction keeps comparing under the old collation:

```sql
begin;
insert into t values (1, 'a');
alter table t alter column v set collate nocase;
insert into t values (2, 'A');   -- accepted; must raise "UNIQUE constraint failed"
```

**4. The stale structures outlive the transaction.** At commit the pending layer *becomes* the
committed head, carrying its old-collation schema and its old-collation index trees — the base's
rebuilt ones are shadowed. After `commit`, inserting `'A'` next to `'a'` is still accepted. The
collation change is, in effect, silently discarded whenever it runs inside a transaction that has
written anything.

Outside a transaction the behavior is correct today — `packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic`
covers it and must keep passing.

## Why the sibling fix did not cover this

`bug-memory-ddl-validation-ignores-pending-rows` closed the same hole for `create unique index` and
`alter table … add constraint … unique`. Those paths *add* a structure, so they could validate
against the DDL connection's **effective rows** (`effectiveDdlRows()` — committed base overlaid
with that connection's uncommitted writes, exactly what a `select` in the transaction returns) in a
pre-pass, then hand the new structure to the open layers with `TransactionLayer.adoptSchema`.

`alter column … set collate` instead *re-keys existing* structures via
`BaseLayer.rebuildAllSecondaryIndexesStrict()`, which walks the base primary tree — committed rows
only, by design. And `adoptSchema` today only **adds** missing indexes; it never replaces one whose
collation changed.

The store backend already validates this case over its effective row stream, so memory and store
currently disagree.

## Expected behavior

- **Validate over effective rows.** Reject with `UNIQUE constraint failed` exactly when the new
  collation makes two of the DDL transaction's *effective* rows collide under a covering unique
  index or unique constraint. A duplicate the transaction deleted must not block the change.
  `NULL` semantics unchanged: multiple `NULL`s never collide.
- **Fail clean.** A rejection leaves the schema, the base layer's index map, and the table
  unchanged, and the transaction stays usable — matching what the sibling fix guarantees.
- **Govern the rest of the transaction.** An accepted change must be enforced (and scanned under)
  for every subsequent statement in that transaction, across savepoints and `rollback to savepoint`,
  and must survive `commit`.

## Design

Mirror the sibling fix's two-part shape: a validation pre-pass over effective rows, plus schema
adoption on the open layers. Two adjustments are specific to re-keying.

**Part 1 — pre-pass validation, non-enforcing base rebuild.**

In `MemoryTableManager.alterColumn`, when `collationChanged`, before `baseLayer.updateSchema(...)`:
for every index of the *new* schema that mentions the altered column **and** enforces uniqueness,
run `validateUniqueOverEffectiveRows(newIndexSchema, finalNewTableSchema)`. That helper already
builds a throwaway collation-aware `MemoryIndex` and lets `populateIndexFromRows(..., enforceUnique
= true, ...)` raise `CONSTRAINT` on the first duplicate. Nothing is mutated before it runs.

"Enforces uniqueness" is `indexSchema.unique === true` **or** the index is the auto-built covering
structure for a declared `unique` constraint (same column set) — the predicate currently living in
`BaseLayer.indexEnforcesUnique`. Lift it to a shared exported helper rather than duplicating it.

Then the base rebuild must become **non-enforcing** (`rebuildAllSecondaryIndexes()`), because base
rows are *not* a subset of effective rows — bug 2 above is exactly a base-resident row the
transaction deleted. This is the same reasoning `BaseLayer.addIndexToBase` already documents: the
base index is a lookup structure, never an enforcement one, and `checkUniqueViaIndex` re-validates
every candidate entry against the live effective row (a deleted row's PK resolves to `null` and is
skipped), so an index entry for a removed row can never manufacture a conflict.

That leaves `rebuildAllSecondaryIndexesStrict` / `populateNewIndex` with no callers. Delete them
(keep `indexEnforcesUnique`'s logic, relocated) rather than leaving dead strict paths behind.

**Part 2 — re-key the open transaction's layers.**

Call `adoptSchemaOnOpenLayers(finalNewTableSchema)` from `alterColumn` after the base rebuild, and
teach `TransactionLayer.adoptSchema` to *replace* an index whose `IndexSchema` differs from the one
it currently holds (collation changed), not merely add missing ones. The replacement is built over
the parent's already-re-keyed tree and then brought up to date with `reindexOwnWrites` — identical
to the additive path, so `reindexOwnWrites` needs no change. `adoptSchemaOnOpenLayers` already walks
the chain oldest-first, which is what makes "build over the parent's tree" valid.

`adoptSchema` also swaps `tableSchemaAtCreation`, which is what makes the layer's own
`checkUniqueConstraints` and scans use the new collation — fixing bugs 3 and 4 (the pending layer
becomes the committed head at commit, so its schema and trees must already be the new ones).

**Constraint on this ticket's scope.** `adoptSchema` may not touch `pkFunctions`, which are derived
once from the primary key definition. A collation change on a **primary key** column changes that
definition, so it is deliberately *out of scope here* and tracked separately in
`alter-collate-pk-in-transaction` (that ticket also owns `rebuildPrimaryTreeStrict`, which swaps the
base primary tree object out from under a pending layer's copy-on-write base). Keep the existing
`rebuildPrimaryTreeStrict()` call as-is; do not regress the no-transaction PK path that
`41.7.1-alter-column-collate-unique.sqllogic` covers. If a guard is needed to keep the new
layer-adoption path off the PK case, add one and say so in the handoff.

**Not covered (state it, don't silently skip):** a `unique` constraint whose covering structure is a
row-time materialized view rather than the auto-index. `findIndexForConstraint` prefers the MV when
one is linked, and this ticket's validation walks `schema.indexes`. Note the gap in the handoff; file
a backlog ticket if it proves reachable.

## Notes

- `effectiveDdlRows()` resolves to `pendingTransactionLayer ?? readLayer` of the DDL connection —
  the same layer `MemoryTable.query` scans — so eager savepoint snapshots are covered for free.
- `ensureSchemaChangeSafety()` already raises `BUSY` when a *sibling* connection holds uncommitted
  writes, so the only pending rows to reason about are the DDL issuer's own.
- The `set collate` that only flips `collationExplicit` (same collation name) is metadata-only:
  `collationChanged` stays false and none of this runs. Keep it that way.
- Extending `41.7.1-alter-column-collate-unique.sqllogic` with a transactional section would fail in
  store mode until `isolation-ddl-validation-ignores-overlay-rows` lands. Put the new cases in the
  memory-only mocha spec `packages/quereus/test/ddl-in-transaction-validation.spec.ts`.

## TODO

- Lift `BaseLayer.indexEnforcesUnique` into an exported helper usable from `MemoryTableManager`.
- In `alterColumn`, add the effective-rows validation pre-pass for every unique-enforcing index of
  the new schema that mentions the altered column; run it before any mutation.
- Switch the collation-change base rebuild from `rebuildAllSecondaryIndexesStrict()` to
  `rebuildAllSecondaryIndexes()`; delete `rebuildAllSecondaryIndexesStrict` and `populateNewIndex`
  once unreferenced.
- Teach `TransactionLayer.adoptSchema` to replace an index whose schema object changed (rebuild over
  the parent's tree + `reindexOwnWrites`), and update its doc comment — it is no longer additive-only.
- Call `adoptSchemaOnOpenLayers(finalNewTableSchema)` from `alterColumn` on a collation change; guard
  the primary-key-column case out of scope (see `alter-collate-pk-in-transaction`).
- Verify the `catch` rollback path still restores a consistent index map (validation now runs before
  any mutation, so the partial-rebuild recovery it was written for should be unreachable — confirm,
  and simplify only if certain).
- Tests in `packages/quereus/test/ddl-in-transaction-validation.spec.ts`, new `describe` block:
  - pending-only duplicate under the new collation → `CONSTRAINT`; transaction still usable;
    column collation unchanged; a later `'A'` insert still accepted.
  - committed row + pending row colliding under the new collation → `CONSTRAINT`.
  - pending `delete` of the committed duplicate → accepted; after `commit`, inserting `'A'` next to
    `'a'` is rejected.
  - accepted change → a later colliding insert in the *same* transaction is rejected.
  - accepted change → after `commit`, a colliding insert is rejected.
  - multiple `NULL`s in the pending layer do not collide.
  - duplicate held only in an eager savepoint snapshot is seen; after `rollback to savepoint` the
    new collation is still enforced.
  - sibling connection with uncommitted writes → `BUSY` (mirrors the existing `create unique index`
    case).
  - metadata-only `set collate binary` on an already-binary column inside a transaction is a no-op.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`. Confirm
  `test/logic/41.7.1-alter-column-collate-unique.sqllogic` still passes.
- Update `packages/quereus/docs/memory-table.md` § *DDL and transactions*: it currently names this
  ticket as a known gap and says the base's structures hold exactly the committed rows. Rewrite that
  paragraph to describe the effective-rows pre-pass plus the re-keying adoption, and note the
  primary-key-column carve-out.
