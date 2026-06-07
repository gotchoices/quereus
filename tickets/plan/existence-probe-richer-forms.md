description: Extend the existence-flag probe detector used by `semijoin-existence-recovery` (and its siblings) to recognize richer boolean-probe normal forms beyond the bare `flag` / `not flag` / `flag = true|false` set the base rule ships. Candidates: `flag is true`, `flag is false`, `flag is not true`, `flag is not false`, and `case when flag then … end`-style probes that reduce to a pure boolean filter. Each additional accepted form widens the set of queries that recover a semi/anti access path.
prereq: semijoin-existence-recovery
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (probe normal-form matcher), packages/quereus/src/planner/analysis/predicate-normalizer.ts (how IS [NOT] TRUE/FALSE and CASE normalize), packages/quereus/src/planner/nodes/scalar.ts (UnaryOpNode / BinaryOpNode / CaseExprNode representation)
----

## Why deferred

`semijoin-existence-recovery` ships a deliberately small, provably-correct probe
set (`flag`, `not flag`, `flag = true|false`). The `IS [NOT] TRUE/FALSE` and
`CASE` forms require first confirming their AST/plan representation and that they
collapse cleanly to a single recognizable polarity under `normalizePredicate` —
research that is orthogonal to the core rewrite and better batched.

## Scope

- Determine how `flag is true` / `is not false` etc. are represented after
  parsing + `normalizePredicate` (a dedicated operator? a `BinaryOp`? a
  `UnaryOp`?). Map each to semi (true) / anti (false) polarity. Note `flag is
  not null` is a constant `true` (flag is NOT NULL) — must NOT be treated as a
  probe.
- Decide whether `case when flag then 1 else 0 end` (and truthiness wrappers)
  are worth recognizing, or whether constant-folding upstream already reduces
  them.
- Keep the rejection criteria airtight: any form whose truth value does not
  exactly partition L rows on the flag must NOT fire.
- Tests: one happy-path recovery per newly accepted form + a rejection test for
  `flag is not null`.
