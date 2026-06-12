description: Column-vs-column comparisons resolve collation with right-operand precedence (emitComparisonOp), diverging from SQLite's left-operand rule — `a = b` with a NOCASE-declared left column and a plain TEXT right column compares BINARY ('Bob' = 'bob' is false where SQLite says true). Decide whether to align with SQLite or document the divergence as engine semantics, and pin whichever with tests.
difficulty: hard
files:
  - packages/quereus/src/runtime/emit/binary.ts                            # emitComparisonOp — right-else-left-else-BINARY
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # effectivePredicateCollation mirrors the same rule
  - docs/types.md                                                          # collation rules — currently silent on operand precedence
----

# Comparison-collation operand precedence: conformance decision

Observed (fix-stage probes, ticket `collation-weakening-key-claims`):

- `select a = 'bob' from t` with `a text collate nocase` holding `'Bob'` →
  **true** (literal carries no collation; left's NOCASE applies). Matches
  SQLite.
- `select a = b from t` with `a text collate nocase` = `'Bob'` and
  `b text` (default BINARY) = `'bob'` → **false**. SQLite applies the left
  operand's collation (NOCASE) and says true. Quereus's
  `emitComparisonOp` gives the right operand's `collationName` precedence
  whenever present, and declared columns carry an explicit collation name, so
  the comparison runs BINARY.

The engine is internally consistent — plan-time resolution
(`effectivePredicateCollation`) mirrors the runtime exactly, and the
collation-aware access-path covers and the FD-extraction gates key off the
same rule — so this is a *conformance/expectation* question, not a soundness
one. SQLite's full rule is: explicit `COLLATE` (anywhere in either operand
expression, leftmost/outermost wins) > left operand's column collation > right
operand's column collation > BINARY.

Decide:

- **Align with SQLite** (explicit-collate highest, then left, then right):
  touches `emitComparisonOp`, `emitIn`, BETWEEN bound resolution, and every
  plan-time mirror; the "explicit COLLATE beats declared column" part likely
  needs an explicit marker distinguishing a CollateNode-applied collation from
  a column-declared one (both currently flatten into `ScalarType.collationName`).
- **Or document the right-precedence rule** in docs/types.md as deliberate
  engine semantics and pin it with tests.

Either way, plan-time mirrors and runtime must change (or stay) together —
they are deliberately drift-coupled.

## Triage direction (2026-06-12, human sign-off)

SQLite conformance is explicitly a non-goal; good semantics is the goal. The
chosen direction follows the engine's existing philosophy (explicit conversions
over implicit coercion — see docs/types.md on cross-category comparisons):

- An explicit `COLLATE` anywhere in either operand expression wins
  (leftmost/outermost on conflict, or consider erroring on conflicting
  explicit COLLATEs too — settle in plan).
- Both operands carrying **different explicitly-declared** column collations,
  with no explicit `COLLATE` → **plan-time error** requiring the user to pick
  via `collate` (the least-surprising option: silently choosing either side is
  a coin flip the user cannot see).
- Exactly one operand carries a declared collation → use it (literals and
  collation-free expressions adopt the collated side, as today).
- Neither → BINARY.

`ColumnSchema.collationExplicit` already distinguishes a declared collation
from a session-default one — a defaulted collation should count as
"no preference" rather than triggering the conflict error. The plan pass must
still distinguish a CollateNode-applied collation from a column-declared one
(both currently flatten into `ScalarType.collationName`), and keep plan-time
mirrors (`effectivePredicateCollation`) and runtime in lockstep. Erroring is a
behavior change: sweep test/logic for now-erroring comparisons and add the
`collate` annotations they need.
