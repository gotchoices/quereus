description: `ORDER BY <n>` (a bare positional ordinal) over a compound set operation (UNION/INTERSECT/EXCEPT/UNION ALL) is silently treated as a constant sort key — it does NOT order by output column n. The outer-ORDER-BY builder for compounds (`applyOuterOrderBy`) compiles the order-by expression directly with `buildExpression`, skipping the `resolveOrdinalReference` step every other ORDER BY/GROUP BY path performs, so `order by 1` builds the literal `1` (a constant → no effective ordering, rows come out in union/input order). Column-name and full-expression ORDER BY over a compound work correctly; only the ordinal form is broken.
files:
  - packages/quereus/src/planner/building/select-compound.ts   # applyOuterOrderBy — the broken outer ORDER BY builder (~lines 150-167); createSetOperationScope builds the compound's output-column scope just above it
  - packages/quereus/src/planner/building/select-ordinal.ts     # resolveOrdinalReference — the ordinal→SELECT-list-AST resolver the regular paths use; a compound has no single SELECT list, so the fix maps n→the compound's nth OUTPUT column instead
  - packages/quereus/src/planner/building/select-modifiers.ts   # applyOrderBy / buildFinalProjections — reference for how the non-compound paths thread resolveOrdinalReference + selectListAsts
  - packages/quereus/test/logic/09.1-set-op-cross-collation.sqllogic  # the collation ticket's ORDER-BY-lockstep case (§9) deliberately uses the column-NAME form and documents this ordinal gap; a regression test belongs alongside the general compound ORDER BY logic file
difficulty: medium
----

# Compound `ORDER BY <ordinal>` is a silent constant sort

## Symptom

```sql
select v from t union select v from t order by 1;   -- expected: ordered by output column 1
-- actual: rows in union/input order; `order by 1` has NO effect
```

`order by 1` (and any bare positive-integer ordinal, including a parenthesized
`-`/`+` unary over an integer literal — see `extractOrdinalValue`) silently fails
to order the result of a compound (UNION / UNION ALL / INTERSECT / EXCEPT, and the
DIFF desugaring). Confirmed reproduction (review of
`set-operation-cross-input-collation-merge`): the result of
`select v from t union select v from t order by 1` over `t = {3,1,2}` comes back
`3,1,2` (deduped, input order) instead of `1,2,3`.

The non-compound SELECT paths are unaffected — `select v from t order by 1`
orders correctly, because the regular ORDER BY builders
(`select-modifiers.applyOrderBy`, `buildFinalProjections`,
`select-aggregates.handlePreAggregateSort`, the window pre-sort in `select.ts`,
and GROUP BY) all run `resolveOrdinalReference(expr, selectListAsts, …)` before
`buildExpression`. The compound outer-ORDER-BY builder does not.

## Root cause

`packages/quereus/src/planner/building/select-compound.ts` → `applyOuterOrderBy`:

```ts
const sortKeys: SortKey[] = outerOrderBy.map((ob) => ({
    expression: buildExpression(selectContext, ob.expr),   // ob.expr === literal 1 → constant sort key
    direction: ob.direction,
    nulls: ob.nulls,
}));
```

There is no ordinal-resolution step, so a bare-integer `ob.expr` compiles to a
`LiteralNode(1)` — a constant — and `SortNode` orders every row by the same
constant (a no-op). `selectContext.scope` here is the
`createSetOperationScope` output-column scope (built just above), so a
column-NAME `order by v` resolves fine; only the ordinal form is lost.

## Expected behavior

`order by <n>` over a compound must order by the compound's **nth output
column** (1-based), the SQL-standard / SQLite semantics. A compound has no single
SELECT-list AST to map the ordinal onto (each arm has its own), so
`resolveOrdinalReference` (which returns a SELECT-list AST expression) is not a
drop-in here — the fix should map ordinal `n` directly to the nth output column
of the set-operation node (the same columns `createSetOperationScope` registers,
via a `ColumnReferenceNode` over the set node's attribute/type at index `n-1`),
and raise the standard out-of-range error for `n < 1` or `n > columnCount` (match
`resolveOrdinalReference`'s message/shape).

## Requirements / specifications

- `order by <n>` over UNION / UNION ALL / INTERSECT / EXCEPT (and DIFF) orders by
  output column `n`, ascending/descending + NULLS handling per the clause.
- Mixed ordinal + name + expression keys in one outer ORDER BY all resolve
  (`… order by 2, name desc`).
- Out-of-range / zero / negative ordinal → the same prepare-time error the
  regular path raises (`ORDER BY position N is not in the SELECT list (1..M)`).
- Non-integer / compound expressions (`order by 1 + 0`, `order by upper(v)`)
  keep their expression semantics (NOT treated as ordinals — mirror
  `extractOrdinalValue`'s narrow shape).
- Interaction with the cross-input collation merge: an ordinal ORDER BY must key
  off the **resolved output-column collation** (the same one the column-name form
  reads), so it stays in lockstep with dedup — i.e. resolve the ordinal to the
  set node's output column so it inherits that column's resolved
  `collationName`/`collationSource`. (The collation ticket's §9 lockstep case
  used the name form specifically because the ordinal path was broken; once
  fixed, add an ordinal variant asserting the same NOCASE ordering.)

## Test use cases

- `select n from o1 union select p from o2 order by 1` sorts under the resolved
  NOCASE (the §9 lockstep assertion, ordinal form): `apple < banana < Cherry`.
- Plain ordinal ordering over a UNION ALL bag; descending ordinal; multi-column
  ordinal + name mix.
- Out-of-range ordinal raises the standard error.

## Out of scope (separate pre-existing quirk, flag only)

A **parenthesized-left** compound with a trailing ORDER BY is a *parse* error
(`(A union B) union C order by n` → "got 'order'"), unrelated to ordinal
resolution. Noted by the collation-ticket implementer; file separately if it
warrants its own fix — do NOT fold it into this builder change.
