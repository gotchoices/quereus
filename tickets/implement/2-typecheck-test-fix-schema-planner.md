description: Fix TypeScript drift errors in the schema/planner/optimizer/func/util test cluster (~70 of the 136 hidden test errors) so the entire type-aware test program type-checks clean. Second of three prereq-chained tickets.
prereq: typecheck-test-fix-runtime-emit
files:
  - packages/quereus/test/function-type-guards.spec.ts          # 12 — scalar type `affinity` removed, FunctionFlags, relation shape
  - packages/quereus/test/schema-differ.spec.ts                 # 9 — SchemaDiff new required fields; column `collation`
  - packages/quereus/test/schema/differ-alter-column.spec.ts    # 1 — same SchemaDiff drift
  - packages/quereus/test/fuzz.spec.ts                          # 9 — fast-check mapper param types; unknown narrowing
  - packages/quereus/test/optimizer/pass-manager.spec.ts        # 5 — OptContext.depth removed; RuleHandle shape
  - packages/quereus/test/planner/framework.spec.ts             # 2 — OptContext.depth; scalar type cast
  - packages/quereus/test/property.spec.ts                      # 3 — implicit any in mapper
  - packages/quereus/test/plugins.spec.ts                       # 3 — src vs dist Database nominal mismatch (JUDGE)
  - packages/quereus/test/planner/stats/catalog-stats.spec.ts   # 3 — ForeignKeyConstraintSchema new required fields
  - packages/quereus/test/optimizer/statistics.spec.ts          # 1 — same FK schema drift
  - packages/quereus/test/schema/catalog.spec.ts                # 3 — FromClause shape
  - packages/quereus/test/boundary-validation.spec.ts           # 3 — invalid PhysicalType (NEGATIVE → @ts-expect-error)
  - packages/quereus/test/util/hrtime.spec.ts                   # 3 — bigint vs number|Date
  - packages/quereus/test/util/schema-equivalence.ts            # 2 — ViewInsertDefault[] vs AstNode
  - packages/quereus/test/plan/_helpers.ts                      # 1 — PlanRow cast
  - packages/quereus/test/optimizer/scalar-cse.spec.ts          # 1 — SqlValue[] params
  - packages/quereus/test/optimizer/binding-collector.spec.ts   # 1 — SqlValue[] params
  - packages/quereus/test/optimizer/const-pass.spec.ts          # 1 — SqlValue[] params
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts # 1 — FunctionFlags
  - packages/quereus/test/planner/validation.spec.ts            # 1 — MockPlanNode vs RelationalPlanNode
  - packages/quereus/test/planner/constraint-extractor.spec.ts  # 1 — undefined vs JSONValue
  - packages/quereus/test/query-rewrite.spec.ts                 # 1 — QueryExpr cast
  - packages/quereus/test/lens-access-form-matcher.spec.ts      # 1 — ScalarFunctionSchema.implementation
  - packages/quereus/test/covering-structure.spec.ts            # 1 — number vs void|Promise<void>
  - packages/quereus/test/capabilities.spec.ts                  # 1 — TableSchema.primaryKey removed
difficulty: medium
----

# Fix schema/planner/optimizer/func/util test type drift

## Background

See `typecheck-test-fix-runtime-emit` (the prereq) for why ~136 type errors
hide in `test/`. That ticket fixed the runtime/emit/vtab cluster; **this ticket
fixes everything else (~70 errors)** so the whole type-aware test program reaches
**zero** errors. The follow-on `typecheck-test-gate` ticket then wires the
config/script/gate.

This ticket touches **no** tsconfig or package.json. Reuse any shared
`test/util/` type factory the prereq introduced rather than re-deriving shapes.

## How to verify

```
cd packages/quereus
npx tsc -p tsconfig.eslint.json --noEmit 2>&1 | tee /tmp/tc.log | grep -c "error TS"
```

After this ticket lands **on top of the prereq**, this must print `0`. (Stream
with `tee`; the run is ~60–90s.) These are compile-only edits — no runtime
behavior change — so a full test run is optional; a `yarn test 2>&1 | tee
/tmp/test.log; tail -n 40 /tmp/test.log` smoke check at the end is reasonable.

## Root causes (shared causes called out so you fix each once)

- **Scalar/relation type-shape drift** — `function-type-guards.spec.ts` (and the
  `framework.spec.ts` scalar cast) build scalar types with a removed `affinity`
  property and relation types missing `isReadOnly/isSet/keys/rowConstraints`,
  and use `0` where `FunctionFlags` is required. Same family as the prereq's
  `MockRelNode`/scalar shapes — reuse the shared factory. `FunctionFlags`: use
  the named enum value(s), not the literal `0` (also hits
  `optimizer/expression-fingerprint.spec.ts`).
- **`OptContext.depth` removed** — `optimizer/pass-manager.spec.ts` and
  `planner/framework.spec.ts` both pass `{ depth: ... }` into `OptContext`. Drop
  the field (or set the current equivalent). `pass-manager` also builds plain
  objects where `RuleHandle` is required — construct via the current
  rule-registration API instead of a bare literal.
- **`SchemaDiff` new required fields** — `schema-differ.spec.ts` (+
  `schema/differ-alter-column.spec.ts`) build `SchemaDiff` literals missing
  `maintainedModuleMigrations, viewTagsChanges, indexTagsChanges, lensToAttach,
  lensToDetach`, and a column literal missing `collation`. Add a small
  `makeEmptySchemaDiff()` helper in the spec (or `test/util/`) and spread it, so
  future field additions touch one place.
- **`ForeignKeyConstraintSchema` new required fields** —
  `planner/stats/catalog-stats.spec.ts` and `optimizer/statistics.spec.ts` build
  FK literals missing `referencedColumns, onDelete, onUpdate, deferred`. Fill in
  current defaults (factor a helper if it reads cleaner).
- **`SqlValue[] | SqlParameters` params** — `optimizer/{scalar-cse,
  binding-collector,const-pass}.spec.ts` pass `unknown[]`/`Record<string,
  unknown>` where typed params are required. Type the local as
  `SqlValue[]`/`SqlParameters` at the source.
- **fast-check mapper signatures** — `fuzz.spec.ts` and `property.spec.ts` pass
  `.map((e: string) => ...)` / mappers with implicit-any params where the
  arbitrary's element type is `unknown`/`string`. Annotate the mapper params to
  the arbitrary's actual element type; narrow `prev`/`curr` `unknown` before use.
- **Removed schema properties** — `capabilities.spec.ts` (`TableSchema.primaryKey`),
  `lens-access-form-matcher.spec.ts` (`ScalarFunctionSchema.implementation`
  now required) — align literals to the current schema.
- **Negative test → `@ts-expect-error`** — `boundary-validation.spec.ts` passes
  `PhysicalType` values `99 / 1.5 / -1` on purpose to exercise validation.
  Prefix each with `// @ts-expect-error invalid PhysicalType (boundary test)`.
- **`bigint` vs `number|Date`** — `util/hrtime.spec.ts` passes a `bigint` where
  `number|Date` is expected; convert with `Number(...)` or update to the current
  hrtime API.
- **AST/Row casts** — `plan/_helpers.ts` (`PlanRow`), `query-rewrite.spec.ts`
  (`QueryExpr`), `util/schema-equivalence.ts` (`ViewInsertDefault[]` vs
  `AstNode`), `schema/catalog.spec.ts` (`FromClause`),
  `planner/constraint-extractor.spec.ts` (`undefined` vs `JSONValue`),
  `planner/validation.spec.ts` (`MockPlanNode`), `covering-structure.spec.ts`
  (`number` vs `void|Promise<void>`) — each is a single isolated drift; follow
  the compiler and match the current type. Prefer constructing the correct shape
  over `as unknown as T`.

## Judgment-required (not mechanical)

- **`plugins.spec.ts` (3) — src vs dist `Database` nominal mismatch.** The error
  is `src/core/database` `Database` not assignable to `dist/src/core/database`
  `Database`. Cause: a workspace devDep (`@quereus/plugin-loader`) whose
  published types resolve `@quereus/quereus` to **`dist/`**, while the test's own
  `Database` comes from **`src/`** — two structurally-identical classes with
  distinct module identities. Resolve by importing `Database` in the test
  through the **same** path the plugin-loader API expects (the package entry,
  not a deep `src/` path), so both sides agree. If that proves impractical
  without a source-side change, a narrowly-scoped, commented cast is acceptable
  **as a last resort** — but call it out explicitly in the review handoff so the
  reviewer can decide whether a real fix (consistent package self-import) belongs
  in a follow-up. Do **not** silently paper over it.

## Edge cases & interactions

- **`@ts-expect-error` hygiene** — only on lines that genuinely fail to compile;
  an unused one becomes `TS2578`. Re-run the typecheck to confirm every one is
  consumed. Give each a one-line reason.
- **Shared-shape factories must match source exactly** — when you add
  `makeEmptySchemaDiff()` / FK / scalar-type helpers, derive field names from the
  current source types, not from memory. A helper that omits a *future* required
  field will reintroduce the exact class of bug this work exists to prevent.
- **Don't weaken source types.** All fixes live in `test/`. If a test cannot be
  made to type-check without changing a `src/` type, that's a real API question —
  document it in the handoff rather than editing source under this ticket.
- **No behavioral change.** Type-only edits. If matching the current type forces
  a different runtime value/assertion, the test was asserting stale behavior —
  flag it in the handoff instead of silently rewriting the assertion.
- **`dist` presence affects `plugins.spec.ts`.** That error's exact text depends
  on whether `dist/` exists. Verify your fix holds both with and without a fresh
  `dist/` (i.e. it shouldn't depend on a stale build artifact).

## TODO

- [ ] Confirm the prereq landed: baseline `tsc -p tsconfig.eslint.json --noEmit`
      should now show **only** this cluster's files.
- [ ] Fix the scalar/relation/FunctionFlags shapes (function-type-guards,
      framework, expression-fingerprint) — reuse the shared factory.
- [ ] Fix `OptContext.depth` + `RuleHandle` (pass-manager, framework).
- [ ] Fix `SchemaDiff` drift via a `makeEmptySchemaDiff()` helper (schema-differ,
      differ-alter-column).
- [ ] Fix `ForeignKeyConstraintSchema` drift (catalog-stats, statistics).
- [ ] Fix `SqlValue[]`/`SqlParameters` param typing (scalar-cse, binding-collector,
      const-pass).
- [ ] Fix fast-check mapper signatures + unknown narrowing (fuzz, property).
- [ ] Fix removed-property literals (capabilities, lens-access-form-matcher).
- [ ] Add `@ts-expect-error` to `boundary-validation` negative cases.
- [ ] Fix the remaining isolated casts/conversions (hrtime, schema-equivalence,
      _helpers, query-rewrite, catalog, constraint-extractor, validation,
      covering-structure).
- [ ] Resolve `plugins.spec.ts` src/dist mismatch (judgment note above).
- [ ] Verify: full `tsc -p tsconfig.eslint.json --noEmit` prints `0` errors.
- [ ] Review handoff: list `@ts-expect-error` additions, the plugins.spec
      resolution chosen, and any deferred stale-behavior assertions.
