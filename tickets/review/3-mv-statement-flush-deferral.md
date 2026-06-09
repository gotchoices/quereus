description: Review the per-statement deferral of full-rebuild MV maintenance — full-rebuild plans are marked dirty per source row and rebuilt once at an end-of-statement flush (inside the statement-atomicity savepoint); bounded-delta arms stay per-row-immediate.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md, docs/materialized-views.md, docs/runtime.md
----

## What landed

Full-rebuild MV maintenance is now **deferred to a once-per-statement flush** instead of run per source row (which would be O(rows × body)). The bounded-delta arms (`inverse-projection` / `residual-recompute` / `prefix-delete` / `join-residual`) are unchanged — they stay **per-row-immediate**, which the covering-UNIQUE enforcement scan depends on. Deferring full-rebuild is safe against that invariant because a full-rebuild MV is **never a covering structure** (`lookupCoveringConflicts` reads only `'inverse-projection'` backings).

### Threading (`database-materialized-views.ts`)
- `maintainRowTime(sourceBase, change, cache?, deferred?, depth=0)` — added `deferred?: Set<string>` (MV keys) **before** `depth`. When a plan is `'full-rebuild'` **and** `deferred` is provided, the MV key is added to `deferred` and the per-row apply is skipped (`continue`). The cascade recursion threads `deferred` through. Without `deferred` (cold callers), a full-rebuild plan falls through to an inline rebuild (safe, unamortized fallback — never actually reached, since cold callers are enforcement/eviction and full-rebuild MVs aren't covering structures).
- `flushDeferredRebuilds(deferred, cache?)` — new. Drains the dirty set as a **round-based worklist** over the producer→consumer DAG: each round snapshots the set, clears it, calls `applyFullRebuild` on each member, and routes the realized `BackingRowChange[]` back through `maintainRowTime(backingBase, bc, cache, deferred)` — a full-rebuild consumer re-dirties into the next round, an incremental consumer applies inline. `assertFlushRounds` caps rounds at `rowTime.size + 1` (cycle backstop; should never fire — the DAG is acyclic).

### Database surface (`database.ts`)
- `_maintainRowTimeCoveringStructures(...)` gained an optional `deferred?` param, threaded to `maintainRowTime`.
- `_flushDeferredRebuilds(deferred, cache?)` — new, delegates to the manager. (`DatabaseInternal` is unchanged — cold callers still use the two-arg form.)

### DML executor (`dml-executor.ts`)
- Each runner (`runInsert` / `runUpdate` / `runDelete`) creates one `deferredRebuilds = new Set<string>()` per statement alongside its `backingConnCache`.
- `deferredRebuilds` is threaded through `processInsertRow` / `processUpdateRow` / `processDeleteRow` / `processEvictions` and every `maintainRowTimeStructures` call.
- `runWithStatementSavepoints` gained `deferredRebuilds` + `backingConnCache` params and calls `_flushDeferredRebuilds` **after the row loop and before the statement-savepoint release** (inside the inner `try`, so a flush failure routes to the savepoint rollback). No-op when the set is empty.

## How to validate

- **Build / lint / tests:** `yarn build` (clean), `yarn eslint ...` on the four changed source/test files (clean), full `yarn test` (quereus **5440 passing**, all other packages green).
- **Focused spec:** `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/incremental/maintenance-equivalence.spec.ts"` — 41 passing.
- **Focused sqllogic:** `... mocha.js "packages/quereus/test/logic.spec.ts" --grep "53-materialized-views-rowtime"`.

### Test coverage added (`maintenance-equivalence.spec.ts`)
Full-rebuild is **not reachable via SQL yet** (the builder never routes to `buildFullRebuildPlan` — the eligibility flip is a later ticket), so all full-rebuild coverage is white-box via the pre-existing `forceFullRebuild` helper, now plus an `instrumentRebuilds` helper that patches the manager's `applyFullRebuild` to count actual rebuilds:
- **one-rebuild-per-bulk-statement** — a 5-row INSERT (and bulk UPDATE/DELETE) over a full-rebuild MV rebuilds it **exactly once** (counter asserts `=== 1`), not per row.
- **rollback leaves backing unchanged** — a multi-row statement whose 2nd row collides on the source PK aborts; counter `=== 0` (flush never ran), MV backing **and** source equal their pre-statement state, and maintenance still works after.
- **explicit-txn rollback** — a deferred rebuild is visible mid-transaction and reverts on `rollback`.
- **autocommit flush+commit** — two consecutive bare-autocommit inserts both persist (no orphaned pending backing layer).
- **mixed-arm same source** — one source feeding an inverse-projection MV (per-row) and a full-rebuild MV (one flush); both stay equal to their live bodies, rebuild counter `=== 1` per statement.
- **incremental-producer → full-rebuild-consumer** (2-level MV-over-MV) — the converse of the pre-existing full-rebuild-producer→incremental-consumer suite; the consumer rebuilds at flush after the producer's inline write lands (reads-own-writes at flush).

The pre-existing full-rebuild suites (single-source, body-goes-empty, multi-source join, MV-over-MV cascade) **now exercise the deferred path automatically** and stay green.

### §53 sqllogic
Added **§25** — documents the flush boundary and that only the full-rebuild arm is deferred (so the deferred set stays empty / the flush is a no-op for the SQL-reachable bounded-delta arms), points to the spec harness for full-rebuild coverage, and regression-guards that the new flush hook is transparent: a bulk multi-row UPDATE crossing a partial predicate inside a 2-level MV-over-MV chain still converges at both levels.

## Honest gaps / where to scrutinize

- **Round-based drain vs the ticket's "pop keys".** The ticket sketched a pop-one-at-a-time worklist with an `assertCascadeDepth`-style counter. I implemented a **round-based** drain instead, deliberately: a literal pop-loop with a `count > rowTime.size` guard can **false-throw on a legitimate diamond DAG** of full-rebuild-over-full-rebuild MVs (a node re-flushed via two predecessors can exceed the count even though the DAG is acyclic). The round approach bounds rounds by the longest chain (≤ `rowTime.size`), never false-throws on an acyclic DAG, and self-corrects a too-early consumer rebuild by re-dirtying it. Please sanity-check the `rowTime.size + 1` bound reasoning in `assertFlushRounds`.
- **Full-rebuild-over-full-rebuild diamonds are not directly tested.** The round-drain handles them in theory, but `forceFullRebuild` only builds single-/two-level chains, and a multi-source full-rebuild consumer reading two full-rebuild backings isn't constructible through the current test helpers. The convergence/round logic for that exotic shape is unverified by a test.
- **OR FAIL mode.** The flush runs after the loop in FAIL mode too, but FAIL skips the statement savepoint — so a flush failure there wouldn't unwind prior rows (consistent with FAIL's keep-prior-rows semantics). With full-rebuild not SQL-reachable, FAIL + full-rebuild is untested end-to-end.
- **Cold-caller inline fallback is defensive-only.** No full-rebuild MV is ever a covering structure, so the enforcement/eviction cold path never reaches a full-rebuild plan; the inline-rebuild fallback is untested because it's structurally unreachable.
- **FK-cascade nesting.** A nested FK-cascade DML statement creates its own per-statement deferred set and flushes at its own boundary; a full-rebuild MV touched by both parent and cascade could rebuild twice (idempotent, parent's flush is authoritative against live post-cascade state). Not separately tested.
- **Doc scope.** The ticket TODO named only `docs/incremental-maintenance.md`; I also updated `docs/materialized-views.md` (its "Full-rebuild is the one deferred arm" paragraph was written as *planned* and the future-work bullet listed the deferral as "next refinement") and `docs/runtime.md` (the `runWithStatementSavepoints` section now notes the end-of-statement flush). Worth a skim for accuracy.
