description: Add a catalog-level reverse foreign-key index to SchemaManager — a derived, event-invalidated map from a referenced `schema.table` to the FKs that reference it — and prove it end-to-end by routing the in-file `assertNoReferencingChildrenForDrop` scan through it. The shared primitive that lets every referencing-FK scan (next ticket) and the maintained-parent enforcement hook short-circuit in O(1) when nothing references a table.
files:
  - packages/quereus/src/schema/manager.ts            # new reverseFkIndex + getReferencingForeignKeys + invalidation; assertNoReferencingChildrenForDrop converted
  - packages/quereus/src/schema/change-events.ts       # table_added / table_modified / table_removed event shapes (reference only)
  - packages/quereus/src/schema/table.ts               # TableSchema, ForeignKeyConstraintSchema (the index entry types)
  - packages/quereus/test/schema/reverse-fk-index.spec.ts  # NEW — rebuild-correctness across DDL lifecycle
  - docs/schema.md                                     # note the reverse FK index if FK enforcement cost is documented
difficulty: medium
----

# Catalog-level reverse foreign-key index

## Why

Every parent-side referential scan in the engine — `executeForeignKeyActions`,
`assertNoRestrictedChildrenForParentMutation`, `assertTransitiveRestrictsForParentMutation`,
the plan-time `buildParentSideFKChecks`, and `SchemaManager.assertNoReferencingChildrenForDrop` —
answers the same question by walking the **whole catalog**: `for each schema → each table →
each FK, does this FK reference the parent?` That is `O(tables × FKs)` paid on every parent
DELETE / key-UPDATE (and now, via `maintained-table-parent-side-fk-orphan`, on every
maintenance-driven backing delete/update, which can fan a single source write into many
backing deltas).

This ticket builds the shared primitive that collapses that walk to a single map lookup: a
reverse index keyed by the **referenced** `schema.table`. A table that nothing references
yields an empty bucket — the O(1) gate. A referenced table yields exactly its referencing
FKs — `O(referencing FKs)` instead of `O(all FKs)`. The next ticket
(`reverse-fk-index-engine-consumers`) routes the runtime/plan-time scans through it; this
ticket lands the index and converts the one consumer that lives in the same file
(`assertNoReferencingChildrenForDrop`) so the primitive ships exercised end-to-end, not dead.

## Design

### The index

`SchemaManager` gains a lazily-built, event-invalidated derived cache:

```ts
/** One FK that references some parent table, paired with its declaring child table. */
interface ReferencingForeignKey {
  readonly childTable: TableSchema;
  readonly fk: ForeignKeyConstraintSchema;
}

// null ⇒ needs rebuild from the live catalog on next access.
private reverseFkIndex: Map<string, ReferencingForeignKey[]> | null = null;
```

Key = `${(fk.referencedSchema ?? childTable.schemaName).toLowerCase()}.${fk.referencedTable.toLowerCase()}`
— the **resolved** referenced schema.table (cross-schema FKs key under their target schema,
exactly as the existing scans compute `targetSchema`).

```ts
/**
 * The FKs that reference `parentSchemaName.parentTableName` (case-insensitive). Empty when
 * nothing references it — the O(1) gate. Lazily (re)builds the whole index from the live
 * catalog on the first access after any schema mutation; pure derived cache.
 */
getReferencingForeignKeys(parentSchemaName: string, parentTableName: string): readonly ReferencingForeignKey[]
```

Returns a shared frozen empty array on a miss (no per-call allocation on the hot
unreferenced path).

### Build

Walk `_getAllSchemas()` → `schema.getAllTables()` → `table.foreignKeys`, bucketing each FK
under its resolved referenced key. **Preserve the existing iteration order** (schema
insertion order → table order → FK declaration order) when pushing into each bucket: the
RESTRICT pre-check throws on the *first* surviving child, and golden/error-message tests may
assert *which* child table is named, so the per-parent bucket must list FKs in the same
relative order today's nested loops visit them.

The FK objects stored are the **same references** held in `childTable.foreignKeys` — identity
is preserved, so the divergent-basis-FK suppression set (`basisFksOverriddenByDivergentLensFk`,
identity-keyed `Set<ForeignKeyConstraintSchema>`) keeps matching against indexed entries
unchanged in the next ticket.

### Invalidation (the load-bearing correctness property)

A stale index that **under-reports** silently drops enforcement — strictly worse than the
unoptimized scan. Over-reporting is harmless (the consumer's per-FK body re-checks
`referencedTable`/`targetSchema`/arity and simply does no work). So the cache must be nulled
on every mutation that can add, drop, or retarget an FK, or add/remove a whole schema:

- **Table FK lifecycle.** A self-subscription to the SchemaManager's own
  `changeNotifier` (mirroring how `MaterializedViewManager` subscribes via
  `getChangeNotifier().addListener`) nulls `reverseFkIndex` on any `table_added` /
  `table_modified` / `table_removed` event. This is exhaustive by construction: an FK is
  declared on a table, and a table enters/leaves/changes the catalog **only** through one of
  those events — `create table … references` (`table_added`), `alter table add/drop
  constraint` (`table_modified`), an FK retarget from a parent/column rename
  (`table_modified` on the child via `propagateTableRename`), and `drop table`
  (`table_removed`). The listener body is just `this.reverseFkIndex = null` — order-independent
  (rebuild happens on next *access*, never inside the listener), so subscribing to its own
  notifier is safe. The synthetic same-object `emitBackingInvalidation` `table_modified` and
  tag-only modifies harmlessly over-invalidate (one cheap lazy rebuild; DDL is rare).
- **Schema attach/detach.** `addSchema`, `getOrCreateSchema`, and `removeSchema` do **not**
  fire change events (verified), yet a cross-schema FK can be added/removed with a whole
  schema (ATTACH/DETACH). Null `reverseFkIndex` directly in those three methods.

Factor the reset into one `private invalidateReverseFkIndex()` and call it from both the
listener and the three schema methods. Unsubscribe in `dispose()` if SchemaManager has a
disposal path (match the MaterializedViewManager pattern); otherwise the listener lifetime is
the SchemaManager's.

### The proof consumer: `assertNoReferencingChildrenForDrop`

Convert the existing nested catalog walk (manager.ts ~line 1225) to:

```ts
for (const { childTable, fk } of this.getReferencingForeignKeys(parentSchemaName, parentTableName)) {
  // Skip the table being dropped itself — self-FK rows go away with it. (UNCHANGED)
  if (childTable.schemaName.toLowerCase() === parentSchemaLower &&
      childTable.name.toLowerCase() === parentTableLower) continue;
  // ... identical MATCH-SIMPLE `select 1 … where <cols> is not null limit 1` body ...
}
```

The two discovery filters (`fk.referencedTable` / `targetSchema` match) are now satisfied by
the index key, so they drop out; **every other line of the body — the self-FK skip, the
NULL-guard WHERE, the `limit 1` probe, the throw — stays byte-for-byte.** This keeps the
DROP-time referencing check behaviorally identical while exercising the index (build +
lookup) on a real path, so the invalidation is covered before the next ticket leans on it.

## Edge cases & interactions

- **False-negative is the only dangerous failure.** The index is consulted only to *find*
  referencing FKs; a missed invalidation that drops an entry drops enforcement. Tests must
  pin every DDL that mutates FKs (below). Over-reporting (stale entry for a dropped FK) is
  caught by the consumer's residual per-FK checks and is harmless.
- **Cross-schema FK.** `fk.referencedSchema` set ⇒ key under that schema. A `main` table
  referencing an attached `aux` table, and vice-versa, must both resolve. Detach of `aux`
  must invalidate (covered by the `removeSchema` reset).
- **Self-referential FK.** Keyed under the table's own name; the bucket includes the self-FK.
  The drop-check's explicit self-skip must remain (the index does not pre-filter it).
- **Composite / arity-mismatch FK.** The index does not pre-resolve referenced columns; the
  arity guard (`parentColIndices.length !== fk.columns.length`) stays in each consumer body.
- **Multiple FKs, same child→parent.** Bucket holds multiple entries; all visited.
- **Maintained-table backings.** `getAllTables()` includes MV backing TableSchemas and a
  maintained table may itself declare an FK — included exactly as today's scans include them.
- **Re-entrancy under cascade.** FK cascades issue DML (not DDL), so no `table_*` event fires
  mid-cascade ⇒ no invalidation mid-loop. Even if a DDL event did null the cache, a caller
  mid-iteration holds its own array reference (rebuild allocates a *new* array), so iteration
  stays consistent.
- **Forked / nested statement execution.** Shares the one per-Database SchemaManager; the
  cache is read-only after build and nulled only on DDL events (absent mid-DML), so
  re-entrant access during a single statement is safe.
- **Lazy first-access cost.** First lookup after any DDL pays one full catalog walk; amortized
  across the many DML writes between DDLs. Acceptable and intentional (rebuild-on-event over
  fragile incremental mutation — the ticket's explicit guidance).

## Key tests (test/schema/reverse-fk-index.spec.ts)

Construct a `Database`, run DDL, assert `schemaManager.getReferencingForeignKeys(...)` returns
the right entries — the index is the unit under test:

- Unreferenced table ⇒ `[]` (the gate); a table referenced by one FK ⇒ exactly that
  `{childTable, fk}`.
- **Rebuild after `create table C references P`** ⇒ `P`'s bucket gains `C`'s FK.
- **Rebuild after `alter table C add constraint … references P`** and after `… drop
  constraint` ⇒ bucket gains/loses the entry.
- **Rebuild after `drop table C`** (child) and after dropping `P` then recreating it ⇒ stale
  entries gone / fresh entries present.
- **Cross-schema:** attach `aux`, `create table aux.C references main.P`, assert `main.P`'s
  bucket includes it; `detach aux` ⇒ bucket empties (proves the `removeSchema` reset).
- **FK retarget via rename:** `alter table P rename to P2` ⇒ the entry re-keys to `main.p2`
  (the propagate-rename `table_modified` invalidated, rebuild re-resolved).
- **Identity:** the returned `fk` is `===` the object in `C.foreignKeys` (guards the
  suppression-set identity the next ticket depends on).
- **Behavioral regression:** the existing DROP-with-referencing-child RESTRICT error still
  fires identically (e.g. a `drop table P` blocked by a child row), confirming the converted
  `assertNoReferencingChildrenForDrop` is unchanged in behavior.

## TODO

- Add `ReferencingForeignKey` type + `reverseFkIndex` field + `getReferencingForeignKeys` +
  `private invalidateReverseFkIndex()` to `SchemaManager`.
- Build the index by walking `_getAllSchemas → getAllTables → foreignKeys`, preserving
  iteration order; return a shared frozen empty array on miss.
- Self-subscribe to `changeNotifier` (null on `table_added`/`table_modified`/`table_removed`);
  unsubscribe in any disposal path.
- Null the index in `addSchema`, `getOrCreateSchema`, `removeSchema`.
- Convert `assertNoReferencingChildrenForDrop` to consume `getReferencingForeignKeys`, keeping
  the self-skip + NULL-guard probe + throw verbatim.
- Write `test/schema/reverse-fk-index.spec.ts` (cases above).
- `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus test` green.
- Update `docs/schema.md` if it documents FK enforcement / catalog scan cost.
