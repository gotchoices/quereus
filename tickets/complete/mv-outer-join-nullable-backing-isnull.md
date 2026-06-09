description: Fixed a materialized view over an outer join stamping its null-extended backing column NOT NULL, which made `is null`/`is not null` reads over the MV fold to wrong results (read-side divergence from the equivalent plain view). Root cause: `ProjectNode` re-typed a bare column-ref projection from the column-ref's stale base-table `columnType` instead of the nullable join-output attribute it actually reads. Fix is wholly at the projection layer (`project-node.ts` only). It also correctly activated a previously-dead lens-prover nullability check; fallout resolved by making optional-member-backed lens test columns nullable (no production lens code changed).
files: packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/51-lens-foundation.sqllogic, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/lens-put-fanout.spec.ts
----

## What shipped

A `ProjectNode` derived both its output `RelationType.columns[].type` and its output
attributes from `proj.node.getType()`. For a bare `ColumnReferenceNode` projection,
`getType()` returns the node's `columnType`, captured at *build* time from the **base-table**
column scope — so over an outer join it is stale (non-nullable) even though the join-output
attribute the projection reads is null-extended (nullable). `deriveBackingShape`
(`materialized-view-helpers.ts:91`, `notNull: c.type.nullable === false`) then stamped the MV
backing column NOT NULL, and a base-table NOT NULL is load-bearing: the read path folds
`… is null → FALSE` / `… is not null → TRUE` against it — a read-side divergence from the
equivalent plain view that the full `select *` equivalence floor never exercised.

The production change is **solely** `project-node.ts`:
- `effectiveProjectionType(projNode, sourceTypeById)` (module-level) — for a `ColumnReferenceNode`
  returns the **source-published** type by attribute id, falling back to `projNode.getType()` when
  the id is absent (correlated outer reference) or the node is not a column-ref (no-op, safe to apply
  uniformly).
- `ProjectNode.sourceTypeById()` — `Map<attributeId, ScalarType>` from `this.source.getAttributes()`
  (collision-free; attribute ids are globally unique).
- Applied at every type-derivation site: `outputTypeCache` column `type`; all four `type` branches of
  `attributesCache`; and `withProjections`'s `predefinedAttributes`.

`ColumnReferenceNode.columnType`, the join's outer column scope, and `materialized-view-helpers.ts`
were deliberately **not** touched (blast radius kept at the projection layer, as the ticket directed).
With the corrected body root, `deriveBackingShape` stamps `notNull: false` automatically.

**Lens-prover fallout (no production code changed).** The lens prover's `checkTypeAndNullability`
(`lens-prover.ts:422`) rejects a NOT-NULL logical column whose basis-derived expression is nullable —
documented at `docs/lens.md:362`. That check was effectively dead before the fix: the lens `get` body
outer-joins optional members, but the buggy projection reported those null-extended columns as NOT
NULL, so it never fired. The fix makes the body root report correct nullability, **activating** the
check and surfacing lens tests that declared a NOT-NULL logical column over an **optional** member —
unsound declarations that only ever deployed because of this bug. Resolved by appending `null` to the
optional-member-backed logical columns (an already-established convention in the same files);
mandatory/anchor/PK columns left as-is. The prover is now simply correct rather than masked, and the
code now matches the long-standing documented contract.

## Review findings

**The implement-stage diff (commit `8dedc3d9`) was read first, with fresh eyes, before the handoff
summary**, then verified against the surrounding code (`reference.ts`, `materialized-view-helpers.ts`,
`lens-prover.ts`, the predicate-folding / null-constraint extractor surface) and the docs.

**Correctness (core fix) — confirmed sound.**
- `effectiveProjectionType` substitutes the source's authoritative published type for a *bare* column
  ref only. A bare `ColumnReferenceNode` reads a column value without coercion, and its `columnType`
  is constructed from `attr.type` (e.g. `key-filter.ts`), so the source type differs only in the
  stale-nullability dimension the fix targets — wholesale substitution is safe. Coercions are
  `CastNode`/expression nodes (not column refs) → fall to the `getType()` branch.
- The substitution direction is the safe one: it relaxes a non-nullable claim to nullable. An
  over-nullable column only forgoes an `is null`/`is not null` folding optimization — it never folds
  to a wrong result. The reverse (less-nullable-than-reality) cannot arise from this change.
- `outputTypeCache` and `attributesCache` now compute `type` via the *same* helper + map, so the two
  surfaces cannot drift (they agreed before via `proj.node.getType()`; they agree after).
- `deriveBackingShape` reads `root.getType().columns[i].type.nullable` — directly fed by the corrected
  `outputTypeCache`. Verified the data path end-to-end.

**Breadth (the ticket's flagged risk) — exercised, no regression.** The change relaxes nullability for
*any* bare column-ref projection over a nullable source, not only MV bodies. Ran the full
optimizer + planner + plan suites (**2084 passing**) — predicate folding, null-rejection, key/FD
inference, semi-/anti-join trivialization, and the lens prover all pass.

**Edge / interaction coverage added (minor, fixed in this pass).** The implementer verified the
**right**-outer-join case white-box but committed no end-to-end test. The fix is symmetric (it reads
whatever nullability `JoinNode` marks per side), and a right join is the materializable both-sided
null-extension analog (a `full` join is a keyless bag → not materializable). I verified a right-join
MV behaves correctly — the unmatched right row null-extends **both** the lookup column and the
**left PK** — and added §31 to `53-materialized-views-rowtime.sqllogic` locking in `name is null`,
`lid_pk is null` (the null-extended left PK — the column a base table stamps NOT NULL, which the
left-join case cannot exercise), and `is not null`. Suite re-run green.

**Lens test fixes — audited, not masking.** Spot-checked each `null` addition against its member
presence: every changed column is backed by a `presence: 'optional'` member (T_c optional vs T_b
mandatory in `lens-put-fanout`; Car_perf mandatory + Car_trim optional in the 3-member split, where
`maxSpeed integer` correctly stays NOT NULL while only `trim text null` changes). The tests' own read
assertions return `null` for those columns (`c: null`, `maxSpeed` for the perf-less car), confirming
they are genuinely nullable — the prover is correctly requiring the declaration to match, not being
silenced. Confirmed no changed column's intent was to assert NOT-NULL over an optional member.

**Docs — checked, already correct.** `docs/materialized-views.md:3` states the MV-indistinguishable-
from-the-plain-view invariant the bug violated; `docs/lens.md:362` already documents the
type/nullability conformance check the fix activates. No doc was stale — the fix brings code in line
with already-published contracts, so no doc edit was warranted.

**Observation, not a defect (no action).** `ProjectNode.withChildren` forwards the pre-rewrite
attributes as `predefinedAttributes` to preserve attribute-id stability. After a `left → inner`
rewrite below a project (`rule-inner-join-existence-recovery`), the forwarded attributes stay nullable
even though the new inner-join source strengthens them to non-nullable — a *completeness* (missed
strengthening) consideration, never a soundness one (over-nullable is conservative; the unsound
inner→outer direction has no rewrite). This is a pre-existing structural property of `withChildren`
(unchanged by this fix) and is unobserved across the full suite, so it is recorded here rather than
filed.

**Lint / build / tests.**
- `yarn lint` (packages/quereus): clean.
- Ran: `logic.spec.ts` (230 sqllogic files, incl. the new §31), `maintenance-equivalence.spec.ts` +
  `lens-advertisement.spec.ts` + `lens-put-fanout.spec.ts` (219), optimizer + planner + plan (2084).
  All green. The implement stage already ran full `yarn test` (5528 passing); my only change is the
  test-only sqllogic addition, which cannot affect other suites.
- **Deferred (unchanged from implement):** `yarn test:store` was not run (agent idle-time
  constraint). The change is planner-layer and store-agnostic, but a release-prep run should include
  it. No new pre-existing failures surfaced; `.pre-existing-error.md` was not written.

**Disposition:** core fix accepted as-is (no production-code changes needed); one minor test-coverage
gap fixed inline (right-join §31); no major findings → no new tickets filed.
