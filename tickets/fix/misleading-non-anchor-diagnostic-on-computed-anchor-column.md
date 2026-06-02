description: A DELETE/UPDATE WHERE clause that filters on a computed (non-invertible) decomposition column living on the **anchor** member is rejected with a diagnostic claiming the WHERE "references a non-anchor decomposition member" — factually wrong and misleading, since the column is on the anchor (it is merely computed). Surfaced during review of `decomposition-non-identity-columnar-mapping-coverage`.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/test/lens-put-fanout.spec.ts
----

## Symptom

Given a decomposition-backed logical table whose anchor member maps a logical column through a
non-column basis expression (e.g. `bumped = a + 1`, `combined = a || b` — both classify as
`computed-mapping`):

```sql
delete from x.N where bumped = 11;     -- or:  update x.N set a = 0 where combined = '1020'
```

is rejected with:

> cannot write through logical table 'N': the WHERE references a **non-anchor decomposition
> member**; a predicate-honest multi-member fan-out needs snapshot-consistent base-op execution
> (deferred — filter only on the anchor / shared key, or pin the rows via the anchor)

(`reason: 'unsupported-decomposition-predicate'`).

This is **factually incorrect**: `bumped`/`combined` are on the **anchor** member. They are
computed (non-invertible) columns, not columns of some *other* member.

## Root cause

`assertAnchorScoped` (decomposition.ts ~line 813, reached by both `decomposeDelete` and
`decomposeUpdate` via `anchorPredicate`) gates each WHERE column with `classifyColumn` and treats
anything that is not `kind === 'member' && member.relationId === anchor` as a non-anchor reference:

```ts
const nonAnchor = [...refs.names].some(name => {
    const route = classifyColumn(shape, name);
    return !(route.kind === 'member' && route.member.relationId === shape.anchor.relationId);
});
```

A `computed-mapping` column on the anchor has `route.kind === 'computed-mapping'`, so it falls into
the `nonAnchor` bucket and inherits the "non-anchor member" message. The classification has the
information to tell the two cases apart (`computed-mapping` vs a genuine non-anchor `member`); the
gate just collapses them.

## Expected behaviour

The diagnostic must accurately describe **why** the predicate is deferred/rejected, distinguishing:

- a genuine **non-anchor member** column (the existing snapshot-consistent-fan-out deferral), from
- a **computed (non-invertible) column on the anchor** — the predicate references a derived value,
  not a base member column.

Additionally, consider whether the computed-anchor case can simply be **supported** rather than
deferred: `substituteViewColumns` already rewrites the user WHERE into base terms (`bumped = 11` →
`a + 1 = 11`), which is anchor-scoped and evaluable inside the anchor subquery. If so, the gate
should let a computed column that resolves entirely to anchor base columns through, and only defer
when the predicate genuinely reaches a non-anchor member or a subquery. (A computed column backed
by a *non-anchor* member, or by an EAV pivot, would still defer.) Decide support-vs-defer here; at
minimum the message must stop misattributing it to a "non-anchor member".

## Reproduction / coverage

The `non-identity columnar mappings` fixture in `test/lens-put-fanout.spec.ts` (anchor `N_core`
with `bumped = a+1`, `combined = a||b`) is the ready-made repro — add a WHERE-on-computed-anchor-
column case there. Pin whichever behaviour is chosen (accurate-reject **or** support), and keep a
genuine non-anchor-member WHERE case asserting the existing (correct) deferral so the two
diagnostics stay distinguishable.
