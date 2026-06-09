description: The robustness net for comprehensive MV maintenance — extended the maintenance-equivalence harness over the formerly-rejected floor shapes (now SQL-reachable since the eligibility flip), drove the deferred-rebuild flush past round 1 (chain + diamond), pinned OR FAIL, swept the diagnostics rejects, aligned the timeless docs, and fixed a real correctness bug the new coverage exposed (OR FAIL left a full-rebuild MV stale). Reviewed and completed.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/architecture.md, docs/materialized-views.md, docs/incremental-maintenance.md, tickets/backlog/known/5-view-lens-mv-future-enhancements.md
----

## What this ticket proved

The MV maintenance contract is `read(MV) == evaluate(body)` after every source mutation and after rollback, for **every** body shape — coverage is total because every shape no bounded-delta arm fits falls to the always-correct full-rebuild floor. This ticket made "total coverage, never revisit" demonstrated rather than asserted: it extended the maintenance-equivalence property harness over the formerly-rejected floor shapes (end-to-end through real `create materialized view`), drove the deferred-rebuild flush worklist past round 1 for the first time, pinned OR FAIL, swept the diagnostics reject spec, aligned the timeless docs, and fixed a genuine correctness bug (OR FAIL leaving a full-rebuild MV stale mid-transaction).

## The production fix (dml-executor.ts)

In `runWithStatementSavepoints`, the inner `catch` now flushes the deferred full-rebuild set on the OR-FAIL throw path (when there is no statement-scope savepoint and the deferred set is non-empty), before re-raising the conflict error. OR FAIL keeps the rows that already succeeded but runs with no statement savepoint, so a mid-statement conflict threw out of the row loop *before* the end-of-loop flush — leaving the survivors' full-rebuild MVs dirtied but never rebuilt (`read(MV) != evaluate(body)` mid-transaction). The failing row's own per-row savepoint already reverted its writes, so the rebuild re-evaluates over exactly the survivors. A no-op unless a statement both runs OR FAIL and dirtied a full-rebuild MV.

## Review findings

Adversarial pass over the implement diff (`2909ec46`), read fresh before the handoff. Aspect angles: SPP/DRY/modularity, type safety, error handling, resource cleanup, correctness, edge/error/regression/interaction coverage, doc accuracy.

### Production fix — verified sound (no change)
- **Re-raise precedence, drain idempotency, savepoint stack.** Traced the inner/outer catch interplay: the failing row's per-row savepoint is rolled back/released in the inner catch (`dml-executor.ts:385`) *before* control reaches the outer FAIL-path flush, so the rebuild reads only survivors. `flushDeferredRebuilds` drains the set (`deferred.clear()` per round), so post-throw the set is empty — no double-flush. `applyFullRebuild`'s `replace-all` is idempotent, so even the redundant re-flush path (end-of-loop flush throws → outer catch re-flushes residual re-dirties) is safe. The `stmtSavepointName` guard is reliable (always a non-empty string or `undefined`). The `finally { disconnectVTable }` ordering is correct (it disconnects the source vtab, not the backing-cache connections the flush used).
- **Non-conflict exceptions in FAIL mode** also route through the flush; harmless (survivors stay consistent whether the caller rolls back or continues).
- **Blast radius** confirmed minimal: the new branch is dead code unless a statement both runs OR FAIL and dirtied a full-rebuild MV (the only deferred arm); every other statement leaves `deferredRebuilds` empty → byte-identical behavior.

### Tests — verified, strong starting point
- Ran the targeted suites: `maintenance-equivalence.spec.ts` + `materialized-view-diagnostics.spec.ts` = **108 passing**; all `*.sqllogic` (230 files incl. §27–29 of file 53) green.
- Coverage spans happy path, edge (empty-source, null-extension, cycle-closing), error paths (OR FAIL abort, FK/RI-tolerated violations), regression (white-box `chosenStrategy === 'full-rebuild'` pins each shape routes to the floor, not a silently-absorbing bounded arm), and interactions (mixed floor + inverse-projection MV under OR FAIL; multi-round chain/diamond flush instrumented to `== 2`). The **negative self-test** (a wrong oracle must red) guards the harness from silently degenerating — a genuinely valuable addition.
- Property `numRuns` (25–50) are modest but seeds are deterministic; acceptable for runner-idle safety, raisable locally. No new gaps found in the test design.

### Docs — verified accurate against the code
- Read all four touched docs (`architecture.md`, `materialized-views.md`, `incremental-maintenance.md`, the backlog ticket) against the actual code. The OR-FAIL abort-path flush, the "total coverage / only non-shape rejects" reframing, the resolved fanning-`isSet` gap, and the perf-vs-coverage reframe of the backlog item all reflect reality. The stale "*deferral not yet wired*" clause was correctly removed. No drift left behind.
- Verified the honest deviation in the handoff: a *keyed* `union all` genuinely does not exist (every `union all` is a bag reject — confirmed by the diagnostics spec); only true-set `union` is in the equivalence zoo. Grounded, not an omission.

### Lint / typecheck — clean
- `yarn workspace @quereus/quereus run typecheck` clean; `yarn lint` clean; full `yarn test` = **5502 passing, 9 pending, 0 failing**.

### MAJOR finding → filed `fix/mv-outer-join-nullable-backing-isnull`
- The handoff flagged an outer-join `is null` read-path quirk as "NOT chased — likely pre-existing" and worked around it in the test by reading the row directly. **I chased it and it is a real read-path correctness bug**, not a benign quirk: an MV over a left/full outer join stamps the null-extended (lookup) backing column as `NOT NULL`, so `select … from mv where name is null` returns `[]` (should return the null-extended row) and `where name is not null` returns *all* rows. The maintained data is correct; the read-side `is null`/`is not null` *predicate folding* against the bogus backing NOT NULL is wrong — a violation of the "observably indistinguishable from the plain view" contract. Root-caused: the body root's `ProjectNode` reports the outer-join column as non-nullable (it re-resolves the column-ref to the base column's declared type, dropping the `nullable: true` that `buildJoinAttributes`/`buildJoinRelationType` correctly set on the join output); `deriveBackingShape` (`materialized-view-helpers.ts:91`) trusts that and declares the backing column NOT NULL. Scoped as MV-backing-specific (plain subquery/CTE/direct joins all evaluate `is null` correctly). Outside this ticket's diff (it lives in the create/type-derivation path, not the deferred-flush code), so filed as a `fix/` ticket with the minimal repro, the white-box root cause, the candidate fix sites, and acceptance criteria — rather than fixed inline.

### No other findings
- Resource cleanup, error handling, type safety (no `any` leakage in the new test helpers beyond the established white-box `as unknown as` shadow pattern already used in the file), and DRY (the new suites reuse the shared `mutationArb` / `assertEquivalent` / `readMultiset` helpers) are all in order. The `forceFullRebuild` isolation suites were correctly retained as a cross-check with refreshed comments. Nothing minor to fix inline.

## Follow-on work
- `fix/mv-outer-join-nullable-backing-isnull` — the read-path nullability bug above (the one substantive thing this review surfaced).

## Validation performed (review)
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn lint` (src + test) — clean.
- Targeted: `maintenance-equivalence.spec.ts` + `materialized-view-diagnostics.spec.ts` 108 passing; all 230 `*.sqllogic` files green.
- `yarn test` — 5502 passing, 9 pending, **0 failing**.
- (Did not re-run `yarn test:store`; the implementer validated it green and the FAIL path is exercised through the shared DML executor by the in-memory suite.)
