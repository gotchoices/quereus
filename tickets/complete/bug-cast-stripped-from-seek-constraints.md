---
description: A query that converts a column's value before comparing it — for example matching rows where the text column read as a number equals 1 — used to return no rows when that column was the table's primary key. Fixed and reviewed.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts            # the fix
  - packages/quereus/src/planner/analysis/scalar-invertibility.ts            # `isNoOpCast` jsdoc + tripwire NOTEs (review)
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts  # NOTE comment only
  - packages/quereus/test/planner/constraint-extractor.spec.ts               # cast describe block rewritten + 6 review cases
  - packages/quereus/test/logic/05.2-cast-seek-correctness.sqllogic          # new; REAL + BLOB groups added in review
  - packages/quereus/test/plan/cast-seek-blocking.spec.ts                    # new (review) — plan-shape cover
  - docs/optimizer.md                                                        # wrapper rule documented on the extraction bullet
difficulty: medium
---

# Converting `CAST` is no longer erased when extracting index-seek constraints

## What was wrong

`constraint-extractor.ts`'s `unwrapCast` stripped **every** `CastNode`. So
`cast(x as integer) = 1` was recognized as `x = 1` and pushed down as a seek key on the
raw stored column. Against a `text primary key`, no stored text compares equal to the
integer `1`, and because the conjunct was reported as fully consumed, no residual
`FILTER` survived above the seek. The query returned zero rows.

Reachable without writing any `cast(...)` in the SQL: `insertCrossTypeCoercion`
(`planner/building/expression.ts`) wraps the textual operand of a numeric comparison in a
synthetic cast, so a bare `where x = 1` on a `text` column planned as
`cast(x as real) = 1` and hit the same erasure.

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

**`rule-sargable-range-rewrite.ts`** — comment only; its own `unwrapCast` still strips
unconditionally, which is dormant (see *Review findings*).

**`docs/optimizer.md`** — the wrapper rule (no-op cast strips, converting cast and
`COLLATE` do not; value-side `bindingKind` is the one exception) is now stated on the
**Constraint Extraction** bullet, where a reader looks up which predicate shapes are
extractable, in addition to the sat-checker "out of scope" bullet that already carried it.

## Behavioral fallout (intended)

`where x = 1` on a `text` primary key now falls back from `INDEXSEEK` to
`INDEXSCAN + FILTER`. That is the correct plan — the old plan was fast and wrong — but it
**is** a performance regression for anyone relying on the implicit coercion.

Two shape changes, both verified sound during review and now covered by tests:

- `cast(x as integer) = y` (converting cast on the left, other-table column on the right)
  binds the constraint to `y` (with `valueExpr = cast(x as integer)`) rather than to `x`.
  That is a correct correlated seek on `y`'s table. Same-table `cast(a) = b` declines.
- `col IN (cast(1 as text))` declines to a residual instead of extracting an IN constraint
  with the pre-cast value `1`. `col IN (cast(1 as real))` (no-op) still extracts.

`IS NULL` over a converting cast also declines now. `cast(x as text) is null` is in fact
equivalent to `x is null`, so this is a small lost-pushdown, not a correctness matter.

## Validation

`yarn workspace @quereus/quereus run test:all`: **6670 passing, 9 pending, 0 failing**
(6659 before the review pass added 11 cases). `yarn lint` clean, including the
`tsc -p tsconfig.test.json` pass over the specs.

Before the fix the same suite was 6639 passing / 6 failing, all six in the old
`CastNode wrapping (unwrapCast)` describe block, and every one of them asserted the buggy
behavior.

### Test inventory

- **`test/planner/constraint-extractor.spec.ts`** — describe block
  `CAST wrapping — no-op strips, converting cast blocks extraction`, 26 cases. Paired
  no-op / converting cases for: column side, literal side, both sides; chained no-op casts;
  flipped operand order; `BETWEEN`; `IS NULL`; `IN` condition and `IN` list elements;
  parameter value sides through both cast kinds (asserting `valueExpr` still holds the
  `CastNode`); covered-key integration; OR-collapse; cross-table rebinding.

  A trap for anyone extending it: `colRef()` is `INTEGER`-typed but a JS number literal
  (`lit(42)`) types as **`REAL`**, so a no-op cast over a literal has target `'REAL'`, not
  `'INTEGER'`. The `castNode()` helper defaults to `'TEXT'` (converting over both).

- **`test/logic/05.2-cast-seek-correctness.sqllogic`** — row-set correctness. Each query is
  paired with the identical predicate over a non-indexed column of the same declared type;
  indexed and non-indexed must agree. Groups: `text primary key` (rows `'1'`, `'1abc'`,
  `'2'`), `real primary key` (truncating cast), `blob primary key` (hex-encoding cast).

  Note the source ticket predicted `x = 1` would return all three text rows. It does not —
  it returns `'1'` and `'1abc'`, same as the non-indexed control, because the planner casts
  `x` to `REAL` and `'2'` converts to `2`.

- **`test/plan/cast-seek-blocking.spec.ts`** — plan shape. Asserts no `INDEXSEEK` and a
  surviving `FILTER` for the explicit cast, the implicit coercion, `BETWEEN`, and the OR
  form; asserts `INDEXSEEK` is retained for `x = '1'` and for the no-op `cast(x as text)`.

## Review findings

Reviewed the implement diff (`2325f877`) before the handoff summary: every branch of
`extractBinaryConstraint`'s side-selection was re-derived by hand against the new helpers,
then each derivation was pinned with a test. Ran `yarn lint` and the full no-bail suite.

**Major (new ticket): none.** Nothing in the diff is wrong, and the two shape changes the
implementer flagged as unverified both turn out to be sound — see below.

**Blocked (human decision): none.**

**Minor (fixed in this pass):**

- *No plan-shape cover.* The `.sqllogic` rows would still pass if a future change made the
  extractor decline **and** the filter vanish some other way. Added
  `test/plan/cast-seek-blocking.spec.ts`: six cases pinning "converting cast → no
  `INDEXSEEK`, `FILTER` survives" and "no-op cast / same-type comparison → `INDEXSEEK`
  retained". All pass against the fix.
- *The two flagged shape changes were untested.* Added six spec cases. Confirmed:
  `cast(t.a as text) = u.y` binds to `u.y` with `bindingKind: 'correlated'`,
  `correlated: true`, and the `CastNode` retained in `valueExpr` — a valid correlated seek
  on `u`, strictly better than the old (wrong) binding to `t.a`. `cast(t.a) = t.b` declines
  (same-table value is unknown until the row is scanned). `t.a = cast(u.y as text)` still
  seeks `t.a`. `col IN (cast(1 as text))` declines; `col IN (cast(1 as real))` extracts
  `IN (1)`.
- *Thin `.sqllogic` fixture.* Three text rows only exercised a text/number storage-class
  mismatch. Added a `real primary key` group (`cast(v as integer)` truncates: `1.0` and
  `1.5` both match `= 1`) and a `blob primary key` group (`cast(b as text)` hex-encodes),
  so the regression is pinned for converting casts that never leave the numeric domain and
  for a non-comparable domain. Both keep the indexed/non-indexed pairing.
- *Stale jsdoc on `isNoOpCast`* (`scalar-invertibility.ts`) claimed a single consumer
  (`coarsened-key.ts`); there are now three. Rewritten to name it as the one definition of
  "value-preserving cast" shared by every wrapper-discarding analysis.
- *`docs/optimizer.md` documented the rule only under the sat-checker's "out of scope"
  bullet*, ~1200 lines away from the Constraint Extraction bullet a reader consults for
  extractable shapes. Added the wrapper rule there, including the `bindingKind` exception
  and pointers to both test files.

**Verified, no change needed:**

- *`isNoOpCast`'s soundness rests on stored values matching their declared column type.*
  Confirmed they do — DML coerces on write (`emit/constraint-check.ts`'s `coerceNewSection`
  and the "already-coerced stored rows" invariant in `emit/dml-executor.ts`), so a `text`
  column never holds a number and `cast(x as text)` over one is genuinely value-preserving.
- *`CastNode.getType()` preserves `collationName`/`collationSource` for textual targets*
  (`nodes/scalar.ts`), so unwrapping a no-op cast on a `NOCASE` column cannot silently
  reclassify the comparison's effective collation. The covered-key and OR-collapse collation
  gates (`equalityConstraintCollationOk`, `orBranchConstraintCollationOk`) are unaffected by
  the stricter unwrap; `columnSideOf` still resolves the column operand.
- *The implementer's dormancy claim for `rule-sargable-range-rewrite.ts`.* Checked
  `rangeRewriteIn`: the base `PlanNode` implementation returns `undefined` and only
  `ScalarFunctionCallNode` overrides it, so a `CastNode` candidate side always declines
  before the unconditional `unwrapCast` can matter; the literal side is constant-folded
  before the rule runs. Dormant, correctly recorded as a `NOTE:` at the helper, not a ticket.

**Tripwires (conditional; recorded at the code site, not filed as tickets):**

- `isNoOpCast` compares `logicalType` by object identity (registry singletons). A
  plugin-registered type duplicating a builtin's name as a distinct object would classify a
  genuine no-op cast as converting — conservative (loses pushdown), never wrong. `NOTE:` at
  `scalar-invertibility.ts` `isNoOpCast`.
- The value-preservation guarantee above depends on strict column typing. If Quereus ever
  adopts SQLite-style loose typing, every `isNoOpCast` caller becomes unsound. `NOTE:` at
  the same site (architectural, but it has exactly one code home).
- `rule-sargable-range-rewrite.ts`'s `unwrapCast` strips converting casts. `NOTE:` at that
  helper naming both assumptions that keep it dormant.
