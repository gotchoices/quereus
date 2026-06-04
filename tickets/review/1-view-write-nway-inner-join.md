description: Review the n-way generalization of the multi-source inner-join write-through substrate — lifting the 2-table / single-column-PK cap to n-way (≥2) inner equi-joins, composite-PK identification, and self-joins. Inner-join only; outer joins, cross-source `set`, and composite shared-key insert stay deferred.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What landed

The multi-source write-through substrate (`multi-source.ts`) was capped at exactly **two distinct base tables, single-column PK per side**. It is now an **n-way (≥2) inner equi-join** path that also admits **composite-PK sides** and **self-joins** (one base table under ≥2 distinct aliases), for `update` / `delete` write-through. The generic shape threads `readonly JoinSide[]` (length ≥2) end to end; routing is keyed by side index `0..n-1`.

### Core changes (`multi-source.ts`)

- `JoinViewAnalysis.sides`: `[JoinSide, JoinSide]` → `readonly JoinSide[]`.
- **Self-join enumeration** (`resolveSourceTableRef`): each AST source's *alias* maps to its planned `TableReferenceNode` by resolving the alias-qualified PK column through the join's combined scope → producing attribute → owning ref (via an `attrId → TableReferenceNode` inversion), **not** by table name. Column→side routing stays id-driven (`sideByTableId`), so it already survived; only source enumeration needed the fix.
- **Composite keys**: `requireSingleColumnPk` → `requireKeyColumns` (returns the side's PK columns, ≥1). The identity capture projects one column **per side per PK column**, named `k<side>_<j>` (`keyColumnName`, replacing the `MS_UPDATE_KEY_COLUMNS = ['k0','k1']` constant). The per-side identifying predicate switched from `<pk> in (select k<side> …)` to a **correlated EXISTS** matching all PK columns (`buildCapturedKeyPredicate`), reusing the UPDATE-RETURNING correlation shape (one pattern). `buildMultiSourceKeyCapture`, `makeMultiSourceKeyRef` (already generic), and `buildMultiSourceUpdateReturning` widened to the flattened shape; the RETURNING EXISTS now correlates **every** side × PK column.
- **n-way FK ordering**: `orderSides` is now an FK **topological sort** (parent before child, source order within an FK-equivalence class; a self-join's mutual edges cycle-break to alias-declaration order). `fkChildIndex` returns `undefined` for length ≠ 2 (the binary FK-child concept doesn't generalize); `anchorSideIndex` = topo head.
- **`stripSideQualifier`** now rejects refs to **any** other side (owning quals checked first, so a self-join's owning-alias ref still strips).
- **`collectInnerJoinSources`** accepts ≥2 inner tables + self-joins + ON/USING; **`extractJoinKeyColumns`** (insert only) walks all ON conjuncts + USING across nested joins via `collectCrossSideEqualities`, union-finds a single shared-key EC, one key column per side. Composite shared key → `unsupported-decomposition-key`; a chain (disjoint key classes) → `unsupported-join`.
- **DELETE**: two-side ON-DELETE / mutual-FK plan-time analysis is gated on `analysis.sides.length === 2 && chosen === 2` and is **deliberately not generalized**; an n-way fan-out orders chosen sides by the topo sort and defers any mutual-FK cycle to the runtime RESTRICT pre-check.

### Builder + static surfaces

- `view-mutation-builder.ts`: `buildIdentityCapture` captures **all** sides for an UPDATE with RETURNING (was `[0,1]`); `capturedSideIndices` already side-id-driven.
- `view-mutation-node.ts`: `IdentityCapture` doc updated off the stale `(k0,k1)` shape.
- `func/builtins/schema.ts`: `isDecomposableJoinBody` widened to ≥2 inner tables + self-joins + composite PK + ON/USING (the boolean shadow of `collectInnerJoinSources`), so `view_info` / `column_info` agree with the now-wider dynamic acceptance. Comments updated.

## Use cases to validate (the acceptance gate)

`test/property.spec.ts` § View Round-Trip Laws → `describe('multi-source inner join')` — **3 new property tests** (all green):
- **Composite-PK inner join** (`cpv`, both sides 2-col PK): PutGet + GetPut + plan-lineage agreement.
- **n-way (3-table) inner join** (`n3v`, anchor + 2 FK-children sharing a key): one update touches each member, FK-ordered base ops; PutGet + lineage.
- **Self-join** (`sjv`, `t a join t b on b.id = a.fk`): per-alias routing serialized in alias-declaration order, each observing the prior (a self-referencing row ends at the later op's value); PutGet + lineage.

Flipped negatives (now accept): `rj_comp` / `rj_self` in the reject-don't-widen test; the composite-PK-RETURNING block in `93.2-view-mutation-pending.sqllogic`; the 3-table / self-join cases in `93.4-view-mutation.sqllogic`; the `xj_three` / `xj_self` rows in `06.3.4-view-info.sqllogic` and `three_v` / `self_v` in `06.3.5-column-info.sqllogic` (now `is_updatable=YES` with traces).

Still **rejecting** with the precise diagnostic (verify these stay red): outer-join body (`unsupported-join`), `select *` join (`unsupported-join`), cross-source `set` (`cross-source-assignment`), composite shared-key insert (`unsupported-decomposition-key`), n-way mutual-FK delete cycle → runtime pre-check (no plan-time reject).

## Validation performed

- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus test` — **4593 passing**, 9 pending.
- `yarn workspace @quereus/quereus lint` — clean.

## Known gaps / where to scrutinize (honest)

- **n-way INSERT is not positively tested.** The insert tests are all 2-table. `extractJoinKeyColumns` generalizes to n sides (union-find over cross-side equalities → one shared-key EC), but only the **star** shape (all members share one key value) can thread the single-column envelope; **chains reject** (`unsupported-join`) and composite shared keys reject (`unsupported-decomposition-key`). A reviewer should decide whether an n-way star-insert positive test (or an explicit chain-insert reject test) is warranted, and confirm `anchorSideIndex` (= topo head) seeds the right surrogate for n>2.
- **n-way DELETE fan-out is not tested.** For >2 chosen sides the lenient default fans out to *every* candidate side (`fkChildIndex` is undefined for n>2), ordered by the topo sort, deferring mutual-FK cycles to runtime. No property/sqllogic test exercises a 3-table delete; the two-side delete suite is unchanged and green.
- **USING-join key extraction** is best-effort (`collectCrossSideEqualities` resolves the owning side under each operand) and untested — no test creates a USING-bodied join view. Update/delete don't need it (they use the PK); only insert does.
- **Self-join updating a PK column**: the flipped `rj_self` (`set cc2 = 9` where `cc2 = b.cc`, a PK) succeeds. Updating a PK through the view is admitted (identity captured pre-write, predicate-scan base op); a reviewer may want to confirm this is the intended contract vs. the docs' note that "an update that changes a base PK breaks the captured identity" (that note concerns RETURNING re-query identity, not the base write itself).
- **Self-join enumeration depends on the inner join preserving base attribute ids up to its output** (true on the logical tree the substrate plans). If a future change altered that preservation, `resolveSourceTableRef` would misroute — it asserts a `ColumnReferenceNode` resolves and its `attributeId` is in `attrToTableRef`, else raises `no-base-lineage`.
- **`effective_targets` for a self-join collapses to one base name** (deduped by table name in `view_info`), while the substrate routes by two distinct scans. Confirm this is the intended surface contract.
- **Composite-PK with a partial-key predicate** (e.g. `where c1 = 1` on PK `(c1,c2)`) binds *every* matching composite row — verified in `93.4` (`ax_jv_comp`). Confirm this fan-out is desired (it is the predicate-honest reading).
