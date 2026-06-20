description: |
  When one logical table is split across two storage tables that happen to give their
  value columns the same name, a CHECK that mentions a column from each table currently
  gets rewritten into a meaningless expression that confuses the two. It is harmless today
  only because such a CHECK is never actually run; make the rewrite keep the two columns
  distinct so it stays correct even if a future change does run it.
prereq:
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # makeLensRewriteScope / rewriteToBasisTerms / collectLensRowLocalConstraints; makeOwningRelationResolver already resolves owning relation
  - packages/quereus/src/schema/lens-fk-discovery.ts                 # logicalToBasisColumnMap (logical→bare basis name) — the collapse source
  - packages/quereus/src/planner/building/constraint-builder.ts      # per-op constraint scope registers new.<col>/old.<col>/bare (~L65-139) — must also register the relation-qualified write-row correlation
  - packages/quereus/src/schema/table.ts                             # ReferencedWriteRowRelation type — natural home for a shared correlation-name helper
  - packages/quereus/test/lens-enforcement.spec.ts                   # collectLensRowLocalConstraints + astToString unit harness (makeCtx/slot, ~L60-189) — where the relation-distinct assertion goes
  - packages/quereus/test/lens-put-fanout.spec.ts                    # colliding-`val` decomposition fixture (perColumnAd / setupPerColumn, ~L2778-2810) to reuse
  - docs/lens.md                                                     # § Constraint Attachment / Enforcement by constraint class — note rewrite is now relation-qualified
difficulty: medium
---

# Relation-qualify the lens logical→basis CHECK rewrite so colliding basis-column names stay distinct

## Background (verified during fix research)

On a decomposition-backed logical table, a write fans out into one base op per storage
member. The prior ticket
(`lens-update-deferred-pk-check-per-op-gate-relation-identity`, now in `complete/`) fixed
the **per-op constraint gate** (`constraintsForOp` in
`planner/building/view-mutation-builder.ts`) to route each lens-synthesized constraint by
**owning basis relation identity** rather than bare column name, threading
`RowConstraintSchema.referencedWriteRowRelations` (`{schema, table, column}` per write-row
basis column, sourced from `makeOwningRelationResolver` + `buildWriteRowRelations` in
`planner/mutation/lens-enforcement.ts`). That gate fix is complete and correct.

This ticket fixes a **separate, latent** flaw in the *rewrite* layer the gate fix
deliberately left untouched.

## The latent flaw

`logicalToBasisColumnMap(slot)` (`schema/lens-fk-discovery.ts`) returns
`Map<logicalColumn, bareBasisColumnName>`. Over the colliding fixture (two `(rowId, val)`
members, one backing logical `id` → basis `w_id.val`, the other backing logical `name` →
basis `w_name.val`) it produces:

```
id   -> "val"
name -> "val"
```

`rewriteToBasisTerms` / `makeLensRewriteScope` (`planner/mutation/lens-enforcement.ts`)
rewrite each logical write-row column to `{ type:'column', name: basisColumn, table:'NEW' }`.
So a row-local CHECK referencing **both** columns — e.g. `check (id <> length(name))` —
rewrites to two **structurally identical** `NEW.val` terms: `NEW.val <> length(NEW.val)`.
The `name`/`w_name.val` reference has silently become `w_id.val`. The distinction between
the two columns (and their owning members) is lost.

### Why it is not a live bug today

Such a cross-member CHECK's `referencedWriteRowRelations` span **two** member relations, so
`constraintsForOp`'s `every()` rides it on **no** single member op ⇒ it is **deferred**
(never built, never evaluated) on a decomposition write — the documented cross-member
deferral contract, exercised green by
`tickets/complete/lens-decomp-cross-member-deferral-test.md`. The degenerate expression is
therefore never executed. The trap: if a future change ever single-member-routes such a
constraint (or otherwise causes the rewritten expression to be built/evaluated), the
collapsed `NEW.val`/`NEW.val` would silently compute the wrong thing — a correctness bug,
not a crash.

## Key research findings that shape the fix

1. **The collapse is purely a decomposition concern.** In a *single-source* lens, two
   logical columns that map to the same basis column name *are the same physical column*, so
   collapsing them to one `NEW.<basis>` is semantically correct. The ambiguity exists only
   across decomposition members, where the same basis *name* denotes *different* physical
   columns on different relations. ⇒ The fix should relation-qualify **only** for a
   multi-member decomposition slot (`slot.advertisement?.storage?.members?.length`), leaving
   the single-source path on `NEW` exactly as today (no behavior change, no test churn there).

2. **A member op's constraint scope only knows its own member's columns.**
   `constraint-builder.ts` (~L65-139) registers, per op, `new.<col>` / `old.<col>` / bare
   for the op's *target table* columns only (the member basis table for a fan-out op). There
   is **no** correlation that reaches a sibling member's row. Therefore a genuinely
   cross-member CHECK is **not evaluable on a single op** — relation-qualifying cannot make
   it evaluable; it can only make the wrong-op case **fail loudly** (`Column not found`)
   instead of silently mis-computing. That fail-safe outcome is exactly what "safe even if
   such a constraint is ever routed" means here. (Making cross-member row-local CHECKs
   *fully evaluable* — over the joined logical row — is a larger feature and is **out of
   scope**; deferral stays the contract.)

3. **The `NEW` qualifier is load-bearing for capture-safety.** The long comment in
   `makeLensRewriteScope` documents that write-row refs are `NEW`-qualified so a ref emitted
   *inside a correlated subquery* cannot be re-captured by a same-named column the subquery's
   own FROM introduces. ⇒ The relation qualifier we substitute **must not** be the bare basis
   table name (a subquery `from w_id` would shadow-capture it, reintroducing the very bug
   `NEW` was added to fix). Use a **collision-proof synthetic correlation** keyed by the
   owning relation, e.g. `__lens_new__<schema>__<table>` (lowercased) — as reserved-feeling
   as `NEW`, and not producible by a parsed user identifier.

4. **No need to change `logicalToBasisColumnMap`'s signature.** `collectLensRowLocalConstraints`
   already builds `owningRelation = makeOwningRelationResolver(slot, ctx.schemaManager)`
   (logical column → `BasisRelationRef`). Thread that resolver (plus the decomposition flag)
   into `makeLensRewriteScope` and combine it with the existing bare-name map to emit a
   relation-qualified correlation. Leave `logicalToBasisColumnMap` (consumed by the FK
   redundancy machinery) untouched.

## Design

Introduce a shared, pure helper (recommended home: `schema/table.ts`, next to
`ReferencedWriteRowRelation`):

```
// Collision-proof per-relation write-row correlation name (lowercased) — the decomposition
// analogue of the `NEW` write-row correlation, distinct per owning member so two basis
// columns that share a NAME across members never collapse to the same AST term.
export function writeRowRelationCorrelation(schema: string, table: string): string {
  return `__lens_new__${schema.toLowerCase()}__${table.toLowerCase()}`;
}
```

**Rewrite side** (`planner/mutation/lens-enforcement.ts`):
- `makeLensRewriteScope` gains the `owningRelation` resolver and a `relationQualify: boolean`
  (true iff the slot is a multi-member decomposition). In `resolve`, for a column found in
  `map`: if `relationQualify` and `owningRelation(name)` resolves to `rel`, emit
  `{ type:'column', name: basisColumn, table: writeRowRelationCorrelation(rel.schema, rel.table) }`;
  otherwise emit the current `{ ..., table:'NEW' }`. The **forward** (authored-inverse)
  branch stays on `NEW` — `authoredForwardMap` admits only subquery-free single-source
  forwards, so it is never decomposition-ambiguous.
- `collectLensRowLocalConstraints` passes the resolver + flag through `rewriteToBasisTerms`.

**Per-op scope side** (`planner/building/constraint-builder.ts`, ~L97-115): in addition to
`new.<col>` / bare, register `<writeRowRelationCorrelation(opSchema, opTable)>.<col>` → the
same `ColumnReferenceNode` (newAttrId), for INSERT|UPDATE, where `opSchema`/`opTable` are the
op's own `tableSchema.schemaName`/`name` (lowercased). Additive and uniform across all
writes (a non-lens or single-source write simply never references the synthetic name). This
is what lets a **single-member** CHECK (all refs on one member — the common, must-stay-green
case, e.g. `length(title) < 5` riding the Doc_core op) resolve its relation-qualified term on
its owning op, while a sibling/cross-member term fails to resolve (fail-safe per finding #2).

Net effect: the rewrite is relation-distinct; single-member CHECKs still ride and enforce
exactly as before (now via the relation correlation instead of `NEW`, resolving identically);
cross-member CHECKs stay deferred by the gate, and if ever routed produce a loud error rather
than a silent wrong answer. The cross-member deferral becomes a timing/perf choice, not a
correctness necessity.

## Risks / watch-outs

- **Don't regress single-source.** Gate relation-qualification strictly on the decomposition
  flag; the full `lens-enforcement.spec.ts` single-source suite (rename/subquery/authored-
  inverse rewrites asserting `astToString` output) must stay byte-stable.
- **Capture-safety** (finding #3): verify the synthetic correlation survives `resolve.ts`'s
  `table.column` path and `RegisteredScope` lowercased lookup, and that a correlated-subquery
  CHECK over a decomposition still rewrites the correlated write-row ref correctly. The
  existing single-source subquery-correlation test is the template; add a decomposition analogue
  only if cheap.
- **astToString rendering.** Confirm a ColumnExpr with the synthetic `table` qualifier renders
  as `<corr>.<col>` so the unit test can assert distinctness.

## Testing

Per the originating ticket's note, assert the **corrected relation-distinct rewrite**, not the
current collapse:

- **Unit (primary).** Reuse the colliding decomposition fixture (`perColumnAd` / `setupPerColumn`
  from `lens-put-fanout.spec.ts`) with a cross-member logical CHECK (e.g.
  `check (id <> length(name))` via `extraLogical`), call
  `collectLensRowLocalConstraints(makeCtx(db), slot(db,'W'))`, and assert via `astToString` that
  the two write-row terms are **distinct** and relation-qualified (the `id` term carries the
  `w_id` correlation, the `name` term the `w_name` correlation) — i.e. NOT both `NEW.val`.
- **Behavioral regression (must stay green).** The single-member CHECK enforcement on a
  decomposition member op (the `length(title) < 5` style test in `lens-put-fanout.spec.ts`)
  continues to ABORT on violation — proves the relation-qualified term still resolves and fires
  on its owning op.
- The existing cross-member deferral test stays green (deferral unchanged).

## TODO

- Add `writeRowRelationCorrelation(schema, table)` shared helper (recommend `schema/table.ts`).
- Thread `owningRelation` + a decomposition `relationQualify` flag into `makeLensRewriteScope`
  and `rewriteToBasisTerms`; emit the relation-qualified correlation for mapped columns on a
  multi-member decomposition slot, keep `NEW` for single-source and the authored-forward branch.
- Register the relation-qualified write-row correlation (`<corr(opSchema,opTable)>.<col>`) in
  the per-op constraint scope in `constraint-builder.ts`, alongside `new.<col>`, for INSERT|UPDATE.
- Add the unit test asserting the relation-distinct rewrite over the colliding fixture; confirm
  the single-member decomposition CHECK behavioral test still ABORTs.
- Run `yarn workspace @quereus/quereus test` (stream with `tee`) and `yarn workspace
  @quereus/quereus lint`; both green.
- Update `docs/lens.md` (§ Constraint Attachment / Enforcement by constraint class) to note the
  rewrite is relation-qualified on decomposition so colliding basis-column names stay distinct.
