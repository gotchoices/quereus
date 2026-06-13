description: Review the runtime/emit/vtab test type-drift fixes (~66 of 136 hidden test type errors). All edits are type-only or behavior-preserving; verify under the type-aware program and confirm no source types were weakened.
prereq:
files:
  - packages/quereus/test/runtime/fanout-lookup-join.spec.ts
  - packages/quereus/test/memory-vtable.spec.ts
  - packages/quereus/test/vtab/test-query-module.ts
  - packages/quereus/test/emit-roundtrip-property.spec.ts
  - packages/quereus/test/emit-missing-types.spec.ts
  - packages/quereus/test/statement-iterator-cleanup.spec.ts
  - packages/quereus/test/runtime/scan-emitter.spec.ts
  - packages/quereus/test/runtime/eager-prefetch.spec.ts
difficulty: easy
----

# Review: runtime/emit/vtab test type-drift fixes

## What landed

Fixed the runtime/emit/vtab cluster of stale TypeScript errors in `test/`
(invisible to CI because `tsconfig.test.json` excludes `test/` and mocha runs
`transpileOnly`). **No tsconfig/package.json touched** — verification uses the
already-working `tsconfig.eslint.json` program. The sibling ticket
(`typecheck-test-fix-schema-planner`) owns the remaining 70 errors; the gate
ticket (`typecheck-test-gate`) wires the config/script.

### Baseline / result
- Before: `npx tsc -p tsconfig.eslint.json --noEmit` → **136** `error TS` lines.
- After: **70** (exactly the sibling cluster). All 8 files in `files:` are
  clean. **Zero new errors introduced** (136 − 66 = 70).

## Per-file change + what to scrutinize

- **`fanout-lookup-join.spec.ts` (33 errors)** — `MockRelNode.getType()` return
  annotation changed `BaseType` → `RelationType` (the interface narrowed;
  `_type` was already a fully-populated `RelationType`). Removed the now-unused
  `BaseType` import. *Annotation-only — the runtime value was already correct.*
  Verify: no `as RelationalPlanNode` cast was used (would re-hide future drift).

- **`memory-vtable.spec.ts` (7)** — `.row` was read directly off `UpdateResult`,
  whose `row?` lives only on the `'ok'` branch of the union. Added a local
  narrowing assertion helper `expectOk(result): asserts result is Extract<…,
  {status:'ok'}>` and replaced each `expect(result.status).to.equal('ok')` with
  `expectOk(result)` (behaviorally identical assertion **plus** type narrowing).
  Verify: the two `'constraint'`-branch tests (lines ~233, ~298) are untouched.

- **`vtab/test-query-module.ts` (5)** — `TestQueryTable.update` returned
  `Promise<Row | undefined>` where the base now requires `Promise<UpdateResult>`
  (that mismatch also caused the `VirtualTableModule<TestQueryTable,…>`
  constraint error at the class header). Now returns `{status:'ok', row}` for
  insert/update and `{status:'ok'}` for delete. Also: the `data` getter now keys
  on the base class's `this.schemaName`/`this.tableName` (always set via
  `super(...)`) instead of `this.tableSchema!.…` (optional → possibly-undefined),
  and the `update`/`delete` closures capture `oldKeyValues` in a local to fix the
  possibly-undefined access. **This is the only change with a runtime return-shape
  difference.** Justification: the return value is never inspected by callers
  (the table is driven purely via SQL `INSERT`/`SELECT`), and the DML executor
  already expects `UpdateResult`. Smoke-tested below.

- **`emit-roundtrip-property.spec.ts` (13)** — two sub-causes:
  - fast-check v4 `oneof<Ts extends MaybeWeightedArbitrary<unknown>[]>` rejects an
    *element-type* array as the generic. Changed `fc.oneof<X[]>(…)` →
    `fc.oneof<fc.Arbitrary<X>[]>(…)` at all 5 sites (4 sort-direction, 1
    `AlterTableAction`). This is the faithful v4 form: it restores the contextual
    typing the args rely on (so the un-`as const` `AlterTableAction` members still
    infer their literal `type`) and yields the same generated value type.
    *Note `fc.constantFrom<X[]>(…)` at lines ~836/865 is left alone — its second
    overload accepts an element array, so it was never an error.*
  - `fc.tuple(...columnDefs, arrayArb)` spread a `Arbitrary<ColumnDef>[]` (array,
    not tuple) so every destructured element widened to `ColumnDef |
    TableConstraint[]`. Destructured `columnDefs` into a fixed `[col0,col1,col2]`
    (colNames is always length-3) so `fc.tuple` infers positional types. Applied
    at both `createTableArb` and `declaredTableInnerArb`.
  Verify: no arbitrary was cast to `Arbitrary<unknown>` (would defeat the property
  contract). The property tests still generate + round-trip these shapes (pass).

- **`emit-missing-types.spec.ts` (3)** — `{type:'setTags', tags}` was missing the
  now-required `mode`. **Judged as drift, NOT negative tests:** each is a positive
  stringify assertion (`expect(...).to.equal('alter view v set tags (…)')`), and
  `SET TAGS` ⇒ `mode:'replace'`. Added `mode:'replace'` to all three. **No
  `@ts-expect-error` was added anywhere in this ticket** (none of the cluster's
  failures were negative tests). Verify the judgement: confirm the expected
  strings match `mode:'replace'` semantics (`set tags`, incl. the `set tags ()`
  clear-all form).

- **`statement-iterator-cleanup.spec.ts` (3)** — `iterator.return`/`iterator.throw`
  are optional on `AsyncIterator`. Used `iterator.return!()` / `iterator.throw!(…)`
  — these tests deliberately invoke them directly and async generators always
  provide them.

- **`scan-emitter.spec.ts` (1)** — base declares `query?(…)` as an optional
  **method**; `StubTable` overrode it with a **getter** (TS2423). Removed the
  `_queryFn` field + getter and instead assign `this.query = queryFn` in the
  constructor **only when provided**, leaving `query` genuinely `undefined` on the
  no-query path. Verify the "vtab without query method" test still exercises the
  undefined path (it does — see smoke run).

- **`eager-prefetch.spec.ts` (1)** — `ReturnType<typeof makeDeferred>` resolves the
  defaulted generic `T = void` to `unknown` (ReturnType uses the constraint, not
  the default), so `.resolve()` demanded an arg. Annotated `pulled: Array<Deferred<void>>`
  (importing `type Deferred`). Matches the existing `Deferred<void>.resolve()`
  zero-arg usage in `controllable-source.ts`.

## How to verify

```
cd packages/quereus
npx tsc -p tsconfig.eslint.json --noEmit 2>&1 | tee /tmp/tc.log | grep -c "error TS"   # expect 70
grep -E "fanout-lookup-join|emit-roundtrip-property|memory-vtable|test-query-module|emit-missing-types|statement-iterator-cleanup|scan-emitter|eager-prefetch" /tmp/tc.log   # expect nothing
```

Runtime smoke (all green when this landed — 199 tests, 4 pre-existing pending skips):
```
# from repo root
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  packages/quereus/test/runtime/scan-emitter.spec.ts \
  packages/quereus/test/memory-vtable.spec.ts \
  packages/quereus/test/vtab/remote-query-disconnect.spec.ts \
  packages/quereus/test/optimizer/remote-grow-retrieve.spec.ts \
  packages/quereus/test/runtime/eager-prefetch.spec.ts \
  packages/quereus/test/statement-iterator-cleanup.spec.ts \
  packages/quereus/test/emit-roundtrip-property.spec.ts \
  packages/quereus/test/emit-missing-types.spec.ts \
  packages/quereus/test/runtime/fanout-lookup-join.spec.ts --colors
```

## Honest gaps / reviewer focus

- **No shared `test/util/` type-factory was extracted.** The ticket floated one,
  but every fix here turned out to be a localized annotation correction (the
  mocks already build correct values), not a shared-shape rebuild — there was
  nothing non-trivial to factor out. `memory-vtable`'s `expectOk` and
  `test-query-module`'s inline `UpdateResult` construction are small and
  file-local. The sibling cluster's analogous drift (`MockPlanNode.getType()` in
  `planner/validation.spec.ts`) is the same one-line return-annotation pattern and
  needs no shared helper either. If the reviewer disagrees, the consolidation is
  cheap follow-up — not a correctness issue.
- **Behavioral-change watch:** `test-query-module.ts`'s `update` return shape is
  the only non-pure-type edit. Confirm via the remote-query specs above that
  nothing reads the old `Row | undefined` return. (Verified passing.)
- **fast-check generic judgement:** confirm `fc.oneof<fc.Arbitrary<X>[]>` is the
  intended faithful fix vs. simply dropping the generic. Dropping works for the
  sort-direction sites (`fc.constant<const T>` preserves literals) but NOT for the
  `AlterTableAction` site (its un-`as const` members would widen `type` to
  `string`), so the uniform `fc.Arbitrary<X>[]` form was chosen for consistency.
- Remaining **70 errors are out of scope** (sibling `typecheck-test-fix-schema-planner`).
  The typecheck is still not gated in CI until `typecheck-test-gate` lands.
- Full `yarn test` was not run (ticket says optional; these are compile-only /
  behavior-preserving). Targeted smoke covered every structurally-changed spec.
