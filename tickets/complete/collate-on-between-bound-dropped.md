description: COMPLETE — A `COLLATE` on a BETWEEN *bound* (e.g. `name between 'bob' collate NOCASE and 'bob'`) was applied to the wrong (or no) comparison, returning wrong rows on a bare scan. Fixed `emitBetween` to resolve lower/upper comparison collations independently with right(bound)-operand precedence (mirroring `emitComparisonOp` and the desugared two-comparison form), fixed the access-path BETWEEN collation classification to read the correct bound per `constraint.op`, and made the range-seek collation cover conservative so a non-BINARY range seek (which the memory runtime filters with a BINARY comparator) declines to a scan + residual. Reviewed: build + lint + full memory suite green; no defects found.
files:
  - packages/quereus/src/runtime/emit/between.ts                          # PRIMARY FIX — per-bound collation resolution + note
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # effectivePredicateCollation BETWEEN arm (per-bound) + classifyConstraintCover range guard
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic          # BETWEEN-bound regression section (scan + index variants)
  - packages/quereus/test/logic/03-expressions.sqllogic                   # corrected an existing test that encoded the OLD whole-expression behavior
  - docs/sql.md                                                           # BETWEEN per-bound COLLATE semantics
  - docs/optimizer.md                                                     # collation-cover range-seek rule
  - tickets/backlog/memory-range-seek-collation-bounds.md                 # deferred runtime improvement (range bounds honoring collation)
----

# `COLLATE` on a BETWEEN bound — landed and reviewed

## What landed

### 1. Primary: `emitBetween` per-bound collation (`runtime/emit/between.ts`)

`BETWEEN` desugars to `expr >= lower AND expr <= upper`, where each comparison resolves its
collation independently. The old code computed a *single* collation with `expr`-first precedence;
a plain column's `collationName` is the implicit default `'BINARY'` (always present and truthy),
so it shadowed an explicit `COLLATE` on a bound. Now each bound resolves with right(bound)-operand
precedence — `bound.collationName ?? expr.collationName ?? 'BINARY'` — and two pre-resolved
collation funcs are used, one per comparison. `NOT BETWEEN` is preserved by the existing negation.
Fixes the reported wrong-rows bug, which reproduces on a bare scan (no index).

### 2. Secondary (classification): BETWEEN arm of `effectivePredicateCollation`

`extractBetweenConstraints` emits two constraints sharing one `BetweenNode` source — `op:'>='`
(lower) and `op:'<='` (upper). The access-path arm now selects the matching bound by `constraint.op`
and applies the same `bound ?? expr ?? 'BINARY'` precedence as the runtime. The stale "dropped during
constant folding" comment was removed (the collation rides on the bound node's `getType()`).

### 3. Secondary (correctness guard): `classifyConstraintCover` range arm

The memory vtab's range-seek path filters range bounds with a BINARY comparator and early-terminates
on a BINARY compare (`plan-filter.ts` / `scan-layer.ts`), ignoring the index's declared collation.
`classifyConstraintCover` now classifies a *range* (non-equality) seek as `MATCH` only when both the
predicate's effective collation and the index collation are `BINARY`; any non-BINARY collation →
`MISMATCH_UNSAFE` → decline to scan + residual. Equality seeks are untouched (collation-aware
`keyComparator`). The deeper runtime fix is filed as `tickets/backlog/memory-range-seek-collation-bounds.md`.

## Review findings

### Verified (and what was checked)

- **Per-bound collation premise** — Confirmed a bare `LiteralNode.getType()` returns *no*
  `collationName` field (undefined; `scalar.ts:395-402`), a column reference returns truthy
  `'BINARY'`, and a folded `COLLATE` literal carries `explicitType.collationName` (uppercased at
  `CollateNode`, `scalar.ts:771`). So the `?? exprColl ?? 'BINARY'` chain is sound: an explicit bound
  COLLATE wins, a bare bound inherits the expr collation, and the expr-side `COLLATE` form still
  propagates to both bounds. This is the exact asymmetry the bug hinged on.
- **Parity with `emitComparisonOp`** — Verified line-for-line: lower comparison `expr >= lower`
  resolves `lower(right) ?? expr(left) ?? BINARY`; upper `expr <= upper` resolves
  `upper(right) ?? expr(left) ?? BINARY`. Matches `binary.ts:209-223` (right-then-left), so all three
  syntactic forms (bound-collated, expr-collated, desugared two-comparison) agree.
- **op→bound mapping** — `extractBetweenConstraints` emits exactly `op:'>='` (lower) and `op:'<='`
  (upper) (`constraint-extractor.ts:464-483`); the classification's `'<='|'<' → upper, else → lower`
  is correct. NOT BETWEEN returns `null` from the extractor (never seeks; handled by runtime negation).
- **Range guard runtime premise** — Confirmed in `plan-filter.ts`: range bounds (lines 28/32/41/45)
  and prefix-equality (line 23) use `compareSqlValues` (BINARY); only the equality branch (line 16)
  uses the collation-aware `keyComparator`. A non-BINARY range seek therefore genuinely under-fetches,
  so declining it is justified.
- **Residual safety** — `classifyCollationCover` (`rule-select-access-path.ts:1301-1329`) attaches the
  de-duped `BetweenNode` as a `FilterNode` residual on decline (`useIndex:false`), so the scan stays
  filtered and results are always correct. `isEquality` is correctly `false` for a BETWEEN (the
  `allEquality` gate at 300-315 fires only on `=`/`IN`; the range call sites pass `false`).
- **Latent correctness bug fixed incidentally** — Before this change the range arm returned `MATCH`
  whenever `predColl === indexColl`, so a NOCASE-predicate range over a NOCASE index would *use* the
  seek and under-fetch (wrong rows) on any table large enough for the cost model to pick a seek. The
  new guard corrects this; the residual makes the result correct regardless of plan.
- **Changed (not just added) test** — `03-expressions.sqllogic` flipped
  `'hello' BETWEEN 'A' COLLATE NOCASE AND 'Z'` from `true` (old whole-expression behavior) to `false`.
  Independently confirmed against SQLite semantics: `'hello' >= 'A'` NOCASE = true,
  `'hello' <= 'Z'` BINARY = false (`'h'`=0x68 > `'Z'`=0x5A) → BETWEEN false. Correct. Only this one
  existing test encoded the old behavior.
- **Docs** — `docs/sql.md` (per-bound COLLATE semantics) and `docs/optimizer.md` (range-seek cover
  rule) read true to the new behavior. Other `*.md` BETWEEN+collation hits are cross-check tracking
  docs, not behavior specs — no update needed.

### Found / fixed

- **Code defects: none.** No inline fixes were required — the three changes are correct as landed.

### Accepted limitations (explicitly, with reasons — not silent)

- **No plan-shape assertion proving the seek actually declines.** The index-variant tests assert
  *results*, not that an `IndexSeek` was declined; on 4-row tables the cost model picks a scan anyway,
  so they validate the decline path's *output* but not that the guard fired. Forcing a seek on a tiny
  table is cost-dependent and fragile, and result correctness is fully covered. The relax-path
  (`memory-range-seek-collation-bounds`) is where such an assertion belongs once non-BINARY range
  seeks become *usable* — deferred there deliberately, not silently dropped.
- **RTRIM bound not tested (only NOCASE).** RTRIM exercises the identical code path (same `??` chain,
  same classification); NOCASE is representative. No separate runtime path exists for it.
- **The memory range-bound collation bug is routed around, not fixed.** It lives in a separate
  subsystem (`vtab/memory/layer`) and is tracked in `tickets/backlog/memory-range-seek-collation-bounds.md`.

### Validation

- `tsc --noEmit` clean; `eslint` clean (single-quoted globs on Windows).
- Full memory suite: **5239 passing, 9 pending, 0 failing** (`yarn workspace @quereus/quereus test`).

## Follow-up

- `tickets/backlog/memory-range-seek-collation-bounds.md` — thread the index column collation into the
  memory range-bound comparison + walk early-termination so non-BINARY range/`BETWEEN`/prefix seeks
  become usable, then relax the `classifyConstraintCover` range guard to mirror the equality arm. That
  ticket should add the plan-shape assertion noted above.
