description: The robustness net for comprehensive MV maintenance — extended the maintenance-equivalence harness over the formerly-rejected floor shapes (now SQL-reachable since the eligibility flip), drove the deferred-rebuild flush past round 1 (chain + diamond), pinned OR FAIL, swept the diagnostics rejects, aligned the timeless docs, and **fixed a real correctness bug the new coverage exposed** (OR FAIL left a full-rebuild MV stale). Implemented; build + `yarn test` + `yarn test:store` green.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/architecture.md, docs/materialized-views.md, docs/incremental-maintenance.md, tickets/backlog/known/5-view-lens-mv-future-enhancements.md
----

## What this ticket proves

The MV maintenance contract is `read(MV) == evaluate(body)` after every source mutation and after rollback, for **every** body shape — coverage is total because every shape no bounded-delta arm fits falls to the always-correct full-rebuild floor. This ticket makes "total coverage, never revisit" demonstrated rather than asserted: it extends the maintenance-equivalence property harness over the formerly-rejected floor shapes (end-to-end through real `create materialized view`, the path a user hits), drives the deferred-rebuild flush worklist past round 1 for the first time, pins OR FAIL, sweeps the diagnostics reject spec, and aligns the timeless docs.

## ⚠️ Scrutinize first: a real correctness fix in production code

The OR FAIL equivalence case exposed a genuine, newly-reachable bug (not a test artifact):

- **Symptom.** In an explicit transaction, `insert or fail into g values (10,9),(1,9),(11,11)` over a full-rebuild MV `select distinct v from g` kept the surviving row `(10,9)` in the source but left the MV backing at `[5]` while the live body was `[5,9]` — **`read(MV) != evaluate(body)` mid-transaction.**
- **Root cause.** `runWithStatementSavepoints` (`dml-executor.ts`) drains the deferred full-rebuild set only at the *end* of the row loop. OR FAIL runs with **no** statement-scope savepoint (it keeps prior rows), so a mid-statement conflict throws out of the loop *before* the flush — the surviving rows' full-rebuild MVs are dirtied but never rebuilt. (ABORT-class statements don't hit this: their statement savepoint unwinds everything, dirtied MVs included.)
- **Fix (12 lines).** In the inner `catch`, when there is no statement savepoint (⇒ FAIL mode) and the deferred set is non-empty, flush it before re-raising the conflict error. The failing row's own per-row savepoint already reverted its writes, so the rebuild re-evaluates over exactly the survivors. Re-throws the original conflict error after the flush.
- **Blast radius is tiny.** The new branch is a no-op unless a statement both (a) runs OR FAIL and (b) dirtied a full-rebuild MV. Every other statement leaves `deferredRebuilds` empty (full-rebuild MVs are the only deferred arm), so behavior is byte-identical. The bounded-delta arms are per-row-immediate, so a FAIL'd row's bounded-delta backing writes were already reverted by its per-row savepoint — the second OR FAIL test pins that a co-located inverse-projection MV stays consistent too.
- **Reviewer questions worth asking:** (1) Is re-raising the *conflict* error (not a flush error) the right precedence? I chose to let a flush failure supersede (a maintenance error is more severe and there's no statement savepoint to unwind to). (2) Autocommit OR FAIL flushes-then-rolls-back the implicit txn (wasted but harmless work) — acceptable? (3) Should `UPDATE OR FAIL` be covered? It is **not parsed** yet (architecture.md §Conflict Resolution), so only `INSERT OR FAIL` is reachable.

## Coverage added (all via real `create materialized view` + SQL writes)

The eligibility flip (`mv-eligibility-floor-fallthrough`, now complete) made `buildMaintenancePlan` route shape-mismatched bodies to `buildFullRebuildPlan`, so these create directly — confirmed by white-box `chosenStrategy === 'full-rebuild'` assertions, not assumed.

**`maintenance-equivalence.spec.ts`** (now 76 passing in-file; property suites use modest `numRuns` 25–50 + small batches for runner-idle safety):
- **SQL-created single-source floor zoo** (reuses the shared `src` mutation generator): DISTINCT, scalar (no-GROUP BY) aggregate, single-source UNION (set), order-by aggregate. Each: random insert / non-key update / key-changing update / delete + rollback; includes the empty-source edge (a scalar aggregate still yields its one global row).
- **Outer (left) 1:1 join** — `t.fk` nullable, no FK constraint, so rows null-extend (the row preservation the inner-join arm cannot do). Random both-source mutations + a deterministic null-extension check.
- **>2-source (3-way) join** `a⋈b⋈c` over a NOT-NULL FK chain — routes to the floor, indexed under all three bases; random mutations on every source with tolerated FK/RI violations.
- **Recursive-CTE transitive closure** over an `edge(src,dst)` graph — random edge churn over a 4-node space (cycles recur) + a deterministic "close the cycle → full 4×4 reachability" case.
- **Full-rebuild → full-rebuild CHAIN** (`distinct a,b` → `distinct a`) and **DIAMOND** (two distinct producers → one UNION consumer). These are the **only** shapes that drive `flushDeferredRebuilds` to **round 2** — asserted via an `instrumentFlushRounds` shadow of the private `assertFlushRounds` (was unverifiable while only single-round incremental↔floor drains were buildable). Both levels asserted equal to ground-truth source bodies, in-txn + rollback.
- **OR FAIL** over a floor MV (the bug-fix proof above) + a mixed floor-and-inverse-projection variant.
- **Negative self-test** (newly added — none existed): a deliberately wrong oracle body must make `assertEquivalent` red, so a degenerate harness can't pass green while testing nothing.

**`materialized-view-diagnostics.spec.ts`** (32 passing): the spec was already shape-reject-free; I added a 2-leg `union all` bag reject and an end-to-end `pragma nondeterministic_schema` floor-acceptance. The remaining create-time rejects are exactly the four non-shape ones (non-determinism, bag/no-key, no-output, size) + the size-pragma and determinism-pragma opt-outs. The fanning (non-1:1) join is pinned here as a **bag reject** (per `join-fanning-isset-overclaim`), deliberately *not* an equivalence-zoo case.

**`53-...-rowtime.sqllogic`** (file green): §27 FR→FR chain under SQL writes, §28 recursive-CTE closure under edge churn, §29 OR FAIL mid-statement abort (the end-to-end SQL proof of the fix — surviving rows reflected, rollback reverts in lockstep).

## Docs aligned (timeless)

- `architecture.md` — MV bullet rewritten: "ineligible bodies are rejected at create" → total coverage via the full-rebuild floor, the only rejects are non-shape.
- `materialized-views.md` — removed the stale "*that deferral is not yet wired*" clause (the flush deferral landed); documented the OR FAIL abort-path flush.
- `incremental-maintenance.md` — the fanning-`isSet` "Known gap" reframed as **resolved** (`join-fanning-isset-overclaim` landed → fanning join now routes to the bag reject); OR FAIL flush nuance; coverage-net test references.
- `5-view-lens-mv-future-enhancements.md` — "Richer incremental MV bodies" reframed from coverage-gap to **perf**: partial-WHERE joins are now a bounded-delta arm, the rest are floor-covered; what remains is bounded-delta arms (perf) and bag/multiplicity materialization (the one genuine reject).

## Honest gaps / deviations (verify these)

- **"union all-with-key" does not exist today.** The ticket listed `union all`-with-key as an equivalence-zoo case. Empirically, **every** `union all` variant — disjoint-WHERE legs, constant-discriminator (`select 1 as leg, …`) — is a **bag reject**: `keysOf` does not derive a unique key from a constant discriminator across legs. So union-all is covered as a *reject* in the diagnostics spec, and only `union` (a true set) is in the equivalence zoo. This is a grounded deviation from the ticket text, not an omission. If a keyed `union all` is later wanted, it needs `keysOf` to recognise a discriminator key first.
- **Outer-join backing `is null` read-path quirk (NOT chased — likely a separate, pre-existing issue).** `select id from mv where name is null` over the outer-join MV returns `[]` even though the null-extended row is physically present (the property full-compare passes). The maintained *data* is correct; a pushed-down `name is null` predicate appears to fold against the backing's lookup-column type (the outer-join lookup column may be typed non-nullable in the backing schema). I rewrote the deterministic assertion to read the row directly rather than via `where name is null`. **Worth a reviewer eye** — if the backing column nullability for outer-join lookup columns is genuinely wrong, that's a read-path correctness bug deserving its own fix ticket; I did not have evidence it affects maintenance and kept it out of scope.
- **Multi-round assertion is exact (`== 2`), not `>= 2`.** The chain/diamond round-count tests assert exactly 2 because the shapes are 2-level. A deeper chain would be a stronger stress; I kept depth 2 (the minimum that exceeds round 1) for clarity and runtime.
- **Property `numRuns` are modest.** 25–50 per suite to stay well inside the runner idle-timeout; seeds are fast-check-deterministic. A reviewer wanting more confidence can raise them locally — the recursive-CTE suite (30 runs) is the heaviest (closure recompute per assertion).
- **`forceFullRebuild` isolation suites retained.** The pre-existing swap-based floor suites still run (now a *cross-check*: the floor agrees with the bounded-delta arm for the same body); I updated their stale "not SQL-reachable yet" comments rather than delete them.

## Validation performed
- `yarn workspace @quereus/quereus run typecheck` — clean. `yarn lint` (src + test) — clean.
- Targeted: `maintenance-equivalence.spec.ts` 76 passing; `materialized-view-diagnostics.spec.ts` 32 passing; `53-materialized-views-rowtime.sqllogic` green.
- `yarn test` — **0 failing** (quereus package 5502 passing; whole monorepo green).
- `yarn test:store` — **0 failing** (5498 passing, 13 pending) — exercises the shared DML-executor FAIL path through the store module.
