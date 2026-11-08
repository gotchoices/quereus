description: A lookup on a two-column key that combined a bound `=` with an `in (…)` list returned no rows; a one-line planner fix now makes it return the right rows on both the memory and store backends.
architecture: docs/optimizer-retrieve.md#access-path-selection
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/test/logic/07.9.1-in-value-list-composite-index.sqllogic, docs/memory-table.md
repro: verified
----

Filed from downstream: Optimystic (`@optimystic/quereus-plugin-optimystic`) avoids this query shape and keeps its own blocked copy, `quereus-composite-in-seek-drops-a-bound-equality`, which unblocks once a Quereus release carries this fix.

## What was wrong

On `create index t_ab on t(a, b)`, `select id from t where a = ? and b in ('p','q')` with `['x']` returned 0 rows instead of 2. `a = ? and b in (?,?)` and `a in (?,?) and b = ?` failed the same way. The all-literal form was correct because it is resolved at plan time.

The cause was in the composite multi-seek arm of `selectPhysicalNodeFromPlan` (`rule-select-access-path.ts`, the `hasMultiValueIn && seekCols.length > 1` branch). For a seek column with a single equality value, the code kept the dynamic value expression only when it was an array, which is the shape a single-element `in (?)` produces. A plain `= ?` carries one scalar expression, so the column fell back to `Literal(undefined)`, and the runtime's skip for NULL-bearing seek keys dropped every seek tuple.

## Change

The fix (committed during the fix stage, in `a52e9991c`) wraps a scalar `valueExpr` in a one-element array at `rule-select-access-path.ts:676`:

```ts
exprs: c.valueExpr === undefined ? undefined : Array.isArray(c.valueExpr) ? c.valueExpr : [c.valueExpr],
```

`equalitySeekKey`, used by the single-column arm, already handled both shapes. `allLiteral` is false for any constraint that has a `valueExpr`, so these queries take the existing dynamic cross-product path.

Implement stage added only a doc clarification: `docs/memory-table.md` ("Advanced Query Planning") now says the composite multi-seek is a cross-product of the `IN` lists **and `=` values**, literal or bound. `docs/optimizer-retrieve.md` says nothing about value shapes. `docs/optimizer-rule-families.md:152` already describes `valueExpr` as "scalar, or one array element per `IN` member", which matches the fixed code.

## Tests

Six cases were appended to `test/logic/07.9.1-in-value-list-composite-index.sqllogic` in the fix stage. Together they reproduce the bug:

- Composite secondary index `t(a, b)`: `a = ? and b in ('p','q')`, `a = ? and b in (?,?)`, `a in (?,?) and b = ?`. These cover the bound `=` as the first column and as the second.
- The same index with the all-literal form `a in ('x','y') and b = 'p'` as a control on the plan-time path.
- Composite primary key `tk(a, b)`: `a = ? and b in ('p','q')`, `a in (?,?) and b = ?`.

The file declares `requires-capability: standalone-index-ddl`, so backends without `create index` skip it.

## Validation done

- Memory backend: `yarn workspace @quereus/quereus test` in the fix stage gave 11107 passing, 26 pending, 0 failing. No source changed after that.
- Store backend: `yarn workspace @quereus/quereus test:store --grep "07.9.1"` passes. To check that the test reaches the fixed code on store, I reverted the line temporarily; the test then failed at line 49 (`Row count mismatch. Expected 2, got 0`). The line has been restored, and `git diff` on the file is empty.
- `yarn workspace @quereus/quereus lint` exits 0.
- One-off script (not kept): with `a = ?` bound to `null` and `b in ('p','q')`, the query returns `[]`. With `a in ('x','y') and b = ?` bound to `null`, it also returns `[]`.

## Known gaps for the reviewer

- **The correlated `=` value was checked by reading the code only.** A correlated subquery `(select count(*) from t where t.a = o.x and t.b in ('p','q'))` returned the right counts (2 / 1 / 0, including a NULL `o.x`). On a 4-row table, though, the planner chose a full `_primary_` scan for `t`, and the equivalent join became a hash join. Neither reached the composite multi-seek. The correlated binding is the same scalar `valueExpr` shape as `= ?`, so the fix covers it. A test that forces this path would need enough rows to make the seek cheaper than a scan, so I didn't write one.
- I ran only `07.9.1` on the store backend, not the full `test:store` suite. The change is confined to one planner branch that the memory suite exercises fully.
- In the multi-value branch just above the fix (`rule-select-access-path.ts:664`), `exprs` still uses `Array.isArray(c.valueExpr) ? c.valueExpr : undefined`. For a multi-element `IN`, `valueExpr` is either an array or absent, so this is correct. It is worth confirming no constraint builder can produce a scalar `valueExpr` with a multi-element `c.value`.
