description: On the persistent storage backend, a query that fixes only the first part of a multi-column primary key (for example every line of one order) now reads just the matching rows instead of the whole table, and can return them already sorted by the rest of the key.
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts (`pkPrefixPlan`, `computeFilterAccessPlan`, `buildPkOrderingAdvertisement`), packages/quereus-store/src/common/store-table-scan.ts (`analyzePKAccess`, `pkEqualityRun`, `pkPrefixWindow`, `pkPrefixRangeSeekLength`, `pkRangeAtPositionIsOrderSafe`, `foldRangeWindow`, `PKAccessPattern`), packages/quereus-store/test/pk-prefix-seek.spec.ts, packages/quereus-store/test/pushdown.spec.ts, packages/quereus-store/README.md, docs/store.md
----

# What landed

For a store table with `primary key (a, b)`, `where a = ?` is now one contiguous read of the data store over the rows whose key starts with that value, instead of a full scan with a residual filter. `where a = ? and b > ?` also bounds `b` inside that window. Both provide `order by b` and `order by b desc` with no Sort.

- **Planner** (`store-module-access-plan.ts`): `pkPrefixPlan` builds a `_primary_` candidate from the leading equality run of the key, cut before the first multi-value `IN` (or runtime-valued set). A bound on the next member is claimed only when there was no cut, the prefix equalities compare under the key's own collations, that member's key bytes order like its comparator, and the bound's collation is served. The candidate replaces the leading-member range wherever both apply and competes with secondary-index seeks on cost. The prefix columns are passed to the ordering advertisement as pinned.
- **Runtime** (`store-table-scan.ts`): `PKAccessPattern` is a discriminated union (`point` / `range` with `prefixValues` + `constraints` / `scan`). `analyzePKAccess` tries the full-key point read, then (only for a plan naming `_primary_`) the prefix window, then (only for a plan naming no secondary index) the leading-member range. The primary-key and secondary-index bound arithmetic now share one `foldRangeWindow`.
- **Docs**: `docs/store.md` access-pattern table and ranking paragraph; `packages/quereus-store/README.md` IN-list section and (added in review) the "which predicate shapes become a seek" table.

The implement-stage commit is `ticket(implement): feat-store-primary-key-prefix-equality-seek`.

# Review findings

**Correctness (read the diff, then ran a differential check).** I wrote a throwaway spec that ran 22 queries against a memory table and a store table and compared rows. Each query also ran inside a transaction that had pending inserts, deletes and updates landing in the queried windows. I ran it once against the plain store module and once against the isolation-wrapped store. The spec was deleted afterwards.

- **Keys:** a 3-column integer key, a NOCASE text key, and a key with `DESC` members.
- **Shapes:** a plain prefix, the prefix with a bound on the next member, `BETWEEN`-style double bounds, and both walk directions. Also a multi-value `IN` after the prefix, the `IN` plus a bound on the same member, `IN` on the leading member, a non-adjacent equality (`a = 1 and c = 16`), `a = 1 and a > 0`, `LIMIT`, and predicate collations both finer and coarser than the key's.
- **Result:** every query matched, and the plans showed `INDEX SEEK` / `INDEX RANGE ... USING primary` with no Sort where expected.
- **An artifact, not a defect:** my first run compared an undecorated text key, and the two modules disagreed. Store text keys default to NOCASE and memory ones to BINARY, and the leading-range query that predates this change disagreed the same way. With `collate nocase` declared on both sides, all queries matched.

**No-bound-after-cut gate (the one the implementer found by reasoning):** confirmed it is load-bearing. With `cut < 0 &&` removed, `where a = 1 and b in (1, 2) and b > 1` on a 3-column key throws `Malformed multi-seek FilterInfo … seekWidth 2 does not cover the 3-column primary key`. I added one end-to-end case to `pk-prefix-seek.spec.ts` that pins it (plan uses `primary`, correct rows).

**Runtime constraint source:** checked that `FilterInfo.constraints` carries only what `rule-select-access-path` built for the chosen seek. So the runtime's `pkEqualityRun` never sees an equality the planner did not pin, for example one the planner skipped because its collation is coarser than the key's. The runtime prefix therefore always matches the planner's. Multi-seek plans dispatch before `analyzePKAccess`, so the "first EQ per member" read cannot misread an IN list.

**Bound arithmetic refactor:** `foldRangeWindow` behaves the same as the two loops it replaced. `buildPkPrefixBounds([])` returns exactly `buildFullScanBounds()`, so the leading-member range is unchanged. The existing `pushdown.spec.ts` probe still passes with the new argument shape.

**Minor, fixed inline:**
- `analyzePKAccess` compared the index name with `toLowerCase()`, while every other `_primary_` check in the file (`resolveIndexFromIdxStr`, `scanMultiSeek`) compares exactly. I made it exact, since the engine always emits the literal name.
- The README seek-shape table lacked a row for the new shape. Added.

**Tests:** the implementer's four cases each pin a distinct behaviour. These are the plan claim, the backwards walk, a guard against the primary-key window pre-empting a chosen secondary index (the implementer verified it fails with the gate removed), and the DESC lower/upper swap. I kept all four. I added one more (the cut gate above) and cut none.

**Docs:** read `docs/store.md`, the store README, and the `docs/module-authoring.md` passage on backing hosts. They describe the new behaviour after the README table fix. `docs/module-authoring.md` needed no change: its only primary-key prefix mention is the backing-host `equalityPrefix` scan, which this ticket does not touch.

**Resource cleanup, error handling and type safety:** no new resources. The bad-`prefixLen` path throws through the existing `malformedFilterInfo`. The access pattern is now a discriminated union, which removed the old `values!` non-null assertion. Nothing found.

**Performance:** the idxStr is decoded up to four times per `query()` call (`query`, `analyzePKAccess`, `pkPrefixRangeSeekLength`, `resolveIndexFromIdxStr`). That is once per seek, not per row, so I left it.

**Tripwires and gaps (already parked by the implementer, not re-filed):**
- The composite-secondary-index ranking on un-analyzed tables is a `NOTE:` at `pkPrefixPlan`.
- A partly pinned `IN` prefix is tracked by backlog `feat-store-primary-key-prefix-in-list-seek`.

**File size:** `store-module-access-plan.ts` is 2,076 lines and `store-table-scan.ts` is 1,534 (`wc -l`). I appended both counts to the existing backlog `debt-oversized-source-files` rather than filing a new ticket.

**Validation:**
- `yarn workspace @quereus/store test`: 2017 passing.
- `tsc --noEmit` and `tsc -p tsconfig.test.json --noEmit` in `packages/quereus-store`: clean.
- `yarn test:store`: 11136 passing / 33 pending. The one-off timeout the implementer saw in `01.9-query-expr-dml.sqllogic` did not recur, so no `.pre-existing-error.md` was filed.
