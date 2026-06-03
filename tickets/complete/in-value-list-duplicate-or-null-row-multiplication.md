description: Fix for `WHERE col IN (<value-list>)` returning duplicated / spurious rows when the IN list has a duplicate literal or a NULL, on an indexed memory-vtab column (multi-seek, plan=5). Fixed in scanLayer's multi-seek branch: skip NULL/NULL-containing seek keys, and dedup yielded rows by primary key. Reviewed and completed.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts (the fix — multi-seek branch + `seekKeyHasNull` helper + BTree dedup), packages/quereus/test/logic/07.9-in-value-list.sqllogic (dual-mode regression), packages/quereus/test/optimizer/secondary-index-access.spec.ts (plan-pinned regressions, extended in review), packages/quereus/src/vtab/memory/layer/scan-plan.ts (equalityKeys build, plan=5)
----

## Summary

`WHERE col IN (v1..vn)` on an **indexed** memory-vtab column compiles to a multi-seek
`IndexSeekNode` (plan=5), and the memory module marks the IN filter *handled* (dropping
the residual `col IN (...)` filter). The multi-seek therefore had to be
set-membership-exact, but `scanLayer`'s multi-seek branch had two faults:

- **Duplicate literal multiplied rows** — `IN (5, 5)` produced two point seeks → the
  matching row yielded twice (bag, not set).
- **NULL element triggered a full scan** — `IN (5, null)` produced a `null` seek key;
  the point-seek branches gate on `equalityKey != null` (loose), so `null` fell through
  to the unbounded full-index walk → every row yielded.

`select distinct *` masked the bug (DISTINCT collapsed the bag back to a set); the
`distinct-elimination` rule then correctly removed a now-redundant DISTINCT over a
PK/UNIQUE-backed set, exposing the already-violated set invariant — the fuzz divergence
that surfaced the bug.

The fix is a single runtime choke point in `scanLayer`'s multi-seek branch
(`scan-layer.ts`), covering single-column, composite, PK, and secondary-index seek keys
(literal and dynamic, since values are concrete there):

- **NULL-skip:** a module-level `seekKeyHasNull(key)` helper skips any seek key that is
  `null` (scalar) or has a `null` component (composite tuple) before recursing.
- **Dedup-by-PK:** a `BTree` keyed by `primaryKeyComparator` accumulates the PKs of
  yielded rows across the whole multi-seek; a row already yielded by an earlier seek is
  dropped. Keying on physical row identity (the PK) is collation-agnostic, so
  case-variant literals hitting the same NOCASE entry collapse correctly.

Dedup is correct across MVCC layers because `MemoryTable.query()` issues a single
`manager.scanLayer(startLayer, plan)` call on one layer whose inherited BTrees present
the full merged view — the entire `equalityKeys` list is processed and deduped within
that one call.

## Review findings

### What was checked

- **Root-cause & fix correctness** (read the full implement diff and `scan-layer.ts`
  with fresh eyes before the handoff). The two faults and the two-part fix are real and
  correctly targeted. `seekKeyHasNull` correctly distinguishes composite tuples
  (`Array.isArray`) from scalars; BLOBs (`Uint8Array`) are correctly treated as scalars
  (not skipped). The `seen.insert(pk).on` dedup idiom matches the established pattern in
  `aggregate.ts` / `distinct.ts` (verified via `find_references` on `.insert(`).
- **Dedup soundness** — IN is set membership; a physical row matches at most one seek
  key (a row has one key value / one composite key), so PK-dedup only ever removes true
  per-seek duplication and never collapses two legitimately distinct rows. Reasoned
  through single-column, PK, non-unique secondary, composite cross-product, and NOCASE
  cases.
- **MVCC scope** — traced `query()` → `manager.scanLayer` → single `scanLayerImpl` call
  (`find_references` on `scanLayer`); confirmed the dedup `seen` tree spans the merged
  overlay+base view within one call. The handoff's central correctness claim holds.
- **Plan-build path** — `scan-plan.ts` confirms `equalityKeys` is produced *only* by
  plan=5 (the IN multi-seek), so the new dedup/NULL-skip cannot affect EQ, range,
  prefix-range, or multi-range plans. `NOT IN` does not compile to a multi-seek, so the
  NULL-skip cannot wrongly affect it.
- **Aspect scan** — SPP/DRY (small single-purpose helper, idiomatic dedup), type safety
  (properly typed `BTree<BTreeKeyForPrimary, …>`, no `any`), error handling (silent
  null-skip is correct, not an error path), resource cleanup (in-memory tree is GC'd
  with the generator). No issues.
- **Lint** — `yarn workspace @quereus/quereus lint` → clean (exit 0).
- **Tests** — full `yarn workspace @quereus/quereus test` → **4429 passing, 9 pending,
  0 failing** (4426 + 3 new review regressions). Fuzz `distinct elimination produces
  identical results` run 3× (not seed-reproducible) → green each time.
- **Docs** — read `docs/memory-table.md` and `docs/optimizer.md`. Both describe IN→
  multi-seek as a *capability* (composite IN cross-product supported; OR-of-equality
  collapses to IN multi-seek). Neither documented bag semantics nor anything the fix
  contradicts — the bug was an undocumented internal correctness defect. **No doc change
  required** (explicitly checked, not skipped).

### What was found / done

- **Minor — coverage gaps the implementer flagged as untested, now closed (fixed in this
  pass).** Added three plan-pinned regressions to the `IN multi-seek set membership`
  block in `secondary-index-access.spec.ts`:
  - **NOCASE UNIQUE** with case-variant literals (`v IN ('A','a')`) → row once. This is
    the exact case that *justifies* deduping by physical PK rather than by seek key (a
    naive key-compare would double-yield); it was previously only argued, not tested.
  - **NOCASE non-unique** index where two distinct NOCASE-equal rows are matched by
    overlapping seeks → both rows survive, per-seek duplication collapses.
  - **Transaction overlay** — `IN (50,50,9,null)` inside an open txn over a merged
    overlay+base view → correct collapse, then correct revert after `ROLLBACK`. Locks in
    the single-`scanLayer`-call MVCC dedup claim.
  All three were first verified as ad-hoc probes (passing) then promoted to permanent
  tests; scratch file removed.

- **Minor — deferred cosmetic, filed (not fixed here).** EXPLAIN/`query_plan` still
  reports the raw literal IN-list length as `inCount` (e.g. `in (5,null,5,9)` →
  `inCount=4`) even though only 2 effective seeks run. Purely cosmetic; the runtime is
  already correct. The planner-side literal dedup/NULL-drop the implementer flagged as
  optional cannot replace the runtime fix (dynamic seek values are unknown at plan time).
  Filed as `backlog/in-multiseek-explain-incount-cosmetic` with the hard constraint that
  it stay a pure subset of the runtime behavior. Not a blocker.

- **Major findings: none.** No correctness, type-safety, resource, or regression issue
  found in the fix.

### Not done (with reason)

- **No layer-level white-box unit test** for the multi-seek (e.g. in
  `scan-layer-descending.spec.ts`). Coverage is end-to-end (`07.9-in-value-list.sqllogic`,
  dual-mode) plus plan-pinned (`secondary-index-access.spec.ts`), which exercises the
  same code through realistic paths and asserts the INDEXSEEK plan is chosen. A
  white-box test would be redundant; deliberately skipped.
- **Store-mode (`test:store`) not re-run in review.** The review additions are
  memory-only specs (`USING memory`); the dual-mode `.sqllogic` file was unchanged and
  already validated against the store residual-filter path at implement time. Re-running
  the slow store suite for memory-only test additions would add no signal.

## Live behavior (post-fix, memory)

```
select * from t where v in (5)        → 1 row
select * from t where v in (5, 5)     → 1 row (was 2)
select * from t where v in (5, null)  → 1 row (was 3)
select * from t where v in (5, 5, 9)  → 1 row (was 2)
v in ('A','a') on NOCASE UNIQUE       → that row, once
id, c_real2 from t1 where c_real2 in (0, null, 0, 820)  → {0, 820} once each
```
