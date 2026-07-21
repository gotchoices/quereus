description: Maintain single-source aggregate materialized views by pure arithmetic on the stored group row (add on insert, subtract on delete) instead of re-scanning the group's source rows on every change — using each aggregate's declared algebra, so it stays correct and needs no per-aggregate code.
prereq: feat-mv-agg-algebra-schema
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/mv-maintenance.md, docs/invariants.md
difficulty: hard
----
## Goal

Add a **delta fast path** to the single-source aggregate maintenance arm. When every stored
aggregate column is delta-maintainable by its declared `AggregateAlgebra`, a source change
updates the stored group row by arithmetic — `merge` on insert, `merge(negate(...))` on
delete — with **zero source reads and no residual re-execution**. Falls back to the existing
`'residual-recompute'` path (unchanged) for any body that does not qualify.

Scope of THIS ticket: the **abelian-group** aggregates over an **exact numeric domain** —
`count(*)`, `count(x)`, and integer-domain `sum(x)`. `min`/`max` (tighten-only, no `negate`)
land in `feat-mv-agg-delta-tighten`; `avg`/decompose in `feat-mv-agg-delta-decompose`. Both are
`prereq` on this ticket and build on the descriptor + apply path it introduces.

## Design decision: a fast path inside `'residual-recompute'`, not a new kind

Per the plan directive ("prefer a fast path inside `'residual-recompute'` if it avoids another
plan interface"): the plan **keeps `kind: 'residual-recompute'`** and gains an optional
descriptor field `delta?: DeltaAggregateDescriptor` (`plans.ts` near `ResidualRecomputePlan:300`).
The `residualScheduler` is still compiled and retained — it is the fallback for the cold inline
caller (REPLACE-eviction) and the degrade path. The apply routing checks `plan.delta`: present
⇒ arithmetic delta; absent ⇒ today's residual re-execution.

Cost strategy and apply-kind are already decoupled in this subsystem (`'prefix-delete'` carries
`chosenStrategy: 'residual-recompute'`). So: add `'delta-aggregate'` to the
`MaintenanceStrategy` union (`cost/index.ts:231`), select it when the descriptor builds, store
it as `chosenStrategy`, but leave `kind` as `'residual-recompute'`.

## The descriptor (built at create time)

```ts
interface DeltaAggregateColumn {
	readonly backingCol: number;          // position of this aggregate in the backing row
	readonly algebra: AggregateAlgebra;   // resolved from the function registry
	readonly initialValue: AggValue;      // clone source for the identity accumulator
	readonly argSourceCol: number | undefined;  // source column feeding step(); undefined = count(*)
	readonly isMultiplicity: boolean;     // true iff numArgs 0 & delta-maintainable → count(*)
}
interface DeltaAggregateDescriptor {
	readonly aggColumns: readonly DeltaAggregateColumn[];  // the aggregate output columns
	readonly groupKeyBackingCols: readonly number[];       // group-key passthrough backing positions
	readonly multiplicityColIndex: number;                 // index into aggColumns of the count(*) witness
}
```

### Create-time eligibility gate (in `buildAggregateResidualPlan`, `plan-builders.ts:491`)

Build `delta` only when ALL hold (else leave `delta` undefined → plain residual, unchanged):

1. **Every stored aggregate column** resolves (via the function registry, by `(name, argc)`) to
   an aggregate declaring `algebra` that is **delta-maintainable** = has `negate` AND
   (`decode` OR is the multiplicity witness). `min`/`max` (no `negate`), `total`,
   `group_concat`, any `distinct` aggregate, or any undeclared UDAF → **fail the gate** (whole
   MV stays residual in this ticket).
2. **A `count(*)` multiplicity column is present** — a delta-maintainable aggregate with
   `numArgs === 0`. This is the structural (not name-based) group-emptiness witness: a group is
   deleted exactly when its multiplicity column finalizes to 0. Without it, emptiness cannot be
   told from an all-NULL `sum` → residual instead. (The general Z-set fix in `docs/todo.md`
   § Bag materialization removes this requirement later.)
3. **Exact numeric domain for retracting sums.** For each `sum`-shaped column (has `negate`,
   numArgs 1), the argument source column's static type must be **integer/bigint affinity**.
   A REAL/NUMERIC/TEXT-affinity sum drifts under repeated add/subtract and would diverge
   byte-exactly from the live re-evaluation the oracle compares against → disqualify that column
   (MV stays residual). This is the single, localized type-aware check; everything else is
   function-generic. `count` is always exact (integer). Document the float-exact path
   (Kahan / periodic rescan) as a tripwire, not work.
4. **Bare-column aggregate arguments.** `sum(a)` qualifies; `sum(a*2)`/`sum(distinct a)` do not
   (the delta must `step` the raw source value). Reuse the existing bare-arg resolution the
   arm already performs for the group key.

The group-key columns and `backingPkSourceCols` are already computed by the residual builder —
reuse them for `groupKeyBackingCols`.

## Apply path (arithmetic read-modify-write)

**Per-statement accumulation.** Extend `ResidualKeyBatchEntry` (`plans.ts:494`) with an optional
`delta?: Map<string, DeltaGroupState>` — keyed by canonical group-key bytes, holding the
group-key value tuple plus, per aggregate column, a **net accumulator delta** (folded across the
statement). In `accumulateResidualKeys` (`apply.ts:780`, dispatched from `maintainRowTime`
`materialized-views.ts:644`): when `plan.delta` is set, for each changed row compute the
per-column contribution and `merge` it into the group's running delta:

- insert `r`: `step(identity, r[argSourceCol])` (count(*) → `step(identity)`), merged in.
- delete `r`: `negate(step(identity, r[argSourceCol]))`, merged in.
- update `old→new`: retract old, insert new — into OLD group and NEW group respectively (a
  group-key-changing update touches two groups, exactly like the residual key derivation).

**Flush (`computeResidualBatchOps` `apply.ts:817` / `applyResidualBatch` `materialized-views.ts:772`).**
For each affected group in `delta`:
1. Read the group's current **effective** backing row by its PK (group key) via the backing
   host (`scanEffective` / point lookup — the same effective read the prefix-delete arm uses).
2. For each aggregate column: `acc = row ? decode(row[backingCol]) : cloneInitialValue(initial)`;
   `merged = merge(acc, delta[col])`; `finalizedValue = finalize(merged)`.
3. If the **multiplicity** column's `finalizedValue === 0` → `delete-key` (group emptied).
   Else build the new backing row (group-key values + finalized aggregate values) → `upsert`.
   The host's value-identical skip suppresses a no-op (MV-016).

**Cold inline path** (`applyForwardResidual`, no statement batch — REPLACE-eviction): keep
running the compiled `residualScheduler` (correct, just not the fast path). No new cold code.

**Degrade-to-rebuild.** The delta path is already O(affected groups) with no rescan, so it
**bypasses** `shouldDegradeToRebuild` — do not route delta groups through the residual/rebuild
crossover. Document this.

## Cost gate (`cost/index.ts`)

Add `'delta-aggregate'` to `MaintenanceStrategy` (`:231`) and a case to `maintenanceCost`
(`:291`): O(1) per changed row plus one RMW per affected group — model as
`changeCardinality × (deltaMergeConst)` with a small constant strictly below
`residualCostPerGroup`, so the backward gate prefers delta > residual > rebuild for a
delta-eligible body. Feed `soundStrategies = ['delta-aggregate', 'residual-recompute']` from the
builder when the descriptor built; assert the gate picks `'delta-aggregate'` (parity with the
existing unwired-strategy guard). The exhaustiveness `never` check at `:306` forces the new arm.

## TODO

- [ ] `plans.ts`: add `DeltaAggregateDescriptor` / `DeltaAggregateColumn` / `DeltaGroupState`;
      add `delta?` to `ResidualRecomputePlan` and `delta?` to `ResidualKeyBatchEntry`.
- [ ] `plan-builders.ts` (`buildAggregateResidualPlan`): build the descriptor after the existing
      group-key/backing-PK resolution; the 4-point eligibility gate; resolve each aggregate's
      algebra from the registry by `(name, argc)`; the integer-domain type check; set
      `chosenStrategy` via the extended cost gate. Leave `delta` undefined on any gate failure.
- [ ] `cost/index.ts`: `'delta-aggregate'` strategy + cost case + selection.
- [ ] `apply.ts` + `materialized-views.ts`: delta accumulation in `accumulateResidualKeys`; the
      RMW flush in `computeResidualBatchOps`/`applyResidualBatch`; route on `plan.delta`.
- [ ] Extend `maintenance-equivalence.spec.ts`: the existing `count(*)+sum` AGGREGATE_SHAPES now
      route through delta automatically (integer `a`) — confirm they stay green. Add a
      UDAF-declared-algebra shape: register a test abelian-group UDAF (e.g. `bit_xor(x)` over
      integers, declaring merge/negate/decode) and a body `select k, count(*), test_xor(a) …`;
      assert equivalence across mutations + rollback. Add a **broken-law negative twin** UDAF
      (wrong `negate`) and assert the oracle catches the divergence (`read(MV) != body`).
- [ ] Performance: confirm a bulk-insert workload over a `count(*)+sum` MV drops to O(affected
      groups) with no source rescans (extend/observe the existing performance sentinel;
      delta should beat the residual ratio). Stream any long run with `tee`.
- [ ] `docs/mv-maintenance.md` § `'residual-recompute'`: document the delta fast path, the
      eligibility gate, the multiplicity-witness emptiness rule, the integer-domain float gate
      (+ the float-exact tripwire), and the degrade bypass. `docs/invariants.md`: note the arm
      reads the declared algebra, never a name list.
- [ ] `yarn build && yarn test && yarn lint` green.

## Edge cases & interactions

- **Group emptied by delete.** Multiplicity → 0 must `delete-key` even though `sum` finalizes to
  NULL (all-NULL group) or 0. Covered by AGGREGATE_SHAPES delete/collision mutations.
- **Group-key-changing update.** Retract from OLD group, insert into NEW group — two groups in
  one change. The NEW group may be created (no stored row → start from identity); the OLD group
  may empty (→ delete). Mirror `collectForwardResidualKeys`'s OLD∪NEW derivation.
- **NULL argument values.** `sum(NULL)`/`count(x)` NULL: `step(identity, NULL)` ≡ identity, so
  the delta is identity and the merge is a no-op — the row still counts toward `count(*)` (arg
  0). This is exactly law 2; the delta arm must feed the raw value (incl. NULL) to `step`, not
  pre-filter.
- **Reads-own-writes / cross-statement.** The flush reads the **effective** (pending-over-
  committed) backing row, so a group already written earlier this transaction (a prior
  statement's flush) is folded correctly. Within one statement all changes accumulate into the
  delta and apply once — never read the backing mid-accumulation.
- **Rollback / savepoint lockstep.** Delta ops ride the same backing connection + statement
  savepoint as the residual arm (`applyMaintenance` on the pending layer) — a failed flush or
  rollback reverts them identically. Oracle's post-rollback assertion pins this.
- **`OR FAIL` / `OR IGNORE` reverted rows.** A per-row-savepoint-reverted row may still have its
  delta in the batch — harmless: the FAIL-path flush reads the surviving effective state, and a
  reverted row's contribution was already undone in the source, so re-reading yields the correct
  stored value. But note: the delta arm accumulates *net contributions*, not keys — a reverted
  insert's `+step` is NOT auto-cancelled unless the revert also runs a compensating delete. Verify
  the DML generator's revert path emits the compensating `BackingRowChange` (delete of the
  reverted insert) into the same accumulation, OR that the FAIL/IGNORE path re-derives from
  effective state. **This is the sharpest correctness risk in the ticket** — the residual arm is
  immune (it recomputes from live state) but the delta arm is not (it trusts accumulated deltas).
  If the revert does not emit a compensating change, delta must fall back to residual for
  `OR FAIL`/`OR IGNORE`/`OR REPLACE` statements, or re-read-and-recompute the affected groups at
  flush instead of trusting the delta. Settle by reading `dml-executor.ts` revert emission; the
  oracle's collision mutations (which exercise REPLACE) are the backstop.
- **Value-identical no-op (MV-016).** A delta that nets to identity (insert then delete of the
  same row in one statement) must produce an upsert value-identical to the stored row → host
  suppresses. Confirm the accumulated-then-finalized value byte-matches.
- **MV-over-MV cascade.** A delta upsert/delete emits the same effective `BackingRowChange[]`;
  the cascade re-drives consumers unchanged. A consumer that is itself a delta-aggregate MV
  accumulates from those changes — verify a two-level `count(*)+sum` chain converges (add a
  chained-MV oracle case if not already covered).
- **bigint/number in sum.** `decode(stored)` → `{sum: v}` where `v` may be bigint or number;
  `merge` must preserve promotion so a group that overflowed to bigint stays exact. Law-4 harness
  covers the function; the oracle's larger integer values exercise it end-to-end.
- **Integer-affinity column holding a non-integer value.** A source column declared INTEGER but
  physically holding `'3.5'`/REAL bytes would let a float into an "exact" sum. If the type system
  permits this, the oracle's type/NULL zoo should surface drift; if it does, tighten the gate to
  also require the physical storage class, or keep such an MV on residual. Verify against the
  spec's value zoo.
- **Empty descriptor / single-column.** A `select k, count(*) group by k` (multiplicity only, no
  sum) is delta-eligible — the multiplicity IS an aggregate column. Ensure the descriptor handles
  a body whose only aggregate is `count(*)`.
