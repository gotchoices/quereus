description: A lookup on a two-column key that combines a bound `=` with an `in (…)` list returns no rows at all, on the built-in in-memory tables and on any module that claims the seek. The fix is one line where the planner builds the seek keys.
architecture: docs/optimizer-retrieve.md#access-path-selection
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts (the composite multi-seek arm of `selectPhysicalNodeFromPlan`, `equalitySeekKey`)
repro: verified
----

Filed from downstream: Optimystic (`@optimystic/quereus-plugin-optimystic`) avoids this shape and keeps its own copy as a blocked ticket, `quereus-composite-in-seek-drops-a-bound-equality`, which unblocks once a Quereus release carries this fix.

## What goes wrong

Measured on 4.25.0 with a plain memory table, and re-run on 5.0.0 with the same result:

```sql
create table t (id text primary key, a text, b text);
create index t_ab on t(a, b);
insert into t values ('1','x','p'), ('2','x','q'), ('3','y','p'), ('4','x','r');
```

| statement | parameters | returned | correct |
|---|---|---|---|
| `select id from t where a = ? and b in ('p','q')` | `'x'` | none | 1, 2 |
| `select id from t where a = ? and b in (?,?)` | `'x','p','q'` | none | 1, 2 |
| `select id from t where a in (?,?) and b = ?` | `'x','y','p'` | none | 1, 3 |
| `select id from t where a in ('x','y') and b = 'p'` | | 1, 3 | 1, 3 |

On 4.25.0 the three parameterised forms also returned nothing on a table with `primary key (a, b)` (rows `('x','p')`, `('x','q')`, `('y','p')`). The all-literal form is right on both because it takes a different path.

## Cause

Read from the code. In the composite multi-seek arm of `selectPhysicalNodeFromPlan`, the branch for a column with a single equality value keeps a dynamic value expression only when it is an array:

```ts
columnValues.push({
	colIdx,
	values: [val],
	exprs: Array.isArray(c.valueExpr) ? c.valueExpr : undefined,
});
```

A single-element `in (?)` carries an array, which the comment above that code describes. A plain `= ?` carries one scalar expression, so `exprs` is `undefined`, the seek key becomes `Literal(undefined)`, and the runtime's NULL-key skip drops every tuple. `equalitySeekKey`, the non-composite arm's equivalent, handles both shapes.

## Proposed change

```ts
exprs: c.valueExpr === undefined ? undefined : Array.isArray(c.valueExpr) ? c.valueExpr : [c.valueExpr],
```

`allLiteral` already reads false for a constraint with a `valueExpr`, so this falls through to the existing dynamic cross-product. Add the table above as a logic test, on both a composite secondary index and a composite primary key.

## If nothing is done

Wrong results — no rows — for an ordinary parameterised query on memory and store tables. Downstream, Optimystic stays correct only by refusing to seek more than one column when an `in` list is present, which reads more rows than it needs.
