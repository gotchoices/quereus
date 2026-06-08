---
description: Memory-table composite-PK / multi-column-secondary-index leading-column range scan dropping all but the last matching row — fixed and reviewed
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/utils/primary-key.ts, packages/quereus/src/vtab/memory/index.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## What was wrong

A range scan over a **composite** primary key (or multi-column secondary
index) constrained only on its **leading column** (`a >= ?`, `a > ?`,
`a >= ? and a < ?`) returned only the **last** matching row in key order.

Root cause: the BTree stores composite keys as arrays (`[a, b]`), but the
lower-bound seek `startKey` was built from the bare **scalar** leading value.
The composite comparator (`createCompositeColumnPrimaryKeyFunctions.compare`,
`primary-key.ts` L119-137) reads `arrA.length` / `arrA[i]`; given a scalar both
are `undefined`, so the seek landed past nearly all rows and the ascending scan
yielded only the final one.

## The fix

`scan-layer.ts`, both range branches: wrap the scalar lower bound in a
single-element array **only when the key is composite**, so the comparator's
existing prefix handling (`primary-key.ts` L124-126 / `index.ts` L120-122:
a shorter key sorts before all full keys sharing that prefix) seeks correctly.
Single-column keys stay on the scalar path. The composite test mirrors the
key-function selection in `createPrimaryKeyFunctions` / `createIndexKeyFunctions`
(>1 column ⇒ array-shaped key).

## Review findings

**Diff reviewed:** `scan-layer.ts` (both range branches) and the new
`05.1-composite-pk-range-scan.sqllogic`. Cross-checked against the two key
comparators (`primary-key.ts createCompositeColumnPrimaryKeyFunctions`,
`index.ts createCompositeColumnKeyFunctions`) and `safe-iterate.ts` seek
semantics (`find` → `moveNearest` crack handling).

- **Correctness of the wrap (ASC composite PK + secondary index):** Verified.
  The composite-detection predicates correctly mirror the key-function
  selection logic: `(primaryKeyDefinition?.length ?? columns.length) > 1` for
  the primary branch (the `?? columns.length` handles the all-columns-PK
  fallback) and `(indexDef?.columns.length ?? 1) > 1` for the secondary branch.
  Inclusive (`>=`) and exclusive (`>`) lower bounds both seek to the right
  crack given the comparator's length-tiebreak rule. **No issue.**

- **Singleton / empty-PK edge:** `primaryKeyDefinition === []` yields `0 > 1`
  = scalar path; the singleton comparator returns 0 for any key, so the seek
  shape is irrelevant. A range scan on a singleton table is not meaningful
  anyway. **No issue.**

- **`equalityPrefix` + `lowerBound` interaction:** The wrap lives only in the
  `else if (plan.lowerBound)` branch, which is mutually exclusive with the
  `equalityPrefix` branch (the latter already builds an array and appends the
  bound). No plan shape bypasses the wrap. **No issue.**

- **Descending ORDER BY over an ASC-leading composite PK** (`order by a desc`
  with `a >= ?`): empirically verified correct (returns all matching rows in
  descending order). The wrap is direction-independent and the comparator
  positions the short key correctly for the backward scan here. **No issue.**

- **MAJOR — DESC-*leading* composite PRIMARY KEY range scan drops all rows.**
  `PRIMARY KEY (a DESC, b)` with `a >= 15 order by a` returns **0 rows**
  (expected 2). The primary scan branch has **no `isDescFirstColumn`
  handling** (the secondary branch does, and the equivalent DESC-leading
  *secondary*-index case is correct). This is a **pre-existing** gap — the
  scalar seek key was already garbage against DESC array keys before this fix —
  and it requires a non-trivial change (porting the secondary branch's
  DESC-leading seek/termination logic into the primary branch), so it is filed
  as a separate ticket rather than fixed inline:
  → `tickets/fix/primary-pk-desc-leading-range-scan-drops-rows.md`.

- **Tests:** Added a passing regression guard for the DESC-leading *secondary*
  index leading-column range to `05.1-composite-pk-range-scan.sqllogic`
  (the working path; the broken primary path is covered by the new fix ticket).
  Original test covers ASC 2-/3-column composite PK, single-column control,
  upper-bound-only control, and ASC multi-column secondary index.

- **Documentation:** Confirmed `docs/optimizer.md` describes planner-level
  seek-key construction and access-path selection, not the array-vs-scalar
  shaping of memory-vtab BTree keys (an internal implementation detail). The
  change touches no documented contract, so no doc update is warranted. Not a
  silent omission — checked and intentional.

## Validation

- `yarn workspace @quereus/quereus test` → **3584 passing, 0 failing**, 9
  pending. Includes `05.1-composite-pk-range-scan.sqllogic` (now also asserting
  the DESC-leading secondary case).
- `yarn workspace @quereus/quereus lint` → exit 0, clean.
- Secondary path confirmed discriminating: the chosen access path for the
  composite-index leading-column range is `INDEXSEEK ... USING idx_kn`, so the
  secondary-branch edit is genuinely exercised.
