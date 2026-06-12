description: A GROUP BY over a non-bare expression (collated, arithmetic, any computed) loses the aggregate's group-key claim at the SELECT projection, so keysOf(root)=[] even though the group columns genuinely key the output. Fix the final-aggregate-projection builder to reference the aggregate's group output column for whole-expression group-key matches, restoring the key (collation- and arithmetic-uniform). Update the one anticipated test.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts        # buildFinalAggregateProjections — the fix
  - packages/quereus/test/coarsened-backing-key.spec.ts               # bag2 assertion flips from reject → real key
  - packages/quereus/test/planner/collation-soundness.spec.ts         # add keysOf regression cases (or a new spec)
  - packages/quereus/src/planner/nodes/aggregate-node.ts              # reference only: propagateAggregateFds already correct
  - packages/quereus/src/planner/util/key-utils.ts                    # reference only: deriveProjectionColumnMap (maps by attr id)
  - packages/quereus/src/planner/util/fd-utils.ts                     # reference only: keysOf / deriveKeysFromFds
difficulty: medium
----

# Collated (and computed) GROUP BY should claim its group key

## Root cause (verified by probe, not the ticket's original hypothesis)

The AggregateNode is **already correct**: `propagateAggregateFds`
(`aggregate-node.ts`) unconditionally emits the group-key FD
`{0..groupCount-1} → (all other output cols)` with `kind: 'unique'`, regardless
of whether the group expressions are bare columns or collated/computed. Probe of
`select b collate nocase as g, count(*) as n from t group by b collate nocase`:

```
Project[20]        cols={0:g[NOCASE],1:n}  isSet=false  keysOf=[]            ← LOSES the key
  HashAggregate[19] cols={0:group_0[NOCASE],1:n} isSet=true keysOf=[[0]] fds=[{d:[0],p:[1],unique}]
    IndexScan ...
```

The key is lost **at the SELECT Project layer**, not in the aggregate. For a
SELECT over GROUP BY whose select-list item is a *non-bare* group expression, a
Project is layered over the AggregateNode, and
`buildFinalAggregateProjections` (`select-aggregates.ts`) **re-evaluates** the
group expression over the aggregate's *representative source row*. That makes
the projection node reference **base-table** attribute ids (e.g. `b`/`a`), which
are **not** in the aggregate's *output* attribute set. `deriveProjectionColumnMap`
(`key-utils.ts`) maps columns by attribute id over the projection's source (the
AggregateNode, whose group output column carries a *fresh* attr id). No match ⇒
the unique group-key FD is dropped by `projectFds` (a determinant column is
unmapped) ⇒ `keysOf(root)=[]` and `isSet=false`.

This is **general**, not collation-specific. The identical defect was confirmed
for arithmetic group keys:

```
select a + 1 as g, count(*) as n from t2 group by a + 1     → keysOf=[]   (broken today)
```

Runtime values are nonetheless correct today (e.g. `a=5 → g=6`, not `7`):
recompute resolves the inner column by attribute id against the aggregate's
representative source row, so it reads the real `a`, not the aggregated `a+1`.
Bare-column group bys (`select c ... group by c`) are unaffected — either no
Project is layered, or the projection is already a bare column reference whose
attr id matches the aggregate output.

## The fix

In `buildFinalAggregateProjections` (`select-aggregates.ts`), before structurally
rebuilding a SELECT column expression, test whether the **whole** expression's
fingerprint equals a GROUP BY expression's fingerprint
(`expressionToString(column.expr) === expressionToString(groupByExpressions[i].expression)`).
On a match at group index `gbIdx`, emit the projection as a **bare
`ColumnReferenceNode` to the aggregate group output column** `aggregateAttributes[gbIdx]`
(its `id`, `type`, and column index `gbIdx`), and set the projection's
`attributeId` to that attr id. Otherwise fall through to the existing recompute.

Validated result (prototype, since reverted):

```
collate    select b collate nocase as g, count(*) ... group by b collate nocase  → keysOf=[[0]],  g published NOCASE,  rows [{g:'Bob',n:2}]
arithmetic select a+1 as g, count(*) ... group by a+1                            → keysOf=[[0]],  rows [{g:6},{g:7}]
composite  select a, b collate nocase as bn, count(*) ... group by a, b collate nocase → keysOf=[[0,1]], rows correct
```

Because the emitted node is a bare column reference to the aggregate's own key
column, `deriveProjectionColumnMap` pass-1 maps it, `projectFds` carries the
`unique` group-key FD, and `keysOf` / `isSet` recover automatically — **no change
to `key-utils.ts`, `fd-utils.ts`, or `aggregate-node.ts` is needed.**

### Why this is sound (and why the ticket's stated collation direction is inverted)

The original ticket says "the output column must be published *at least as coarse
as* the grouping collation; republishing *finer* would over-claim." Analysis and
the probe show the **opposite** is the real hazard: a key republished under a
collation strictly **coarser** than its enforcement collation over-claims
(NOCASE merges two BINARY-distinct rows into one key value); **finer-or-equal is
sound**. The chosen fix sidesteps the lattice entirely: it references the
aggregate's own group key column, published under *exactly* its enforcement
(grouping) collation — equality, trivially sound. No collation gate is written.

### Rejected alternative (do NOT do this)

Making `CollateNode.isInjectiveIn` true, or special-casing `CollateNode` in
`deriveProjectionColumnMap`: (a) does **not** fix the arithmetic shape (same
attr-id-mismatch root cause); (b) would need a collation-strength gate reading
the *source attribute's* published collation — the inner ColRef's captured
`columnType` is **stale** (reports BINARY even when the agg column publishes
NOCASE), so the obvious `inner.getType().collationName` read is wrong; (c) risks
the genuine over-claim pinned by `collation-soundness.spec.ts` ("CollateNode is
not injective", "a collated projection drops the source key"). Keep
`CollateNode.isInjectiveIn` conservatively `false` — those pins must stay green.

## Edge cases & interactions

- **Output column naming must not change.** The synthesized `ColumnReferenceNode`
  must yield the same output column name as today. `ProjectNode.buildOutputType`
  uses `proj.alias` if present, else `proj.node.expression.name`. With an alias
  (`... as g`) the alias wins. **Without** an alias (`select b collate nocase, count(*) ...`),
  synthesize the `AST.ColumnExpr` with `name = expressionToString(column.expr)`
  (e.g. `"b collate nocase"`) so the unaliased name is unchanged. Add a
  result-column-name regression assertion for the unaliased case.
- **Output column type/collation unchanged.** Use `aggregateAttributes[gbIdx].type`
  (the grouping collation, e.g. NOCASE) so `g` still publishes NOCASE.
- **Runtime value parity.** The aggregate group output column holds the group-by
  expression's value (the group key); reading it equals the prior recompute. Pin
  `a+1 → 6` (not 7) and `b collate nocase → 'Bob'` so a future refactor can't
  reintroduce double-application.
- **Partial group key in SELECT (must NOT over-claim).** `select b collate nocase, count(*) from t group by a, b collate nocase` projects only one of two group
  columns. Only the projected group column maps; `projectFds` drops the unique FD
  (a determinant column is absent) ⇒ no false key. Add a test asserting
  `keysOf(root)` is **not** `[[0]]` here (sound under-claim).
- **Ordinal/positional GROUP BY** (`group by 1`). `groupByExpressions` are built
  from the ordinal-resolved AST (`resolveOrdinalReference`), so the group expr's
  `.expression` is the resolved select expression. Confirm
  `expressionToString(column.expr)` still matches for `select b collate nocase ... group by 1`. Add a case.
- **Nested / derived group expression** (`select (b collate nocase) || 'x' ... group by b collate nocase`). The whole select expr does **not** fingerprint-match
  the group expr, so it correctly falls through to recompute — the output column
  is a function of the key, not the key itself. No key claimed for it (out of
  scope, no regression).
- **Group expression appearing twice / aliased differently.** Each occurrence
  fingerprint-matches and resolves to the same group column reference; both
  output columns become synonyms of the key. `keysOf` still finds the key.
  Sanity-check no crash and a valid key.
- **count(\*) / multiple aggregates.** Key is the group columns only; aggregate
  columns are dependents. Unchanged.
- **Non-aggregate collated projection (must stay keyless).**
  `select distinct b collate nocase from t12` (base BINARY PK) is **not** an
  aggregate path; this fix does not touch it, and the source key must still be
  dropped (pinned by `collation-soundness.spec.ts` "a collated projection drops
  the source key"). Keep green.
- **ORDER BY / HAVING over grouped expressions** are separate rebuild paths, not
  changed here, and do not affect `keysOf(root)`. Out of scope; recompute there
  remains functionally correct.

## Required test update (anticipated — NOT a regression)

`packages/quereus/test/coarsened-backing-key.spec.ts` → test **"bodies with no
lineage key keep the bag rejection"** (currently ~line 153). The `bag2` MV

```sql
create materialized view bag2 as
  select v collate nocase as v, count(*) as n from t group by v collate nocase
```

is currently asserted to **reject** with `'no provable unique key'`. Post-fix it
**registers with a real, non-coarsened key**. Replace that `expectExecError`
with positive assertions (validated against the prototype):

- `db.exec(bag2)` succeeds;
- `mv.derivation.logicalKey` deep-equals `[{ index: 0, desc: false }]`;
- `mv.derivation.coarsenedKey === undefined` (genuine key, *not* coarsened — this
  is the non-coarsened complement to ticket `mv-coarsened-backing-key-warning`);
- backing PK is column `0` published `NOCASE`;
- selecting from it dedups under NOCASE (e.g. rows `'a'`,`'A'` → one row `n=2`).

Update the now-stale comment at lines 158-160 (which forward-references "the
group-by key completeness backlog ticket" — this ticket). **Keep** the `bag1`
(`select v from t`) rejection — that is a genuine key-dropping projection.

Note for the runner: until this test is updated, the package suite fails *only*
on this one assertion (confirmed: `130 passing, 1 failing`, the failure being
exactly this expected flip). This is not a pre-existing error.

## New regression tests

Add to `test/planner/collation-soundness.spec.ts` (or a new
`test/planner/groupby-key-completeness.spec.ts`) using the `rootOf` + `keysOf`
harness already in that file:

- collated single group key → `keysOf(root)` contains `[0]`, output col 0
  publishes NOCASE;
- arithmetic group key (`a+1`) → `keysOf(root)` contains `[0]`;
- composite `group by a, b collate nocase` → `keysOf(root)` contains `[0,1]`;
- partial-projection (project one of two group cols) → does **not** claim the
  single projected column as a key;
- runtime value parity (`a+1 → 6`, collate → `'Bob'`) via the existing `collect`
  helper.

## TODO

- Implement the fingerprint-match branch in `buildFinalAggregateProjections`
  (`select-aggregates.ts`); synthesize the `AST.ColumnExpr` with the correct name
  for unaliased columns; set `attributeId` on the projection.
- Update `coarsened-backing-key.spec.ts` `bag2` from reject → real-key assertions
  and fix the stale comment; keep `bag1` rejection.
- Add the planner `keysOf` regression cases above (+ partial-key under-claim,
  ordinal GROUP BY, unaliased column naming).
- Run `yarn workspace @quereus/quereus test` (full suite) and `yarn lint`
  (single-quoted globs on Windows). Confirm the aggregate/group-by/collation
  sqllogic files (`07*.sqllogic`, `06.4*`, `25*`, `92-hash-aggregate-edge-cases`,
  `109-aggregate-physical-selection`) stay green.
- Optional: note the FD-completeness improvement in `docs/optimizer.md`
  (Functional Dependency Tracking) — grouped-expression key now survives the
  final projection.
