description: COMPLETE. Behavior-neutral DRY + invariant-pinning over the ≤1-row (singleton) FD machinery: five `computePhysical` producer sites fold the `∅→all_cols` singleton through one `addSingletonFd` helper, the node-level at-most-one-row predicate has one spelling (`isAtMostOneRow` = `isUnique([])`), and a "Singleton equivalence" property law walks the optimized tree. Reviewed adversarially; no behavior bugs; misleading law framing corrected inline; follow-up filed for a law with real teeth.
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/values-node.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md
----

## What shipped (as implemented)

- **Phase A — producer DRY.** New `addSingletonFd(fds, columnCount)` in `fd-utils.ts` folds `singletonFd(columnCount)` into `fds` via `addFd` (no-op copy when `columnCount === 0`). Replaced open-coded `singletonFd` + `addFd` at five `computePhysical` sites: `aggregate-node` (scalar branch), `filter` (covered-key ⇒ ≤1-row), `limit-offset` (constant LIMIT ≤ 1), `table-access-nodes` (full-PK seek), `values-node` (rows ≤ 1). `singletonFd` is now referenced **only** inside `addSingletonFd` — DRY is complete.
- **Phase B — predicate alias.** New `isAtMostOneRow(rel)` = `isUnique([], rel)`. Migrated `key-utils.analyzeJoinKeyCoverage` (`left/rightIsSingleton`) and the whole-Sort-elimination guard in `rule-orderby-fd-pruning`. Deliberately left `rule-join-greedy-commute.isSingleton` and `characteristics.guaranteesUniqueRows` alone (both carry a zero-column `estimatedRows === 1` fallback `isUnique([])` cannot express) — verified correct.
- **Phase C — "Singleton equivalence" property law** in the Key Soundness block of `test/property.spec.ts`; pure static walk over every relational node.
- **Phase D — docs** in `docs/optimizer.md` (FD helper catalog + Singleton-equivalence paragraph).

## Review findings

Reviewed the implement diff (`68038bf8`) adversarially across SPP / DRY / modularity / type-safety / resource-cleanup / error-handling / test-coverage / docs-currency angles, re-derived the helper algebra by hand, and ran the full gate.

### Checked and verified sound (no change needed)
- **DRY completeness.** Grep confirms `singletonFd` is referenced only inside `addSingletonFd`; all five producer sites migrated. Scope-boundary exclusions (`rule-join-greedy-commute.isSingleton`, `characteristics.guaranteesUniqueRows`) correctly left alone — their zero-column `estimatedRows === 1` fallback is genuinely inexpressible via `isUnique([])`.
- **`mergeFds` → `addFd` equivalence** (limit-offset migration). Verified: `addFd` never mutates its `fds` argument (builds a fresh `result`), and `mergeFds(a, [s]) = addFd(a.slice(), s)`, so `addSingletonFd(a, n)` is byte-identical to the prior `mergeFds(a, [singleton])`. ✓
- **Zero-column `[] ` vs `undefined` divergence** (handoff concern #1). For the theoretical zero-column case, `limit-offset` / `table-access` now yield `fds: []` where the old guards left `undefined`/`base.fds`; `aggregate`/`values` preserve `undefined` via an explicit `length > 0 ? … : undefined`. Confirmed behaviorally inert — every consumer treats `[]` and `undefined` identically (`fds ?? []`, `.length`, `hasSingletonFd` false for both) — and zero-column LIMIT/seeks do not occur in practice. **Accepted as-is**; not worth re-guarding against the DRY win.
- **Type safety / cleanup / error handling.** No `any` introduced, no swallowed exceptions, no resources to clean up (pure functions + a static plan walk). Helper placement and JSDoc are consistent with the surrounding fd-utils surface.

### MINOR — fixed inline this pass
1. **The "Singleton equivalence" law is green-by-construction and was mis-described as a producer guard.** The three channels are derivation-linked: `keysOf` pushes `[]` whenever `hasSingletonFd` is true, and `isAtMostOneRow` (= `isUnique([])`) reads its truth back out of `keysOf`. Algebraically `isAtMostOneRow ⟺ keysOf-has-empty ⟺ (declared-empty-key ∨ singleton-FD)`, so **both** asserted implications are tautologies on today's read surface — the law cannot be falsified by any plan or producer, only by a future refactor of `keysOf`/`isUnique`/`hasSingletonFd` that breaks their wiring. Concretely, `PragmaNode` (2 columns) and `SingleRowNode` encode ≤1-row via a *declared* `keys: [[]]` with **no** FD — the exact "empty key without matching FD" case the original comment claimed to catch — and they pass silently. Corrected the law comment in `property.spec.ts`, the `docs/optimizer.md` Singleton-equivalence paragraph, and the `isAtMostOneRow` JSDoc to state the true scope (read-surface regression guard, not a producer check).
2. **Stale in-file comment** in `rule-orderby-fd-pruning.ts:16` still read `isUnique([], source)` after the code migrated to `isAtMostOneRow(source)` — updated.
3. **`isAtMostOneRow` JSDoc imprecision** — "a zero-column relation has no representable empty key" was wrong (`SingleRowNode` is zero-column yet has a declared empty key, so `keysOf` surfaces `[]`). Reworded to "known *only* via `estimatedRows === 1` … a zero-column relation cannot carry the singleton FD."

### MAJOR — filed as new ticket
- **`tickets/backlog/singleton-channel-independent-law.md`** — give the equivalence law real teeth by pinning the *independent* channels (declared empty key in `RelationType.keys` ⟺ singleton FD in `physical.fds`, with the documented `colCount === 0` carve-out). Carries an open design question (reconcile `PragmaNode`/`analyze-node`/`declarative-schema` to emit the FD via `addSingletonFd`, vs. accept declared-key-only) because those producers violate the stronger invariant today. Backlog rather than fix/plan because the current law is harmless and this is a backstop enhancement, not a defect, and it needs a human design call. Also worth verifying there: whether any consumer reads `hasSingletonFd` *directly* (bypassing `keysOf`) and thus currently misses those nodes' ≤1-row-ness.

### Negative self-test (handoff concern #2) — intentionally not added
The implementer flagged the absence of a negative self-test (à la "the soundness check fails loudly on an injected over-claim"). Confirmed such a test is **impossible** for `checkSingletonEquivalence`: because both implications are tautologies over the real `keysOf`/`isUnique`/`hasSingletonFd` (which the checker calls on the node directly), no node or stub data can make the channels disagree — falsifying it would require mocking fd-utils itself. This is itself evidence for finding #1 and the follow-up ticket; documented rather than papered over with a stub.

## Validation
- `yarn workspace @quereus/quereus run typecheck` → exit 0.
- `eslint` on all changed source + test files → exit 0.
- Focused `property.spec --grep "singleton equivalence"` → 1 passing.
- Full quereus suite (`yarn workspace @quereus/quereus run test`) → **3949 passing, 9 pending**, exit 0.
- `test:store` not run — diff is planner/test/docs only, no storage code path touched (matches implement-stage rationale).

## Non-goals (unchanged)
No new `Singleton` type; no `keysOf`/`isUnique` semantic change; lens `primary key ()` path and `TableLiteralNode` untouched.
