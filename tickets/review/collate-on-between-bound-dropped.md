description: REVIEW — A `COLLATE` on a BETWEEN *bound* was applied to the wrong (or no) comparison. Fixed `emitBetween` to resolve lower/upper comparison collations independently with bound precedence (mirroring `emitComparisonOp` and the desugared form), fixed the access-path BETWEEN collation classification to read the correct bound per `constraint.op`, and made the range-seek collation-cover conservative so a non-BINARY range seek (which the memory runtime cannot honor) declines to a scan + residual. Build + lint + full memory suite green.
files:
  - packages/quereus/src/runtime/emit/between.ts                          # PRIMARY FIX — per-bound collation resolution + note
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # effectivePredicateCollation BETWEEN arm (per-bound) + classifyConstraintCover range guard
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic          # new BETWEEN-bound regression section (scan + index variants)
  - packages/quereus/test/logic/03-expressions.sqllogic                   # corrected an existing test that encoded the OLD whole-expression behavior
  - tickets/backlog/memory-range-seek-collation-bounds.md                 # deferred runtime improvement (range bounds honoring collation)
----

# `COLLATE` on a BETWEEN bound — landed fix, ready for adversarial review

## What landed

Three source changes (plus two test files and one backlog ticket):

### 1. Primary: `emitBetween` per-bound collation (`runtime/emit/between.ts`)

`BETWEEN` desugars to `expr >= lower AND expr <= upper`, where **each** comparison resolves
its collation independently. The old code computed a **single** collation with `expr`-first
precedence:

```ts
if (exprType.collationName) collationName = exprType.collationName;   // column → 'BINARY' (truthy) wins
else if (lowerType.collationName) ...
```

A plain column's `collationName` is the implicit default `'BINARY'` — always present and
truthy — so it shadowed an explicit `COLLATE` on a bound, and a single collation was applied
to both comparisons. Now each bound resolves with right(bound)-operand precedence, matching
`emitComparisonOp`:

```ts
const exprColl = plan.expr.getType().collationName;
const lowerCollationName = plan.lower.getType().collationName ?? exprColl ?? 'BINARY';
const upperCollationName = plan.upper.getType().collationName ?? exprColl ?? 'BINARY';
```

Two collation funcs are pre-resolved and each `compareSqlValuesFast` uses its own. `NOT BETWEEN`
is preserved: `!(v>=lo[lowerColl] && v<=hi[upperColl])`. The `note` now shows a single name when
both bounds agree, or `lower/upper` when they differ.

This is the fix for the reported wrong-rows bug, which **reproduces on a bare scan** (no index).

### 2. Secondary (classification): BETWEEN arm of `effectivePredicateCollation`

`extractBetweenConstraints` emits two constraints sharing one `BetweenNode` source — `op:'>='`
(lower) and `op:'<='` (upper). The access-path arm now picks the matching bound by
`constraint.op` and applies the same `bound ?? expr ?? 'BINARY'` precedence as the runtime. The
stale comment claiming the bound collation is "dropped during constant folding" was removed —
**the fix stage confirmed it is NOT dropped** (it rides on the bound node's `getType()`), which
also supersedes the comment-only revert noted in `index-collation-mismatch-residual-filter`'s
review findings.

### 3. Secondary (correctness guard): `classifyConstraintCover` range arm

Implementing #2 surfaced a **pre-existing runtime limitation**: the memory vtab's range-seek
path filters range bounds with a BINARY comparator and early-terminates on a BINARY compare
(`plan-filter.ts` / `scan-layer.ts`), ignoring the index's declared collation. So a non-BINARY
range seek under-fetches. `classifyConstraintCover` now classifies a **range** (non-equality)
seek as `MATCH` only when both the predicate's effective collation and the index collation are
`BINARY`; any non-BINARY collation → `MISMATCH_UNSAFE` → decline to a scan + residual (always
correct, since the residual re-applies the now-fixed `BetweenNode`). Equality seeks are
untouched (they use the collation-aware `keyComparator` and remain enabled). The deeper runtime
fix that would let non-BINARY range seeks be *used* is filed as
`tickets/backlog/memory-range-seek-collation-bounds.md` and referenced from the code comment.

## Validation performed

- `tsc --noEmit` clean; `eslint` clean; full memory suite **5239 passing, 9 pending, 0 failing**.
- Targeted `06.4.2-collation-extras` passes.

## Use cases / expected behavior (verify these)

Table `name text` (BINARY), rows `(1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob')`:

| Query | Expected | Why |
|---|---|---|
| `name between 'bob' collate NOCASE and 'bob'` | `[2,4]` | lower NOCASE (true for BOB/Bob), upper BINARY (`<= 'bob'` true) |
| `name collate NOCASE between 'bob' and 'bob'` | `[2,4]` | expr NOCASE → both bounds inherit |
| `name >= 'bob' collate NOCASE and name <= 'bob'` | `[2,4]` | desugared parity |
| `name between 'BOB' and 'bob' collate NOCASE` | `[2,4]` | upper-bound COLLATE variant |
| `name not between 'bob' collate NOCASE and 'bob'` | `[1,3]` | complement under per-bound negation |
| same BETWEEN over a `name collate NOCASE` index | `[2,4]` | matching-collation → declines to scan + residual |
| same BETWEEN over a BINARY index, both bounds NOCASE | `[2,4]` | NOCASE bound ≠ BINARY index → declines |

Scalar (no table), in `03-expressions.sqllogic`:

- `'hello' BETWEEN 'A' COLLATE NOCASE AND 'Z'` → **false** (was asserted `true` under the old
  whole-expression behavior). Per-bound: `'hello' >= 'A'` NOCASE = true, `'hello' <= 'Z'`
  BINARY = false. This matches SQLite and the desugared two-comparison form.
- `'hello' BETWEEN 'A' AND 'Z' COLLATE NOCASE` → **true** (upper-bound NOCASE flips only the
  upper comparison).

## Honest gaps / things to scrutinize

- **Semantics choice is right-operand-precedence, per-bound** — deliberately consistent with
  quereus's existing `emitComparisonOp` (and confirmed against SQLite for the scalar case
  above). This is NOT SQLite's left-explicit-first rule in general; that simplification is
  pre-existing and out of scope. Reviewer should confirm all three syntactic forms agree (they
  do in the tests) and decide if the broader right-precedence model is acceptable.
- **`03-expressions.sqllogic` expectation was changed**, not just added. The old `yes4:true`
  encoded the buggy behavior. Confirm the new `false`/`true` values are correct (I believe they
  match SQLite). Only this one existing test encoded the old behavior — the rest of the suite
  was unaffected.
- **Non-BINARY range seeks are now always declined** (scan + residual). This is a correctness
  guard around a real runtime limitation, but it is a behavior change to `classifyConstraintCover`
  beyond the literal ticket text. It affects range / prefix-range / OR_RANGE seeks uniformly.
  Results are unchanged (always correct); only plans change (a non-BINARY range that previously
  MATCHed a seek now scans). The full suite stayed green, so no plan-shape assertion regressed —
  but the reviewer may want to confirm no intended non-BINARY range-seek optimization is silently
  lost (none exists today: such a seek was already runtime-broken). The relax-path is the backlog
  ticket.
- **The memory range-bound collation bug itself is NOT fixed here** — only routed around. It is
  a separate subsystem (`vtab/memory/layer`) and a larger change; see the backlog ticket.
- **Index variant tests likely run as scans on 4-row tables** (cost-based). They assert
  correctness, not plan shape, so they validate the decline-to-scan path's *result* but do not
  prove an `IndexSeek` node was attempted. A plan-shape assertion (e.g. in
  `test/optimizer/secondary-index-access.spec.ts`) confirming the decline could be added if the
  reviewer wants tighter coverage.
