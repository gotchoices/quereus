description: Completed — landed AST-level round-trip property test (`packages/quereus/test/emit-roundtrip-property.spec.ts` + comparator `test/emit-roundtrip-comparator.ts`). Reviewed and dispatched the stringifier↔parser mismatches the test surfaced into separate fix tickets.
files:
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit-roundtrip-comparator.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
  docs/architecture.md
----

## What landed

- `packages/quereus/test/emit-roundtrip-property.spec.ts` — fast-check property suite. Generates AST nodes (not SQL) for each major statement family (CREATE TABLE/VIEW/INDEX/ASSERTION, ALTER TABLE, DROP, transactional, PRAGMA, ANALYZE, INSERT/UPDATE/DELETE smoke) and asserts `parse(stringify(ast)) ≡ ast` structurally. One `it()` per family so failures localize. Plus 8 comparator self-tests including a positive failure case (`flags a dropped CHECK operations list`).
- `packages/quereus/test/emit-roundtrip-comparator.ts` — `assertAstEquivalent(a, b)` with documented default-equivalence tables (`DEFAULT_EQUIVALENCES`, `FALSE_DEFAULT_FIELDS`, `EMPTY_RECORD_DEFAULT_FIELDS`) that absorb parser-default ≡ stringifier-omission asymmetries (PK direction, GENERATED stored, conflict resolution, CHECK operations, `false` booleans, empty `moduleArgs`).
- `docs/architecture.md` — bullet under Testing Strategy § Property-Based Tests pointing at the new spec.

Validation from repo root: lint clean, build clean, 3246 tests passing.

## Review findings

Worked the diff (`git show 32901920`) before the handoff summary. Findings below; categories explicitly enumerated per stage rules.

### Correctness / SPP

- The 7 findings the handoff called out were all real and reproducible against the codebase:
  1. `CREATE TEMP TABLE/VIEW` can't round-trip — `parser.ts:2144 createStatement` dispatches on TABLE/INDEX/VIEW/ASSERTION/UNIQUE only, with no TEMP/TEMPORARY peek. The detection at `:2171` is unreachable. → filed `tickets/fix/fix-create-temp-dispatch.md`.
  2. `INSERT … on conflict <res>` (legacy trailing form) — stringifier emits SQL the parser no longer accepts. → filed `tickets/fix/fix-insert-or-conflict-stringify.md`.
  3. `analyze <schemaName>` schema-only branch is unreachable from parser output but emitted by `ast-stringify.ts:810`, re-parsing to a *different* AST shape. Spec question, not a code question. → filed `tickets/backlog/analyze-schema-only-shape-decision.md` (needs owner sign-off before code lands).
  4. `ForeignKeyClause.deferrable` / `initiallyDeferred` set by parser (`parser.ts:3680-3720`), never emitted by stringifier — file header even has a TODO. → filed `tickets/fix/fix-fk-deferrable-stringify.md`.
  5. `ColumnConstraint.deferrable` / `TableConstraint.deferrable` fields declared on the AST type but never written by the parser (grep over `parser.ts`: only assigns to `ForeignKeyClause.deferrable`). Dead. → filed `tickets/fix/fix-dead-constraint-deferrable-fields.md` with prereq on the FK ticket.
  6. `DeclareSchema` items are stubbed (`ast-stringify.ts:870-887` emits `table X { ... }`). Round-trip impossible. → filed `tickets/fix/fix-declare-schema-items-stringify.md`.
  7. Boolean false-default normalization in the comparator is correct *today* but would mask a future regression if a planner consumer starts caring about explicit-`false` vs absent. Latent — captured here in writing, not filed as a ticket since there's no current bug. Worth re-evaluating if the planner grows that distinction.

### DRY

- `columnConstraintsToString` and `tableConstraintsToString` (`ast-stringify.ts:898-…`) duplicate the FK body (`references <tbl>(<cols>) on delete … on update …`). The deferrability fix should extract a `foreignKeyClauseTail(fk)` helper used by both arms — noted explicitly in `fix-fk-deferrable-stringify.md` so the next implementer does the dedup with the fix, not after.

### Modular / maintainable

- The comparator centralizes all normalizations in three tables at the top of `emit-roundtrip-comparator.ts`. Future agents adding a new default-equivalence touch exactly one place — good. The convention is documented in the file header.
- The `parentTypeTagOf` heuristic distinguishes `ColumnConstraint` from `TableConstraint` structurally via `Array.isArray(node['columns'])`. Fragile if `ColumnConstraint` ever grows a `columns` field, but the AST type doesn't define one and the comparator's threshold (only triggered for the 4 dual-host constraint types `primaryKey`/`unique`/`check`/`foreignKey`) keeps the surface contained. Noted in the handoff; no action.

### Scalable / performant

- Whole spec runs in ~70ms (3246 → 3266 specs total). 100–200 runs per `it()`. Comfortable budget for future arb expansion.

### Resource cleanup

- N/A — pure synchronous test code, no file/db handles.

### Error handling

- `checkRoundTrip` wraps stringify, re-parse, and compare with augmenting error messages (original AST + SQL + reparsed AST). Good for fast-check shrinking. Errors are never swallowed.

### Type safety

- Arbitraries return `fc.Arbitrary<AST.XYZ>` typed against `parser/ast.ts`. A future AST-shape change will fail the test compile. The arb for `ColumnDef` constraints is restricted to one constraint per column — documented inline as a deliberate parser-acceptance constraint, not a soundness issue.
- `astEquivalent` parameters typed `unknown` — appropriate for a generic deep-compare. Casts to `Record<string, unknown>` are localized and guarded by `typeof === 'object'` checks.

### Test coverage gaps

The arbitraries are deliberately bounded; the bounded surfaces are documented in `Note:` comments inside the arb definitions and tied to specific findings:

- `isTemporary: false` constraint in `createTableArb` / `createViewArb` (finding 1).
- `insertArb` omits `onConflict` (finding 2).
- `analyzeArb` excludes schema-only (finding 3).
- FK arbitraries omit `deferrable` / `initiallyDeferred` (finding 4).
- Expression arbitraries are intentionally minimal (literal / column / one binary shape). Expression coverage is the focus of the older `emit-roundtrip.spec.ts`, not this test. Acceptable.
- DML smoke (`insert`/`update`/`delete`) doesn't exercise CTEs, RETURNING with aliases, or UPSERT clauses. Out-of-scope; older string-roundtrip suite covers them.
- `DROP TRIGGER` is not in the arb. Verified `parser.ts:2443-2460 dropStatement` only accepts TABLE/VIEW/INDEX/ASSERTION — the `'trigger'` variant in the AST union is unused at the parser surface. Correct choice to exclude.
- `DeclareSchema` excluded — covered by finding 6 / its fix ticket.

### Docs

- `docs/architecture.md` § Testing Strategy updated. Existing `packages/quereus/README.md`, `docs/runtime.md`, etc. don't reference round-trip tests; no further updates needed.
- File header on `emit-roundtrip-comparator.ts` thoroughly documents the comparator contract. File header on `ast-stringify.ts` still carries the FK-deferrability TODO — should be removed when `fix-fk-deferrable-stringify` lands (noted in that ticket).

### Lint + tests

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 3246 passing, 0 failing.

## Tickets spawned

- `tickets/fix/fix-create-temp-dispatch.md`
- `tickets/fix/fix-insert-or-conflict-stringify.md`
- `tickets/fix/fix-fk-deferrable-stringify.md`
- `tickets/fix/fix-dead-constraint-deferrable-fields.md` (prereq: fix-fk-deferrable-stringify)
- `tickets/fix/fix-declare-schema-items-stringify.md`
- `tickets/backlog/analyze-schema-only-shape-decision.md` (needs owner spec decision before promoting)
