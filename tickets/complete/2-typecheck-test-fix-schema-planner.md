description: Fixed the schema/planner/optimizer/func/util cluster of stale TypeScript errors in test/ (the remaining 70). With the prereq landed, `tsc -p tsconfig.eslint.json --noEmit` reports ZERO errors across the whole type-aware test program. Reviewed and accepted: all edits are type-only or behavior-preserving; diff is strictly test-scoped.
files:
  - packages/quereus/test/function-type-guards.spec.ts
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts
  - packages/quereus/test/lens-access-form-matcher.spec.ts
  - packages/quereus/test/optimizer/pass-manager.spec.ts
  - packages/quereus/test/planner/framework.spec.ts
  - packages/quereus/test/schema-differ.spec.ts
  - packages/quereus/test/schema/differ-alter-column.spec.ts
  - packages/quereus/test/planner/stats/catalog-stats.spec.ts
  - packages/quereus/test/optimizer/statistics.spec.ts
  - packages/quereus/test/optimizer/scalar-cse.spec.ts
  - packages/quereus/test/optimizer/binding-collector.spec.ts
  - packages/quereus/test/optimizer/const-pass.spec.ts
  - packages/quereus/test/fuzz.spec.ts
  - packages/quereus/test/property.spec.ts
  - packages/quereus/test/capabilities.spec.ts
  - packages/quereus/test/boundary-validation.spec.ts
  - packages/quereus/test/util/hrtime.spec.ts
  - packages/quereus/test/emit-roundtrip-comparator.ts
  - packages/quereus/test/plan/_helpers.ts
  - packages/quereus/test/query-rewrite.spec.ts
  - packages/quereus/test/planner/constraint-extractor.spec.ts
  - packages/quereus/test/planner/validation.spec.ts
  - packages/quereus/test/covering-structure.spec.ts
  - packages/quereus/test/plugins.spec.ts
  - packages/quereus/test/schema/catalog.spec.ts
----

# Complete: schema/planner/optimizer/func/util test type-drift fixes

Resolved the remaining 70 stale `tsc` errors in `packages/quereus/test/` — the
sibling cluster to `typecheck-test-fix-runtime-emit`. With both landed, the whole
type-aware test program (`tsconfig.eslint.json`) type-checks **clean (0 errors)**.
These errors were invisible to CI because `tsconfig.test.json` excludes `test/` and
mocha runs `transpileOnly`; the follow-on `typecheck-test-gate` ticket
(`tickets/implement/3-typecheck-test-gate.md`) wires the CI gate and runs the full
test matrix.

The implementation was type-only / behavior-preserving by design and confined
entirely to `test/`. The review below independently re-verified that.

## Review findings

### What was checked
- **Full implement diff** read with fresh eyes (commit `5ef0edf7`), all 25 changed
  test files, before the handoff summary.
- **Scope** — confirmed the commit touches *only* `packages/quereus/test/**` (plus
  the ticket move). No `src/`, `tsconfig*.json`, or `package.json` changes. The
  source-side type definitions the tests align to (`ScalarType` affinity removal,
  `RelationType` new fields, `OptContext.depth` removal, `RuleHandle.sideEffectMode`
  requirement, `SchemaDiff`/`ForeignKeyConstraintSchema` new fields, `FromClause[]`,
  `TableSchema.primaryKey` removal) are owned by prior/landed work, not this ticket.
- **Type check** — `npx tsc -p tsconfig.eslint.json --noEmit` → **0** `error TS`
  (re-ran independently; was 70 on top of the landed prereq).
- **Lint** — `yarn lint` (eslint, the only lint script in the monorepo) → **clean,
  exit 0**.
- **Tests** — ran every touched spec + the comparator consumers in two foreground
  batches: **1245 passing, 0 failing** (689 + 556), independently reproducing the
  handoff's count. Includes the behavior-adjacent specs (`property`, `fuzz`,
  `function-type-guards`, `expression-fingerprint`, `constraint-extractor`,
  `schema-differ`, `differ-alter-column`, `hrtime`, `pass-manager`, `framework`)
  and the `assertAstEquivalent` consumers (`emit-roundtrip-property`,
  `declarative-equivalence`).
- **`sideEffectMode:'safe'` correctness** — the four test rule literals in
  `pass-manager.spec.ts` are children-preserving structural rewrites
  (`makeNode(Project/Filter, [...node.getChildren()])`), which matches the source
  registry's documented `'safe'` definition (no subtree moved/dropped/duplicated).
  Correct.
- **`[undefined]→[null]` edit** (`constraint-extractor.spec.ts`) — traced the test:
  `computeCoveredKeysForConstraints` bails on `correlated:true` before inspecting
  `value`, and `[null]` preserves the singleton-IN length. Element value is inert;
  the assertion (`does NOT cover`) is unaffected. Confirmed.
- **`assertAstEquivalent` `AstNode`→`unknown` widening** (`emit-roundtrip-comparator.ts`,
  a file outside the ticket's original set) — widening a parameter type is
  contravariant and cannot break callers; the internal `astEquivalent` already
  takes `unknown` and walks arrays structurally. `util/schema-equivalence.ts` (the
  consumer with the two original errors) was left unchanged and still passes.
  Accepted as the honest callee-side fix.

### What was found
- **No correctness defects, no regressions, no new bugs.** The change does exactly
  what it claims.
- **Minor (accepted, no action): mild scope-creep on two fixtures.** In
  `function-type-guards.spec.ts` and `expression-fingerprint.spec.ts`, several
  `flags: 0` literals were changed to `FunctionFlags.UTF8` (or
  `UTF8 | (deterministic ? DETERMINISTIC : 0)`). `flags: 0` was already type-valid,
  so this part of the edit was not strictly required by the type fix. However it is
  behavior-equivalent for the guards/classifiers under test, preserves the
  `DETERMINISTIC` bit that `expression-fingerprint`'s non-deterministic-guard tests
  depend on, matches the source idiom (real registered functions set UTF8), and all
  affected tests pass. Left as-is — reverting would be churn for a fixture that is
  arguably now more realistic.
- **Minor (accepted): `db as any` ×3 in `plugins.spec.ts`.** Bridges the
  src↔dist `Database` module-identity mismatch with a narrowly-scoped, commented
  cast, avoiding a dependency on a freshly-built `dist/` artifact under ts-node.
  The file already opts into `any` pervasively. The alternative (a real package
  self-import) is a source-side/build concern, plausibly the gate ticket's
  territory — not worth a separate ticket.
- **Minor (accepted): isolated `as any` / `as unknown as T` casts** in
  `validation.spec.ts` (`scanD as any` — matches the file's existing `scanX as any`
  `MockPlanNode` idiom), `plan/_helpers.ts` (`PlanRow`), and `query-rewrite.spec.ts`
  (partial-AST `QueryExpr` stub). Constructing full shapes would change behavior;
  the casts are the correct call and in-style.
- **`@ts-expect-error` ×3** in `boundary-validation.spec.ts` for the negative
  `physicalType` cases — all three are consumed (proven by tsc=0; an unused
  directive would surface as TS2578). Correct.

### What was done
- **Minor findings:** fixed inline → none required. All minor items are either
  already correct or accepted-as-is with rationale above; no inline edits were
  needed in this review pass.
- **Major findings:** none → no new `fix/`/`plan/`/`backlog/` tickets filed.
- **Docs:** none required. This is test-fixture type alignment; no `docs/` file or
  README reflects these fixtures, and the underlying source type definitions are
  documented elsewhere and owned by prior work.

### Gaps (accepted, covered downstream)
- Full `yarn test` across all workspaces was **not** run here (the change is
  compile-only / behavior-preserving and the targeted run covered every changed
  spec). This is genuinely covered: `tickets/implement/3-typecheck-test-gate.md`
  owns wiring the CI gate and running the full matrix.
- No `.pre-existing-error.md` written — no unrelated/pre-existing failures surfaced
  during verification.

## End
