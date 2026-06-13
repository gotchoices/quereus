description: Fix TypeScript drift errors in the runtime/emit/vtab test cluster (~66 of the 136 hidden test errors) so they type-check clean under the type-aware program. First of three prereq-chained tickets; establishes shared test type-factory reuse for downstream tickets.
prereq:
files:
  - packages/quereus/test/runtime/fanout-lookup-join.spec.ts   # 33 errors — MockRelNode.getType() return type
  - packages/quereus/test/emit-roundtrip-property.spec.ts        # 13 — fast-check arbitrary generics + ColumnDef/TableConstraint union
  - packages/quereus/test/memory-vtable.spec.ts                  # 7 — UpdateResult shape (`.row` removed)
  - packages/quereus/test/vtab/test-query-module.ts              # 5 — UpdateResult return type + oldKeyValues possibly-undefined
  - packages/quereus/test/emit-missing-types.spec.ts             # 3 — AlterObjectTagsAction shape (drift vs negative test — judge)
  - packages/quereus/test/statement-iterator-cleanup.spec.ts     # 3
  - packages/quereus/test/runtime/scan-emitter.spec.ts           # 1
  - packages/quereus/test/runtime/eager-prefetch.spec.ts         # 1
difficulty: medium
----

# Fix runtime/emit/vtab test type drift

## Background

`tsc --noEmit` (the `typecheck` script and the build) covers `src/` only. Test
files have **zero** TypeScript diagnostics coverage today: `tsconfig.test.json`
inherits `exclude: ["test"]` from the base tsconfig, which silently empties its
`include`; mocha runs through ts-node with `transpileOnly: true`; and ESLint's
type-aware parse does not surface raw `tsc` errors. As a result ~136 stale
type errors hide in `test/` — call-signature drift, schema-shape drift, removed
properties — and every CI signal stays green.

This ticket fixes the **runtime/emit/vtab cluster** (~66 of the 136). A sibling
ticket (`typecheck-test-fix-schema-planner`) fixes the rest, and a final ticket
(`typecheck-test-gate`) wires the config/script/gate. **This ticket does not
touch any tsconfig or package.json** — verification uses the already-working
`tsconfig.eslint.json` program (see below).

## How to reproduce / verify

The full type-aware program already type-checks today with no config change:

```
cd packages/quereus
npx tsc -p tsconfig.eslint.json --noEmit 2>&1 | grep "error TS"
```

This emits all 136 errors. After this ticket, **none of the errors should
reference the files listed above**. Verify with:

```
npx tsc -p tsconfig.eslint.json --noEmit 2>&1 \
  | grep -E "fanout-lookup-join|emit-roundtrip-property|memory-vtable|test-query-module|emit-missing-types|statement-iterator-cleanup|scan-emitter|eager-prefetch"
```

→ must print nothing. (Errors in the *other* cluster's files are expected to
remain until the sibling ticket lands — ignore them.)

`tsc -p tsconfig.eslint.json --noEmit` runs ~60–90s. Stream it with `| tee
/tmp/tc.log` and grep the log; don't silently redirect. Do **not** run the full
test suite for this ticket — these are compile-only fixes; runtime behavior is
unchanged. A quick `yarn test 2>&1 | tee /tmp/test.log; tail -n 40
/tmp/test.log` at the end is a reasonable smoke check but optional.

## Root causes (mechanical drift — the compiler tells you the exact shape)

- **`fanout-lookup-join.spec.ts` (33)** — `class MockRelNode` (≈ line 1260)
  declares `getType(): BaseType`, but `RelationalPlanNode` now narrows
  `getType()` to return `RelationType`. The backing `_type` literal is already
  fully populated. **One-line fix:** change the declaration to
  `getType(): RelationType`. All 33 errors collapse.
- **`memory-vtable.spec.ts` (7)** — reads `.row` off an `UpdateResult`; that
  property no longer exists. Inspect the current `UpdateResult` type
  (`src/vtab/` / runtime update path) and read the correct field, or assert the
  result shape the API now returns.
- **`vtab/test-query-module.ts` (5)** — a mock `xUpdate`/update callback returns
  `Promise<Row | undefined>` where `Promise<UpdateResult>` is required, plus an
  `args.oldKeyValues` possibly-`undefined` access. Return the correct
  `UpdateResult` shape and guard the optional field.
- **`emit-roundtrip-property.spec.ts` (13)** — two sub-causes: (a) fast-check
  arbitraries whose element type (`("asc"|"desc"|undefined)[]`,
  `AlterTableAction[]`) no longer satisfies `MaybeWeightedArbitrary<unknown>[]`
  — annotate the arbitrary's generic or wrap elements in `fc.constant`/the
  right combinator; (b) a `ColumnDef | TableConstraint[]` union being assigned
  where `ColumnDef`/`TableConstraint[]` is expected — narrow before use.
- **`emit-missing-types.spec.ts` (3)** — object literals `{ type: "setTags",
  tags: {...} }` not assignable to `AlterObjectTagsAction`. **Judge intent:** if
  the test asserts the emitter *rejects* a malformed action, this is a negative
  test → prefix the line with `// @ts-expect-error <reason>`. If it's just drift
  from the current `AlterObjectTagsAction` shape, fill in the missing fields.
- **`statement-iterator-cleanup.spec.ts` (3)**, **`scan-emitter.spec.ts` (1)**,
  **`eager-prefetch.spec.ts` (1)** — small, isolated drift; follow the compiler
  message.

## Guidance

- Prefer fixing the **mock/factory once** over editing each call site (the
  fanout case is the canonical example). Where several spec files build the same
  drifted shape (relation/scalar `BaseType`, `UpdateResult`), consider a small
  shared factory under `test/util/` so the sibling ticket can reuse it rather
  than re-deriving the shape — but don't over-engineer a one-off.
- **Do not** weaken source types or add blanket `as any` / `@ts-ignore` to
  silence errors. Match the current source shape. `@ts-expect-error` is allowed
  **only** for genuinely-negative tests and must carry a one-line reason.
- Keep edits limited to the files in this ticket's `files:` list. The sibling
  ticket owns everything else.

## Edge cases & interactions

- **`@ts-expect-error` must stay "expected".** A stray `@ts-expect-error` on a
  line that actually compiles becomes its own `TS2578 "Unused
  '@ts-expect-error'"` error. Only add it where the line truly fails to type,
  and re-run the typecheck to confirm it's consumed.
- **Mock identity vs interface.** When fixing `MockRelNode`/mock query-module
  shapes, change the *declared return/param types* to match the interface, not
  the runtime values — the values are already correct; it's the annotations that
  drifted. Avoid casting the whole mock to the interface (`as RelationalPlanNode`)
  which would re-hide future drift.
- **fast-check generic widening.** Don't "fix" the arbitrary by casting to
  `Arbitrary<unknown>` — that defeats the property test's type contract. Give
  the combinator the correct element arbitrary so the generated value type still
  matches what the property body consumes.
- **UpdateResult is shared with the store path.** `memory-vtable` and
  `test-query-module` both touch the update-result contract; make sure both use
  the *same* current field names so they don't diverge again.
- **No behavioral change.** These are type-only edits. If a "fix" requires
  changing a runtime value (not just a type), stop — that signals the test was
  asserting stale behavior and belongs in a fix ticket, not here; document it in
  the review handoff instead of silently changing the assertion.

## TODO

- [ ] Reproduce the 136-error baseline with `tsc -p tsconfig.eslint.json --noEmit`.
- [ ] Fix `fanout-lookup-join.spec.ts` (`MockRelNode.getType()` → `RelationType`).
- [ ] Fix `memory-vtable.spec.ts` + `vtab/test-query-module.ts` (`UpdateResult` shape).
- [ ] Fix `emit-roundtrip-property.spec.ts` (fast-check generics + ColumnDef union).
- [ ] Triage `emit-missing-types.spec.ts` (drift vs `@ts-expect-error`).
- [ ] Fix `statement-iterator-cleanup`, `scan-emitter`, `eager-prefetch`.
- [ ] (Optional) extract shared `test/util/` type factory if it removes duplication.
- [ ] Verify: the grep over this ticket's files prints **zero** `error TS` lines.
- [ ] Write the review handoff noting any `@ts-expect-error` calls added and why,
      and any case where a "fix" was deferred as a suspected stale-behavior assertion.
