description: Complete — collation gating of plan-time equality facts, implemented and review-passed. Equality-derived value-level facts (FD pins/ECs/bindings, guard-discharge facts, covered-key witnesses, logical + physical join equi-pairs, unique-index key promotion) are now gated per conjunct on the comparison's effective collation, resolved by a shared runtime-mirroring helper module. All four repro shapes fixed with deterministic regressions plus a collation-aware Key Soundness property net. Review confirmed the implementation and surfaced two adjacent pre-existing collation holes (filed as fix tickets) plus a test-typecheck infrastructure gap (backlog).
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # shared effective-collation helpers + isValueDiscriminatingEquality
  - packages/quereus/src/planner/util/fd-utils.ts                          # extractEqualityFds gate; buildPredicateFacts per-conjunct gates
  - packages/quereus/src/planner/nodes/filter.ts                           # threads declaredCollationOf into guard activation
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # covered-key equality gate; Cast-only unwrap pin
  - packages/quereus/src/planner/nodes/join-node.ts                        # logical equi-pair value-discriminating gate
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts         # physical matched-collation gate ('=' pairs + USING)
  - packages/quereus/src/planner/type-utils.ts                             # enforcementCollationCoversDeclared — index key-promotion gate
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # effectivePredicateCollation delegates to shared helpers
  - packages/quereus/src/planner/nodes/scalar.ts                           # CollateNode non-injectivity pin
  - packages/quereus/test/planner/collation-soundness.spec.ts              # deterministic regression net (22 tests after review)
  - packages/quereus/test/optimizer/conditional-fds.spec.ts                # signature fix + 4 new collation-gate unit tests (review)
  - packages/quereus/test/property.spec.ts                                 # collation-aware Key Soundness net + td/te zoo
  - docs/optimizer.md                                                      # "Collation gate on equality facts" subsection
----

# Collation-blind equality-fact extraction — complete

## What landed (implement stage)

An equality conjunct implies **value** equality only when its effective
comparison collation is value-discriminating (BINARY for textual operands).
Six gates landed, all reading operand **types** (which survive constant
folding — `'bob' COLLATE NOCASE` folds to a literal whose type keeps NOCASE):

1. **`extractEqualityFds`** — pins / col=col mirrors / EC pairs / constant
   bindings require `isValueDiscriminatingEquality` (both sides checked for
   robustness to emitter resolution-order differences).
2. **`buildPredicateFacts`** (guard discharge) — `col=lit` facts require
   effective collation BINARY or equal to the column's declared collation;
   `col=col` facts require agreeing collations; TEXT range bounds require
   BINARY on both effective and declared (the subset check compares BINARY).
3. **Covered-key detection** — an `=` constraint counts only when its
   comparison is at least as fine as the key's enforcement collation
   (BINARY, or equal to declared).
4. **Logical join equi-pairs** — `isValueDiscriminatingEquality` required;
   collate-wrapped sides stay structurally excluded (pinned).
5. **Physical join selection** — '=' and USING pairs require *matched*
   operand collations; mismatches demote to residual / return null, so every
   algorithm agrees with the canonical scalar comparison.
6. **Unique-index key promotion** — an index whose per-column collation is
   finer than the declared column collation is not promoted to a relation
   key (declared-BINARY or equal-collation only).

Shared helper module `planner/analysis/comparison-collation.ts` mirrors
`emitComparisonOp` / `emitIn` / `emitBetween` resolution exactly and is used
by all gates plus the access-path collation-cover analysis. Sound-by-accident
invariants pinned in comments + tests: CollateNode non-injectivity,
constraint-extractor's Cast-only unwrap.

Validation: 21-test deterministic regression spec (repros 1–4 + controls),
collation-aware Key Soundness property net (output-collation folding,
mixed-case zoo tables with collision-guaranteeing sentinels), mutation check
on the covered-key gate, full workspace suite + lint green.

## Review findings

**Process:** read the implement diff fresh before the handoff summary;
verified every gate against the runtime emitters it claims to mirror
(binary.ts right-first, subquery.ts condition-collation, between.ts
bound-first, merge/bloom/hash left-first — all confirmed); traced every
producer of `op: '='` constraints, every `extractEquiPairsFromCondition` /
`extractEquiPairsFromUsing` caller, the USING path through logical key
derivation (join-utils never reads usingColumns — cross-product keys, sound),
and the EC/`valueEquality` producers upstream of filter activation; ran
lint + the full workspace test suite (green, 5805 passing in quereus) and
several hand repros against live shapes the tests don't cover.

**Checked and sound (no findings):**
- Gate semantics at all six sites, including the both-sides check in
  `isValueDiscriminatingEquality` and the coarser-index promotion direction
  (NOCASE-enforced unique over BINARY column correctly still promotes).
- Singleton-IN covered-key path needs no gate (emitIn compares under the bare
  condition column's declared collation = the key's enforcement collation);
  OR-collapsed INs always have ≥2 values, so they cannot reach the
  singleton-equality branch.
- `equalityConstraintCollationOk`'s permissive non-BinaryOp fallback is
  unreachable for '=' constraints today (only `extractBinaryConstraint`
  mints them) — pinned with a comment (minor, fixed inline).
- `ANY`-typed escape hatch matches `builtin-types.ts` (`name: 'ANY'`);
  `lt === undefined` treated as potentially textual (conservative).
- USING callers pass full `Attribute[]` so the structural `type?` widening
  always sees real collations.
- Docs (optimizer.md) verified against the code they describe.

**Minor findings (fixed in this pass):**
- `conditional-fds.spec.ts` still called `predicateImpliesGuard` with the old
  7-arg signature at 36 sites — undetected because no tool type-checks test
  files (see backlog finding below) and every case short-circuited at
  `effColl === 'BINARY'` before invoking the `undefined` callback. Fixed all
  36; added 4 unit tests that actually drive the `declaredCollationOf` paths
  (folded-NOCASE-literal rejection, equals-declared discharge, col=col
  mismatch vs match, TEXT-range BINARY/BINARY requirement with both failure
  directions).
- The USING asymmetric-collation gate was untested (flagged in the handoff) —
  added a regression: mismatched USING mints no key claims, generic join
  compares left-collation, duplicated left key not over-claimed.

**Major findings (filed as new tickets — both pre-existing at the implement
commit, same bug family, sites outside the ticket's list):**
- `fix/or-equality-collapse-collation-blind` — **proven wrong results**:
  `where b = 'bob' collate nocase or b = 'x' collate nocase` returns only
  BINARY matches because `tryCollapseOrToIn` (predicate-normalizer) rewrites
  OR-of-equalities into an IN that compares under the bare column's
  collation. Sibling collapses in constraint-extractor
  (`collapseBranchesToIn`, `tryCollapseToOrRange`) share the blindness, and
  the collapsed constraint's OR `sourceExpression` defeats the access path's
  collation-cover decline (boolean operands → BINARY).
- `fix/check-extraction-collation-blind-fds` — **proven false ≤1-row claim**:
  `check (b = c collate nocase)` is enforced under NOCASE (verified
  empirically) but `check-extraction.ts` mints a value-level determination FD
  from the body at AST level; closure then covers a BINARY unique key and
  `isAtMostOneRow` returns true over a 2-row result. Bare col=col CHECK
  bodies are sound today only because CHECK enforcement empirically compares
  BINARY even for NOCASE-declared columns (itself a conformance question the
  ticket records).
- `backlog/test-suite-typecheck-coverage` — `tsconfig.test.json` inherits
  `exclude: ["test"]` from the base config, so its test include is a no-op;
  ts-node is transpileOnly; ~136 pre-existing TS errors hide in test files
  (cause of the 36-call-site drift above).

**Known accepted limitations (documented, not findings):** declared-NOCASE
pins mint no constant bindings (EC inference / view insert-default
completeness loss); collated TEXT ranges never discharge range guards;
NOCASE=NOCASE logical equi-pairs mint no FD/EC facts (the physical path still
claims keys soundly via its own gate); the property net's negative power is
probabilistic (the deterministic spec is the hard gate); `yarn test:store`
deliberately not run — the store-side enforcement-collation question is
backlog `unique-enforcement-collation-cross-module-audit`.

**Validation after review edits:** targeted run of both edited specs
(135 passing), then full `yarn test` across all workspaces (green; 5805
passing in quereus) and `yarn workspace @quereus/quereus run lint` (clean).

## Related tickets

- `fix/or-equality-collapse-collation-blind` (review discovery)
- `fix/check-extraction-collation-blind-fds` (review discovery)
- `fix/same-table-column-equality-seek-crash` (implement discovery)
- `backlog/test-suite-typecheck-coverage` (review discovery)
- `backlog/unique-enforcement-collation-cross-module-audit` (implement)
- `backlog/comparison-collation-precedence-conformance` (pre-existing)
