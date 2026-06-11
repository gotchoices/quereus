description: Audit — relation-key promotion and covered-key/coverage gates now assume a specific enforcement collation per uniqueness source (PK and table-level UNIQUE enforce under the declared column collation; index-derived UNIQUE under the index's per-column collation). Verified empirically for the memory module; the store module (and other storage plugins) may key/enforce under different collations (e.g. a module-level default applied to implicit-collation PK columns), which would re-open the finer-enforcement key over-claim the memory-side gate closed. Verify each module's actual enforcement collation and align or gate accordingly.
difficulty: hard
files:
  - packages/quereus/src/planner/type-utils.ts                       # enforcementCollationCoversDeclared — the promotion gate + its assumptions
  - packages/quereus/src/vtab/memory/layer/manager.ts                # memory UC checks (declared collation) vs index lookups (index collation)
  - packages/quereus/src/vtab/memory/utils/primary-key.ts            # PK comparators from pkDef.collation (= declared)
  - packages/quereus/src/schema/column.ts                            # collationExplicit note: store keys explicit PK collation natively, applies its own default to implicit text PK columns
  - packages/quereus-store/                                          # store-side key serialization / uniqueness enforcement
----

# Cross-module audit: uniqueness enforcement collation vs key claims

Ticket `collation-blind-equality-fact-extraction` gated relation-key promotion
(`relationTypeFromTableSchema` → `enforcementCollationCoversDeclared`) on the
rule: a unique constraint is a relation key only when its enforcement
collation is at least as coarse as the column's declared (output) collation —
the two decidable cases being "index collation equals declared" and "declared
is BINARY". The assumptions baked in:

- **PK**: `findPKDefinition` copies the declared column collation into the PK
  definition, and the memory module's PK comparators use exactly that —
  enforcement = declared. Verified by test (NOCASE PK rejects case-variants).
- **Table-level UNIQUE**: the memory layer manager compares with
  `schema.columns[col].collation` — enforcement = declared.
- **Index-derived UNIQUE**: enforcement follows the *index's* per-column
  collation (a BINARY `create unique index (b collate binary)` over a NOCASE
  column stores both 'Bob' and 'bob' — verified empirically), hence the gate.

What is NOT yet verified:

- **Store module**: per the `collationExplicit` note on `ColumnSchema`, the
  store "keys an *explicit* per-column PK collation natively but applies its
  own table-level default collation to an *implicit*-default text PK column".
  If a session `default_collation` makes a column implicitly NOCASE while the
  store's own default keys it BINARY, the PK would be enforced *finer* than
  the declared/output collation — exactly the over-claim shape the gate closes
  for index-derived constraints. `yarn test:store` exercises the logic suite
  against the store but the suite has no asymmetric-collation PK shape yet.
- **Other storage plugins** (leveldb / indexeddb / RN / NativeScript) to the
  extent they enforce uniqueness themselves.
- Whether index-derived UNIQUE enforcement *should* instead be normalized at
  the engine layer (the memory manager's declared-collation UC check and the
  index-collation BTree currently both run; the effective behavior is whichever
  finds the conflict first — today the index lookup misses case-variants under
  a finer index collation before the declared-collation check can see them).

Use cases / expectations:

- A claimed relation key must hold under each key column's output (declared)
  collation regardless of storage module (the Key Soundness harness convention).
- A module whose enforcement is finer than declared must either not surface
  the constraint as a relation key, or normalize its enforcement.
- `yarn test:store` should gain the asymmetric-collation shapes from
  `test/planner/collation-soundness.spec.ts` (finer-index promotion, NOCASE PK
  conflict) once the store behavior is decided.
