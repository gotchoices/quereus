description: Feed each flag-less set-op leg's σ predicate conjuncts into the write-branch oracle so a range σ (`where x < 5`) on a *projected* column makes a provably-out-of-range INSERT skip the leg — closing the phantom-base-row over-insert.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/analysis/sat-checker.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
difficulty: medium
----

## Problem (recap)

`legConsistency` (`set-op.ts:1577`) decides whether an INSERT row / DELETE-UPDATE predicate is
consistent with a flag-less leg via
`checkSatisfiability(conjuncts, leg.domains, leg.bindings, leg.attrIndex, leg.getCollation)`.

`leg.bindings` (built in `buildFlaglessLeg`, `set-op.ts:1559`) = the leg's *planned physical*
`constantBindings` ++ the synthesized literal-discriminator bindings. A `=`-σ on a **projected**
column forwards as a `ConstantBinding` (`where color='red'` over a `color`-projecting leg), so the
oracle sees it. A **range** σ (`where x < 5`) on a projected column does **not** forward:

- `FilterNode.computePhysical` passes the source domains through *unchanged* — it does **not**
  intersect the predicate into a `DomainConstraint` (`filter.ts:149-151`: "Intersecting with the
  filter predicate is deferred"). So no range `DomainConstraint` appears on the leg output.
- A range predicate is not an equality, so `extractEqualityFds` emits no `ConstantBinding` for it.

⇒ the oracle never sees the range σ. The leg is judged `sat`/`unknown` for any supplied value.

### Consequence

- DELETE / data-UPDATE: honest over-inclusion — the frozen-capture member-exists correlation only
  matches rows actually resident in the leg, so a fanned no-op leg self-corrects. **Sound.**
- INSERT: a VALUES row whose supplied value provably violates the leg's range σ is still routed into
  the leg. The base insert lands a row the view's σ hides on read-back, but the row is **physically
  present in the base table** — a phantom row / over-insert. This is the bug.

## Fix — feed the leg's σ conjuncts to the oracle ("Option A", made trivial by attr-id preservation)

The load-bearing fact that collapses the ticket's "needs a base→output attribute remap" worry:
**`ProjectNode` preserves the base column's attribute id for a plain `ColumnReferenceNode`
projection** (`project-node.ts:198-208` — when the projection node *is* a `ColumnReferenceNode` it
re-uses `proj.node.attributeId` rather than minting a fresh id). So for a leg
`select id, x from items_a where x < 5`:

- The leg's σ `FilterNode.predicate` (`x < 5`) is a `ScalarPlanNode` referencing the **base** `x`
  attribute id.
- `leg.attrIndex` is built from `legRoot.getAttributes()` (`set-op.ts:1543-1545`), and the projected
  `x` output attribute carries that **same** base attr id. So `attrIndex(base x id)` already returns
  the leg's output column index — **no manual remap is needed**.
- The mutation predicate `x = 7` is built against `leg.scope`, whose `ColumnReferenceNode` for data
  column `x` also carries that same attr id. Both conjuncts therefore fold onto the same
  `checkSatisfiability` accumulator: `x = 7 ∧ x < 5 ⇒ unsat ⇒ skip the leg`. No phantom.

### Soundness — feeding the *whole* leg σ is safe

`checkSatisfiability` never emits a false `unsat` (its contract, `sat-checker.ts:70-74`), so adding
more conjuncts can only ever move the verdict toward `unsat` when a *real* contradiction exists —
never spuriously. Specifically, a σ conjunct whose column is **not projected** (e.g. the existing
93.6 legs `where color='red'` that project only `id, x, kind, src`) resolves to `attrIndex →
undefined`; `absorb`/`markUnknownForColumns` (`sat-checker.ts:312-329`) only marks accumulators for
columns with a *valid* index, so an undefined-index conjunct contributes **nothing** — not even a
`sawUnknown`. Existing 93.6 routing (all driven by literal discriminators + `=`-σ on non-projected
columns) is therefore unchanged. Likewise an OR / function σ (`where f(x)`) splits to a single
non-AND conjunct that `absorb` routes to `markUnknown` → no false `unsat` (include-on-unknown,
unchanged).

### Mechanics

- Add a `sigmaConjuncts: readonly ScalarPlanNode[]` field to `interface FlaglessLeg`
  (`set-op.ts:1421`).
- In `buildFlaglessLeg`, after `legRoot` is planned (`set-op.ts:1538-1542`), collect every
  `FilterNode.predicate` in the leg's relational subtree and `splitConjuncts` each into the flat
  conjunct list. Walk relational children via `RelationalPlanNode.getRelations()` (a small
  recursive DFS; `FilterNode` is already imported, `set-op.ts:12`). Collecting **all** filters in
  the leg body is sound (each is a conjunct that must hold); over-collection only ever pushes toward
  `unknown`/`sat`. The conjuncts are the *logical* (un-optimized) plan from `buildSelectStmt`, so the
  σ `FilterNode` is present as `Project(Filter(...))`.
- In `legConsistency` (`set-op.ts:1577-1584`), append `leg.sigmaConjuncts` to the predicate-derived
  conjuncts before the `checkSatisfiability` call:
  `checkSatisfiability([...conjuncts, ...leg.sigmaConjuncts], leg.domains, leg.bindings, …)`.
- **No `sat-checker.ts` change required** — it already handles the undefined-attrIndex case. (Listed
  in `files:` only as the contract the fix leans on; touch it only if a helper genuinely needs it.)

Prefer this over the "surface a range σ as a `DomainConstraint` on the leg output" alternative: the
DomainConstraint path would require a `FilterNode.computePhysical` hot-path change (the deferred
predicate-intersection work) and a base→output projection remap — strictly heavier for the same
result, and it would not subsume an OR/BETWEEN σ that the conjunct path absorbs directly.

## Edge cases & interactions

- **σ on a projected column, INSERT in-range** → `sat` → leg included (routes correctly; no
  regression vs. today's include).
- **σ on a projected column, INSERT out-of-range** → `unsat` → leg skipped (**the fix**; no phantom).
- **σ on a NON-projected column** (existing 93.6 `where color='red'`, `where size='large'`) →
  `attrIndex → undefined` → ignored. **All current 93.6 assertions must stay green** — this is the
  primary regression guard.
- **Two legs over different base tables, complementary ranges** (`x<5` / `x>=5`): a supplied value
  routes to exactly one leg — assert the *other* base table gets NO phantom row.
- **Value lands in a gap** (legs `x<5` / `x>=10`, insert `x=7`): both `unsat` → `baseOps` empty →
  the existing `consistent with no writable leg` diagnostic fires (honest reject, not a silent
  no-op). Add a `→ error:` assertion.
- **Column omitted from the INSERT** (no supplied value for the σ column): the row predicate carries
  no constraint on it, so σ `x<5` alone is `sat` (x *could* be < 5) → leg included → base column
  defaults. Correct — the fix only excludes a leg when the *supplied* value provably violates σ.
- **BETWEEN / mixed range σ** (`where x between 0 and 4`): absorbed by `checkSatisfiability`'s
  BETWEEN handling; an out-of-band supplied value → `unsat`. Worth one assertion.
- **DELETE / data-UPDATE with a range σ**: fan-out now *narrows* (the out-of-range leg is no longer
  fanned to), but the member-exists correlation already self-corrected the no-op leg, so the
  observable result is identical. Verify a delete/update over the range-discriminated view still
  removes/updates exactly the resident rows (no row wrongly spared, none wrongly hit).
- **TEXT range σ with a non-BINARY collation**: `leg.getCollation(col)` already supplies the output
  column's declared collation to the checker — exercise a `where name < 'm'`-style leg only if cheap;
  otherwise note it's covered by the existing collation wiring.
- **σ FilterNode absent** (a leg with no `where`): `sigmaConjuncts` is empty → behavior unchanged.

## TODO

- Add `sigmaConjuncts: readonly ScalarPlanNode[]` to `interface FlaglessLeg` (`set-op.ts:1421`).
- In `buildFlaglessLeg`, add a small recursive `collectFilterConjuncts(node)` over
  `getRelations()` that splits every `FilterNode.predicate`; populate `sigmaConjuncts` in the
  returned leg.
- Append `leg.sigmaConjuncts` to the conjunct list in `legConsistency`.
- Extend `93.6-set-op-flagless-write.sqllogic` with a range-discriminated section:
  - a two-leg `union all` over `lo` / `hi` distinguished by `where x < 5` / `where x >= 5` on a
    projected `x`;
  - an INSERT with an out-of-range value asserting the wrong base table gets **no phantom row** and
    the right one gets the row (assert both base tables directly, then read back through the view);
  - the complementary in-range INSERT (routes to the other leg only);
  - a gap-value INSERT asserting the `consistent with no writable leg` reject;
  - (optional) a BETWEEN-σ leg and a DELETE-through-range sanity row.
- Update `docs/view-updateability.md` § Set Operations (~line 601): the v1-limitation sentence
  currently parks this as `set-op-flagless-range-sigma-oracle`, backlog — change it to reflect that a
  range σ on a *projected* column is now honored by the oracle (an out-of-range INSERT skips the leg,
  no phantom base row); keep the residual note that a σ on a **non-projected** column (`where
  f(color)`) still routes include-on-unknown.
- Run `yarn workspace @quereus/quereus test` and `yarn lint` (stream with `tee`); confirm 93.6 and
  the broader logic suite stay green.
