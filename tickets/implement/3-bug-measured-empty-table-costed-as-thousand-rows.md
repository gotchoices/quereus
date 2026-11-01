description: When a table has been measured and found empty, several places in the planner still treat it as a table of unknown size and price it as a thousand (or a hundred) rows, so one plan holds two contradictory sizes for the same table and the query-plan diagnostics show made-up row counts.
architecture: docs/optimizer-costing.md#statistics-abstraction
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/test/optimizer/access-plan-request-row-count.spec.ts, docs/optimizer-costing.md, docs/progressive-optimizer.md
repro: verified
----

# A measured zero is read as "unknown" at five sites

## The contract

A row count has two spellings (`docs/optimizer-costing.md` § Base-table row estimates, `planner/stats/table-cardinality.ts`): `undefined` means nobody measured the table; a number — including `0` — is a measurement. Consumers substitute a default only for `undefined`. Measured zeros reach the planner from `ANALYZE` on an empty table, from the observed overlay (a complete scan of a drained table whose previous estimate was large, `docs/progressive-optimizer.md` §3.7), and — once `feat-planner-asks-the-backend-how-big-a-table-is` lands — from a module's own count (the store reports 0 for an empty table it has primed).

## Reproduced (2026-11-01, memory backend, `auto_analyze` off)

```sql
create table e (id integer primary key, v integer);
create table s (id integer primary key, e_id integer, w integer);
insert into s select value, value % 50, value from generate_series(1, 2000);
analyze e;
analyze s;
select * from e;                                        -- IndexScan e: cost 1000, rows 0
select s.w, e.v from s join e on e.id = s.e_id;         -- e costed as 100 rows by join selection
```

`db.getDebugPlan('select * from e')` shows `INDEX SCAN e … [cost: 1000] {rows: 0}`: the node relays the measured 0 as its row estimate while its cost — the memory module's quote — was computed for 1000 rows. One table, two sizes, in one plan.

## The five sites (all verified)

| site | read | effect of a measured 0 |
| --- | --- | --- |
| `rule-select-access-path.ts` `createSeqScan` (~1246) | `tableRef.estimatedRows \|\| 1000` | a SeqScan built without a module cost (the collation-decline arms) is costed for 1000 rows; its `FilterInfo` row estimate says 1000 |
| `rule-select-access-path.ts` `selectPhysicalNode` (~429) | `makeFullScanFilterInfo(accessPlan.cost, accessPlan.rows \|\| 1000)` | a module answering `rows: 0` reads back as 1000 — `IndexSeekNode` relays that as its estimate, and `index-nested-loop.ts` `displacedPlan` reads it as the displaced plan's rows (the NOTE there names this) |
| `rule-join-physical-selection.ts` (~286) | `physicalSourceRows(…) \|\| 100` | an empty side is priced as 100 rows; the comment beside it ("0 is the un-analyzed unknown sentinel") predates `unknown-row-count-stops-pretending-to-be-zero` and is wrong now |
| `vtab/memory/module.ts` `getBestAccessPlan` (~464) | `request.estimatedRows \|\| 1000` | every access path of an empty memory table is priced for 1000 rows |
| `func/builtins/explain.ts` (~143) | `estimatedRows \|\| 10` | `query_plan().est_rows` shows 10 for a measured 0, for an unknown count, and — because it reads the logical getter, which physical access nodes do not define — for every physical access node |

Checked and left: `rule-select-access-path.ts` ~1080 (`accessPlan.rows || 0`, the legacy PK-seek gate) maps a missing module estimate to "small", not a zero to "unknown"; it only ever admits a primary-key equality seek, which is right at any size.

## Decision: honor the zero, floor it at one row where it would price something at nothing

Mechanically swapping `||` for `??` is not enough, and the reason is the most fragile property of a zero: any insert invalidates it by an infinite ratio. (PostgreSQL's planner assumes a never-vacuumed table has at least ten pages for the same reason: a table small now may not be once data loads.) With `??` alone, the memory module's `AccessPlanBuilder.fullScan(0)` costs 0 — below every seek (`eqMatch` starts at 0.5) — so a point query on a table measured empty and filled since (a stale `ANALYZE`, `auto_analyze` off) would switch from a primary-key seek to a full scan. So:

- **Relays keep the zero.** `FilterInfo` row estimates and the physical `estimatedRows` they feed say 0: `createSeqScan` and `selectPhysicalNode` use `??` with the existing default only for `undefined`.
- **Cost consumers floor a measured zero at one row.** The memory module's table size (`request.estimatedRows === undefined ? 1000 : Math.max(1, request.estimatedRows)`) and join selection's side rows (`rows === undefined ? <default> : Math.max(1, rows)`). A one-row table still prices a primary-key seek (0.8) below a full scan (1.0), so a stale zero cannot turn seeks into scans. This matches the store, which already floors a substituted live count at 1 (`sizeRequestFromLiveCount`), and `FilterNode`'s min-1 convention.
- `createSeqScan`'s own cost needs no floor: `seqScanCost(0)` is `SEQ_SCAN_BASE` (0.1), never zero.
- **Diagnostics tell the truth.** `query_plan().est_rows` reports the node's physical estimate when it has one, else its logical one, else `null` (the column is nullable). `est_cost` is unchanged.

Tradeoff accepted: an empty-measured outer now makes a plain nested loop cheap in join selection (`nestedLoopJoinCost(1, n)`); if the zero is stale and the inner cannot be cached, one execution can be quadratic before feedback re-observes the table (the nested loop's outer scan is itself a complete scan, so the next execution re-plans) or auto-analyze refreshes it. Today's `|| 100` hides that only by pretending the empty table has 100 rows.

`vtab/memory/module.ts` ~464 is also the site `feat-memory-backend-sizes-itself` (backlog) will change for the *unknown* case; this ticket touches only the measured-zero arm and leaves the 1000 default and its NOTE in place.

## Edge cases & interactions

- **Unknown stays unknown.** Every site keeps its current default for `undefined`; never-analyzed plans do not change. Verify: `yarn test` (golden plans unchanged), `yarn bench:gate` (foreground, ~35 s).
- **Stale zero, point query.** A table analyzed empty, then filled, still seeks on its primary key. Verify: test below.
- **Measured zero, one plan, one size.** The access leaf's cost and row estimate agree. Verify: test below.
- **A module answering `rows: 0` for a seek** is relayed as 0; the index-nested-loop displaced-plan comparison then reads the module's own answer (update the NOTE in `displacedPlan`). Verify: inspection.
- **`query_plan().est_rows` consumers**: `test/optimizer/keys-propagation.spec.ts` and `test/planner/tvf-physical-properties.spec.ts` read it; quoomb-web reads it with `|| 0`. Verify: those specs; inspection of `packages/quoomb-web/src/worker/quereus.worker.ts`.
- **The store's floor** (`sizeRequestFromLiveCount`) is untouched. Verify: `yarn workspace @quereus/store test`.
- **Shared lines with other queued tickets**: `feat-per-row-latency-cost-for-remote-scans` edits the latency charges next to join selection's side rows, and `unknown-size-join-scans-instead-of-seeking` will change the unknown default there; keep the side-row read in one place so both compose. Verify: inspection.

## Tests (only these)

In `test/optimizer/access-plan-request-row-count.spec.ts`, beside "sends a measured 0 as 0":

- A table analyzed while empty plans `select * from e` with an access leaf whose cost is the one-row price and whose row estimate is 0 — not 1000 for either.
- The same table, filled with 2,000 rows afterwards (`auto_analyze` off, so the catalog still says 0), plans `select * from e where id = ?` as an `IndexSeek` on the primary key — the stale-zero guard.

## TODO

- `createSeqScan`, `selectPhysicalNode`: `??`.
- Join selection side rows and the memory module's table size: `undefined` → existing default, measured 0 → 1; fix the stale comment in join selection.
- `explain.ts`: physical estimate, then logical, then `null`.
- Update the NOTEs that describe the old collapse: `table-cardinality.ts` header, `createSeqScan`'s, `table-access-nodes.ts` ~537, `index-nested-loop.ts` `displacedPlan`.
- The two tests.
- Docs: `docs/optimizer-costing.md` ("What a physical seek node reports" names the `|| 1000`) and `docs/progressive-optimizer.md` §3.7 ("Measured zero") and §5 (remove the "Measured zero honored" item).
- `yarn lint`, `yarn test`, `yarn workspace @quereus/store test`, `yarn bench:gate`, `yarn docs:check`.
