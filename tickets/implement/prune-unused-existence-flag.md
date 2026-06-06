description: Add a demand-gated optimizer rule that prunes an UNUSED outer-join `exists … as` existence flag from a JoinNode, re-enabling join-elimination / physical-join selection once the last flag is dropped. Pure optimization — no correctness defect today.
prereq: outer-join-existence-column
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts (new), packages/quereus/src/planner/rules/join/rule-join-elimination.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (new), docs/view-updateability.md, docs/optimizer.md
----

## Goal

The read half (`outer-join-existence-read`) appends a `{true,false}` match flag
to a `JoinNode`'s output for each `exists [<side>] as <name>` clause and guards
five join rules with `if (node.hasExistenceColumns) return null`:

- `rule-join-elimination` (Structural, Project, priority 24)
- `rule-fanout-lookup-join` (Structural, Project, priority 23)
- `rule-join-physical-selection` (PostOptimization, Join, priority 5)
- `rule-monotonic-merge-join` (PostOptimization, Join, priority 4)
- `rule-lateral-top1-asof` (Structural, Join, priority 5)

Those guards are load-bearing **while the flag is live** (the flag's attr id is
not a column of either side, so the demand scans in those rules cannot see its
dependency on the non-preserved side — eliminating/rewriting the join would be
unsound). But when **nothing demands the flag**, the whole mechanism is dead
weight: the join is pinned to a nested-loop shape and cannot be eliminated,
purely to compute a column no one reads.

Add a **demand-gated pruning rule**: detect an existence flag whose output
attribute id is not demanded by any ancestor and rebuild the `JoinNode` without
that `ExistenceColumnSpec`. Once the last spec is dropped, `existence` becomes
`undefined`, `hasExistenceColumns` flips to `false`, and the five guarded rules
re-enable automatically on the (now flag-free) join.

## Design

### Demand analysis — mirror `ruleJoinElimination`

`ruleJoinElimination` already solves the exact demand-analysis problem this rule
needs, and the helpers are reusable verbatim. The rule:

1. Fires on a `ProjectNode`.
2. Collects demanded attr ids from the project's projection expressions
   (`collectAttrIds`).
3. `walkChain(node.source, demanded)` walks a whitelisted pass-through chain
   (`Filter` → adds predicate attrs to `demanded`; `Sort` → adds sort-key attrs;
   `LimitOffset`/`Distinct`/`Alias` → pass through) down to the first `JoinNode`,
   returning `{ join, chain }` or `null` if the chain hits anything else.

**Soundness of the Project anchor.** A node above the anchoring Project can only
reference attr ids the Project *outputs*; the Project outputs exactly its
projections' attr ids. So if the flag's attr id is absent from the project
projections + intervening filter/sort references, nothing above the project can
reference it either. Anchoring on the nearest enclosing Project is therefore a
complete demand check for the standard shape. When the join is **not** reachable
through a clean Project+chain (e.g. buried under an aggregate or a second join),
`walkChain` returns `null` and the rule simply does not fire — the flag is
retained (correct, just unoptimized).

### Rewrite

```
export function ruleJoinExistencePruning(node, _ctx) {
  if (!(node instanceof ProjectNode)) return null;
  const demanded = new Set<number>();
  for (const proj of node.projections) collectAttrIds(proj.node, demanded);
  const walk = walkChain(node.source, demanded);
  if (!walk) return null;
  const { join, chain } = walk;
  if (!join.hasExistenceColumns) return null;

  const kept = join.existence!.filter(s => demanded.has(s.attrId));
  if (kept.length === join.existence!.length) return null;   // nothing unused

  const newJoin = new JoinNode(
    join.scope, join.left, join.right, join.joinType,
    join.condition, join.usingColumns,
    kept.length ? kept : undefined,
  );
  const newSource = rebuildChain(chain, newJoin);
  return rebuildProject(node, newSource);
}
```

To stay DRY, **export** `collectAttrIds`, `walkChain`, `rebuildChain`,
`rebuildProject`, and the `ChainEntry` / `ChainWalkResult` types from
`rule-join-elimination.ts` and import them here (they are currently
module-private). Do not copy them.

### Why dropping a flag (even a middle one) is runtime-safe

Runtime column resolution is by **attribute id**, not by a stored column index:
`emitColumnReference` calls `resolveAttribute(rctx, plan.attributeId, …)`, which
indexes the row via a `RowDescriptor` (attrId → columnIndex) rebuilt from the
node's `getAttributes()` (`runtime/context-helpers.ts`). The join emitter
(`runtime/emit/join.ts`) builds `matchedFlags`/`unmatchedFlags` from
`plan.existence` in array order, and `buildJoinAttributes` appends the flag
attributes in the **same** order — so after pruning, the kept flags' positions
and the rebuilt descriptor stay consistent and downstream `ColumnReferenceNode`s
resolve to the correct slot. The build-time `columnIndex` field stored on a kept
flag's `ColumnReferenceNode` goes stale, but nothing reads it for row lookup
(`physical-utils` ordering helpers also resolve by attr id), so a middle-flag
drop is safe. **Add a test for the two-flag case where only the later flag is
used** to lock this in.

### Registration

`optimizer.ts`, Structural pass, `nodeType: PlanNodeType.Project`, `phase:
'rewrite'`, **priority 22** — after `projection-pruning` (19) and
`predicate-pushdown` (20, Filter-typed) so demand is settled, and **before**
`fanout-lookup-join` (23) and `join-elimination` (24) so the freshly-pruned
Project is threaded through them in the same `applyRules` loop (it loops over all
Project rules in priority order on the running `currentNode`). The
PostOptimization join rules (`join-physical-selection`, `monotonic-merge-join`)
and the Structural Join-typed `lateral-top1-asof` (priority 5, visited
top-down *after* the ancestor Project in the same pass) see the flag-free join
automatically.

`sideEffectMode: 'safe'` — the rewrite drops only a derived, read-only
`{true,false}` boolean column; both join sides are preserved verbatim, so no
write can be skipped or reordered. (Contrast `join-elimination`, which is
`'aware'` because it drops a whole side.)

### Write-half is safe by construction — no special-casing needed

An existence column is writable through a view that exposes it
(`create view v as select …, hasP from … exists right as hasP`). Every
UPDATE/INSERT-through-view path therefore flows through a Project whose
projection list contains `hasP`, so `collectAttrIds` marks the flag demanded and
the rule retains it. The unused case arises **only** when the flag is never
selected (e.g. `select c.cc, p.pv from … exists right as hasP` with `hasP`
omitted). No statement-level context is needed in the rule; the demand gate is
the complete and correct mechanism. Document this reasoning in a code comment so
the reviewer can confirm it.

## Edge cases & interactions

- **Single flag, unused** — the common case: `existence` goes to `undefined`,
  `hasExistenceColumns` false, join-elimination/physical-selection re-enable.
- **Multiple flags, all unused** — all dropped → `undefined`.
- **Multiple flags, mixed (drop a middle one, keep a later one)** — kept array
  preserves original relative order; verify the *kept* flag returns the correct
  value at runtime (attr-id resolution; see above). This is the regression-prone
  case — test it explicitly.
- **`select *` over the join** — star expansion enumerates the flag column, so it
  is demanded → retained. Verify the flag survives and reads correctly.
- **Flag referenced only in a chain `Filter` / `Sort` (not the projection)** —
  `walkChain` adds those attrs to `demanded`, so the flag is retained. Test e.g.
  `select c.cc from … exists right as hasP where hasP order by c.cc`.
- **Flag referenced through a lower Project** (`Project → Project → … → Join`) —
  the lower Project must project the flag for the upper one to see it, so the
  anchor's projection scan catches it. (Note: this rule anchors on the nearest
  Project above the join; the `Project-on-Project` collapse is
  `ruleProjectionPruning`'s job and runs first at priority 19.)
- **Join not reachable via a clean Project+chain** (under Aggregate, under
  another Join, top of a scalar subquery) — `walkChain` returns `null`, rule
  no-ops, flag retained. No correctness impact.
- **Write-half PutGet corpus** — `update v set hasP = …` through a view that
  selects `hasP`: flag demanded → retained → write routing unchanged. Run the
  full property-spec write-half families to confirm.
- **Read-half property invariants** — flags that *are* selected stay put, so the
  read-agreement, FD `key → flag`, clean-`{true,false}`, and Key-Soundness
  assertions are untouched. Confirm by running the existing suite.
- **Pruned-then-eliminated** — after pruning, a LEFT join whose now-only-data
  non-preserved side is unreferenced should be *eliminated* by
  `join-elimination` in the same pass (assert join count drops to 0 with an
  FK→PK setup). After pruning, an INNER/LEFT equi-join with both data sides
  referenced should pick up a hash/merge physical variant in PostOptimization.

## Tests

New optimizer spec `test/optimizer/rule-join-existence-pruning.spec.ts`
(model on `rule-join-elimination.spec.ts` — `planRows` + `joinCount` / op-name
assertions, plus result-equality checks):

- **prunes + eliminates**: with `orders LEFT JOIN customers ON … exists right as
  hasC` selecting only `order_id, total` (no `hasC`), the plan has **zero** join
  ops (flag pruned → FK→PK elimination fires). Compare to the same query *with*
  `hasC` selected → join op survives (flag live, guard holds).
- **prunes + physical selection**: a non-eliminable equi-join with an unused flag
  where both data sides are referenced → a hash/merge physical join variant
  appears (no nested-loop Join op left for the flag's sake). Without pruning it
  would stay a logical `Join`.
- **retained when used in projection / filter / sort** (three cases above).
- **retained for `select *`**.
- **mixed multi-flag**: two flags, only the later used → exactly one flag column
  remains and its values are correct (run via `db.eval`, not just plan shape).
- **result equality**: every prune case returns byte-identical rows to the
  unpruned (flag-disabled-rule) baseline — guard with
  `tuning.disabledRules = new Set(['join-existence-pruning'])` to get the
  before/after comparison from one db.

Extend `test/property.spec.ts` "Outer-join existence column" describe block:

- **pruning preserves read agreement**: an unused-flag query returns the same
  data rows as the flag-selected query (minus the flag column).
- **write-half unaffected**: re-run a representative `update … set hasP = …`
  PutGet through a flag-selecting view and confirm routing is unchanged (the flag
  is retained because the view projects it).

Run: `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80
/tmp/t.log` and `yarn workspace @quereus/quereus run lint` (single-quote globs on
Windows). The property-spec Key-Soundness corpus and "Outer-join existence
column (read half)" sections must stay green.

## Out of scope (stretch / backlog)

- **Semijoin/anti-semijoin recovery**: when a flag is still referenced but only
  as a pure existence probe (the classic semijoin shape — flag consumed solely
  by a top-level `where hasP` / `where not hasP` and nowhere else), a follow-on
  rewrite to a semi/anti join could recover the access-path choice the flag
  currently forfeits. Not required here; if pursued, file a separate `plan/`
  ticket — it needs its own demand-shape analysis (flag used *only* as a boolean
  filter) and interacts with the existing `semi-join-fk-trivial` /
  `anti-join-fk-empty` rules.
- **Aggregate-anchored pruning**: an unused flag under an `AggregateNode` (mirror
  `ruleJoinEliminationUnderAggregate` — collect demand from group-by + aggregate
  exprs, same `walkChain`). Small mirror of this rule but a distinct entrypoint;
  defer to a follow-on unless trivially droppable in the same run. No correctness
  impact from deferring (an unused flag under an aggregate is just computed and
  discarded, as today).

## Docs

- `docs/view-updateability.md` ~lines 220–223: the read-half text says the
  flag-bearing `JoinNode` "stays the nested-loop join … a documented read-half
  limitation (existence joins forgo hash/merge selection)." Update to note that
  an **unused** flag is now pruned (re-enabling the standard join optimizations),
  and the limitation applies only while the flag is **live/demanded**.
- `docs/optimizer.md` Join rules section (~line 490): add a short entry for
  `ruleJoinExistencePruning` (demand-gated drop of unused `exists … as` flags;
  Structural/Project/priority 22; re-enables the five flag-guarded rules).

## TODO

- Export `collectAttrIds`, `walkChain`, `rebuildChain`, `rebuildProject`,
  `ChainEntry`, `ChainWalkResult` from `rule-join-elimination.ts`.
- Add `rule-join-existence-pruning.ts` implementing `ruleJoinExistencePruning`
  per the design above (logger `optimizer:rule:join-existence-pruning`).
- Register it in `optimizer.ts` (Structural, Project, priority 22, `'safe'`).
- Add `test/optimizer/rule-join-existence-pruning.spec.ts` covering the cases
  above.
- Extend the "Outer-join existence column" block in `test/property.spec.ts`.
- Update `docs/view-updateability.md` and `docs/optimizer.md`.
- `yarn workspace @quereus/quereus test` + `lint` green (stream with `tee`).
