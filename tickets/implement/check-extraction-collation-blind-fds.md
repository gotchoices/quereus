description: Fix CHECK collation soundness — (A) thread declared column collation into write-time CHECK enforcement (constraint-builder scope types omit collationName, so bare-column CHECK comparisons resolve BINARY, diverging from normal queries / ALTER validation / assertions / SQLite), and (B) add a schema-level value-discrimination gate to check-extraction so CHECK/assertion-derived value-level facts (FDs, ECs, valueEquality mirrors, pins, bindings, domains) are only minted when the enforcement comparison is BINARY for textual operands. Three reproduced false ≤1-row / empty-key claims at HEAD. A and B must land together (B alone leaves the R6 guard-discharge hole open; A alone widens unsoundness).
files:
  - packages/quereus/src/planner/building/constraint-builder.ts        # Part A: NEW/OLD scope types lack collationName (lines ~100-126)
  - packages/quereus/src/planner/analysis/check-extraction.ts          # Part B: gate all contribution kinds in handleEquality / recognizeGuardedBody / domains
  - packages/quereus/src/planner/analysis/comparison-collation.ts      # home for the schema-level (AST+ColumnSchema) variant of isValueDiscriminatingEquality
  - packages/quereus/src/planner/analysis/predicate-shape.ts           # possible home for a "subtree contains COLLATE" detector
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts     # third extractCheckConstraints caller — passes columnIndexMap only; needs column metadata too
  - packages/quereus/src/planner/nodes/reference.ts                    # getCheckExtraction consumer (no change expected; cache is schema-keyed, fine)
  - packages/quereus/src/schema/lens-prover.ts                         # getCheckExtraction consumers incl. enumerableDomain (protected by domain gating)
  - packages/quereus/test/planner/collation-soundness.spec.ts          # regression home (R1/R3/R6 + controls)
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts          # unit tests — extractCheckConstraints signature change
  - packages/quereus/test/optimizer/conditional-fds.spec.ts            # guarded-FD unit tests — same signature change
  - docs/optimizer.md                                                  # extend "Collation gate on equality facts" subsection
----

# CHECK collation: enforcement conformance fix + extraction value-discrimination gate

Producer site #7 of the `collation-blind-equality-fact-extraction` family.
That ticket gated every *typed-plan-node* equality-fact producer;
`check-extraction.ts` runs on raw AST + `TableSchema` and was missed. Fix
stage reproduced three live unsoundness shapes and resolved the enforcement
question.

## Reproduced at HEAD (fix stage, all verified by test)

**R1 — collate-wrapped CHECK body, unconditional form:**

```sql
create table t (id integer primary key, b text unique, c text,
                check (b = c collate nocase)) using memory;
insert into t values (1,'x','X');  -- accepted: enforcement honors the wrapper
insert into t values (2,'X','X');
select * from t where c = 'X';     -- 2 rows; isAtMostOneRow=true; keysOf=[[]] (empty key!)
```

Chain: `handleEquality` sees `b = <collate expr>`; the wrapped side is not a
bare column so `collectColumnNames` reduces it to `{c}` and mints FD `c → b`.
The filter pins `c` (BINARY, sound); closure adds `b`; the BINARY unique key
`{b}` is covered → false ≤1-row claim AND a false empty-key claim.

**R3 — guarded twin (implication-form CHECK), same wrapper shape:**
`check (status <> 'active' or b = c collate nocase)` + filter
`status = 'active' and c = 'X'` → same false claims over 2 rows.

**R6 — NO wrapper needed; guard-scope collation mismatch:**

```sql
create table g2 (id integer primary key, status text collate nocase,
                 b text unique, c text, check (status <> 'active' or b = c)) using memory;
insert into g2 values (1,'ACTIVE','p','X');  -- guard FALSE under today's BINARY CHECK eval → body unenforced
insert into g2 values (2,'ACTIVE','q','X');
select * from g2 where status = 'active' and c = 'X';  -- 2 rows; isAtMostOneRow=true; keysOf=[[]]
```

The filter comparison resolves NOCASE (declared), so `buildPredicateFacts`
mints the `status='active'` fact (passes the prior ticket's
"effective equals declared" gate) and `predicateImpliesGuard` discharges the
guard — but CHECK *enforcement* evaluated the guard disjunct BINARY, so the
'ACTIVE' rows bypassed the body. The prior ticket's discharge gate *assumes*
guard scopes are evaluated under declared collation; enforcement violates
that assumption today. Part A restores it.

## The enforcement decision (resolved in fix stage)

Write-time CHECK enforcement must honor **declared column collations** (and
explicit COLLATE wrappers, which it already honors). Root cause of today's
BINARY accident: `constraint-builder.ts` builds the CHECK scope's
`ColumnReferenceNode` types as `{typeClass, logicalType, nullable,
isReadOnly}` — **no `collationName`** — for both NEW (~line 100) and OLD
(~line 121) registrations. Every other column-reference site carries it
(`relationTypeFromTableSchema`, `columnSchemaToDef` in
`planner/type-utils.ts`). Evidence the omission is a bug, not a choice:

- `runtime/emit/alter-table.ts` ADD COLUMN backfill checks deliberately set
  `collationName` with a comment claiming write-time resolves the same way
  (it doesn't, today — live divergence).
- `validateBackfillAgainstChecks` (alter-table.ts:545) validates existing
  rows via plain SQL `select 1 from t where not (<check>)` — declared
  collations apply. ALTER-time validation and write-time enforcement
  disagree today.
- Assertion enforcement (`AssertionEvaluator`) compiles plain SQL — declared
  collations apply. Yet `assertion-hoist-cache.ts` feeds the same ungated
  `extractCheckConstraints`, so bare `col=col` assertion facts over
  NOCASE-declared columns are unsound **today** through that path.
- UNIQUE enforcement honors declared collation (completed ticket
  `unique-constraint-honors-column-collation`); SQLite resolves CHECK
  comparisons with declared column collations.

Operand-precedence (Quereus right-first vs SQLite left-first) stays as-is —
that is backlog `comparison-collation-precedence-conformance`, out of scope.

**Behavior changes Part A causes (intended, pin with tests):**
- `check (b = c)` with `c text collate nocase`: now accepts
  NOCASE-equal/BINARY-distinct pairs (today rejects — R2/R2b verified both
  operand orders reject at HEAD).
- `check (c = 'ABC')` with `c` NOCASE-declared: now accepts case-variants.
- Explicit wrappers keep winning over declared (`b = c collate binary` over
  a NOCASE column compares BINARY).
- Deferred CHECKs reuse the same compiled evaluator — follows automatically.

## Part B — the extraction gate

`extractCheckConstraints` needs per-column metadata (declared collation +
logical type) alongside `columnIndexMap`; thread from `TableSchema.columns`
at the `getCheckExtraction` / `assertion-hoist-cache` call sites (unit tests
construct a small column-info array). Put the schema-level rule next to
`isValueDiscriminatingEquality` in `comparison-collation.ts` and document
that it mirrors post-Part-A enforcement (declared collations + wrappers).

Rule per equality operand (AST level, conservative):
- bare column → contributes its declared collation (normalize; absent =
  BINARY); textuality from the column's logical type (mirror
  `isStaticallyNonTextual`: textual unless `isTextual !== true` &&
  `physicalType !== TEXT` && `name !== 'ANY'`).
- literal → contributes BINARY; textual iff string-valued.
- any other expression → contributes BINARY **only if** its subtree contains
  no non-BINARY COLLATE node AND every column referenced inside is
  BINARY-declared-or-non-textual (robust to unknown collation propagation
  through planner node types); textuality unknown → treat as textual.

Mint a value-level fact only when every collation either operand could
contribute is BINARY, or both operands are statically non-textual (mirrors
the both-sides rule of `isValueDiscriminatingEquality`).

Apply to ALL value-level contributions:
- `handleEquality`: col=col mirror FDs + EC pair; `∅→col` pin + constant
  binding from col=lit; one-way `col → col` FD from the
  `collectColumnNames` single-column path (the R1 shape).
- `recognizeGuardedBody`: all three shapes, especially the
  `valueEquality: true` mirror tags (the EC lift in `filter.ts`
  `activateGuardedFds` keys off them).
- **Domain constraints too** (`handleInequality`, BETWEEN, IN enum): a
  text-typed domain under non-BINARY enforcement collation over-claims
  (e.g. `check (c in ('a','b'))` under NOCASE admits 'A'; consumers include
  `ruleFilterContradiction` and lens-prover's `enumerableDomain` PutGet
  enumeration). Gate: skip text-domain contributions when the column's
  declared collation is non-BINARY or the compared operand carries a
  non-BINARY wrapper. Non-textual columns unaffected.
- Guard *scopes* (`recognizeNegatedGuard`) need NO new gate once Part A
  lands: discharge facts already pass the prior ticket's
  `buildPredicateFacts` gate (effective ∈ {BINARY, declared}), and
  `clauseEntailed` matches guard literals with BINARY `sqlValueEquals` —
  with enforcement on declared collation the filter rows are exactly/within
  the guard scope. Verify this reasoning in review of the diff; pin R6.
- A COLLATE wrapper inside a guard *scope* disjunct already makes the whole
  CHECK unrecognized (verified at HEAD: `columnIndexFromExpr` /
  `literalValue` reject collate nodes) — keep, and pin with a unit test.

Gated-away bodies are a completeness loss only, never a semantics change.
Sound shapes that must KEEP extracting: BINARY-declared text columns
(controls), non-textual columns regardless of declared collation, explicit
`collate binary`-wrapped... note the last is already not recognized
(columnIndexFromExpr does not unwrap) — fine, do not add unwrapping.

## Why A and B must land in one commit

- B without A: R6 stays broken (its body is BINARY-clean; the hole is guard
  *enforcement* collation) unless B adds a guard-scope gate that A makes
  unnecessary.
- A without B: every bare col=col / col=lit / domain fact over
  declared-collation columns becomes unsound (today they are sound by
  accident under BINARY enforcement).
- B's gate is sound under both enforcement semantics (it only loses
  completeness under today's accident), so within the commit there is no
  ordering hazard.

## TODO

Phase A — enforcement
- [ ] Thread `collationName: tableColumn.collation` into the NEW and OLD
      scope types in `buildConstraintChecks` (constraint-builder.ts).
- [ ] Behavior pins (sqllogic or spec): bare `b = c` with NOCASE-declared `c`
      accepts NOCASE-equal pair (both operand orders); `c = 'ABC'` NOCASE
      column accepts 'abc'; explicit `collate binary` wrapper over NOCASE
      column still rejects case-variants; wrapper-honored R5 control stays;
      UPDATE-path CHECK referencing `old.col` resolves the same collation;
      deferred CHECK (deferrable constraint) consistent with immediate.

Phase B — extraction gate
- [ ] Add schema-level value-discrimination helper (comparison-collation.ts)
      operating on AST operands + per-column {collation, logicalType};
      include a "subtree contains non-BINARY COLLATE" walker
      (predicate-shape.ts is a natural home).
- [ ] Extend `extractCheckConstraints` signature with column metadata;
      update `getCheckExtraction`, `assertion-hoist-cache.ts`, and unit-test
      call sites (check-derived-fds.spec.ts, conditional-fds.spec.ts).
- [ ] Gate handleEquality (all three shapes), recognizeGuardedBody (all
      three shapes incl. valueEquality tags), and domain contributions
      (inequality ranges, BETWEEN, IN enums) for textual operands.
- [ ] Pin: COLLATE wrapper in a guard scope keeps the whole CHECK skipped.

Phase C — regression + validation
- [ ] collation-soundness.spec.ts: R1, R3, R6 (rows=2, isAtMostOneRow=false,
      no empty/over-claimed key), plus an assertion-hoist shape over
      NOCASE-declared columns minting no value FDs.
- [ ] Sound controls: BINARY text columns keep CHECK FDs/EC/pins/domains;
      INTEGER column with (inert) declared collation keeps facts;
      declared-NOCASE guard discharge works end-to-end post-A where genuinely
      sound (filter literal BINARY-equal to guard literal).
- [ ] Sweep existing sqllogic suites for tests pinning today's BINARY CHECK
      enforcement over collated columns (40.2-check-extras,
      41.4-alter-add-column-constraints, 03-expressions) and update
      intentionally-changed expectations.
- [ ] docs/optimizer.md "Collation gate on equality facts": add the
      check-extraction producer + enforcement-mirroring note; brief CHECK
      collation semantics note in docs/sql.md if CHECK semantics are
      documented there.
- [ ] Full `yarn test` + `yarn workspace @quereus/quereus run lint`.
