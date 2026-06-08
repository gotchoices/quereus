description: Reviewed the new prefix-NOT precedence matrix (`packages/quereus/test/logic/03.8-not-precedence.sqllogic`) and the one-line pointer replacing the old witness in `02-filters.sqllogic`. Matrix is semantically sound; lint + tests pass; no further changes required in this pass.
files:
  packages/quereus/test/logic/03.8-not-precedence.sqllogic
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/src/parser/parser.ts
----

## Review findings

### Diff-first read

Read `git show 6f3c8fcdc9d` before the implement-stage handoff.
Three files of substance:

- New 255-line `03.8-not-precedence.sqllogic`.
- 22-line shrink of `02-filters.sqllogic` (removed 5-row witness +
  comment header; left a 2-line pointer; kept the trailing
  `drop table t;` which still cleans up table `t` created at line 8).
- Ticket move (review → complete).

No source/runtime/optimizer code touched — pure test addition,
which aligns with the implement ticket scope.

### Semantics — re-derived by hand

Probe relation `p(id pk, v any null)` with rows `(1,5), (2,10),
(3,null)`. WHERE keeps a row only when the predicate evaluates to
true; null/false → excluded. I re-walked every block against the
three-valued truth table:

- **Comparison (= == <> != < <= > >=).** For every operator, the
  null row excludes (since `not (null op 5) = not null = null`).
  Non-null rows: `not (5 = 5)` = false, `not (5 < 5)` = true, etc.
  All 16 assertions match the truth table.
- **IN value/subquery (5,7).** v=5 in true → not false (excl);
  v=10 in false → not true (incl); v=null in null → not null
  (excl). Result `{10}` matches.
- **BETWEEN 3 and 7.** v=5 inside (excl); v=10 outside (incl);
  null excl. `{10}` matches.
- **LIKE '5' with `cast(v as text)`.** v=5 → '5' like '5' = true →
  not false (excl); v=10 → '10' like '5' = false → not true (incl);
  v=null → null like '5' = null → not null (excl). `{10}` matches.
- **IS NULL.** v=5/10 → is null false → not true (incl);
  v=null → is null true → not false (excl). `{5,10}` matches.
- **IS NOT NULL.** v=5/10 → is not null true → not false (excl);
  v=null → is not null false → not true (incl). `{null}` matches.
  This is the only block where the null row IS the surviving row;
  the file's comment calls this out.
- **EXISTS.** Non-correlated; inner reads p directly. v=5 exists
  → true → not false. v=99 not exists → false → not true. Both
  matches.
- **Stacked NOT.** `not not p` ≡ `p`. Smoke pairs match.
- **NOT bound by AND.** `not v = 5 and v < 5` (count=0) — for each
  row both conjuncts evaluate false or null → never true. Wrong-
  parse equivalent `not (v = 5 and v < 5)` (count=2) — v=5 and v=10
  each make the inner AND false, flipped to true; null excl. The
  discriminator has 2 rows of bite, exactly as advertised.
- **De Morgan.** `not (v in (5,7) or v = 10)` = `(not v in (5,7))
  and (not v = 10)`. Each non-null row hits one branch (v=5 hits
  IN, v=10 hits =10), so both forms return []. Null excl on both
  sides. `[]` matches.

NULL semantics are pedantically correct throughout.

### Parser cross-check

Confirmed the matrix actually exercises the fix and not just the
parenthesised form:

- `parser.ts:1208` defines `notExpression()`, called from
  `logicalAnd()` at `:1197` (above `isNull → equality → comparison`
  in the chain). `unary()` at `:1480` only handles `MINUS/PLUS/
  TILDE`, with a docblock that explicitly says prefix NOT lives
  higher up.
- Postfix `NOT IN/NOT BETWEEN/NOT LIKE` handled by the comparison
  loop at `parser.ts:1271-1351`, including `NOT IN (SELECT ...)`
  at `:1277`. All three postfix forms used in the matrix are
  parser-supported.
- `EXISTS` is a primary expression (`parser.ts:1605`), so the
  matrix's EXISTS block does not stress the precedence fix
  (already noted by the implementer); kept for regression against
  future parser rewrites.
- `==` and `!=` are first-class in `equality()` at `:1244`,
  mapped to `==`/`!=`/`=`. The matrix asserts the `==`/`!=`
  branches survive prefix-NOT properly.

### Negative-control trust

Did not re-run the negative control myself — the implementer's
log is specific (first comparison row turns red on revert) and
the parser layout above explains why every block would fail under
the pre-fix `unary()`-level NOT (the comparison rows reduce to
`(not v) op k` and exclude all rows; the IN/BETWEEN/LIKE rows
reduce analogously). Trust + verify against the parser shape
rather than re-running.

### Validation

- `yarn workspace @quereus/quereus run test` — 3247 passing,
  0 failing, ~47 s.
- `yarn workspace @quereus/quereus run lint` — exit 0, no output.

### Things checked but not changed

- **Docs.** `docs/architecture.md` § Testing Strategy (line 182+)
  describes `*.sqllogic` files at a category level and does not
  enumerate individual files. No edit required. Confirmed by grep
  that no doc references either filename.
- **`02-filters.sqllogic` trailing `drop table t;`.** Looks like
  a leftover at first glance, but table `t` is created at line 8
  for the predicate-inference tests and was always dropped at the
  end of the file; the pointer comment is just inserted before
  that drop. Keep as-is.
- **EXISTS row strength.** Implementer flagged this as a possible
  enhancement (`not exists (...) and X`). The AND-binding block
  already exercises `NOT … and X` via the comparison form, so
  duplicating it for EXISTS would be redundant; the existing
  EXISTS block adequately locks in the parse for future parser
  rewrites. Accepted as-is.
- **LIKE on string-typed probe.** Implementer offered to split out
  a string-typed probe table for LIKE. The `cast(v as text)`
  approach keeps one probe relation per file (per ticket guidance)
  and `cast(null as text)` returns null which preserves the
  null-row semantics. Accepted as-is.

### Findings disposition

- **Minor (fix in this pass):** none.
- **Major (file new ticket):** none.

The matrix does what the ticket asked: discriminates the correct
parse from the buggy one, exercises three-valued logic in every
block, and uses three equivalent forms (A/B/C) so any future
predicate added without recursing under prefix-NOT will diverge
loudly. Lint and tests pass.
