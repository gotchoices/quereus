----
description: `select exists(select ... where c.fk = o.k) as flag from o` and correlated `IN (...)` in the SELECT list still re-run the inner query once per row; rewrite them to a single left join that computes a match flag, reusing the existing "existence column" join form.
prereq: feat-decorrelate-scalar-subquery-order-by
files: packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic
difficulty: hard
----

# Decorrelate correlated EXISTS / IN appearing in the SELECT list

## Background

`rule-subquery-decorrelation.ts` rewrites correlated EXISTS / NOT EXISTS / IN
into semi/anti joins — but only when they appear as **top-level conjuncts of a
WHERE FilterNode** (the rule anchors on `FilterNode` and pattern-matches the
predicate's conjuncts). A correlated EXISTS/IN in the **SELECT list**
(`select o.id, exists(select 1 from c where c.fk = o.k) as has_child from o`)
is not a boolean filter — it is a scalar expression whose value (true/false) must
appear in the output row. A semi/anti join cannot express that: it drops
non-matching rows, whereas the SELECT-list form must **keep every outer row** and
report the match as a column.

The engine already has the right primitive: a `JoinNode` carrying an
`ExistenceColumnSpec` (`nodes/join-node.ts`) — an `exists <side> as <name>` match
flag appended to a LEFT join's output as a `{true,false}` boolean column
(`hasExistenceColumns` on `JoinNode`). This is exactly a "kept every outer row,
here's whether it matched" column. Several rules already consume/produce this
form (`rule-semijoin-existence-recovery`, `rule-inner-join-existence-recovery`,
`rule-join-existence-pruning`), so producing it here plugs straight into the
existing cascade — a pruned/recovered downstream shape comes for free.

## What's still per-row

- `select exists(select 1 from c where c.fk = o.k) as flag from o`
- `select not exists(...) as flag from o`
- `select (o.k in (select c.fk from c where c.g = o.g)) as flag from o`

Each ExistsNode/InNode in a projection re-executes its inner pipeline per outer
row.

## Design

New anchor `ruleExistsInSelectDecorrelation` on `ProjectNode` in
`rule-subquery-decorrelation.ts` (reuse the file's existing
`extractExistsCorrelation` / `extractInCorrelation` correlation splitters — they
are already written for the WHERE path and are anchor-agnostic given a subquery
root + outer attribute id set).

For each recognized correlated `ExistsNode` / `NOT ExistsNode` / `InNode` in the
projection expressions:

1. Extract the correlation condition + residual inner-only filter via the
   existing splitter (bail if not a simple equi-correlation — same gate as the
   WHERE path).
2. Build a LEFT `JoinNode` over the current source and the (residual-filtered)
   inner source, with an `ExistenceColumnSpec { attrId: <fresh>, name, side:
   'right' }` and the correlation condition as the join condition. Stack one
   join per recognized subquery (left-deep, mirroring `decorrelateAll`).
3. Replace the subquery node in the projection with:
   - EXISTS → a `ColumnReferenceNode` to the flag attribute;
   - NOT EXISTS → `NOT <flag ref>`;
   - IN → the flag ref (the IN equi-condition `o.k = c.fk` is folded into the
     join condition alongside any inner correlation, same as
     `extractInCorrelation` builds for the semi-join path).
4. Rebuild the `ProjectNode` with the substituted projections over the
   join-stacked source, preserving output attribute ids (reuse the
   `rebuildProject` pattern).

Result:

```
Project[ o.id, <flag ref> AS has_child ]
  LeftJoin[ c.fk = o.k ] exists right as <flag>
    o
    (Filter(residual, c))          -- residual inner-only predicates, if any
```

The inner side is scanned once; the flag is derived by the join emitter.

### Existence-flag semantics vs fan-out

`emitLoopJoin` drives `left join … exists right as` like a normal left join with
one appended flag bit: a matched left row with **K** matching right rows yields
**K** output rows (each `flag = true`), an unmatched left row yields **1**
null-extended row (`flag = false`). For a SELECT-list EXISTS that **fans out K**,
this would duplicate the outer row K times — **wrong** (EXISTS must yield exactly
one row per outer row with a single boolean). So this rewrite is sound only when
the inner side matches **at most one** row per outer row, OR the duplicates are
collapsed. Two options — **resolve during implement, default to the first**:

- **Preferred:** wrap the inner (right) side so it produces ≤1 row per
  correlation key before the join — a `DISTINCT`/grouped projection on the
  correlation key, so K→1. `exists` only cares about presence, so collapsing
  duplicates is value-preserving. Reuse the grouped-subtree construction from
  `rule-scalar-agg-decorrelation.ts` (group by the inner correlation key, no
  aggregate) or a DistinctNode on the key.
- **Fallback (narrower):** gate the rewrite on the inner already matching ≤1 per
  key (a unique key / FK→PK alignment on the correlation column, via the same
  `rightMatchesAtMostOne` helper the recovery rules use) and bail otherwise. Ships
  a correct-but-narrower rule; note the gap in the review handoff.

The count/agg sites had no such fan-out hazard (a grouped aggregate is already
≤1 per key); this is the distinctive risk of the EXISTS/IN-in-projection site and
**the main reason it is its own ticket**.

### NOT IN

Do **not** decorrelate `NOT IN (correlated subquery)` — its NULL semantics
(a single inner NULL makes the whole predicate NULL/unknown) are not captured by
a match flag. Bail, matching the existing NOT-IN deferral in the WHERE path.

### Registration

```
{ pass: PassId.Structural, id: 'exists-in-select-decorrelation',
  nodeType: PlanNodeType.Project, phase: 'rewrite',
  fn: ruleExistsInSelectDecorrelation, sideEffectMode: 'aware' }
```

Register adjacent to the other Project-typed decorrelation rules. `sideEffectMode:
'aware'` — bail on a side-effecting inner (mirror the EXISTS/IN WHERE rule's
`subtreeHasSideEffects` refusal). Place it so the produced existence-flag join is
visible to `join-existence-pruning` / the recovery rules downstream in the same
pass (they run later — verify ordering against the registration block).

## Edge cases & interactions

- **Fan-out inner (K>1 per key):** the headline correctness case — a plain
  existence join would duplicate the outer row. Test an inner with multiple rows
  per correlation key and assert exactly one output row per outer row with the
  right flag.
- **NOT EXISTS:** flag negated; unmatched outer → flag false → `not false` = true.
  Test.
- **Correlated IN in projection:** `(o.k in (select c.fk from c where c.g=o.g))`.
  Test true/false/empty-inner.
- **NOT IN with inner NULLs:** must bail (stay correlated). Add a test proving the
  NULL/unknown result is still computed correctly by the per-row path.
- **Multiple EXISTS/IN in one SELECT list:** one stacked LEFT join per subquery;
  each flag column distinct. Test two.
- **EXISTS in SELECT list AND EXISTS in WHERE of the same query:** the WHERE one
  becomes a semi join (existing rule), the SELECT-list one an existence-flag
  join. Confirm both fire and the result is correct.
- **Interaction with existence-flag pruning/recovery:** if the flag is later
  unused (e.g. wrapped in a constant), `join-existence-pruning` should strip it;
  if selected as a bare `where`-style probe upstream, recovery may re-shape it.
  Confirm no double-optimization or incorrect collapse.
- **Empty inner / no match:** outer row kept, flag false (EXISTS) / true (NOT
  EXISTS). Test.
- **Non-equi / non-value-faithful correlation:** bail via the existing splitter;
  stays correlated but correct.
- **Side-effecting inner:** bail (per-row firing observable).

## TODO

- Add `ruleExistsInSelectDecorrelation` on `ProjectNode` in
  `rule-subquery-decorrelation.ts`; reuse `extractExistsCorrelation` /
  `extractInCorrelation` and the existence-flag `JoinNode` construction.
- Decide fan-out handling: implement the DISTINCT/grouped-key collapse (preferred)
  or the `rightMatchesAtMostOne` gate (fallback); document the choice + any gap.
- Register `exists-in-select-decorrelation` in `optimizer.ts`.
- Add `.sqllogic` coverage for every edge case above (new `07.7.x` file or extend
  the subquery suite); include the fan-out and NOT-IN-bail cases explicitly.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`; stream with `tee`.
