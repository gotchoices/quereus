description: `ORDER BY <n>` (a bare positional ordinal) over a compound set operation (UNION / UNION ALL / INTERSECT / EXCEPT / DIFF) was silently compiled as a constant sort key (a no-op) instead of ordering by output column n. Root cause: the compound outer-ORDER-BY builder (`applyOuterOrderBy` in select-compound.ts) called `buildExpression` directly, skipping the ordinal-resolution step every other ORDER BY/GROUP BY path performs, so `order by 1` built `LiteralNode(1)`. Fix (already applied + validated in the working tree during the fix stage): resolve the ordinal to a `ColumnReferenceNode` over the set node's Nth output column, so it inherits that column's resolved type/collation and stays in lockstep with dedup.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts          # NEW exported `resolveCompoundOrdinalColumn` — ordinal → ColumnReferenceNode over set node's Nth output column
  - packages/quereus/src/planner/building/select-compound.ts         # applyOuterOrderBy now calls resolveCompoundOrdinalColumn before falling back to buildExpression
  - packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic  # NEW "ORDER BY ordinal over a compound" regression section
  - packages/quereus/test/logic/09.1-set-op-cross-collation.sqllogic # §9 now asserts the ordinal form (`order by 1`) under resolved NOCASE; stale note removed
difficulty: easy
----

# Compound `ORDER BY <ordinal>` — implement & finish validation

## State at handoff

The fix was reproduced, designed, **implemented, and validated** during the fix
stage. The reproduction (`select v from t union select v from t order by 1` over
`t = {3,1,2}`) confirmed rows came back `3,1,2` (input order) instead of
`1,2,3`. After the change, a comprehensive ad-hoc repro (plain/descending
ordinal, UNION ALL bag, INTERSECT/EXCEPT, multi-column ordinal+name mix,
`1 + 0` non-ordinal, out-of-range / zero errors, and the NOCASE collation
lockstep case) all pass. `yarn typecheck` is clean. The two touched sqllogic
files pass.

**Remaining implement-stage work is verification + the review handoff** — see
the TODO list. Do not re-design; the approach below is settled.

## What changed

### `select-ordinal.ts` — new resolver

A compound has no single SELECT-list AST to map an ordinal onto (each arm has
its own), so `resolveOrdinalReference` (which returns a SELECT-list AST
expression) is not a drop-in. Instead a new exported function maps ordinal `n`
directly to the set node's Nth **output column**:

```ts
export function resolveCompoundOrdinalColumn(
	expr: AST.Expression,
	setNode: RelationalPlanNode,
	scope: Scope,
): ColumnReferenceNode | null {
	const value = extractOrdinalValue(expr);          // reuses the existing narrow shape
	if (value === null) return null;                  // non-ordinal → caller falls through
	const columns = setNode.getType().columns;
	if (value < 1 || value > columns.length) {
		throw new QuereusError(
			`ORDER BY position ${value} is not in the SELECT list (1..${columns.length})`,
			StatusCode.ERROR, undefined,
			expr.loc?.start.line, expr.loc?.start.column,
		);
	}
	const index = value - 1;
	const column = columns[index];
	const attr = setNode.getAttributes()[index];
	const colExpr: AST.ColumnExpr = { type: 'column', name: column.name || attr.name };
	return new ColumnReferenceNode(scope, colExpr, column.type, attr.id, index);
}
```

Because it builds the reference over `column.type` / `attr.id` at index `n-1` —
the same `(c.type, attr.id, i)` triple `createSetOperationScope` registers for
the column-name path — the ordinal inherits the set node's **resolved**
output-column collation (`collationName` / `collationSource`), so it stays in
lockstep with dedup. The out-of-range message/shape matches
`resolveOrdinalReference`. `extractOrdinalValue` is reused unchanged, so
`order by 1 + 0` / `order by upper(v)` keep their expression semantics.

### `select-compound.ts` — `applyOuterOrderBy` wiring

```ts
const ordinalRef = resolveCompoundOrdinalColumn(ob.expr, input, selectContext.scope);
return {
	expression: ordinalRef ?? buildExpression(selectContext, ob.expr),
	direction: ob.direction,
	nulls: ob.nulls,
};
```

`input` here is the bare `SetOperationNode` (before SORT/LIMIT are applied), so
`input.getType().columns` / `input.getAttributes()` are the compound's output
columns. Mixed ordinal + name + expression keys all resolve per-key.

## Tests added

- `28-set-ops-sort-edge-cases.sqllogic` — new section: plain ordinal over UNION,
  descending ordinal over UNION ALL, ordinal over INTERSECT and EXCEPT, mixed
  ordinal + name keys, `order by 1 + 0, v` (non-ordinal expression keeps its
  semantics), and out-of-range / zero ordinal errors.
- `09.1-set-op-cross-collation.sqllogic` §9 — added the ordinal variant
  (`select n from o1 union select p from o2 order by 1` → `apple < banana <
  Cherry` under resolved NOCASE) and removed the stale "ordinal is broken,
  not asserted here" note.

## Out of scope (flag only — do NOT fold in)

A **parenthesized-left** compound with a trailing ORDER BY is a *parse* error
(`(A union B) union C order by n` → "got 'order'"), unrelated to ordinal
resolution. If it warrants a fix, file a separate ticket; it is not part of this
change.

## TODO

- Confirm the two touched test files still pass:
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "28-set-ops-sort-edge-cases|09.1-set-op-cross-collation"`
- Run the full quereus test suite (`yarn test` from repo root) and confirm green; stream with `tee`.
- Run lint on the changed files (`yarn workspace @quereus/quereus run lint`, single-quoted globs on Windows) and `yarn typecheck` (already clean at handoff).
- Produce the review/ handoff ticket. Be honest about any residual gaps (e.g. the parenthesized-left parse-error quirk above is intentionally untouched).
