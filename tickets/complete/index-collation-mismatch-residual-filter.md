description: Access-path collation-cover fix. An IndexSeek over an index whose per-column collation differs from a predicate's effective comparison collation no longer consumes the predicate with no residual. The access-path rule now classifies the collation-cover relation and either keeps the seek + residual Filter (coarser equality index — a provable superset) or declines to a scan + residual (finer index, or any range/prefix/OR_RANGE mismatch). Reviewed and completed.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts          # The fix + collation-cover helpers
  - packages/quereus/test/optimizer/secondary-index-access.spec.ts                # 4 plan-shape + correctness tests
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic                  # restored + added collation assertions
  - docs/optimizer.md                                                             # Rule-catalog + Known-Issues notes
----

# Collation-mismatched index seek now retains a residual (or declines) — COMPLETE

## Summary of the landed change

`selectPhysicalNodeFromPlan` / `selectPhysicalNodeLegacy` in `rule-select-access-path.ts`
previously treated a module-"handled" seek constraint as a complete substitute for the
predicate, ignoring collation. A NOCASE secondary-index seek was therefore emitted for a
BINARY `name = 'BOB'` with no residual Filter and over-fetched every collation-equal row
(`'BOB'` and `'Bob'`). The fix adds collation-cover analysis (helpers at the bottom of the
file) that, per consumed seek constraint, classifies the index-column vs predicate-effective
collation as `MATCH` / `COARSER_SAFE` / `MISMATCH_UNSAFE` and aggregates a decision:

- **MATCH** → use the seek, no residual.
- **COARSER_SAFE** (BINARY equality over a non-BINARY index — a provable superset) → keep the
  seek, re-apply the original predicate as a residual `Filter`.
- **MISMATCH_UNSAFE** (finer index that under-fetches, or any range/prefix/OR_RANGE mismatch
  that reorders the walked window) → decline the seek, fall back to a `SeqScan` + residual.

The key correctness invariant: `effectivePredicateCollation` reads the **same**
`getType().collationName` that the runtime emitters (`emitComparisonOp`, `emitIn`,
`emitBetween`) read, with the same right→left precedence — so plan-time classification and
runtime evaluation can never disagree about a predicate's effective collation.

## Review findings

### What was checked

- **Read the implement diff first** (commit `7ca2f08e`) with fresh eyes before the handoff
  summary, then the current source, the runtime emitters it claims to mirror, the constraint
  extractor, and the scalar plan nodes (`BinaryOpNode`/`InNode`/`BetweenNode`/`CollateNode`/
  `LiteralNode`).
- **Plan/runtime collation parity** — verified `effectivePredicateCollation`'s
  `BinaryOpNode` (right ?? left ?? BINARY) and `InNode` (condition ?? BINARY) arms exactly
  mirror `emitComparisonOp` and `emitIn`. Confirmed the whole feature is *self-consistent by
  construction*: it classifies cover off the same `getType()` values the runtime residual is
  later evaluated against, so even if a column's declared collation failed to propagate, plan
  and runtime would agree and the residual would still be correct.
- **`COARSER_SAFE` soundness** — only `isEquality && predColl==='BINARY' && indexColl!=='BINARY'`
  qualifies; a BINARY equality is equal under any coarser collation, so a non-BINARY index is a
  superset an equality residual recovers. NOCASE/RTRIM are mutually incomparable and a finer
  index under-fetches — correctly classed UNSAFE.
- **Residual dedup** — verified both constraints synthesized from one `BETWEEN` carry the
  *same* `sourceExpression` node (`constraint-extractor.ts:471,480`), so
  `combineResidualExpressions`' identity-dedup is correctly motivated and collapses them to one.
- **Leaf substitution** — `selectPhysicalNode*` now returns `RelationalPlanNode` (a `FilterNode`
  when a residual is added); both callers compose it correctly (grow path stacks the module
  residual on top; non-grow path substitutes via `rebuildPipelineWithNewLeaf`).
- **Docs** — `docs/optimizer.md` rule-catalog + Known-Issues entries read accurately against
  the landed behavior.
- **Build / lint / tests** — `yarn build` clean; `eslint` on the changed source clean; full
  memory suite **5239 passing, 9 pending, 0 failing**.

### What was found and done

- **MINOR (fixed inline)** — Refined the misleading comment on `effectivePredicateCollation`'s
  `BetweenNode` arm. The original implied bounds are "bare literals" as an incidental fact; the
  reviewed reality is that a `COLLATE` on a BETWEEN bound is *dropped before this rule runs*
  (folding/extraction), so the expr-only read is in fact the correct and only reachable choice.
  An earlier attempt to broaden this arm to `expr ?? lower ?? upper` (mirroring `emitBetween`)
  was reverted as inert — the bound collation never reaches plan-rule time. Net source change
  is comment-only; logic is identical to the implemented version. Suite re-confirmed green.

- **MAJOR (new ticket filed: `tickets/fix/collate-on-between-bound-dropped.md`)** — While
  probing the BETWEEN angle, found a **pre-existing, index-independent** correctness bug:
  `select id from t where name between 'bob' collate NOCASE and 'bob'` returns `[]` (expected
  `[2,4]`) **even with no index** — a plain `SeqScan` + `Filter(BetweenNode)`. The COLLATE on
  the bound is silently dropped, so that comparison evaluates under BINARY. The equivalent
  expr-side (`name collate NOCASE between …`) and desugared (`>= … collate NOCASE and <= …`)
  forms both return the correct `[2,4]`. This is in constant folding / `emitBetween` collation
  resolution, **not** the access-path collation-cover code this ticket touched, so it is filed
  separately rather than fixed here. The ticket notes the follow-on: once that fold is fixed,
  the BETWEEN arm of `effectivePredicateCollation` and the trailing-range seek extraction
  should be revisited so a bound-collated BETWEEN over a collated index classifies correctly.

### Categories explicitly clear

- **Type safety / lint** — clean (`RelationalPlanNode` broadening removed two `as unknown as`
  casts; no `any` introduced).
- **DRY / modularity** — the cover logic is small single-purpose functions, correctly placed in
  the rule (not duplicated per vtab module). No duplication found.
- **Resource cleanup / error handling** — N/A; this is pure plan rewriting (no resources, no
  swallowed exceptions). Declines `log()` their reason.
- **Regression coverage** — the restored `06.4.2` assertions + the 4 new optimizer specs cover
  coarser-keep, matching-no-regression, range-decline, and finer-decline; the full suite is
  green, so no existing behavior regressed.

### Implementer-flagged gaps — disposition

- **Non-grow double-filter** — confirmed correct (redundant Filter, harmless). Not exercised by
  any current test; left as a documented perf nit, not a correctness issue. No action.
- **Legacy PK collation path** — reasoned-but-test-dark (memory module routes through the
  module path; PK text columns with non-BINARY collation are rare). Logic mirrors the secondary
  path and is sound on inspection. Left as-is; not worth a synthetic harness.
- **OR_RANGE effective collation** — accepted: a BINARY column yields BINARY (MATCH, no
  regression — `or-multi-range-seek` green); a collated column yields a value that drives a
  *safe* decline. No wrong-result path. No action.
- **BETWEEN over a collated index** — investigated directly (see MAJOR above); the only real
  issue there is the separate folding bug, now ticketed.

## Out of scope (unchanged)

- The create path / persistence emitter (handled by `index-explicit-column-collate-apply-path`).
- Pushing collation logic into any vtab module (kept in the rule by design).
- The BETWEEN-bound COLLATE folding bug (now its own fix ticket).
