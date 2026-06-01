description: Optimization — skip the lens-boundary `enforced-fk` existence check when the child basis table provably carries an equivalent FK and the referenced logical relation is a faithful, non-row-reducing projection of its basis parent, so the faithful-passthrough case does not pay for a redundant double-enforcement.
prereq: lens-fk-enforcement-wiring
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/docs/lens.md
----

## Context

`lens-fk-enforcement-wiring` (landed) synthesizes a deferred basis-term `EXISTS`
child-side FK existence check at the lens write boundary for every logical
`enforced-fk` obligation — see `collectLensForeignKeyConstraints` in
`packages/quereus/src/planner/mutation/lens-enforcement.ts`. It **double-enforces
by design**: it emits the lens-level check even when the basis tables already
carry an equivalent FK that the re-planned basis write enforces via
`buildChildSideFKChecks` (`planner/building/foreign-key-builder.ts`). Double-enforce
is always sound; this ticket is the bounded performance follow-up that elides the
lens-level check **only when redundancy is provable**, leaving every uncertain case
double-enforcing.

The single-source rewrite re-plans a lens write against the basis table by name
(`planner/mutation/single-source.ts`), so the basis write's own
`buildChildSideFKChecks` already runs (gated by the same `foreign_keys` pragma). When
the basis FK is provably equivalent to the logical FK, the lens-level `EXISTS` is
pure redundant runtime cost.

## The redundant case (all three must hold; any uncertainty ⇒ enforce)

For one logical FK obligation on a child lens slot:

1. **Single-source, value-preserving child mapping.** The child slot's compiled
   body is single-source (resolves to one basis child `TableSchema`), and every
   logical FK child column (`fk.columns[i]`) maps — via the slot's reconstructible
   projection (`logicalToBasisColumnMap` / the prover's `mappedBasisColumn`) — to a
   plain basis child column with no transform. A column that only falls back to its
   logical name (no real mapping) disqualifies.

2. **An equivalent basis FK exists** on the child basis table: some basis FK whose
   `(child column → referenced column)` pair-set equals the mapped
   `(basis child column → basis parent column)` pair-set, referencing the basis
   parent table (schema + name). Compare as an **unordered set of index pairs** (mirror
   `lookupCoveringFK`'s positional `equiMap` reasoning in `planner/util/ind-utils.ts`):
   a permuted/partial basis FK must not match.

3. **Row-set equivalence of the referenced relation.** The referenced **logical**
   parent relation's row set equals the referenced **basis** parent relation's row
   set on the referenced columns. Provable conservatively when the logical parent's
   lens slot resolves and its `compiledBody` is a **faithful, non-row-reducing
   projection** of the basis parent: single `from` of `type:'table'` naming the basis
   parent, and **none** of `where` / `groupBy` / `having` / `distinct` / `limit` /
   `offset` / `union` / `compound` / `withClause`. (`orderBy` is row-preserving and
   may be ignored.) The default-mapper body `select … from y.parent` is the obvious
   provable case; an override adding a `where` / join / aggregation is the obvious
   non-provable case.

### Why this is sound

With (1), `NEW.logicalChildCol[i] == NEW.basisChildCol[i]`. With (2), the basis
write's FK check guarantees `∃ basis-parent row p : p.basisParentCol[i] ==
NEW.basisChildCol[i]`. With (3), every basis-parent row maps 1:1 (values preserved
on the referenced columns) to a logical-parent row, so the logical parent's row set
⊇ the basis parent's on those columns ⇒ the lens-level existence check is implied by
the basis check. MATCH SIMPLE NULL semantics already match (both
`synthesizeFKExistsExpr` paths OR-guard on `IS NULL`), so no NULL-handling skew.

A false "equivalent" verdict silently drops enforcement — a soundness hole. Every
unresolved step (multi-source child, non-plain mapping, missing/unresolved basis FK,
no parent lens slot, a parent body that might filter rows) must default to **enforce**.

## Architecture / placement

Do the detection at **collection time** in `lens-enforcement.ts`
(`collectLensForeignKeyConstraints`), **not** as a stored obligation field. Rationale:
redundancy depends on the *current* basis FK set, and the basis is a physical schema
whose DDL can drift out-of-band between deploys (the prover already re-validates
covering structures at plan time for exactly this reason — see
`revalidateRowTime` / `findBasisCovering`). Reading the basis FK at write-plan time
makes the elision exactly as sound as the physical `buildChildSideFKChecks`, which
also reads `tableSchema.foreignKeys` at plan time. Keep the obligation classification
(`{ kind: 'enforced-fk' }`) unchanged.

Add a predicate `lensForeignKeyRedundant(slot, fk, schemaManager): boolean` in
`lens-enforcement.ts`; in `collectLensForeignKeyConstraints`, when it returns true,
`log(...)` a clear note and `continue` (skip pushing the constraint). The existing
`log` channel (`planner:lens-enforcement`) is the observability hook the requirement
asks for ("e.g. an introspection note / debug log") — message should name the FK and
the basis FK that subsumes it.

### Reuse vs. replicate

Prefer reuse over duplication (AGENTS.md § DRY). The prover's
`resolveSingleBasisSource` currently takes `(db, body, basisSchemaName)` and
`mappedBasisColumn` takes a `ProveContext`. Two clean options — pick during
implementation:

- **(preferred) Export a slot-level single-source resolver.** Refactor
  `resolveSingleBasisSource` to accept a `SchemaManager` (it only uses
  `db.schemaManager`) and export it (or add a thin `resolveSlotBasisSource(slot,
  schemaManager)` wrapper) from `lens-prover.ts`. `lens-enforcement.ts` already has
  the logical→basis **name** map via its local `logicalToBasisColumnMap(slot)`;
  convert names → basis column indices with `basisTable.columnIndexMap`.
- Otherwise replicate the ~6-line single-source `from`-walk locally and document why.

The logical→basis name map for the **parent** slot is just
`logicalToBasisColumnMap(parentSlot)` (already in this file). Logical parent
referenced column **names** come from the existing `resolveLogicalReferencedColumns`.

## Key tests (extend `packages/quereus/test/lens-enforcement.spec.ts`)

The `describe('lens enforcement: child-side FK existence …')` block and its
`deployFkLens` helper (basis schema with **no** FK) are the model. `slot(db, t)` +
`collectLensForeignKeyConstraints(slot, db.schemaManager)` returns the routed
constraints — assert `.length === 0` for elision, `=== 1` for double-enforce.

- **Elision happens (provable):** basis `y` declares the **same** FK
  (`child.pid references parent(id)`) and the logical body is the faithful default
  projection ⇒ `collectLensForeignKeyConstraints(...).length === 0`; a dangling
  `insert into x.child` still ABORTs (the basis FK enforces it) ⇒ no correctness
  change. Expected: behavior identical to today, one fewer synthesized check.
- **Composite FK elides** when the basis carries the equivalent composite FK with the
  same pair-set; a permuted basis FK (`references parent(py, px)`) does **not** elide.
- **No basis FK ⇒ enforce** (the existing `deployFkLens` core-gap case): still
  `.length === 1` and still ABORTs — guards against over-eliding.
- **Parent override with a `where` ⇒ enforce** (condition 3 fails): basis has the FK,
  but `declare lens for x over y { view parent as select id, name from y.parent where id > 0 }`
  makes the logical parent a strict subset ⇒ `.length === 1` (must NOT elide — the
  soundness-critical case; a dangling insert whose value exists in basis parent but is
  filtered out of the logical parent must still ABORT).
- **Rename override on child still elides** when the basis FK is on the basis column:
  `view child as select id, basis_pid as pid from y.child` over a basis with
  `constraint fk foreign key (basis_pid) references parent(id)` ⇒ `.length === 0`.
- **pragma `foreign_keys = false` ⇒ no routed check regardless** (unchanged; the
  collector is already gated by the caller).

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lens.log; tail -n 60 /tmp/lens.log`
and `yarn workspace @quereus/quereus lint`.

## Docs

Update `packages/quereus/docs/lens.md` § Constraint Attachment (the `enforced-fk`
description) to note that the lens-level FK check is **elided when the basis carries
a provably equivalent FK over a faithful, non-row-reducing logical parent**, and that
any uncertainty defaults to double-enforce.

## TODO

- [ ] Decide reuse vs. replicate for single-source resolution; if reusing, refactor
      `resolveSingleBasisSource` (lens-prover.ts) to take `SchemaManager` and export it
      (or a `resolveSlotBasisSource` wrapper).
- [ ] Implement `lensForeignKeyRedundant(slot, fk, schemaManager)` in
      `lens-enforcement.ts`: condition (1) single-source + value-preserving child map
      (basis child column indices); condition (2) equivalent basis FK via unordered
      `(childIdx, parentIdx)` pair-set match against the child basis table's
      `foreignKeys` (use `resolveReferencedColumns` for the basis FK's parent indices);
      condition (3) parent slot resolves and parent `compiledBody` is a faithful
      non-row-reducing projection of the basis parent. Default **enforce** on any gap.
- [ ] Wire the predicate into `collectLensForeignKeyConstraints`: `continue` + `log`
      when redundant. Keep obligation classification unchanged.
- [ ] Add the elision/non-elision tests above to `lens-enforcement.spec.ts`.
- [ ] Update `docs/lens.md` § Constraint Attachment.
- [ ] `yarn workspace @quereus/quereus test` + `lint` green.
