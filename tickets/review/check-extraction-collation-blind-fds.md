description: Review CHECK collation soundness fix — (A) declared column collations now thread into write-time CHECK enforcement scope types; (B) check-extraction gates all value-level facts (FDs, ECs, pins, bindings, domains) on a schema-level value-discrimination rule mirroring enforcement. Landed together in one change as required.
files:
  - packages/quereus/src/planner/building/constraint-builder.ts        # Part A: collationName on NEW/OLD scope types
  - packages/quereus/src/planner/analysis/comparison-collation.ts      # isValueDiscriminatingAstComparison + DeclaredColumnInfo
  - packages/quereus/src/planner/analysis/predicate-shape.ts           # collectCollateNames subtree walker
  - packages/quereus/src/planner/analysis/check-extraction.ts          # gates on handleEquality / recognizeGuardedBody / domains; signature +columns
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts     # threads table.columns
  - packages/quereus/src/planner/util/fd-utils.ts                      # buildPredicateFacts doc comment extended (no code change)
  - packages/quereus/test/planner/collation-soundness.spec.ts          # R1/R3/R6 + controls + assertion-hoist (new describe)
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts          # gate unit tests + signature updates
  - packages/quereus/test/optimizer/conditional-fds.spec.ts            # guarded-body gate + guard-scope COLLATE pin + signature updates
  - packages/quereus/test/logic/40.2-check-extras.sqllogic             # Part A behavior pins (new section)
  - docs/optimizer.md                                                  # new bullet in "Collation gate on equality facts"
  - docs/sql.md                                                        # CHECK Constraints semantics block (collation + deferral)
----

# CHECK collation: enforcement conformance + extraction gate — implemented

Producer site #7 of the `collation-blind-equality-fact-extraction` family.
Both halves landed in this change, as the fix-stage analysis required.

## What was done

**Part A (enforcement).** `buildConstraintChecks` (constraint-builder.ts) now
sets `collationName: tableColumn.collation` on both the NEW and OLD scope
types it registers for CHECK expressions. Write-time CHECK comparisons now
resolve declared column collations exactly like read-path queries, ALTER
backfill validation (`validateBackfillAgainstChecks` compiles plain SQL), the
ADD COLUMN backfill hook (planner/building/alter-table.ts already set
`collationName` with a comment *claiming* write-time parity — now true), and
assertion enforcement. Deferred CHECKs reuse the same compiled evaluator and
were verified consistent.

**Part B (extraction gate).** New schema-level
`isValueDiscriminatingAstComparison(left, right, columnIndexMap, columns)` in
`comparison-collation.ts` (+ `DeclaredColumnInfo`; `ColumnSchema` is
structurally assignable). Per-operand rule, per the fix-stage spec: bare
column → declared collation + logical-type textuality; literal → BINARY,
textual iff string-valued; any other expression → BINARY only if the subtree
has no non-BINARY COLLATE node (`collectCollateNames`, new syntactic walker in
predicate-shape.ts) AND every column inside is BINARY-declared-or-non-textual;
textuality unknown ⇒ textual. Mint iff all contributions BINARY, or both
operands statically non-textual. Applied to: `handleEquality` (all three
shapes incl. the single-column `collectColumnNames` path — the R1 shape),
`recognizeGuardedBody` (all three shapes incl. `valueEquality` mirror tags),
`handleInequality` ranges, BETWEEN (per-bound), and IN enums (per-value).
`extractCheckConstraints` takes a required 4th `columns` param;
`getCheckExtraction` threads `tableSchema.columns`, assertion-hoist threads
`table.columns`. Guard *scopes* (`recognizeNegatedGuard`) deliberately
ungated — see "Verify this reasoning" below.

## Validation performed

- Full `yarn test` green (5836 passing in quereus + all other workspaces);
  `yarn workspace @quereus/quereus run lint` clean. No existing sqllogic
  expectations needed changes (sweep found 40.2's `code = code collate nocase`
  collation-neutral; 41.4 / 03-expressions have no CHECK+collation interplay;
  03.4-defaults' ADD COLUMN collation-parity pin now genuinely matches
  write-time).
- **Pre-fix failure demonstrated**: with `packages/quereus/src` stashed to
  HEAD, 5+ of the 7 new collation-soundness tests fail (R1/R3/R6 false-claim
  and divergent-enforcement shapes); all pass post-fix.
- New e2e regressions (collation-soundness.spec.ts): R1 (wrapped body, 2 rows,
  no ≤1-row/empty-key), R3 (guarded twin), R6 (NOCASE guard disjunct now
  rejects case-variant guard-scope rows at INSERT), R6 control (declared-NOCASE
  guard discharge produces a TRUE ≤1-row end-to-end), assertion-hoist twin of
  R1, BINARY control (sound CHECK FDs kept), NOCASE-declared col=col control.
- Gate unit tests (check-derived-fds.spec.ts): NOCASE col=col / col=lit mint
  nothing; `col = (col collate nocase)` mints nothing; `col = (col collate
  binary)` keeps the one-way FD; inert collation on INTEGER keeps pin/binding
  and numeric domains; NOCASE text domains suppressed (range/BETWEEN/IN).
- Guarded shapes (conditional-fds.spec.ts): NOCASE-declared guarded body mints
  no guarded FDs; collate-wrapped guarded body mints nothing; COLLATE wrapper
  in a guard-scope disjunct keeps the whole CHECK skipped (pinned).
- Part A sqllogic pins (40.2-check-extras, new section): bare col=col both
  spellings, col=lit case-variants, explicit `collate binary` override,
  NOCASE-wrapper control, UPDATE-path `old.c = c`, deferred (subquery) CHECK.

## Deviations from the ticket — reviewer attention

1. **Operand-order pin.** The ticket's Phase-A pin said bare `b = c` with
   NOCASE-declared `c` accepts the NOCASE-equal pair "(both operand orders)".
   That assumption does not hold under the engine's right-operand-first
   precedence (`emitComparisonOp`): a plain column carries an *explicit*
   `'BINARY'` collation string (ColumnSchema.collation defaults to 'BINARY'),
   so `check (c = b)` resolves b's BINARY and rejects — **exactly matching
   `select … where c = b`**, which I verified empirically returns 0 rows for
   the case-variant pair at HEAD. The conformance property (enforcement ≡
   read path) is the actual soundness requirement and is what the sqllogic
   section pins, with a comment pointing at backlog
   `comparison-collation-precedence-conformance` for the SQLite left-first
   divergence (explicitly out of scope per the ticket).
2. **R6 repro reshaped.** Post-Part-A the original R6 rows ('ACTIVE','p','X')
   cannot be inserted (that *is* the fix), so the false-≤1-row repro is no
   longer constructible. Pinned instead as: INSERT rejection (guard enforced
   under NOCASE) + the sound end-to-end discharge control.

## Verify this reasoning (review obligations from the fix ticket)

- **Guard scopes ungated**: discharge facts pass `buildPredicateFacts`'
  per-conjunct gate (effective ∈ {BINARY, declared}); `clauseEntailed` matches
  guard literals with BINARY `sqlValueEquals`; with Part A, CHECK guard
  disjuncts are enforced under declared collations, so filter rows are
  exactly/within the guard scope. Walked through eq-literal, eq-column, range
  (text ranges already require BINARY both ways — stricter), and is-null
  (collation-inert) clause kinds; R6 + R6-control pin it end-to-end. The
  fd-utils doc comment was extended to state the CHECK-guard half of the
  assumption. Reviewer should re-verify this chain against the diff.

## Known gaps / adjacent observations (not addressed, out of scope)

- `buildNotNullDefaults` (constraint-builder.ts) and the OLD/NEW *attribute*
  types built in planner/building/insert.ts still omit `collationName` — a
  comparison inside a DEFAULT expression (or possibly RETURNING) may still
  resolve BINARY against a declared-collation sibling. Not a fact-soundness
  issue (defaults are not extracted as facts); candidate follow-up ticket if
  considered worth conforming.
- The IN per-value gate is partially shadowed: a collate-wrapped IN value
  already bails at `literalValue` before the gate; the gate still matters for
  the textuality escape (string literals against non-textual NOCASE columns).
- `c text collate nocase check (c = 'abc')` column-level form: the NOCASE wins
  from either operand side since literals carry no collation — symmetric, no
  precedence caveat there.
- Cache invalidation: `getCheckExtraction` / assertion-hoist caches are keyed
  by TableSchema instance; ALTER (incl. SET COLLATE) swaps the instance, so
  the gate re-evaluates with fresh collations. Unchanged mechanism, verified
  by inspection only.
