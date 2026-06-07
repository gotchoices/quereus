description: A secondary index whose per-column collation differs from a predicate's effective comparison collation is used as an index seek WITHOUT retaining the original predicate as a residual filter, so the seek over-fetches collation-equal rows and returns wrong results. Repro surfaced once `index-explicit-column-collate-apply-path` enabled building a NOCASE index on a BINARY column.
prereq:
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # equality-seek (~486-520) and range-seek (~609-715) build IndexSeekNode from constraints with no check that the index column's collation matches the predicate's effective collation; `collation` is never read in this file
  - packages/quereus/src/runtime/emit/binary.ts                            # emitComparisonOp (~209-233) — the residual predicate WOULD evaluate correctly (it resolves the effective collation from operand types, default BINARY); the bug is that the access path drops the residual, not that the comparator is wrong
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                   # the memory btree secondary-index comparator walks under the INDEX's per-column collation (NOCASE), which is what over-fetches when the predicate is BINARY
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic           # "INDEX with an explicit per-column COLLATE" section documents the gap (KNOWN GAP comment) and is where the corrected `→ [{"id":2}]` assertion should be restored once fixed
----

# Collation-mismatched index seek must retain a residual predicate (or not be used as the sole satisfier)

## Symptom (confirmed repro)

```sql
create table coll_idx (id integer primary key, name text);          -- name is BINARY
insert into coll_idx values (1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob');

select id from coll_idx where name = 'BOB' order by id;             -- before any index
-- → [{"id":2}]                                                       (correct: BINARY equality)

create index idx_name_nc on coll_idx (name collate NOCASE);          -- NOCASE index on a BINARY column

select id from coll_idx where name = 'BOB' order by id;             -- same query, index now exists
-- → [{"id":2},{"id":4}]   ← WRONG: 'Bob' (id 4) leaks in
```

The equality `name = 'BOB'` has **BINARY** effective collation: the column `name`
declares no COLLATE, the literal carries none, so the comparison is case-sensitive
and only id 2 matches. The presence of an unrelated NOCASE *index* must not change
query semantics — an index is an access path, not a comparison rule.

## Root cause

`rule-select-access-path.ts` chooses an `IndexSeekNode` for the equality constraint
on `name` using the NOCASE index `idx_name_nc`. The memory btree walks that index
under its **per-column NOCASE comparator** (see `scan-layer.ts`), so the seek for
`'BOB'` returns every NOCASE-equal row (`'BOB'`, `'Bob'`). The access-path rule then
treats the seek as *fully satisfying* the predicate and does **not** retain
`name = 'BOB'` as a residual filter — so the BINARY-illegal row `'Bob'` is never
discarded. `rule-select-access-path.ts` never reads `collation` anywhere (confirmed:
the only `collation` token in the file is in an unrelated comment ~1016); index
selection is collation-blind.

The runtime comparator is NOT the bug: `emitComparisonOp` (binary.ts) resolves the
effective collation from operand types (default BINARY) and would reject `'Bob'`
correctly *if the predicate were still evaluated*. The defect is purely that the
access path consumes the predicate into a collation-mismatched seek and drops it.

This was latent and unreachable until `index-explicit-column-collate-apply-path`
made `create index … (col collate <c>)` build on a column whose own collation
differs — before that, the live create path rejected the collate-folded form.

## Required behavior

When an index is considered to satisfy an equality (or range) constraint, the index
column's collation must equal the predicate's **effective comparison collation** for
the seek to be a complete substitute for the predicate. Otherwise the planner must
either:

- **(a)** keep using the index as a coarse access path but RETAIN the original
  predicate as a residual filter over the seek output (correct + still uses the
  index for the case where index collation is *coarser* — NOCASE index, BINARY
  predicate — since NOCASE-equality is a superset of BINARY-equality), or
- **(b)** decline to use the index for that constraint when its collation does not
  match (simpler; falls back to a scan + filter, losing the index benefit).

(a) is preferred: a NOCASE index seek over-fetches a superset of the BINARY matches,
so seek-then-residual-filter is both correct and still index-accelerated. Note the
asymmetry — a *finer* index collation than the predicate (BINARY index, NOCASE
predicate) under-fetches and the index must NOT be used as the seek for that
predicate at all; only the coarser-index direction is salvageable with a residual.

The effective comparison collation is resolvable the same way the runtime does it
(`emitComparisonOp` in binary.ts: right operand's `collationName`, else left
operand's, else BINARY) — but at plan time, off the constraint's operand types.

## Acceptance

- The repro above returns `[{"id":2}]` with the NOCASE index present.
- Restore the corrected assertion in `06.4.2-collation-extras.sqllogic` (the section
  currently carries a `KNOWN GAP` comment pointing here): re-add
  `select id from coll_idx where name = 'BOB' order by id;` → `[{"id":2}]`.
- A NOCASE predicate over the NOCASE index still returns both rows
  (`where name = 'bob' collate NOCASE` → `[{"id":2},{"id":4}]`) — already correct,
  must not regress.
- The index is still *used* (not silently degraded to a full scan) for the coarser-
  index case — verify via a plan assertion if approach (a) is taken.
- Consider the symmetric case (BINARY index, NOCASE-collated column/predicate) and a
  composite index with one mismatched column; add coverage for whichever the fix
  touches.

## Notes

- Scope is the access-path/optimizer layer; the create path and persistence emitter
  (fixed in `index-explicit-column-collate-apply-path`) are correct and out of scope.
- This is a correctness bug, not a perf nicety — it returns wrong rows. Prioritize
  accordingly.
