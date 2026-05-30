description: Lens prover + obligation classification + deploy report + read-only gate + Phase D auto-index retirement. The prover proves/blocks unsound logical-schema deploys (5 errors), surfaces advisory warnings, classifies every logical constraint into an enforcement obligation, and makes a non-reconstructible-PK table read-only. LIVE per-write enforcement of those obligations is the follow-up `lens-constraint-enforcement-wiring`.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/planner/building/view-mutation.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/lens-prover.spec.ts, packages/quereus/test/logic/55-lens-prover.sqllogic, docs/lens.md, docs/optimizer.md, docs/materialized-views.md
----

## What landed

The first, self-contained half of the prover capstone: **prove / block / classify / advise + read-only enforcement + auto-index retirement.** `proveLens(slot, db)` runs per logical table in the lens compiler's compile-first loop, producing:

- **5 blocking errors** (any ⇒ deploy blocks, aggregated + thrown atomically before catalog mutation): `lens.uncovered-column`, `lens.type-mismatch`, `lens.nullability-mismatch`, `lens.unrealizable-constraint`, `lens.non-invertible` (v1 enumerated stub — no new error yet).
- **Warning-severity diagnostics** that flow to the `LensDeployReport`: three advisories (`lens.no-backing-index`, `lens.no-answering-structure`, `lens.partial-override`) plus the read-only verdict `lens.pk-not-reconstructible`.
- **Per-constraint obligation classification** (`LensSlot.obligations`): `proved` / `enforced-row-local` / `enforced-set-level{row-time|commit-time}` / `enforced-fk` / `vacuous`.
- **`readOnly`** verdict: a non-reconstructible PK ⇒ read-only; reads resolve, mutations error at the lens boundary (`analyzeView` raises `lens-read-only`).
- **Phase D**: `MemoryTableManager.ensureUniqueConstraintIndexes` gated on `!isLogicalSchema()`.

The deploy report is persisted on `DeclaredSchemaManager` (`get/setDeployedLensReport`) — the stable hook the sibling `lens-advisory-acknowledgment` ticket consumes. The **live per-write enforcement** of the non-read-only obligations is deliberately deferred to `lens-constraint-enforcement-wiring` (in `implement/`, chained `prereq`).

Build, lint, and the full suite are green: **4033 passing** (4031 inherited + 2 review-added), 9 pending, 0 failing.

## Review findings

Approach: read the implement diff (`79b259f3`) with fresh eyes before the handoff; verified the load-bearing data-shape assumptions against the actual codebase; ran build + lint + targeted spec + full suite; added adversarial coverage for untested-but-shipped paths.

### Correctness — verified sound (no findings)
- **The load-bearing alignment assumption holds.** The prover's `outputIndex` / `isReconstructibleColumn` / `mappedBasisColumn` all index `compiledBody.columns[oi]` by non-hidden-provenance position. Confirmed the compiler (`compileDefaultBody` / `compileOverrideBody`) builds `composed` (→ `body.columns`) and the non-hidden `provenance` entries in lockstep, and that `deriveRelationBacking` already relies on the identical `nonHidden[i] ↔ body.columns[i]` pairing — so the prover's indexing is consistent with shipped code, not a new fragile assumption.
- **Every consumed type shape matches.** `UniqueConstraintSchema.columns` (table-column indices), `RowConstraintSchema.expr`, `PrimaryKeyColumnDefinition.index`, `ForeignKeyConstraintSchema`, `getReservedTagByTemplate(...).segment`, `proveEffectiveKeyUnique(root, outputColIndices)`, `getPlan() → PlanNode.getRelations()` — all checked against source.
- **Atomic-deploy contract intact.** Prover errors aggregate across all tables and throw before any catalog mutation. Added a regression test confirming a blocked deploy leaves **no** deploy report behind.
- **Read-only gate** correctly sits in `analyzeView` (the common entry for all three view-DML rewrites), matches only a logical schema's lens slot (no false-positive on ordinary view write-through), and blocks insert/update/delete while reads resolve — covered by spec + sqllogic.
- **Obligation seam is adequate for the follow-up.** `ConstraintObligation` carries the constraint + kind + set-level mode + covering-structure ref; combined with `slot.compiledBody` (for the logical→basis column mapping) and `slot.readOnly`, it is sufficient for `lens-constraint-enforcement-wiring` to route row-local / set-level / FK enforcement. The split is the right seam — the view-DML rewrite re-plans against the basis by name and drops the logical context, so live enforcement genuinely needs a deliberate threading mechanism, not a hook.

### Minor — fixed inline this pass
- **Type-laziness (`packages/quereus/src/schema/lens-prover.ts`).** `planBody` used `db.getPlan(...) as unknown as { getRelations(): ... }`. `PlanNode` already declares `getRelations()` and production code (`materialized-view-helpers.ts`) calls it with no cast. Removed the double-cast (AGENTS.md: "Don't be type lazy"). `RelationalPlanNode` import remains used by `ProveContext.root` and `planBody`'s return type.
- **Doc imprecision (module header).** Header said "three warnings"; four warning-severity diagnostics actually flow to the report (the read-only `pk-not-reconstructible` verdict is also a report warning, as the spec asserts). Corrected to "five errors + four warning-severity diagnostics (three advisories + the read-only verdict)".

### Test gaps — closed inline this pass (`test/lens-prover.spec.ts`, +2 → 17 passing)
- **PRIMARY KEY set-level path.** No prior test that a *primary key* (not just `unique`) routes to `enforced-set-level commit-time`, that the `no-backing-index` advisory is labelled for a primary key, or that a reconstructible-but-unproven PK stays **writable** (not read-only). Added (`enforced-set-level commit-time — a reconstructible PK the basis does not prove`).
- **Multi-error aggregation + atomicity.** No prior test that >1 blocking error aggregate into one `blocked by N error(s)` failure, nor that the blocked deploy leaves no report. Added.

### Considered — acceptable / deferred by design (no action)
- **`proveRoundTrip` no-op stub** is correctly encapsulated behind one swappable function; no round-trip-only failure shape slips through (non-invertibility is caught at mutation time by view-updateability; a non-reconstructible key by the read-only check). Computed-complement form is chained to `bx-operator-model-and-roundtrip-laws` + `view-mutation-plan-node-substrate`.
- **Graceful degradation when the body fails to plan** (skips plan-derived checks) is conservative — a non-planning body fails downstream at view registration / read; it never produces a *spurious block*. Accepted tradeoff.
- **Type/nullability leniency** is intentional and tuned to not false-block; numeric↔boolean compatibility is correct for SQLite storage. Temporal/OBJECT/collation tightening is a future concern, not a soundness gap here.
- **`collectColumnRefNames` reflective walk** has no visited-set, but CHECK expressions are acyclic trees, so no loop risk in practice; over-collection is bounded by the `logicalColIndex` membership guard. Not worth complicating.
- **Deploy report surfaced via the manager hook** (not `apply schema` result rows) is an adequate contract for the sibling ack ticket; converting the void `ApplySchemaNode` to relational is correctly deferred as high-blast-radius and orthogonal.

### Disposition
No **major** findings — no new tickets filed. The two downstream tickets already exist: `lens-constraint-enforcement-wiring` (live enforcement, `implement/`) and `lens-advisory-acknowledgment` (report consumption, `implement/3.1`). All minor findings and test gaps were resolved in this pass.
