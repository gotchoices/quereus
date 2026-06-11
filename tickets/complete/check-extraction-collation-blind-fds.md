description: CHECK collation soundness fix, reviewed — (A) declared column collations thread into write-time CHECK enforcement scope types; (B) check-extraction gates all value-level facts (FDs, ECs, pins, bindings, domains) on a schema-level value-discrimination rule mirroring enforcement. Review confirmed both halves, refactored the triplicated AST walk, and spun off two pre-existing findings.
files:
  - packages/quereus/src/planner/building/constraint-builder.ts        # Part A: collationName on NEW/OLD scope types
  - packages/quereus/src/planner/analysis/comparison-collation.ts      # isValueDiscriminatingAstComparison + DeclaredColumnInfo
  - packages/quereus/src/planner/analysis/predicate-shape.ts           # walkAstNodes shared walker + collectCollateNames
  - packages/quereus/src/planner/analysis/check-extraction.ts          # gates on handleEquality / recognizeGuardedBody / domains; signature +columns
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts     # threads table.columns
  - packages/quereus/src/planner/util/fd-utils.ts                      # buildPredicateFacts doc comment extended
  - packages/quereus/test/planner/collation-soundness.spec.ts          # R1/R3/R6 + controls + assertion-hoist
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts          # gate unit tests
  - packages/quereus/test/optimizer/conditional-fds.spec.ts            # guarded-body gate + guard-scope COLLATE pin
  - packages/quereus/test/logic/40.2-check-extras.sqllogic             # Part A behavior pins
  - docs/optimizer.md                                                  # "Collation gate on equality facts" bullet
  - docs/sql.md                                                        # CHECK Constraints semantics block
----

# CHECK collation: enforcement conformance + extraction gate — complete

Producer site #7 of the `collation-blind-equality-fact-extraction` family.
Both halves landed together as the fix-stage analysis required.

## What was done

**Part A (enforcement).** `buildConstraintChecks` (constraint-builder.ts) sets
`collationName: tableColumn.collation` on both the NEW and OLD scope types it
registers for CHECK expressions. Write-time CHECK comparisons now resolve
declared column collations exactly like read-path queries, ALTER backfill
validation, the ADD COLUMN backfill hook, and assertion enforcement. Deferred
CHECKs reuse the same compiled evaluator.

**Part B (extraction gate).** Schema-level
`isValueDiscriminatingAstComparison(left, right, columnIndexMap, columns)` in
comparison-collation.ts (+ `DeclaredColumnInfo`). Per-operand rule: bare
column → declared collation + logical-type textuality; literal → BINARY,
textual iff string-valued; any other expression → BINARY only if the subtree
has no non-BINARY COLLATE node AND every column inside is
BINARY-declared-or-non-textual; textuality unknown ⇒ textual. Mint iff all
contributions BINARY, or both operands statically non-textual. Applied to all
`handleEquality` shapes, `recognizeGuardedBody` (incl. `valueEquality` mirror
tags), `handleInequality` ranges, BETWEEN (per-bound), and IN enums
(per-value). `extractCheckConstraints` takes a required 4th `columns` param;
`getCheckExtraction` and assertion-hoist thread the table's columns. Guard
*scopes* (`recognizeNegatedGuard`) deliberately ungated — verified sound, see
findings.

**Deviations (validated in review):**
- Operand-order pin: bare `check (c = b)` with NOCASE-declared `c` resolves
  b's implicit BINARY (right-operand-first `emitComparisonOp`), matching
  `select … where c = b`. The conformance property (enforcement ≡ read path)
  is what 40.2 pins; SQLite's left-first divergence stays in backlog
  `comparison-collation-precedence-conformance`.
- R6 repro reshaped: post-Part-A the original guard-bypassing rows are
  rejected at INSERT (that is the fix), pinned as INSERT rejection + a sound
  end-to-end discharge control.

## Review findings

Reviewed the implement diff (2c838e97) file-by-file with the runtime
resolution helpers, enforcement builder, and discharge gate open alongside.

**Verified correct (in scope):**
- Gate soundness direction: every branch of `astOperandContribution` errs
  conservative. `columnIndexFromExpr` returns undefined for `collate` nodes,
  so wrapped columns fall to the compound-operand branch where
  `collectCollateNames` + the per-column declared-collation sweep catch
  non-BINARY contributions however collation might propagate. Known
  conservative misses (no unsoundness): `b = (c collate binary)` with
  NOCASE-declared `c` is gated though the wrapper makes it BINARY; unary-minus
  literals fall to the compound branch (textuality unknown).
- The guard-scopes-ungated obligation from the fix ticket: walked all four
  guard-clause kinds against `buildPredicateFacts`' per-conjunct gates
  (fd-utils.ts:1176–1183). eq-literal: filter effective ∈ {BINARY, declared} ⇒
  filter rows ⊆ declared-collation guard scope (BINARY-equal implies
  collation-equal; declared-equal is exactly the scope); the BINARY
  `sqlValueEquals` literal match at discharge under-claims at worst.
  eq-column: requires matched operand collations, which equal the declared
  collation enforcement resolves. range: text bounds require BINARY effective
  AND BINARY declared — strictly finer than the guard scope. is-null:
  collation-inert. With Part A making CHECK guard disjuncts enforce under
  declared collations (pinned by R6), the chain is sound.
- Part A consistency: the new scope types match the alter-table.ts backfill
  attribute pattern; `shouldCheckConstraint` operation filtering and the
  deferred-check shared-evaluator claim check out. The sqllogic section pins
  both operand orders, literal/wrapper/override forms, UPDATE-path `old.c =
  c`, and the deferred subquery CHECK.
- Subquery operands cannot leak past the gate: `containsNonDeterministicCall`
  skips any CHECK containing `subquery`/`exists` nodes before extraction.
- Cache freshness: `getCheckExtraction`/assertion-hoist caches are WeakMaps
  keyed by TableSchema instance; ALTER swaps the instance, so collation
  changes re-evaluate the gate.
- Docs: optimizer.md bullet and sql.md CHECK block accurately describe the
  shipped behavior (precedence caveat included).
- Tests: gate unit tests cover mint/suppress for col=col, col=lit, wrapper,
  inert-collation, and all three domain kinds; e2e tests pin R1/R3/R6,
  assertion hoist, and both sound controls.

**Minor — fixed in this pass:**
- DRY: the new `collectCollateNames` was a third copy of the reflective
  AST-walk boilerplate (alongside `collectColumnNames` and
  `containsNonDeterministicCall`). Factored a shared `walkAstNodes` generator
  into predicate-shape.ts and rewrote all three over it (reflective walk kept
  deliberately — a typed visitor that missed a node kind would make the
  soundness gates silently blind). Similar pre-existing walkers in
  lens-prover.ts / assertion-classifier.ts left untouched (out of diff scope).

**Major — new tickets:**
- `fix/check-extraction-rowop-mask-transition-checks`: while walking the
  enforcement-vs-extraction conformance chain, found extraction never consults
  `check.operations` or `old.`/`new.` row-image qualifiers. Two **confirmed
  wrong-results repros** (pre-existing, reproduced at this ticket's HEAD): an
  insert-only CHECK's binding folds `where status='b'` to empty after a legal
  UPDATE; `check on update (old.a = b)` extracts as a same-row EC and returns
  0 of 2 matching rows. Full spec in the ticket.
- `backlog/write-path-scope-collation-conformance`: the handoff's noted gap —
  `buildNotNullDefaults` and the OLD/NEW attribute types in
  insert.ts/delete.ts still omit `collationName` (DEFAULT/RETURNING
  comparisons may diverge from the read path). Conformance only, no fact
  soundness impact; filed with site list.

**Explicitly empty categories:** no error-handling, resource-cleanup, or
type-safety findings — the change is pure analysis-time logic over immutable
AST/schema, adds no resources or exception paths, and the one structural-typing
seam (`DeclaredColumnInfo` ⊇ `ColumnSchema`) is deliberate and documented.

**Validation:** `yarn workspace @quereus/quereus run lint` clean; full
`yarn test` green twice (before and after the walker refactor — 5836 passing
in quereus, 9 pending; all other workspaces green).
