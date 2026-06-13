description: Fixed the schema/planner/optimizer/func/util cluster of stale TypeScript errors in test/ (the remaining 70). With the prereq landed, `tsc -p tsconfig.eslint.json --noEmit` now reports ZERO errors across the whole type-aware test program. All edits are type-only or behavior-preserving; a handful of behavior-adjacent edits are flagged below for review.
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
  - packages/quereus/test/emit-roundtrip-comparator.ts   # widened assertAstEquivalent (fixes schema-equivalence.ts errors at the callee)
  - packages/quereus/test/plan/_helpers.ts
  - packages/quereus/test/query-rewrite.spec.ts
  - packages/quereus/test/planner/constraint-extractor.spec.ts
  - packages/quereus/test/planner/validation.spec.ts
  - packages/quereus/test/covering-structure.spec.ts
  - packages/quereus/test/plugins.spec.ts
  - packages/quereus/test/schema/catalog.spec.ts
----

# Review: schema/planner/optimizer/func/util test type-drift fixes

Resolved the remaining 70 stale `tsc` errors in `packages/quereus/test/` — the
sibling cluster to `typecheck-test-fix-runtime-emit` (landed). With both done,
the whole type-aware test program type-checks **clean (0 errors)**. These were
invisible to CI because `tsconfig.test.json` excludes `test/` and mocha runs
`transpileOnly`. **No `tsconfig`, `package.json`, or `src/` files were touched —
every edit is under `test/`.** The follow-on `typecheck-test-gate` ticket wires
the CI gate.

## How to verify

```
cd packages/quereus
npx tsc -p tsconfig.eslint.json --noEmit 2>&1 | grep -c "error TS"   # → 0
```

(~60–90s.) Then spot-check the behavior-adjacent edits flagged below.

## What landed (by root cause)

- **Scalar/relation/FunctionFlags shapes** (`function-type-guards`, `framework`,
  `expression-fingerprint`, `lens-access-form-matcher`) — scalar types now use
  `{ typeClass:'scalar', logicalType: <BUILTIN>_TYPE, nullable }` (the removed
  `affinity` prop dropped; `INTEGER_TYPE`/`REAL_TYPE`/`TEXT_TYPE` from
  `builtin-types`); relation types gained `isReadOnly/isSet/keys/rowConstraints`.
  `lens-access-form-matcher` got the now-required `implementation`.
- **`OptContext.depth` removed + `RuleHandle.sideEffectMode` required**
  (`pass-manager`, `framework`) — dropped `depth` from the context literals;
  added `sideEffectMode:'safe'` to four rule literals (all are
  children-preserving structural rewrites → `'safe'` is correct).
- **`SchemaDiff` new required fields** (`schema-differ`) — added a
  `makeEmptySchemaDiff()` helper; the seven test literals now spread it and
  override only the field each case exercises, so future field additions touch
  one place. Also: column literal gained `collation`; the `CreateTableStmt`
  literal's `table` gained `type:'identifier'`.
- **`ForeignKeyConstraintSchema` new required fields** (`catalog-stats`,
  `statistics`) — FK literals filled with current defaults
  (`referencedColumns:[0], onDelete:'restrict', onUpdate:'restrict',
  deferred:false`). The stats provider only reads `referencedTable`/`columns`,
  so these are inert for the tests.
- **`SqlValue[]`/`SqlParameters` params** (`scalar-cse`, `binding-collector`,
  `const-pass`) — typed each `collect()` local `params` at the source instead of
  `unknown[]`/`Record<string,unknown>`.
- **fast-check mappers** (`fuzz`, `property`) — `tie(...)` is `Arbitrary<unknown>`;
  wrapped the seven uncast mapper sites with `as fc.Arbitrary<string>` (the
  file's existing idiom, e.g. line 296/308); narrowed `prev`/`curr` `unknown` in
  the ORDER-BY check.
- **Removed schema props** — `capabilities` (dropped `TableSchema.primaryKey`,
  which no longer exists; the `primaryKey` param still feeds
  `primaryKeyDefinition`).
- **`FromClause[]`** (`schema/catalog`) — `select.from` is now an array; wrapped
  the three single-`FromClause` literals in `[...]`.
- **Isolated conversions** — `hrtime` (`Number(bigint)` for chai's
  `number|Date` matchers); `covering-structure` (arrow expression body →
  block body so the `watch` callback returns `void`).

## Honest flags for review (behavior-adjacent / judgment)

1. **`@ts-expect-error` ×3** in `boundary-validation` — the negative
   `physicalType: 99 / 1.5 / -1` cases, each with a one-line reason. All three
   are consumed (proved by `tsc` = 0; an unused directive would be a TS2578).

2. **`plugins.spec.ts` src↔dist `Database` mismatch → `db as any` ×3.** Chose a
   narrowly-scoped, commented cast over the ticket's preferred package-entry
   import (`@quereus/quereus`). Rationale: importing through the package entry
   makes the test's `Database` resolve to `dist/` (matching `@quereus/plugin-loader`'s
   published types) but couples the test to a freshly-built `dist/` at runtime
   under ts-node — which the ticket explicitly warns against ("shouldn't depend
   on a stale build artifact"). The file already opts into `any` (top-level
   eslint-disable + pervasive `any`), so the cast is in-style. **Reviewer
   decision:** accept, or file a follow-up for a real consistent package
   self-import (likely a source-side/build concern, plausibly the gate ticket's
   territory).

3. **`assertAstEquivalent` widened `AstNode` → `unknown`** in
   `emit-roundtrip-comparator.ts` (a file NOT in the ticket's listed set).
   `util/schema-equivalence.ts` had the two errors (`ViewInsertDefault[]` vs
   `AstNode`), but the honest fix is at the callee: the internal `astEquivalent`
   already takes `unknown` and walks arrays structurally, so the exported
   wrapper's `AstNode` typing was just too narrow. This fixed both errors with
   zero casts and left `schema-equivalence.ts` **unchanged**. Widening a param
   can't break callers. Verified `emit-roundtrip-property` + `declarative-equivalence`
   (a schema-equivalence consumer) still pass. **Reviewer decision:** accept the
   widening, or prefer a localized `as unknown as AstNode` at the two
   schema-equivalence call sites instead.

4. **Stale-value edits (no assertion depends on them; flagged per ticket rule):**
   - `property.spec.ts`: `name: \`chk_${idx}\`` → `name: 'chk_0'`. fast-check's
     `.map` passes no index, so `idx` was always `undefined` at runtime
     (`chk_undefined`); the dropped param was required to satisfy the single-arg
     mapper signature. There is exactly one CHECK in the array and nothing
     asserts the constraint name (it only feeds generated `constraint <name>
     check (...)` DDL), so `chk_0` is behavior-equivalent.
   - `constraint-extractor.spec.ts`: `c.value = [undefined]` → `[null]`
     (`undefined` isn't `JSONValue`). The cover guard keys on `correlated:true`
     and bails before inspecting `value`, so the element is inert; `[null]` keeps
     the singleton-IN length.
   - `expression-fingerprint` / `function-type-guards` flags: `0` →
     `FunctionFlags.UTF8` (or `UTF8 | (deterministic ? DETERMINISTIC : 0)`),
     matching the source idiom (real registered functions always set UTF8). The
     determinism bit — which `expression-fingerprint`'s non-deterministic-guard
     tests depend on — is preserved exactly. Verified all fingerprint tests pass.

5. **`as unknown as T` ×2** — `plan/_helpers.ts` (`PlanRow`, casting a generic
   `Record<string,SqlValue>` eval row) and `query-rewrite.spec.ts` (`QueryExpr`,
   a deliberately-partial AST stub). Construction would mean fabricating/coercing
   full shapes (changing behavior), so the cast is the right call here.
   **`scanD as any`** in `validation.spec.ts` matches the file's existing
   `scanX as any` idiom for `MockPlanNode` (siblings on the same lines).

6. **Revealed cascade** — `schema/differ-alter-column.spec.ts`: after fixing the
   column `collation` drift, the outer `CatalogTable` return surfaced as missing
   `referencedTables`/`namedConstraints` (TS had bailed on the nested column
   error first in the baseline). Added both (empty arrays).

## Verification performed

- `tsc -p tsconfig.eslint.json --noEmit` → **0** `error TS` (was 70 on top of the
  landed prereq; full program now clean).
- Targeted mocha over every touched spec (foreground, in three batches):
  **1245 passing** total — incl. `expression-fingerprint`, `function-type-guards`,
  `hrtime`, `constraint-extractor`, `lens-access-form-matcher` (327);
  `covering-structure`, `schema-differ`, `differ-alter-column`, `schema/catalog`,
  `pass-manager`, `statistics`, `scalar-cse`, `binding-collector`, `const-pass`,
  `catalog-stats`, `validation`, `framework`, `capabilities`,
  `boundary-validation`, `query-rewrite`, `plugins` (515); and the fast-check +
  comparator consumers `emit-roundtrip-property`, `declarative-equivalence`,
  `fuzz`, `property` (403). Zero failures.
- Confirmed `plugins.spec.ts` passes at runtime with the `db as any` cast (the
  cast is erased; the sample plugins load and execute).

## Gaps / not done

- Full `yarn test` across all workspaces not run (compile-only / behavior-
  preserving by design; the targeted smoke covered every changed spec). The gate
  ticket / CI will run the full matrix.
- `plugins.spec` proper package-self-import and the `assertAstEquivalent`
  widening are the two judgment calls above — both work and are verified, but a
  reviewer may prefer the alternatives noted.
- No `.pre-existing-error.md` written — no unrelated/pre-existing failures
  surfaced during verification.

## End
