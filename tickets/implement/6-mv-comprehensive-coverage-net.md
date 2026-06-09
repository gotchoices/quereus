description: The robustness net for comprehensive MV maintenance — extend the maintenance-equivalence property harness over every formerly-rejected body shape (the proof that no shape is a coverage gap), finish the companion timeless docs (architecture.md, future-enhancements backlog), and do the diagnostics sweep.
prereq: mv-join-where-widening
files: packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, docs/architecture.md, docs/incremental-maintenance.md, tickets/backlog/known/5-view-lens-mv-future-enhancements.md
----

The earlier tickets make every body maintainable; this one *proves* it and aligns the remaining docs. The maintenance-equivalence harness is the contract: over a zoo of body shapes and random source mutation batches, `read(MV) == evaluate(body)` must hold after every batch and after rollback. Extending it across the formerly-rejected shapes is what makes "comprehensive, never revisit" real — coverage is demonstrated, not asserted shape-by-shape.

**Harness zoo extension** (`test/incremental/maintenance-equivalence.spec.ts`). Add body shapes that now route through the full-rebuild floor or the widened join arm:
- fanning (non-1:1) inner join; outer (left) 1:1 join;
- 2-leg `union` and `union all`-with-key... (only keyed/set bodies — a true bag body is a *reject*, tested separately);
- a small recursive CTE;
- a >2-source join;
- a scalar (no-GROUP BY) aggregate;
- partial-`WHERE` 1:1 joins (T-only, P-referencing, both-sides);
- MV-over-MV chains that **mix** a full-rebuild producer with an incremental consumer (and vice-versa).
- A **full-rebuild → full-rebuild** chain (and, if constructible, a full-rebuild *diamond* — one full-rebuild consumer over two full-rebuild producers). This is the only shape that drives `flushDeferredRebuilds` past **round 1**: until the eligibility flip (ticket `mv-eligibility-floor-fallthrough`) makes full-rebuild SQL-reachable, the flush-deferral ticket could only exercise single-round drains (incremental↔full-rebuild), so the multi-round worklist convergence and the `assertFlushRounds` bound are currently unverified by any test. Assert convergence at every level.
- A **FAIL-mode** (`or fail`) bulk statement over a full-rebuild MV: the flush runs after the row loop with no statement savepoint, so a mid-statement abort keeps prior rows and the flush still rebuilds correctly. (Untested end-to-end while full-rebuild is SQL-unreachable.)
For each: random insert/update/delete batches on every participating source, asserting `read(MV) == evaluate(body)` each batch and after a rolled-back batch. Keep the harness's negative self-test (a deliberately wrong oracle must red) so the net can't silently degenerate.

**Reject coverage** (`materialized-view-diagnostics.spec.ts`). Confirm the *only* create-time rejects remaining are the four non-shape ones: non-deterministic body (no opt-out), bag / no-unique-key body, no-relational-output body, and full-rebuild-only-over-threshold; plus the pragma-disable acceptance. Remove/repoint every stale *shape* reject assertion.

**Companion timeless docs.**
- `docs/architecture.md` — update the Materialized Views design bullet and the Constraints note ("ineligible bodies are rejected at create" → total coverage via the full-rebuild floor; the only rejects are non-shape).
- `docs/incremental-maintenance.md` — final consistency pass so it matches `docs/materialized-views.md` (the authoritative spec) end-to-end.
- `tickets/backlog/known/5-view-lens-mv-future-enhancements.md` — strike the now-resolved items from "Richer incremental MV bodies" (partial-WHERE join bodies, outer/fanning joins as *coverage* gaps); leave the genuine futures (bounded-delta arms for floor-covered shapes as *perf*; bag/multiplicity materialization; post-commit-for-heavy; statement-level op-coalescing for incremental arms).

## Edge cases & interactions
- **Harness scale/runtime**: more shapes × random batches can lengthen the suite — keep batch counts modest and seeds deterministic; the suite must finish well inside the runner idle-timeout. Stream output if long (`yarn test 2>&1 | tee`).
- **Rollback assertions**: every shape must also be checked after a rolled-back mutation batch (the backing reverts in lockstep) — the floor's transactional `replace-all` is the riskiest here.
- **MV-over-MV mixed-arm convergence**: the trickiest oracle case — a deferred (full-rebuild) producer feeding an incremental consumer only reconciles at flush; assert final equivalence, not mid-statement state.
- **Bag body is a reject, not an equivalence case**: do not add a no-unique-key body to the equivalence zoo — add it to the diagnostics spec as a reject.
- **Doc drift**: treat all MV docs as out-of-date until read; `materialized-views.md` is the source of truth, the others conform to it.

## TODO
- Extend the equivalence harness zoo with the shapes above (floor-maintained + widened-join), random batches + rollback checks; preserve the negative self-test.
- Sweep `materialized-view-diagnostics.spec.ts`: only the four non-shape rejects + pragma-disable acceptance remain.
- Add representative `-- error:` / acceptance cases to §53 for any not covered by earlier tickets.
- Update `docs/architecture.md` (MV bullet + Constraints note) and finish `docs/incremental-maintenance.md`.
- Strike resolved items from `tickets/backlog/known/5-view-lens-mv-future-enhancements.md`.
- Run `yarn test` and `yarn test:store`; both green.
