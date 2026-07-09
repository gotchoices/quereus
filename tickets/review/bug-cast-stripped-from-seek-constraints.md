---
description: A query that converts a column's value before comparing it — for example matching rows where the text column read as a number equals 1 — used to return no rows when that column was the table's primary key. Fixed; this ticket asks for a review of the fix.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # the fix
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts  # NOTE: comment only
  - packages/quereus/test/planner/constraint-extractor.spec.ts             # cast describe block rewritten
  - packages/quereus/test/logic/05.2-cast-seek-correctness.sqllogic        # new
  - docs/optimizer.md                                                       # cross-reference updated
difficulty: medium
---

# Converting `CAST` is no longer erased when extracting index-seek constraints

## What was wrong

`constraint-extractor.ts`'s `unwrapCast` stripped **every** `CastNode`. So
`cast(x as integer) = 1` was recognized as `x = 1` and pushed down as a seek key on the
raw stored column. Against a `text primary key`, no stored text compares equal to the
integer `1`, and because the conjunct was reported as fully consumed, no residual
`FILTER` survived above the seek. The query returned zero rows.

This was reachable without writing any `cast(...)` in the SQL:
`insertCrossTypeCoercion` (`planner/building/expression.ts`) wraps the textual operand of
a numeric comparison in a synthetic cast, so a bare `where x = 1` on a `text` column
planned as `cast(x as real) = 1` and hit the same erasure.

## What changed

**`constraint-extractor.ts`** — two helpers where there was one:

- `unwrapCast` now loops `while (cur instanceof CastNode && isNoOpCast(cur))`, matching
  `sat-checker.ts`'s `unwrap()` and `coarsened-key.ts`. Only a *value-preserving* cast
  (target logical type equal to the operand's) is stripped. Used by `isColumnReference`,
  `getColumnReference`, `isLiteralConstant`, `getLiteralValue`, and `columnSideOf` — all
  of which **discard** the wrapper, so the value must be unchanged.
- `unwrapCastForBindingKind` (new) strips any cast chain, converting or not. Used only at
  `extractBinaryConstraint`'s `innerValue` and inside `isDynamicValue` — both classify the
  *shape* of the value side while `result.valueExpr` retains the whole cast node and
  evaluates it at runtime. This preserves parameter/correlated seek pushdown for
  `x = cast(:p as integer)`.

`isNoOpCast` was already exported from `scalar-invertibility.ts`; it is now imported here.

**`rule-sargable-range-rewrite.ts`** — comment only. Its own `unwrapCast` still strips
unconditionally. That is dormant (constant folding collapses a cast over a literal before
the rule runs, and the column side never reaches the helper because
`candidateSide.rangeRewriteIn(...)` declines a `CastNode`). A `NOTE:` at the helper records
the condition under which it becomes a real defect. Deliberately no behavior change.

**`docs/optimizer.md`** — the sat-checker "out of scope" bullet already carried the
no-op-cast rule; its cross-reference to `constraint-extractor.ts` was updated to name the
seek-witness failure mode and the `insertCrossTypeCoercion` path.

## Fallout, honestly

`where x = 1` on a `text` primary key now falls back from `INDEXSEEK` to
`INDEXSCAN + FILTER`. That is the correct plan — the old plan was fast and wrong — but it
**is** a performance regression for anyone relying on the implicit coercion. Nothing in the
suite asserts on that plan shape, and no `.sqllogic`, plan, or optimizer test regressed.

Two shape changes worth a second look from the reviewer:

- `cast(x as integer) = y` (converting cast on the left, other-table column on the right)
  now binds the constraint to `y` (with `valueExpr = cast(x as integer)`) rather than to
  `x`. Sound, but it is a different constraint than before. No test covers it.
- `col IN (cast(1 as text))` now declines to a residual instead of extracting an IN
  constraint with the pre-cast value `1`. Correct, and dormant in practice (folding), but
  it is a behavior change on the IN path that the ticket did not call out.

`getLiteralValue` returning the pre-cast value was a latent defect fixed as a side effect
of the strict unwrap, not a tripwire — it was only dormant because constant folding
collapses `cast(1 as text)` to `'1'` before extraction runs.

## Validation

`yarn workspace @quereus/quereus run test:all` (the no-bail variant; plain `yarn test`
bails on the first failure): **6659 passing, 9 pending, 0 failing**. `yarn lint` clean.

Before the fix the same suite was 6639 passing / 6 failing, all six in the
`CastNode wrapping (unwrapCast)` describe block, and every one of them asserted the buggy
behavior.

### `test/planner/constraint-extractor.spec.ts`

The `describe` block was renamed to
`CAST wrapping — no-op strips, converting cast blocks extraction` (it named the helper, not
the behavior) and rewritten as paired cases. A trap for anyone extending it: `colRef()` is
`INTEGER`-typed but a JS number literal (`lit(42)`) types as **`REAL`**, so a no-op cast
over a literal has target `'REAL'`, not `'INTEGER'`. The `castNode()` helper still defaults
to `'TEXT'` (converting over both).

Covered: no-op vs converting cast on the column side, on the literal side, on both;
chained no-op casts; flipped operand order; `BETWEEN`; `IS NULL`; `IN` (condition must be a
bare column ref, unchanged); parameter value sides through both cast kinds, asserting
`valueExpr` still holds the `CastNode`; covered-key integration (a converting cast on the
PK must not land in `computeCoveredKeysForConstraints`' covered set); and OR-collapse
(a converting cast in a branch keeps the whole OR residual).

One pre-existing test outside that block was retargeted: `col(left) = cast(lit)(right) →
nonLiteral true but valueSide is literal` now builds a `'REAL'` (no-op) cast so it still
exercises the `bindingKind: 'literal'` branch it was written for.

### `test/logic/05.2-cast-seek-correctness.sqllogic` (new)

Against `create table t (x text primary key)` with rows `'1'`, `'1abc'`, `'2'`, every query
is paired with the identical predicate over a non-indexed `text` column in a sibling table;
indexed and non-indexed must agree. Row sets are asserted, never plan shapes.

| predicate | rows |
|---|---|
| `cast(x as integer) = 1` | `'1'`, `'1abc'` |
| `1 = cast(x as integer)` | `'1'`, `'1abc'` |
| `cast(x as integer) between 1 and 1` | `'1'`, `'1abc'` |
| `cast(x as integer) in (1)` | `'1'`, `'1abc'` |
| `cast(x as integer) = 1 or cast(x as integer) = 2` | `'1'`, `'1abc'`, `'2'` |
| `x = 1` (implicit coercion) | `'1'`, `'1abc'` |
| `x = '1'` (control, still seeks) | `'1'` |
| `cast(x as text) = '1'` (no-op cast, still folds) | `'1'` |

Note the source ticket predicted `x = 1` would return all three rows. It does not — it
returns `'1'` and `'1abc'`, the same as the non-indexed control, because the planner casts
`x` to `REAL` and `'2'` converts to `2`. The table above is what the engine actually
produced under the fix.

## Known gaps for the reviewer

- **No plan-shape test.** Nothing asserts that `cast(x as integer) = 1` now produces a
  residual `FILTER` above the scan. The `.sqllogic` cases would still pass if a future
  change made the extractor decline *and* the filter vanish in some other way that
  happened to return the right rows for these three specific rows. A `test/plan/` case
  pinning "no `INDEXSEEK` for a converting cast" would be stronger.
- **Three text rows is a thin fixture.** `'1'`, `'1abc'`, `'2'` exercise the
  prefix-parse and the non-match, but nothing tests a `blob` column, a `real` column
  compared to an integer literal, or a cast whose target is `numeric`/`any`.
- **`isNoOpCast` compares `logicalType` by reference** (`===` on the registry singleton).
  A user-registered type with the same name but a distinct object would classify a genuine
  no-op cast as converting — conservative (loses pushdown), never wrong.
- **The two shape changes listed under *Fallout*** (`cast(col) = otherTableCol` rebinding,
  `IN (cast(lit))` declining) are untested. Both are believed sound; neither was in the
  ticket's scope.
- **`rule-sargable-range-rewrite.ts` still strips converting casts.** Comment only, no
  test. If the reviewer disagrees that it is dormant, that is a real bug, not a tripwire.

## Review findings

_(to be filled in by the review stage)_
