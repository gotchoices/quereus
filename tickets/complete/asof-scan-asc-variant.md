---
description: Recognize ASC variant of lateral-top-1 asof (`q.K >= left.K order by q.K asc limit 1`)
files:
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/test/optimizer/asof-scan.spec.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
  - docs/optimizer.md
---

`ruleLateralTop1Asof` recognizes both directions of the lateral-top-1 asof
pattern:

- **'desc'** (existing): `q.K <= t.K order by q.K desc limit 1` →
  *latest right ≤ left.K*
- **'asc'** (new): `q.K >= t.K order by q.K asc limit 1` →
  *earliest right ≥ left.K*

Each direction also accepts the strict variant (`<` / `>`) and all four
mirrored operator forms (`q.K op t.K` and `t.K op' q.K`). Sort direction
must agree with the predicate; mismatched pairs leave the rule inert.

## What landed

- **`AsofScanNode`** — new public field `direction: 'asc' | 'desc'` threaded
  through the constructor, `withChildren`, `toString`, and
  `getLogicalAttributes` (`query_plan(...).properties.direction` is
  observable). The right input must still advertise
  `monotonicOn(matchAttr, asc)` and `accessCapabilities.asofRight`; only the
  cursor-walk semantics flip per direction.
- **Rule** — `extractSortAttrId` returns `{ attrId, direction }` for both
  asc and desc keys. `classifyPredicates` canonicalizes the asof inequality
  to `(rightCol op leftCol)` and maps each operator (`<=`, `<`, `>=`, `>`,
  plus the four mirrors) to a `(strict, direction)` pair. The rule rejects
  `(sort.direction, asof.direction)` mismatches.
- **Emitter** — branches the per-bucket cursor advancement on `direction`:
  - `'desc'`: cursor starts at `-1`; advance while `bucket[cursor+1].match`
    qualifies (`≤` left.match, or `<` strict). Cursor sits on the last
    qualifying row.
  - `'asc'`: cursor starts at `0`; advance while `bucket[cursor].match` is
    too small (`<` left.match, or `≤` strict). Cursor sits on the first
    qualifying row, or past-the-end (`bucket.length`) when none qualifies.
  Both modes maintain `O(L + R)` streaming cost; the right input is
  bucketed once in ascending match order.

## Tests

- `test/optimizer/asof-scan.spec.ts` covers asc + non-strict + partition,
  asc strict, mismatched-direction cases (no `ASOFSCAN`), and asserts
  `direction` in plan properties for both forms.
- `test/logic/84-asof-scan.sqllogic` adds asc plan-shape probe, partitioned
  non-strict asc, boundary-tie contrast (non-strict vs strict asc), inner
  cross-join asc that drops unmatched left rows, and unpartitioned asc.

## Validation

- `yarn workspace @quereus/quereus run build` — clean
- `yarn workspace @quereus/quereus run lint` — clean
- `yarn workspace @quereus/quereus run test` — 2647 passing, 2 pending
  (matches baseline)

## Code-review notes

- Cursor-walk polarity verified for the asc branch: non-strict skips on
  `cmp < 0`, strict skips on `cmp <= 0`; past-the-end bookkeeping via
  `if (cursor < bucket.length)` is correct.
- `classifyPredicates` correctly bails on mixed inequalities — the
  pre-existing `if (asof) return null;` guard fires on any second
  inequality regardless of direction.
- `docs/optimizer.md § Streaming asof scan` describes both forms and the
  sort/predicate-direction bail.
