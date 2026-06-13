description: Review the catalog-level reverse foreign-key index added to SchemaManager (derived, event-invalidated map from referenced schema.table → referencing FKs) and the conversion of the in-file `assertNoReferencingChildrenForDrop` drop-check to consume it.
prereq:
files:
  - packages/quereus/src/schema/manager.ts                   # reverseFkIndex + getReferencingForeignKeys + build/invalidate; constructor self-subscription; addSchema/getOrCreateSchema/removeSchema resets; converted assertNoReferencingChildrenForDrop
  - packages/quereus/test/schema/reverse-fk-index.spec.ts    # NEW — 15 cases, full DDL lifecycle + drop-check regression
  - docs/schema.md                                           # dropTable note + new "Reverse foreign-key index" subsection
difficulty: medium
----

# Review: catalog-level reverse foreign-key index

## What landed

A lazily-built, event-invalidated derived cache on `SchemaManager` keyed by the
**referenced** `schema.table`, plus the conversion of the one consumer that lives
in the same file so the primitive ships exercised, not dead.

### Public surface

```ts
export interface ReferencingForeignKey {
  readonly childTable: TableSchema;            // the declaring child
  readonly fk: ForeignKeyConstraintSchema;     // === the object in childTable.foreignKeys
}

// On SchemaManager:
getReferencingForeignKeys(parentSchemaName: string, parentTableName: string): readonly ReferencingForeignKey[]
```

- **Key** = `(fk.referencedSchema ?? childTable.schemaName).toLowerCase() + '.' + fk.referencedTable.toLowerCase()`
  — resolved exactly as every existing parent-side scan computes its target.
- **Miss** returns a single shared `Object.freeze([])` (the O(1) unreferenced-table
  gate; no per-call allocation).
- **Order** within a bucket = schema-insertion → table → FK-declaration (preserves
  the nested-loop visitation order the RESTRICT first-surviving-child pre-check and
  golden error-message tests rely on).
- **Identity**: the returned `fk` is the same object reference held in
  `childTable.foreignKeys` (the next ticket's divergent-basis-FK suppression set is
  identity-keyed, so this matters).

### Invalidation (the load-bearing correctness property)

`private invalidateReverseFkIndex()` nulls the cache (rebuild on next access). Called from:

- A **self-subscription** to the SchemaManager's own `changeNotifier` (in the
  constructor) that nulls on any `table_added` / `table_modified` / `table_removed`.
  Exhaustive: an FK enters/leaves/retargets the catalog only through one of those
  (create-with-references → added; ALTER ADD/DROP CONSTRAINT and parent/column-rename
  FK rewrite → modified; DROP TABLE → removed). Listener body is just the null — order-
  independent (rebuild happens on access, never in the listener), so self-subscription
  is safe. No disposal path on SchemaManager ⇒ listener lifetime = the manager's (not
  unsubscribed; matches the "otherwise" branch of the ticket's guidance).
- `addSchema`, `getOrCreateSchema`, `removeSchema` directly — ATTACH/DETACH fire no
  change event yet can bring/remove a schema's FK-bearing tables.

Design bias: **under-reporting drops enforcement (fatal); over-reporting is harmless**
(each consumer re-checks `referencedTable`/target-schema/arity in its per-FK body). So
invalidation is deliberately broad.

### The one converted consumer

`assertNoReferencingChildrenForDrop` (the `pragma foreign_keys`-gated DROP-time
referencing-child scan) now iterates `getReferencingForeignKeys(parent…)` instead of
the nested `_getAllSchemas → getAllTables → foreignKeys` walk. The two discovery
filters dropped out (satisfied by the key); **the self-FK skip, the MATCH-SIMPLE
NULL-guard `select 1 … limit 1` probe, and the throw are byte-for-byte unchanged.**

## How to validate

`yarn workspace @quereus/quereus run lint` (eslint + tsc on tests) and
`yarn workspace @quereus/quereus test` were both green at handoff (6092 passing,
9 pending; the new spec's 15 cases included). To run just the new spec:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  packages/quereus/test/schema/reverse-fk-index.spec.ts --reporter spec
```

### Cases covered (`test/schema/reverse-fk-index.spec.ts`)

- Unreferenced ⇒ shared frozen `[]` (and two misses return the *same* array).
- One referencer ⇒ exactly `{childTable, fk}`; case-insensitive on schema+table.
- Rebuild after `create table C references P` (table_added).
- Rebuild after `ALTER … ADD CONSTRAINT … references P` and `… DROP CONSTRAINT`.
- Rebuild after `drop table C`, and after dropping then recreating `P`.
- **removeSchema reset**: aux-local parent+child, `removeSchema('aux')` empties the bucket.
- **Parent rename re-keys**: `alter table P rename to P2` ⇒ entry moves to `main.p2`.
- Self-FK keyed under the table itself; multiple FKs same child→parent in declaration
  order; cross-child schema→table→FK order; `fk` identity `===` `C.foreignKeys[0]`.
- **Behavioral regression** on the converted drop-check: DROP blocked by a referencing
  child row; allowed once rows gone; self-FK never blocks (self-skip).

## Honest gaps / things to scrutinize

- **Cross-schema FK is schema-local in this engine, contrary to the ticket's framing.**
  The ticket's design imagined `references main.P` keying under `main`. In reality
  `constraint-builder.buildForeignKeyConstraintSchema` hardcodes
  `referencedSchema: childSchemaName`, and `ForeignKeyClause.table` carries no schema —
  so a declared FK always resolves its parent to the **child's** schema. The index
  faithfully mirrors that (`fk.referencedSchema ?? childTable.schemaName`), identical to
  every existing scan (`foreign-key-actions.ts`, `foreign-key-builder.ts`,
  `multi-source.ts`). Consequently the removeSchema test uses an **aux-local**
  parent+child rather than `aux.C references main.P`; I did **not** add a test asserting
  the (idealized) cross-schema resolution because that path does not exist in the engine
  and is out of this ticket's scope. Worth a reviewer eye on whether that's acceptable
  vs. flagging cross-schema FK resolution as a separate concern.
- **`addSchema` / `getOrCreateSchema` resets are not independently observable** through
  `getReferencingForeignKeys` results: adding an empty schema changes nothing, and the
  subsequent `table_added` events on imported tables would invalidate anyway. They are
  belt-and-suspenders resets verified by inspection, not by a dedicated assertion. Only
  the **removeSchema** reset is load-bearing-and-observable (and is tested).
  `getOrCreateSchema` is private (import-only path) and has no direct test.
- **Scope**: only the in-file `assertNoReferencingChildrenForDrop` was converted. The
  runtime/plan-time scans (`executeForeignKeyActions`,
  `assertNoRestrictedChildrenForParentMutation`,
  `assertTransitiveRestrictsForParentMutation`, `buildParentSideFKChecks`) are still the
  old O(tables × FKs) walks — that conversion is the next ticket
  (`reverse-fk-index-engine-consumers`), which leans on the identity-preserved `fk` and
  the invalidation proven here.
- **Incidental discovery (not caused by this change)**: single-column FK columns are
  auto-NOT-NULL in Quereus (e.g. `pid integer references P(id)` ⇒ `pid` NOT NULL). It
  only shaped test seeding (self-FK row must reference a real id), nothing in the impl.

## No pre-existing failures encountered

The full quereus suite was green; no `.pre-existing-error.md` was written.
