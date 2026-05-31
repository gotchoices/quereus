description: Review the independent-channel singleton property law and the producer reconciliation it forced. A new forward-only law in test/property.spec.ts pins the two *independent* ≤1-row encoding channels — the declared empty key in `RelationType.keys` and the `∅ → all_cols` singleton FD in `physical.fds` — directly (not through `keysOf`), so it can fail on producer drift. Five leaf producers were reconciled to satisfy it (one — `TableLiteralNode` — was discovered by the law itself).
files: packages/quereus/test/property.spec.ts, packages/quereus/src/planner/nodes/pragma.ts, packages/quereus/src/planner/nodes/analyze-node.ts, packages/quereus/src/planner/nodes/declarative-schema.ts, packages/quereus/src/planner/nodes/single-row.ts, packages/quereus/src/planner/nodes/values-node.ts, docs/optimizer.md
----

## What shipped

### Design decision (option 1 — reconcile the producers)

The implement ticket offered two options. **Option 1 was taken**: make the producers that hand-declare the empty key also carry the matching singleton FD, then add a law over the two independent channels. Option 2 (weaken the law) would have re-degenerated into the existing tautology and was rejected.

Confirmed harmless / actually-fixes-a-gap before reconciling: the consumers that read `hasSingletonFd` **directly** (not via `keysOf`) — `characteristics.guaranteesUniqueRows` and `rule-join-greedy-commute.isSingleton` — were silently **missing** the ≤1-row-ness of `PragmaNode` / `AnalyzeNode(single)` / `ExplainSchemaNode` (they have ≥1 column and carried no FD, so the FD-only consumers returned false while `keysOf`/`isAtMostOneRow` returned true via the declared key). The reconciliation closes that latent inconsistency.

### The law (test/property.spec.ts, "Key Soundness" describe)

`checkIndependentSingletonChannels(label, node)` asserts the **forward** implication only:

> `declaredEmptyKey(node) && colCount > 0  ⇒  hasSingletonFd(node.physical?.fds, colCount)`

with `colCount === 0` as the documented carve-out (the FD has no dependents and is unrepresentable; the ≤1-row claim rides `estimatedRows`/`isSet`, as on `SingleRowNode`).

**The reverse (`FD ⇒ declared empty key`) is deliberately NOT asserted** — and this is the most important review point. The ticket's desired-behavior sketch wrote it as a "⟺", but the reverse is **not** a sound universal invariant: derived nodes (`FilterNode` over a covered key, `LIMIT 1`, scalar aggregate, full-PK seek, single-row VALUES, JOIN-of-two-singletons) add the singleton FD *physically* via `addSingletonFd` in `computePhysical` without rewriting their inherited *logical* `RelationType.keys` (which pass through from the source). So the FD channel is legitimately richer than the declared-key channel. Asserting the reverse universally would red on every one of those. The forward direction is the one with teeth against the exact drift the ticket targeted ("declare `keys: [[]]`, forget the FD" — the `PragmaNode` smoking gun).

Three tests:
- `singleton equivalence: …` — existing read-surface law, now **also** runs the forward independent-channel check over the corpus (vacuous today — no corpus query yields a ≤1-row producer — but a regression guard if the shape zoo grows).
- `the independent-channel check fails loudly on a declared-empty-key producer with no FD` — **negative self-test** (mirrors `checkNoOverClaim`'s self-test). Proves the law reds on injected drift, asserts the honest and zero-column cases pass. Without this, a green run could be vacuous.
- `independent singleton channels: a declared empty key implies the ∅→all_cols FD on leaf producers` — plans `pragma default_vtab_module`, `analyze ta`, `analyze`, `explain schema main`, `select 1`; runs the forward law on every relational node; then asserts **concrete per-producer witnesses** (both channels, both directions) — e.g. the `Pragma` node declares the empty key AND carries the FD, while bare `analyze` declares NEITHER. This is what gives the law teeth: removing the FD reconciliation from any producer reds the `fd` assertion.

### Producers reconciled

| Node | File | Change |
|---|---|---|
| `PragmaPlanNode` | pragma.ts | `computePhysical` emits singleton FD (read=1 row, write=0 rows, both ≤1). |
| `ExplainSchemaNode` | declarative-schema.ts | `computePhysical` emits singleton FD (1 row). |
| `AnalyzePlanNode` | analyze-node.ts | **Latent over-claim fixed.** Declared key is now conditional: `keys: targetTableName ? [[]] : []`. `computePhysical` emits the singleton FD only for the single-table form. Bare `ANALYZE` returns **one row per table** (a bag) yet previously hardcoded `keys: [[]]`, over-claiming ≤1-row. |
| `SingleRowNode` | single-row.ts | Comment-only — it is the zero-column carve-out (no FD possible). |
| `TableLiteralNode` | values-node.ts | **Discovered by the law.** `select 1` const-folds (Project-over-SingleRow) into a `TableLiteral` that *preserves the logical type* (`keys: [[]]`) but *drops the source's physical FDs*. `computePhysical` now re-emits the singleton FD when `rowCount <= 1` (mirrors `ValuesNode`). This producer was NOT in the ticket's `files:` list — the new law caught it on first run. |

### Docs
`docs/optimizer.md` "Singleton equivalence" paragraph extended with the independent-channel law, the forward-only rationale, the list of reconciled producers, and the conditional-ANALYZE note.

## Validation performed

- `yarn typecheck` (tsc --noEmit, src + test): clean.
- Full quereus mocha suite (`test/**/*.spec.ts`): **4133 tests, 4124 pass, 9 pending, 0 failures** (82s).
- `eslint` on all 6 changed files: clean.
- Teeth demonstrated empirically: the first run of the new targeted test **failed** on `TableLiteral[…] of 'select 1'` before that producer was reconciled — i.e. the law is not green-by-construction.

## What the reviewer should scrutinize (honest gaps)

1. **Reverse implication intentionally absent.** If you believe the codebase should *also* guarantee that physically-≤1-row nodes declare the empty logical key, that's a larger design change (it would require derived nodes to rewrite `RelationType.keys` in their logical type), not a test tweak. Today it would be unsound to assert. Decide whether the forward-only law is the right scope.

2. **Breadth of the producer walk.** The forward law is exercised with teeth only on the 5 targeted statements + the (vacuous) `ta`/`tb` corpus. A *new* node type that inherits the empty key but drops the FD would only be caught if it appears in the corpus or the targeted set. Consider whether more shapes (e.g. a query that wraps a ≤1-row producer in projections/joins) belong in the corpus. The `select 1` case already exercises the Project-inherited-empty-key + TableLiteral fold path.

3. **`estimatedRows` now set in `computePhysical`** for Pragma/Analyze/Explain/TableLiteral. Previously `physical.estimatedRows` was undefined for these → `PlanNodeCharacteristics.estimatesRows` fell back to `DEFAULT_ROW_ESTIMATE = 1000`. Now it reports the true 1/10. Minor cost-model accuracy improvement; full suite passed but worth a sanity check that no cost-based rule regressed on these statement types.

4. **New singleton FDs enable new optimizations.** A query over a ≤1-row Pragma/Analyze/Explain/TableLiteral result can now have DISTINCT/whole-Sort eliminated and be treated as a "preferred driver" by join-greedy-commute. All existing tests pass, but these statements are rarely sub-queried, so coverage of those new rewrites on *these specific nodes* is thin. No behavioral test was added that runs such a query end-to-end (e.g. `select distinct * from (select 1)`) — a reviewer-added behavioral guard would be reasonable.

5. **PRAGMA write mode** yields 0 rows and is wrapped in a `SinkNode` by `buildPragmaStmt`; the singleton FD on a 0-row relation is sound (0 ≤ 1) and `readonly` semantics were left untouched (out of scope). Confirm that's the intended boundary.

## Non-goals (unchanged)
No change to `keysOf` / `isUnique` / `hasSingletonFd` semantics — this is producer consistency + a stronger backstop, not a read-surface change.
