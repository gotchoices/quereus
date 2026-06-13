description: Catalog-level reverse foreign-key index on SchemaManager (derived, event-invalidated map referenced schema.table → referencing FKs) plus conversion of the in-file `assertNoReferencingChildrenForDrop` drop-check to consume it. Reviewed; one latent under-reporting gap (silent catalog-import path) found and fixed inline.
files:
  - packages/quereus/src/schema/manager.ts                   # reverseFkIndex + getReferencingForeignKeys + build/invalidate; constructor self-subscription; addSchema/getOrCreateSchema/removeSchema resets; importTable reset (added in review); converted assertNoReferencingChildrenForDrop
  - packages/quereus/test/schema/reverse-fk-index.spec.ts    # 16 cases (15 from implement + 1 review regression)
  - docs/schema.md                                           # dropTable note + "Reverse foreign-key index" subsection (import-path reset added in review)
difficulty: medium
----

# Reverse foreign-key index (catalog level) — completed

A lazily-built, event-invalidated derived cache on `SchemaManager`, keyed by the
**referenced** `schema.table`, returning the FKs that reference a parent. One
consumer — the `pragma foreign_keys`-gated DROP-time referencing-child scan
(`assertNoReferencingChildrenForDrop`) — was converted to use it, so the
primitive ships exercised.

## Public surface

```ts
export interface ReferencingForeignKey {
  readonly childTable: TableSchema;            // the declaring child
  readonly fk: ForeignKeyConstraintSchema;     // === the object in childTable.foreignKeys (identity preserved)
}

// On SchemaManager:
getReferencingForeignKeys(parentSchemaName: string, parentTableName: string): readonly ReferencingForeignKey[]
```

- **Key** = `(fk.referencedSchema ?? childTable.schemaName).toLowerCase() + '.' + fk.referencedTable.toLowerCase()`.
- **Miss** → a single shared `Object.freeze([])` (O(1) unreferenced-table gate, no per-call alloc).
- **Order** within a bucket = schema-insertion → table → FK-declaration.
- **Invalidation**: self-subscription to the `SchemaChangeNotifier` nulls the
  cache on any `table_added` / `table_modified` / `table_removed`; `addSchema` /
  `getOrCreateSchema` / `removeSchema` null it directly (ATTACH/DETACH fire no
  event); **and `importTable` nulls it directly** (added in review — see below).
  Rebuild always happens on next access, never in a listener, so it is
  order-independent.

## Review findings

Reviewed the implement commit `a4a44c11` diff (manager.ts, the new spec, docs)
with fresh eyes before reading the handoff. Scrutinized SPP/DRY/modularity,
invalidation exhaustiveness (the load-bearing correctness property), async
safety of the converted consumer, identity/ordering guarantees, and type safety.

### What was checked

- **Invalidation exhaustiveness — the central claim.** Verified every vector by
  which an FK enters/leaves/retargets the catalog: create-with-references
  (`table_added`), ALTER ADD/DROP CONSTRAINT + parent/column-rename FK rewrite
  (`table_modified`), DROP TABLE (`table_removed`), ATTACH/DETACH
  (`addSchema`/`removeSchema` direct), MV/backing import (`createBackingTable`
  fires `table_added`). **Found one uncovered vector — see below.**
- **Construction order.** `changeNotifier` is a field initializer (manager.ts:198),
  so it is constructed before the constructor body adds the listener
  (manager.ts:248). Safe.
- **Bucket ordering.** `_getAllSchemas()` returns `this.schemas.values()` (Map
  insertion order), matching the documented schema-insertion order.
- **Async safety of the converted drop-check.** It captures the bucket array
  reference, then awaits per-FK probes. Invalidation only nulls the field and a
  rebuild allocates a *new* map with *new* arrays — the captured array is never
  mutated, so concurrent invalidation mid-loop is safe. The self-FK skip, the
  MATCH-SIMPLE non-NULL probe, and the throw are byte-for-byte unchanged.
- **Empty/identity guarantees.** Shared frozen empty array on miss; returned `fk`
  is `===` the object in `childTable.foreignKeys`. Both covered by spec cases.
- **Lint + full suite.** `yarn lint` (eslint + tsc on tests) exit 0;
  `yarn test` 6093 passing / 9 pending.

### What was found and done (minor — fixed inline)

**Silent catalog-import path bypassed invalidation (under-reporting — the fatal
direction).** `importTable` (catalog rehydration) registers FK-bearing tables
*silently* — it calls `schema.addTable` with **no `table_added` event** (a store
rehydrating its own catalog must not re-emit persistence events) and resolves the
schema via `getOrCreateSchema`, which only resets the index when it *creates* a
schema. So importing a child with an FK into an already-existing schema (e.g.
`main`) hit neither the event path nor a schema-reset path — the handoff's stated
invariant ("an FK enters the catalog ONLY through table_added/modified/removed")
is therefore false. Masked in current flows (cold reopen builds the index lazily
only *after* rehydration completes; ATTACH of a new schema resets via
`addSchema`), but a re-import onto a live, already-built index would
**under-report**, which the design itself flags as fatal (silently dropping
enforcement). Fixed by having `importTable` call `invalidateReverseFkIndex()`
directly after `addTable`, so the silent path upholds the same invariant as the
events. Added a regression test (`invalidates when a silent catalog import adds
an FK to an existing schema`) — **verified it fails without the fix** — and
updated `docs/schema.md` to list the import-path reset.

### Confirmed non-issues (checked, nothing to do)

- **Cross-schema FK is schema-local in this engine.** A declared FK always
  resolves its parent to the child's schema (`constraint-builder` hardcodes
  `referencedSchema: childSchemaName`); the index mirrors this exactly, identical
  to every existing scan. Not a defect — correctly faithful to engine behavior.
- **`addSchema`/`getOrCreateSchema` resets are belt-and-suspenders** (an empty new
  schema changes no lookup result; later table imports now reset via `importTable`
  anyway). Only the `removeSchema` reset is independently observable, and it is
  tested.

### Major findings → new tickets

None. The one finding was a localized, low-risk inline fix.

### Deferred (already scoped, not this ticket)

The runtime/plan-time scans (`executeForeignKeyActions`,
`assertNoRestrictedChildrenForParentMutation`,
`assertTransitiveRestrictsForParentMutation`, `buildParentSideFKChecks`) remain
the old O(tables × FKs) walks — their conversion is the next ticket
(`reverse-fk-index-engine-consumers`), which leans on the identity-preserved `fk`
and the invalidation hardened here.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus test` — 6093 passing, 9 pending.
- Reverse-FK spec alone: 16 passing.

No `.pre-existing-error.md` written — the suite was green throughout.
