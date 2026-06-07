description: Live CREATE INDEX now accepts an explicit per-column COLLATE (`create index ix on t (col collate nocase [desc])`) via the collate-folded form instead of rejecting it as an expression index, and the persistence emitter keeps the trailing asc/desc for that form. Unblocks the differ-emitted explicit-COLLATE recreate from 2.1. Implemented; needs review.
prereq:
files:
  - packages/quereus/src/schema/manager.ts                 # buildIndexSchema (~2052-2071) now calls resolveImportedIndexColumn (the same module-level helper importIndex uses)
  - packages/quereus/src/emit/ast-stringify.ts             # indexedColumnsToString (~902-909) folded-expr branch now re-appends `desc`
  - packages/quereus/test/index-ddl-roundtrip.spec.ts      # un-skipped the pending desc+collate test; +2 apply-level tests after "adding an explicit index COLLATE recreates"
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic  # repurposed the old negative section to a positive feature section (+ KNOWN GAP note)
  - tickets/fix/index-collation-mismatch-residual-filter.md      # NEW fix ticket — surfaced planner bug (see "Surfaced bug" below)
----

# Live CREATE INDEX explicit per-column COLLATE (apply path + emitter) — review handoff

## What landed (implementation)

- **`buildIndexSchema`** (manager.ts ~2052): replaced the `if (indexedCol.expr) throw`
  block + the `indexedCol.name`/`indexedCol.collation` reads with a single
  `resolveImportedIndexColumn(indexedCol)` call — the exact helper `importIndex`
  already uses. It unwraps the parser's collate-folded form (`col COLLATE x` →
  `{name, collation}`), passes a bare `col.name` through, and returns an unset name
  for a genuine expression index. The unset-name branch still throws the original
  `Indices on expressions are not supported yet.` message; its `loc` is preserved
  off `indexedCol.expr?.loc` (optional-chained because a bare-name column has no
  expr — only the expr branch reaches the throw, but the chaining is defensive).
  Collation resolution is now identical to import: explicit index COLLATE → table
  column collation → BINARY, via `normalizeCollationName`. The removed
  `Indexed column must be a simple column name.` message had zero references.
- **`indexedColumnsToString`** (ast-stringify.ts ~902): the `else if (col.expr)`
  (folded) branch now builds `expressionToString(col.expr)` and re-appends ` desc`
  when `col.direction === 'desc'` (asc stays elided, matching the plain `col.name`
  branch). The collation itself was already rendered by `expressionToString`; only
  the direction was being dropped.

Both fixes are tiny and localized; the create path (`createIndex` →
`buildIndexSchema`) is module-agnostic, so the store catalog path gets the fix too.

## Tests

- **`index-ddl-roundtrip.spec.ts`**:
  - Un-skipped `an explicit COLLATE on a descending column (collate-folded form),
    re-declared verbatim, does not churn` (was `it.skip`, blocked on this ticket).
    Its baseline now APPLIES through the fixed create path.
  - Added `applying an added explicit index COLLATE converges and the catalog index
    carries the collation` — declare `index ix on t (email)`, apply; re-declare
    `(email collate nocase)`, apply; assert `index_info` shows NOCASE and a re-diff
    is empty (converged). This is the end-to-end apply assertion the 2.1 tests were
    missing (they asserted only the diff DECISION).
  - Added `an explicit-COLLATE index applies on first declare and re-applies with
    zero churn` — verbatim `(email collate nocase)` builds on first apply and
    produces no churn on re-declare.
  - Full file: 63 passing.
- **`06.4.2-collation-extras.sqllogic`**: the old section asserted the create would
  ERROR (`-- error: Indices on expressions are not supported`). That pinned the very
  behavior this ticket reverses, so it was failing. Repurposed it to a positive
  feature section: the NOCASE index now builds, `index_info` reports the resolved
  `NOCASE`, and a genuine `lower(name)` expression index is still rejected (proves
  the expression-index guard survives). See the KNOWN GAP note re: the surfaced bug.

## Validation run

- `yarn workspace @quereus/quereus test` (memory): **5234 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus typecheck`: clean.
- `yarn workspace @quereus/quereus lint`: clean.
- Store backend: `06.4.2-collation-extras.sqllogic` (not in the memory-only exclusion
  list) run with `QUEREUS_TEST_STORE=true` against LevelDB: **1 passing**, confirming
  the collated-index create flows through the store catalog path. The full
  `yarn test:store` was NOT run (slower; covers the same create path for this file) —
  the targeted single-file store run is the relevant coverage since
  `index-ddl-roundtrip.spec.ts` is a memory-only mocha spec, not a sqllogic file, so
  `test:store` would not exercise it anyway.

## Surfaced bug — filed as `tickets/fix/index-collation-mismatch-residual-filter.md`

**This is the most important thing for the reviewer to look at.** Enabling the
collated-index create exposed a latent **correctness** bug in the planner access
path that was previously unreachable (you could not build such an index before):

```sql
create table coll_idx (id integer primary key, name text);   -- name is BINARY
insert into coll_idx values (1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob');
select id from coll_idx where name = 'BOB';   -- before index → [{id:2}]  (correct)
create index idx_name_nc on coll_idx (name collate NOCASE);
select id from coll_idx where name = 'BOB';   -- after index  → [{id:2},{id:4}]  WRONG
```

A BINARY equality is satisfied by an `IndexSeekNode` over the NOCASE index
(`rule-select-access-path.ts`), which walks the btree under the index's NOCASE
comparator and over-fetches, and the access path does NOT retain the original BINARY
predicate as a residual filter — so `'Bob'` leaks in. The runtime comparator is
fine; the defect is the access path consuming a collation-mismatched predicate into
a seek without a residual. Root cause, repro, the affected files, and two candidate
fixes (preferred: seek-then-residual-filter for the coarser-index direction) are in
the fix ticket. I deliberately did **not** attempt this fix here — it is a separate
optimizer-layer subsystem outside this ticket's create-path/emitter scope, and a
non-trivial planner change with its own test surface.

The `06.4.2` sqllogic section carries a `KNOWN GAP` comment pointing at that ticket
and intentionally omits the corrected `where name = 'BOB' → [{id:2}]` assertion
(re-add it once the fix lands). I did NOT pin the buggy `[{id:2},{id:4}]` as expected.

## Out of scope (carried forward from the source ticket — do NOT implement)

`generateMigrationDDL` emits `CREATE INDEX` before the `ALTER COLUMN … SET COLLATE`
for a column-collation-driven recreate. Per the source ticket this is currently
benign (memory returns correct collation-aware results after the sequence; the store
keys secondary indexes under one table-level collation, so a per-column SET COLLATE
does not re-key them). It becomes a stale-key hazard only on a future backend that
keys secondary indexes by per-column collation AND resolves index collation from the
column at CREATE INDEX time. Left as-is, as instructed.

## Reviewer attention / known gaps

- **Primary:** validate the surfaced-bug analysis and the fix ticket's framing — is
  seek-then-residual the right call, and is "currently benign for memory + store"
  accurate? The bug returns wrong rows, so confirm nothing else in the suite silently
  depends on the buggy path.
- The two new apply-level tests assert `index_info('t')` returns a single row
  (`{column_name:'email', collation:'NOCASE'}`) — relies on `index_info` not
  reporting the PK index. Consistent with the existing import test at ~203, but worth
  a glance.
- `desc`-direction coverage for the emitter is via the un-skipped roundtrip test
  (BODY-level no-churn) and the diff-decision tests; there is no apply-level test
  that an `(email collate nocase desc)` index round-trips its DESC through a real
  apply + `index_info`. The emitter change is trivial, but that exact end-to-end path
  is asserted only at the canonical-body level.
