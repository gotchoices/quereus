description: A materialized view over an outer (left/full) join stamps its backing column for the null-extended (lookup) side as NOT NULL, because a ProjectNode atop the join re-types a bare column-ref projection from the column-ref's own (base-table, non-nullable) captured type instead of the nullable join-output attribute it actually reads. The maintained DATA is correct, but a query against the MV with `is null` / `is not null` on that column folds against the backing's bogus NOT NULL and returns WRONG results, violating the MV-indistinguishable-from-view contract.
files: packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic
----

## Confirmed root cause (white-box reproduced)

Repro body: `select t.id, t.fk, p.name from t left join p on t.fk = p.id`.
Probing the optimized plan root (`db.getPlan(body).getRelations()[0]`):

```
ROOT KIND : Project
SRC ATTRS : id#32:nullable=false, fk#33:nullable=false, id#34:nullable=true, name#35:nullable=true   ← join, CORRECT
ROOT ATTRS: id#32:nullable=false, fk#33:nullable=false,                      name#35:nullable=false   ← project, WRONG
BODY COLS : id:nullable=false, fk:nullable=false, name:nullable=false                                  ← getType(), WRONG
```

Observable MV failure (matches the ticket symptom exactly):

```
select id from mv where name is null      → []          (should be [2])
select id from mv where name is not null  → [1,2,3]      (should be [1,3])
select id from mv where name = 'a'        → [1]          (correct — equality does not use the null fold)
```

The join (`buildJoinAttributes`/`buildJoinRelationType` in `join-utils.ts`) correctly marks the
lookup side `name#35` **nullable** (left/full null-extension). The defect is one layer up:

1. **Primary defect — `ProjectNode` re-types a column-ref from the wrong source.**
   `project-node.ts` derives BOTH its output `RelationType.columns[].type` (`outputTypeCache`,
   line ~82) AND its output attributes (`attributesCache`, lines ~134/147/159/169) from
   `proj.node.getType()`. For a bare `ColumnReferenceNode` projection, `getType()` returns the
   node's `columnType` field — captured at *build* time in `registerColumnScope`
   (`select.ts:320-323`) from the **base table** column type (`p.name` → `text` NOT NULL),
   because the join's outer column scope is `MultiScope([leftScope, rightScope])` whose sub-scopes
   are the base-table scopes. So the column-ref carries the join attribute's *id* (`#35`) but a
   *stale, non-nullable type*. `ProjectNode` trusts that stale type instead of the nullable
   join-output attribute (`source.getAttributes()` by `attributeId`) it actually reads.

2. **`deriveBackingShape` faithfully propagates the wrong flag.**
   `materialized-view-helpers.ts:91` sets `notNull: c.type.nullable === false`, so the backing
   base table declares `name` NOT NULL. Unlike a derived relation's optimistic nullable flag
   (which the live `is null` path does not fold against), a **base-table NOT NULL** column is a
   hard fact the optimizer folds `… is null → FALSE` / `… is not null → TRUE` against. The backing
   is a real base table, so the bogus NOT NULL becomes load-bearing and breaks read-side folding.

The plain (non-materialized) query path is **already correct** and must stay so: its
`where p.name is null` resolves `p.name` through the join scope to the same stale-typed column-ref,
but the live `is null` fold does not trust a *derived* relation's nullable flag, only a base-table
NOT NULL — so it null-checks at runtime and returns the null-extended row. The fix must not disturb
that path.

## Required fix

Make a `ProjectNode`'s output column/attribute type for a **bare column-reference** projection
honor the **type the source relation publishes for that attribute id** (the nullable, join-output
type), falling back to `proj.node.getType()` only when the attribute id is not present in the
source (e.g. a correlated reference to an outer relation). This is the general, correct fix: the
projection's `RelationType.columns[].type.nullable` and attribute `nullable` flags over an outer
join become trustworthy, `deriveBackingShape` then stamps the backing column nullable
automatically, and the read-side fold disappears.

Centralize the resolution so every type-derivation site in `ProjectNode` agrees:

- Build a `Map<attributeId, ScalarType>` from `this.source.getAttributes()` once.
- Add a small helper, e.g. `effectiveProjectionType(projNode, sourceTypeById): ScalarType` —
  returns `sourceTypeById.get(projNode.attributeId) ?? projNode.getType()` when
  `projNode instanceof ColumnReferenceNode`, else `projNode.getType()`.
- Use it in `outputTypeCache` (the `type:` of each output column) and in **all** branches of
  `attributesCache` that mint `type: proj.node.getType()` (the non-predefined column-ref branch,
  the `attributeId`-supplied branch, and the computed-expression branch — the helper is a no-op
  for non-column-refs so it is safe to apply uniformly).
- `withProjections` (line ~427) mints `predefinedAttributes` from `proj.node.getType()` directly;
  apply the same helper there (its `this.source` is unchanged, so the same source map works) so an
  optimizer rebuild cannot re-introduce the stale type. `withChildren` already forwards the
  previously-computed (now-correct) attributes via `predefinedAttributes`, so it needs no change —
  but verify the predefined path returns the corrected types end-to-end.

Notes / guard-rails for the implementer:

- Attribute ids are globally unique (`PlanNode.nextAttrId`), so the source map is collision-free
  even across self-joins.
- Do NOT change `ColumnReferenceNode.columnType` or the join's outer column scope
  (`select.ts` `buildJoin`/`registerColumnScope`). That is a broader, riskier change (it also
  re-types join-condition column-refs) and is unnecessary: the plain query path already evaluates
  correctly, and only the projection *output* type feeds the MV backing. Keep the blast radius at
  the projection layer as the ticket directs.
- A defensive backstop at `materialized-view-helpers.ts:91` (declare NOT NULL only when *provably*
  so) is **optional** and must not substitute for the project-node fix; with the project-node fix
  the body root reports `nullable` correctly and `deriveBackingShape` needs no change. Skip the
  backstop unless implementing it is trivial and clearly additive.

Blast radius to sanity-check after the change: consumers that read an outer-join-derived column's
static `nullable` over a projection (predicate folding, null-rejection rewrites, key/constraint
inference). The change only ever *relaxes* a non-nullable claim to nullable for a genuinely
null-extended column, which is strictly more correct; confirm no test that depends on a (wrong)
NOT-NULL claim over an outer join regresses, and that the plain-query path is unchanged.

## Acceptance

- Repro over the MV: `where name is null` → `[2]`; `where name is not null` → `[1,3]`; full scan
  and `where name = 'a'` unchanged.
- A `full` outer join's both-sided null extension: a left-side NOT-NULL column (e.g. the left PK)
  that gets null-extended for unmatched right rows reads correctly under `is null` / `is not null`
  through the MV.
- White-box: the MV body root `getType().columns` and `getAttributes()` report the null-extended
  column as `nullable: true`, and `deriveBackingShape` reports it as `notNull: false`.
- `maintenance-equivalence.spec.ts` outer-join suite: switch the
  "a t row referencing a missing p is preserved" assertion back to the natural
  `select id from mv where name is null` read (and the post-`delete from p` leg likewise) — the
  existing comment explains it currently reads the whole backing precisely *because* of this bug.
  Add an `is null` / `is not null` equivalence case (live body vs MV backing agree).
- Add an end-to-end leg to `53-materialized-views-rowtime.sqllogic`: create the left-join MV and
  assert `where name is null` / `is not null` / full-scan results.
- `yarn test` + `yarn lint` green.

## TODO

- In `project-node.ts`, add the `Map<attributeId, ScalarType>` source-attr map and an
  `effectiveProjectionType(projNode, sourceTypeById)` helper (column-ref → source type by id with
  `getType()` fallback; otherwise `getType()`).
- Apply the helper in `outputTypeCache` (output column `type:`) and in every `type:` site of
  `attributesCache`, plus `withProjections`'s `predefinedAttributes` construction.
- Verify white-box (a tiny throwaway probe is fine, then remove it): body root `getType().columns`
  and `getAttributes()` show `name → nullable: true`; `deriveBackingShape` → `notNull: false`.
- Flip the `maintenance-equivalence.spec.ts` outer-join assertions to the natural
  `where name is null` reads and add an `is null`/`is not null` equivalence case.
- Add the e2e left-join `is null` leg to `53-materialized-views-rowtime.sqllogic`.
- Run `yarn test` and `yarn lint` (single-quote lint globs on Windows); confirm green and that no
  outer-join nullability test regressed.
