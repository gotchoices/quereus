description: A virtual-table module is never told which of its columns a query reads, so a column store has to assemble every column of every row even for `select count(*)` or a one-column projection; the planning request should carry the set of columns the plan above the scan actually consumes.
files: packages/quereus/src/vtab/best-access-plan.ts (`BestAccessPlanRequest`), packages/quereus/src/vtab/index-info.ts (`colUsed`, declared but always `0n`), packages/quereus/src/vtab/filter-info.ts (the three `colUsed: 0n` sites), packages/quereus/src/planner/rules/shared/access-leaf.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, docs/module-authoring.md, docs/sql-vtab.md
tradeoffs: The field is advisory to row-store modules (memory, store) and costs them nothing, but a module that honours it returns rows whose unread columns are unspecified, so every consumer above the scan — residual filters the module did not claim, FK and constraint checks, RETURNING, triggers, DML old-row images — must be counted as reading the columns it reads, or a module would return a wrong value instead of a slow one.
----

# A scan request names the columns the query reads

## The cost, measured

Lamina (a column store: one row tree plus one value index per column) reads a row by descending each column's tree for that row id. Measured from SiteCAD (2026-11-08, lamina at SiteCAD's pin, Node 24, memory provider): `select count(*) from Entity` over 2,350 rows of a 17-column table takes 274 ms, about 3.4 µs per cell, and every cell is read although the query needs none. Some of that cost is lamina's own and is being fixed there (a per-column leaf cursor and a cached watermark probe took a prototype 17-column scan from 191 ms to 38 ms, identical rows). With those changes, the remaining cost of a narrow read is proportional to the table's width rather than to the columns the query uses. Only Quereus knows which columns those are.

The isolated share of projection was not measured separately. For `count(*)` or a single-column read on a 17-column table, the expected saving is most of the remaining per-row cost.

## Current state

- `BestAccessPlanRequest` carries `columns` (the table's column metadata), `filters`, `requiredOrdering`, `limit`/`offset` and statistics — not which columns are consumed.
- The legacy `IndexInfo.colUsed` bitmask ("bit N set if column N is used") exists but every construction site in `filter-info.ts` sets it to `0n`, so no module can rely on it. Either populate it or remove it; leaving a documented field that is always zero is misleading.

## What to build

- Add to `BestAccessPlanRequest` an optional `requiredColumns?: ReadonlySet<number>` (column indices), populated when the planner can compute the full set the plan above this scan reads. **Absent means "assume all columns"**, the same convention `limit` uses, so a module only narrows its read when the engine has proved it safe.
- The set is the union of every column referenced above the scan: projected outputs, unclaimed residual filters, join keys, ordering, aggregate arguments, and the reads a mutation performs on the scanned rows (old-row images for UPDATE/DELETE, constraint and FK checks, RETURNING, triggers). `count(*)` with no residual yields the empty set.
- A module honouring it may leave unread columns of the emitted row as anything (e.g. `null`); document this in `docs/module-authoring.md` together with the "absent = all" rule. Modules that ignore the field stay correct.
- Decide whether `colUsed` is populated from the same computation or deleted.

## Tests

- Planner: the set for `select a from t`, `select count(*) from t`, `select a from t where b > 1` with `b` unclaimed (includes `b`), a join (includes join keys), `order by c` (includes `c`), and `delete from t where …` / `update t set …` (absent or all columns, unless the mutation's reads are proven).
- A test module that returns `null` for every column outside `requiredColumns`, run against a query corpus whose results must match the memory module's. That catches any consumer missing from the set.

## Consumer

Lamina will read only the named columns' row trees once the field exists (SiteCAD board: `lamina-row-writes-cost-15ms-each`, section *Not changed*, first item).
