description: Extend the existence-flag probe matcher in `rule-semijoin-existence-recovery` to recognize the `IS [NOT] TRUE/FALSE` probe normal forms, widening the set of `left join … exists … as` queries that recover a semi/anti access path. Builds directly on the new unary operators landed by `is-bool-predicate-support`. `flag is not null` (a constant `true` for the never-null flag) must NOT fire. CASE-wrapped probes are explicitly out of scope (rationale below).
prereq: is-bool-predicate-support
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (classifyProbe, ~L338-367; doc table ~L57-67), packages/quereus/src/planner/nodes/scalar.ts (UnaryOpNode), packages/quereus/src/planner/nodes/join-utils.ts (EXISTENCE_FLAG_TYPE — flag is non-null), packages/quereus/test/logic/ (existing semijoin-existence-recovery .sqllogic + new cases)
----

## Context

`ruleSemijoinExistenceRecovery` rewrites a probe-only `left join … exists right
as` flag into a semi/anti join. Its `classifyProbe` currently accepts four probe
normal forms (each normalized via `normalizePredicate` first):

| Form         | Node shape after normalize                       | Polarity |
|--------------|--------------------------------------------------|----------|
| `f`          | `ColumnReferenceNode`, `attributeId === flagId`  | semi     |
| `not f`      | `UnaryOpNode` NOT over that colref               | anti     |
| `f = true`   | `BinaryOpNode` `=`, flag colref vs `true`        | semi     |
| `f = false`  | `BinaryOpNode` `=`, flag colref vs `false`       | anti     |

This ticket adds the `IS [NOT] TRUE/FALSE` forms. The flag's type
(`EXISTENCE_FLAG_TYPE`) is `{true,false}`, **provably non-NULL** (`nullable:
false`; `emitLoopJoin` pre-computes matched=true / unmatched=false). That
non-nullability is what makes the `IS NOT TRUE` / `IS NOT FALSE` collapses exact:

| Form (over the non-null flag) | Equivalent | Polarity |
|-------------------------------|------------|----------|
| `f is true`                   | `f = true` | semi     |
| `f is not false`              | `f = true` | semi     |
| `f is false`                  | `f = false`| anti     |
| `f is not true`               | `f = false`| anti     |

After `is-bool-predicate-support`, each form is a `UnaryOpNode` whose operator is
one of `IS TRUE` / `IS NOT TRUE` / `IS FALSE` / `IS NOT FALSE` and whose operand
is the flag `ColumnReferenceNode`. `normalizePredicate` leaves these unchanged (a
non-`NOT` unary just recurses its operand), so `classifyProbe` can match the
operator directly.

## Implementation

In `classifyProbe` (after the existing colref / `NOT` / `= true|false` branches),
add a branch:

```ts
if (n instanceof UnaryOpNode && isFlagColRef(n.operand, flagId)) {
    switch (n.expression.operator) {
        case 'IS TRUE':
        case 'IS NOT FALSE': return 'semi';
        case 'IS FALSE':
        case 'IS NOT TRUE':  return 'anti';
    }
}
```

(The existing `NOT` branch already special-cases `UnaryOpNode` with operator
`NOT`; keep it. The new switch only matches the four boolean-test operators, so
`IS NULL` / `IS NOT NULL` fall through and return `null` — abstain.)

Update the "Accepted probe normal forms" table in the rule's header doc (Q2,
~L57-67) to list the four new rows and drop the "deferred to
`existence-probe-richer-forms`" note for `IS [NOT] TRUE/FALSE`. Note in the doc
that `IS NOT TRUE` / `IS NOT FALSE` polarity relies on the flag being non-null.

## CASE forms — out of scope (decision)

`case when flag then … end`-style probes are **dropped from scope**, not
deferred again:

- A `case` returns its THEN/ELSE value (e.g. integer `1`/`0`), so `where case
  when flag then 1 else 0 end` is a truthiness-of-integer filter, a different
  shape than a boolean probe — recognition would need bespoke CASE-shape matching
  (single base-less WHEN = flag colref, THEN truthy-const, ELSE falsy-const, no
  other branches) for each polarity.
- Constant folding does **not** reduce it: the WHEN depends on the (non-constant)
  flag, so no upstream pass collapses it to a bare colref.
- It is a contrived way to write `where flag`; the value/complexity ratio is poor
  and the matcher surface is fragile.

If a real workload ever produces CASE-wrapped existence probes, file a fresh
backlog ticket then. No code or test is owed here for CASE.

## Edge cases & interactions

- **`f is not null` must NOT fire.** The flag is non-null, so `f is not null` is a
  constant `true` — it is `UnaryOpNode` operator `IS NOT NULL`, which the new
  switch does not list ⇒ `classifyProbe` returns `null` ⇒ rule abstains. Add an
  explicit rejection test asserting the plan keeps the `left join` + flag (no
  semi/anti rewrite) and returns all left rows. Likewise `f is null` (constant
  false) must not fire.
- **Polarity correctness on fan-out.** SEMI recovery still requires the existing
  `rightMatchesAtMostOne` fan-out guard (a left row matching K>1 right rows makes
  `where f` keep K rows vs semi's 1). The new `is true` / `is not false` forms are
  SEMI and ride the **same** guard — confirm a non-unique right side abstains for
  them too (don't bypass the guard in the new branch). ANTI forms (`is false` /
  `is not true`) are fan-out-immune as before.
- **Sole-probe / demand-shape unchanged.** The new forms still flow through
  `analyzeChain`'s "exactly one conjunct references flagId, in an accepted probe
  shape" check; `referencesAttr` already descends the unary operand. A second
  reference to the flag (e.g. `f is true and f = something`) must still
  disqualify.
- **Normalizer interaction.** Confirm `normalizePredicate(f is not true)` returns
  the `UnaryOpNode` unchanged (it must not rewrite into `NOT (f is true)`), so the
  matcher sees the bare operator. `not (f is true)` (a `NOT` wrapping the unary,
  which a user could write) is NOT one of the accepted forms — the rule abstains;
  that is acceptable (still correct, just unoptimized) — note it, no test owed.
- **Termination / write-half safety** are unchanged from the base rule (output is
  a semi/anti join with no existence spec; a writable flag lands in `demanded` and
  abstains). No new reasoning needed.
- **Store path untouched** — pure planner rewrite, byte-identical rows. `yarn
  test` (memory vtab) is sufficient; do not run `test:store`.

## TODO

- Add the `UnaryOpNode` boolean-test branch to `classifyProbe`.
- Update the rule's Q2 doc table (add four rows; note non-null reliance; remove
  the deferral note).
- Tests (extend the existing `semijoin-existence-recovery` `.sqllogic`, or a
  sibling file):
  - One happy-path recovery per new form — assert the rewrite fires and rows
    match the baseline `where f` / `where not f`:
    - `where h is true` ⇒ semi (rows WITH a match)
    - `where h is not false` ⇒ semi
    - `where h is false` ⇒ anti (rows with NO match)
    - `where h is not true` ⇒ anti
    Verify recovery via a plan assertion (semi/anti join present, flag column
    gone) consistent with how the base rule's tests assert.
  - Rejection: `where h is not null` does NOT rewrite (flag-bearing `left join`
    retained; all left rows returned). Optionally `where h is null` likewise.
  - A fan-out (non-unique right) case for `where h is true` confirms the SEMI
    guard still abstains.
- Build + typecheck + lint + `yarn test` green; stream output with `tee`.
