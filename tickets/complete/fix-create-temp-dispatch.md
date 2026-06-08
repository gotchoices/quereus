description: Parser fix that hoists TEMP/TEMPORARY detection out of `createTableStatement` / `createViewStatement` and into the top-level `createStatement` dispatcher so `create temp table` / `create temp view` now parse and round-trip through the stringifier.
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/logic/08.1-view-edge-cases.sqllogic
----

## What landed

- `createStatement` (`parser.ts:2144`) peeks for `TEMP`/`TEMPORARY` before dispatching on TABLE/INDEX/VIEW/ASSERTION/UNIQUE. Routes only to `createTableStatement` / `createViewStatement` when the flag is set; rejects `TEMP INDEX` / `TEMP UNIQUE INDEX` / `TEMP ASSERTION` with `"Expected TABLE or VIEW after CREATE TEMP/TEMPORARY."`.
- `createTableStatement` and `createViewStatement` take `isTemporary` as a parameter; the unreachable inner peek blocks were removed.
- Property tests (`emit-roundtrip-property.spec.ts`) now exercise `isTemporary ∈ {true, false}` for both `createTableArb` and `createViewArb`.
- Unit tests (`ast-stringify.spec.ts`) parse → stringify → reparse for `create temp table`, `create temporary table`, and `create temp view` and assert `isTemporary === true` on the post-round-trip AST.
- `08.1-view-edge-cases.sqllogic` — the two sections marked `-- Quereus parser doesn't support CREATE TEMP VIEW` are unblocked; they create, select-from, and drop a temp view end-to-end.

## Review findings

### Parser dispatch — clean

- TEMP/TEMPORARY peek hoisted ahead of all dispatch branches; precedence is right.
- Both `TEMP` and `TEMPORARY` tokens covered (`peekKeyword` resolves via dedicated TokenType, falls back to identifier lexeme — `lexer.ts:264-265` maps both).
- Error path on `CREATE TEMP <not-table-or-view>` is well-defined and explicit.
- `CREATE TEMP IF NOT EXISTS TABLE …` is rejected (TEMP must precede TABLE/VIEW, then IF NOT EXISTS is consumed inside the per-stmt method). Verified by reading `createTableStatement`/`createViewStatement` ordering.

### Callers — verified

- `createTableStatement` and `createViewStatement` are private, and the only two callers in the source tree are the two dispatch arms in `createStatement` (`grep` confirms). The new `isTemporary` parameter cannot be missed elsewhere.

### Schema-qualified temp — works

- `tableIdentifier()` already lists `temp`/`temporary` in its contextual-keyword set (`parser.ts:757`), so `create temp view temp.sq_tv as …` consumes the second `temp` as a schema identifier without ambiguity. Sqllogic test exercises this.

### Round-trip tests — adequate coverage for the parser layer

- Property tests previously pinned `isTemporary: false`; now generate `fc.boolean()`. The stale `Note:` paragraphs explaining the broken state were removed.
- Unit tests cover three forms (`temp`, `temporary`, view) by walking the AST rather than the emitted string — consistent with the file's style.
- Sqllogic exercises temp VIEW end-to-end (create → select → drop). Temp TABLE end-to-end (create → insert → select → update → delete) is not exercised — see major finding below.

### Lint / tests

- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn workspace @quereus/quereus run test` → 3274 passing, 0 failing.

### Docs

- `docs/sql.md` already documented `create [temp | temporary] table …` and the view grammar — aspirational before, accurate now. No edit needed.
- `docs/schema.md:161` lists `TEMP` in the stringifier's "Feature coverage" — also accurate now.

### Major finding (filed as new backlog ticket)

`packages/quereus/src/planner/type-utils.ts:62` sets the relation-type's `isReadOnly` to `true` for any `tableSchema.isTemporary === true`. This conflates VIEW (logically read-only) with TEMP TABLE (normally writable). Before this fix the parser couldn't produce `isTemporary: true`, so the branch was dormant; now it is live. No INSERT/UPDATE/DELETE builder currently consults `RelationType.isReadOnly` to reject writes, so the bug doesn't surface as a hard failure today, but the conflation propagates through join/project/scalar/window/sequencing nodes and is a footgun waiting to happen. Filed as `tickets/backlog/temp-table-readonly-conflation.md`. The same ticket calls for a sqllogic test that exercises temp tables end-to-end (insert/update/delete), since the parser-level unit tests added here do not reach planner/runtime.

### Minor findings (not actioned)

- `parser.ts:2170` error message mentions `VIRTUAL` but `createStatement` has no `VIRTUAL` branch — `CREATE VIRTUAL TABLE` is handled elsewhere or not at all. Pre-existing, unrelated to this fix; not in scope.
- The implementer's "Known gaps" called out that schema-manager handling of `isTemporary` (per-connection scoping, etc.) was not audited. That's a separate concern from the readonly-conflation above and is not necessarily a bug — SQLite-style temp namespace semantics aren't a stated requirement of this engine. Leaving alone until someone needs it.

### What was checked and not found

- No additional callers of the two private methods (would have needed updating). None found — confirmed.
- No regressions in property tests when `isTemporary` flips to `true`. None — round-trip is symmetric.
- No regressions in other sqllogic suites. None — full test suite green.
- No reachable code path that gates writes on `RelationType.isReadOnly`. None found — the conflation is latent (see major finding).
