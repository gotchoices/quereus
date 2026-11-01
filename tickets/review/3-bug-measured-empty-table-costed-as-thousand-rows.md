description: A table measured as empty is now reported as having 0 rows and priced as one row everywhere in the planner, instead of being treated as a table of unknown size and priced as a thousand (or a hundred) rows, so a plan no longer holds two sizes for the same table and query-plan diagnostics stop showing made-up row counts.
architecture: docs/optimizer-costing.md#statistics-abstraction
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus/test/optimizer/access-plan-request-row-count.spec.ts, packages/quereus/test/optimizer/key-set-seek.spec.ts, packages/quereus-store/test/store-row-count-to-planner.spec.ts, packages/quereus-store/test/stats-persistence.spec.ts, docs/optimizer-costing.md, docs/progressive-optimizer.md, docs/module-authoring.md
repro: verified
----

# Measured zero: reported as 0, priced as one row

## The rule now in force

A row count has two spellings: `undefined` = nobody measured; a number, including `0`, = a measurement. Sites that **relay** a count keep the 0. Sites that turn a count into a **cost** floor a measured 0 at one row. Reason: a zero goes stale on the first insert, and a table priced at nothing undercuts every seek (a point query on a table analyzed empty, filled since, `auto_analyze` off, would switch from a primary-key seek to a full scan). At one row the memory module still prices a primary-key seek (0.8) below a full scan (1.0). Written up in `docs/optimizer-costing.md` § Base-table row estimates ("A measured zero is reported as 0 and priced as one row").

## What changed, site by site

- `rule-select-access-path.ts` `selectPhysicalNode`: `accessPlan.rows ?? 1000` (relay). A module's `rows: 0` reaches `IndexSeekNode`'s estimate and `index-nested-loop.ts` `displacedPlan` as 0.
- `rule-select-access-path.ts` `createSeqScan`: `tableRef.estimatedRows ?? 1000` (relay). No floor needed for cost: `seqScanCost(0)` = `SEQ_SCAN_BASE` (0.1).
- `rule-join-physical-selection.ts`: new `costedRows(rows, unknown)` — `undefined` → the unknown default, else `Math.max(1, rows)`. Used by `sideRows` (unknown → `UNKNOWN_SIDE_ROWS` = 100, unchanged) and `rowsRead` (the latency read; unknown leaf → the side's rows). One helper so `unknown-size-join-scans-instead-of-seeking` and `feat-per-row-latency-cost-for-remote-scans` compose on it. Stale "0 is the un-analyzed sentinel" comment removed.
- `vtab/memory/module.ts` `getBestAccessPlan`: `undefined` → 1000 (unchanged, NOTE for `feat-memory-backend-sizes-itself` kept), measured 0 → 1.
- `func/builtins/explain.ts`: `est_rows` = `node.physical.estimatedRows ?? logical estimatedRows ?? null`. Was `logical || 10`, which showed 10 for every physical access node. Scalar nodes now show `null`. quoomb-web readers all null-safe (checked `QueryPlan.tsx`, `QueryPlanGraph.tsx`, `quereus.worker.ts`).
- Store `sizeRequestFromLiveCount`: a supplied 0 is floored at 1 too (before, a 0 the live count agreed with went through verbatim, so a drained, never-analyzed store table priced its full scan at 0; the planner's push-down comparison then declined a primary-key equality and rebuilt it as `FILTER` over `INDEX SEEK`). The stale-snapshot exception is **kept**: a supplied 0 contradicted by a live count > 0 still uses the live count, which is more accurate than 1 for secondary-index arms. The doc comment was rewritten; the old "floored at 1, conservatively rather than load-bearingly" NOTE was deleted (the floor is now load-bearing and engine-wide).
- NOTEs updated: `table-cardinality.ts` header, `createSeqScan`, `table-access-nodes.ts` (`IndexSeekNode.computePhysical`), `index-nested-loop.ts` `displacedPlan`.
- Docs: `optimizer-costing.md` (new paragraph plus the `|| 1000` → `?? 1000` fix in "What a physical seek node reports"), `progressive-optimizer.md` §3.7 "Measured zero" rewritten and the §5 item removed, `module-authoring.md` row-count guidance (tell module authors to floor 0 for costing). `module-authoring.md` is now 56 words under the 12000-word docs cap.

Left as the ticket said: `rule-select-access-path.ts` ~1080 (`accessPlan.rows || 0`, the legacy PK-seek gate).

## Tests

- `access-plan-request-row-count.spec.ts` "prices a measured-empty table as one row and reports it as 0 — one table, one size": checks that the access leaf of `select * from e` (analyzed empty) has the same `est_cost` as a one-row analyzed table and `est_rows` 0. Fails before the change (cost 1000, est_rows 10).
- Same file, "still seeks the primary key once a table measured empty has filled up": analyze empty, `auto_analyze` off, insert 2000 rows, then `select * from e where id = ?` must plan `INDEXSEEK … primary`. This guards against a plain `||` → `??` swap (it passes before the change too, which is expected: the old `|| 1000` also seeked).
- `store-row-count-to-planner.spec.ts` "prices a measured 0 as one row, so a primary-key seek still undercuts the scan": on a drained store table, a full-scan request with `estimatedRows: 0` must equal the `estimatedRows: 1` plan, and a PK-equality request must cost less than it. I confirmed it fails under the old logic (scan `{cost: 0, rows: 0}`). Note: my first version, which compared seek plans only, did **not** fail on the old code. The store's PK seek never depended on the size. The decline happened in the engine's comparison against the zero-cost scan.
- Fixture change, `key-set-seek.spec.ts` "compound shape" describe: it used to `analyze` **empty** `txn`/`entry` "so the cost model works from real numbers". That relied on the old collapse (empty sides priced at 100/1000). Now every side prices at one row, plain nested loops win, and all three tests in the describe failed. I seeded 2000 `txn` / 1000 `entry` / 100 accounts before analyzing. I picked those sizes from a small grid of sizes I measured. At 100/2000 or 1000/2000 the key-set seek fires but `txn` gets hash-joined (two IndexScans), so the first test still fails. The fixture is therefore somewhat size-sensitive; the comment in `beforeEach` gives the reason (`txn` much larger than the ~10 entries account 1 selects).
- `stats-persistence.spec.ts`: comment only (its claim about `est_rows` had gone stale).

## Validation run

`yarn lint` clean; `yarn test` all green (quereus 10843 passing, store 1960, all others passing). I re-ran it after rebuilding `dist`, because store/sync/isolation tests resolve `@quereus/quereus` from the built `dist`, not `src`. `yarn workspace @quereus/store test` green against the rebuilt engine; `yarn bench:gate` passed; `yarn docs:check` OK. Watch out: `packages/quereus/test-runner.mjs` runs mocha with `--bail`, so a single failure hides every spec after it. My first full run reported "1 failing" and that count was misleading.

## For the reviewer to probe

- Accepted tradeoff (from the ticket, now in docs): an empty-measured outer makes a plain nested loop cheap in join selection, so a stale zero over an uncacheable inner can cost one quadratic execution before feedback re-observes or auto-analyze refreshes. I did not add a test or measurement for that window.
- `FilterNode`'s physical `estimatedRows` relays 0 over an empty scan (seen in `query_plan` output: `FILTER … est_rows 0`). The "min-1 convention" the ticket cites seems to apply only to the logical getter. I did not touch it. Any cost consumer that reads a Filter's physical 0 without a floor (outside join selection, which floors) is a possible remaining site. I swept the planner for `|| default` substitutions on row counts and found no others, but I did not audit every `?? default` consumer for a missing floor.
- `est_rows` now prefers the physical estimate over the logical one for every node, not only access nodes. On nodes where the two diverge, the diagnostic number changed. Only `keys-propagation.spec.ts` and `tvf-physical-properties.spec.ts` read it, and both pass.
- In the memory module, a measured-empty table answers `rows: 1` for its full scan (the floored size), so an `IndexSeek` over it relays 1, while a `SeqScan`/`IndexScan` relays the catalog's 0. That is the module's own answer and fine by the rule, but it means "one table, one size" holds for scans and not strictly for seeks.
