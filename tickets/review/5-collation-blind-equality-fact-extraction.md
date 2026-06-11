description: Implemented — collation gating of plan-time equality facts. Confirmed soundness bug fixed at five extraction sites (FD pins/ECs/bindings, guard-discharge facts, covered-key witnesses, logical join equi-pairs, physical join equi-pairs) plus one discovered adjacent producer hole (unique-index key promotion with finer-than-declared index collation). Shared runtime-mirroring collation helper added; sound-by-accident invariants pinned (CollateNode non-injectivity, Cast-only unwrap); Key Soundness net extended with a mixed-case text zoo and collation-aware key checking. All repro shapes 1–4 verified fixed with regression tests; full workspace suite + lint green.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # NEW — shared effective-collation helpers + isValueDiscriminatingEquality
  - packages/quereus/src/planner/util/fd-utils.ts                          # extractEqualityFds gate; buildPredicateFacts per-conjunct gates (new declaredCollationOf param on predicateImpliesGuard)
  - packages/quereus/src/planner/nodes/filter.ts                           # threads declaredCollationOf into guard activation
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # covered-key equality gate (equalityConstraintCollationOk); unwrapCast pin comment
  - packages/quereus/src/planner/nodes/join-node.ts                        # extractEquiPairsFromCondition value-discriminating gate + pinned collate-wrapper exclusion
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts         # physical-selection extractor: matched-collation gate ('=' pairs + USING)
  - packages/quereus/src/planner/type-utils.ts                             # enforcementCollationCoversDeclared — unique-index key-promotion gate
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # effectivePredicateCollation now delegates to the shared helpers
  - packages/quereus/src/planner/nodes/scalar.ts                           # CollateNode non-injectivity pin comment
  - packages/quereus/test/planner/collation-soundness.spec.ts              # NEW — deterministic regression net (21 tests)
  - packages/quereus/test/property.spec.ts                                 # Key Soundness: collation-aware key check + td/te zoo tables/shapes
  - docs/optimizer.md                                                      # new "Collation gate on equality facts" subsection; guard-discharge paragraph rewritten
----

# Collation-blind equality-fact extraction — implemented

## What changed and why

An equality conjunct only implies **value** equality when its effective
comparison collation is value-discriminating (BINARY for textual operands).
Every plan-time fact minted from equalities is a value-level claim, so each
extraction site now gates per conjunct. **Load-bearing discovery:** constant
folding (`const-pass.ts`) collapses `'bob' COLLATE NOCASE` into a
`LiteralNode` whose *type* still carries `collationName: 'NOCASE'` — so
shape-based exclusions (the CollateNode-not-unwrapped argument in the original
ticket) do NOT protect any site that sees optimized plans. The ticket's claim
that the covered-key path was "sound by accident" was therefore **wrong**:
repro 1's false ≤1-row claim came from `computeCoveredKeysForConstraints`
counting the folded NOCASE literal as a covering equality, not (only) from the
pins. All gates read operand **types**, which survive folding.

Gates, site by site:

1. **`extractEqualityFds`** (pins `∅→col`, `col=col` mirrors, EC pairs,
   constant bindings): conjunct must satisfy `isValueDiscriminatingEquality` —
   non-textual operands always pass; textual operands require every
   contributed collation to be BINARY (both sides checked, robust to
   resolution-order differences between emitters). Declared-NOCASE pins are
   gated away — the declared-collation ≤1-row case flows through the
   covered-key path instead (verified by control test).
2. **`buildPredicateFacts`** (guard discharge): `col=lit` facts require
   effective collation BINARY **or equal to the column's declared collation**
   (the ticket's wider gate — guard scopes are evaluated under declared
   collation at maintenance time; guard recognition is AST-level and rejects
   collate shapes, verified). `col=col` facts require both columns' collations
   to agree. TEXT range bounds require BINARY on both effective and declared
   (stricter than the ticket suggested because the subset check compares
   bounds under BINARY — the wider gate would be unsound for ranges; this
   incidentally closes a latent NOCASE-range discharge hole). IN facts pass
   through an always-true gate kept for future-proofing.
   `predicateImpliesGuard` gained a `declaredCollationOf` parameter (only
   caller: filter.ts).
3. **Covered-key detection** (`computeCoveredKeysForConstraints`): an `=`
   constraint counts only when effective collation is BINARY or equals the
   constrained column's declared collation (comparison at least as fine as the
   key's enforcement). Also hardens assertion row/group classification, which
   shares this function.
4. **Logical join equi-pairs** (`extractEquiPairsFromCondition`): pairs
   require `isValueDiscriminatingEquality`. Consumers (key coverage, FD/EC,
   FK alignment, join elimination, fanout-lookup, semijoin recovery, coverage
   prover) all assume value pairing. Collate-wrapped sides remain structurally
   excluded — pinned with comment + test.
5. **Physical join selection** (`equi-pair-extractor.ts`): '=' pairs require
   *matched* operand collations (not necessarily BINARY — hash/merge/bloom
   emitters are collation-aware, and matched collation makes their left-first
   resolution agree with the canonical right-first scalar rule). Mismatched
   conjuncts demote to the residual. USING pairs apply the same gate (whole
   extraction returns null on mismatch). This **changes observable results**
   for asymmetric-collation joins: previously a hash join compared
   NOCASE (left-first) where the NLJ/scalar form compares BINARY
   (right-first) — same query, different rows by algorithm. Now both run the
   canonical comparison. Related conformance decision (left vs right
   precedence vs SQLite) is already filed: backlog
   `comparison-collation-precedence-conformance`.
6. **Unique-index key promotion** (`relationTypeFromTableSchema`): a
   `create unique index (b collate binary)` over a NOCASE-declared column
   stores both 'Bob' and 'bob' (verified — enforcement follows the index
   collation), so promoting it to a relation key over-claimed NOCASE-output
   distinctness and observably eliminated a DISTINCT (returned 2 rows where 1
   is correct). Promotion now requires index collation == declared collation
   (or declared BINARY). PK promotion needs no gate: `findPKDefinition` copies
   the declared collation into the PK def and the memory PK comparators use it
   (verified by test).

The shared helper module (`planner/analysis/comparison-collation.ts`) mirrors
`emitComparisonOp` (right ?? left ?? BINARY), `emitIn` (condition), and
`emitBetween` (bound ?? expr) and is now used by fd-utils, the
constraint-extractor gate, both equi-pair extractors, and
rule-select-access-path's `effectivePredicateCollation` — one resolution,
no drift.

## Validation performed

- `packages/quereus/test/planner/collation-soundness.spec.ts` (21 tests, all
  deterministic): repro shapes 1–4; declared-collation ≤1-row controls;
  in-scope guard-discharge control; seek correctness over case-variants;
  CollateNode non-injectivity (unit); collated-projection key drop +
  NOCASE-dedup; collate-wrapped join-side exclusion; asymmetric join
  result-consistency vs the filter spelling + key-claim soundness check;
  matched-NOCASE join behavior; finer-index promotion gate + matching-index
  control; `extractEqualityFds` gate unit tests (BINARY pin extracts /
  NOCASE-declared and collate-wrapped don't / non-textual unaffected /
  col=col mixed collations contribute nothing).
- Key Soundness property net (`test/property.spec.ts`): key distinctness now
  checked under each column's **output collation** (NOCASE folds case, RTRIM
  folds trailing spaces; `isSet` stays value-based per the ticket); new
  mixed-case tables `td` (BINARY PK (s,u) + NOCASE column) and `te`
  (partial-unique scope) with deterministic sentinel rows guaranteeing
  case-variant collisions; 9 new zoo shapes (collated projection, collated
  pins ± covering, asymmetric self-join, out-of-scope/in-scope partial-unique
  discharge); negative self-test for the collation-aware fold.
- **Mutation check**: removing the covered-key gate reds the deterministic
  spec every time and the property net probabilistically (~1/3 of 50-run
  passes observed — the query draw is random; the deterministic spec is the
  hard gate).
- `yarn test` (all workspaces): green. `yarn workspace @quereus/quereus run
  lint`: clean. One unrelated flaky failure encountered once and documented in
  `tickets/.pre-existing-error.md` (fuzz differential: NULL-comparison filter
  diverges when predicate-pushdown is disabled; reproduced at HEAD).

## Known gaps / honest notes for review

- **Completeness losses (intentional, documented in docs/optimizer.md):**
  declared-NOCASE pins no longer produce constant bindings → EC-driven
  inference (`rule-predicate-inference-equivalence`) and filtered-view insert
  defaults (`attributeDefaults`) lose those entries (ticket says acceptable);
  collated TEXT range facts never discharge range guards; NOCASE=NOCASE
  logical equi-pairs produce no FD/EC/key-coverage facts (BINARY-only gate) —
  though the *physical* join path still claims keys soundly for
  matched-collation joins via its own gated extractor.
- **USING-join gate is untested directly** — no spec exercises USING with
  asymmetric declared collations (the gate returns null → generic join). Low
  risk (conservative direction) but a reviewer may want a case.
- `isStaticallyNonTextual` treats `ANY`-typed operands as potentially textual
  (physicalType NULL + validates anything); a custom plugin logical type that
  can hold text but sets neither `isTextual` nor TEXT physicalType would slip
  the escape hatch — only matters if it also carries a non-BINARY collation.
- The property net's negative power is probabilistic (random query draw);
  raising numRuns or weighting the collation shapes would strengthen it at
  test-time cost.
- `yarn test:store` was NOT run (per AGENTS.md it is reserved for
  store-specific diagnosis); the store module's enforcement collation is
  exactly the open question filed as backlog
  `unique-enforcement-collation-cross-module-audit`.

## Discovered bugs filed separately

- `fix/same-table-column-equality-seek-crash` — pre-existing runtime crash:
  `select * from t (b text primary key, c text) where b = c` plans the
  same-table column as a seek value and throws "No row context found".
  Reproduced at HEAD; includes a note that covered-key eqCols also counts the
  expression-bound equality (latent over-claim masked by the crash).
- `backlog/unique-enforcement-collation-cross-module-audit` — verify
  store/plugin uniqueness-enforcement collations against the new promotion
  gate's assumptions.
- `tickets/.pre-existing-error.md` — fuzz differential NULL-comparison
  divergence (runner triage).
