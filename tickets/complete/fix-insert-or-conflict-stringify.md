description: Move `InsertStmt.onConflict` emission from the retired trailing `on conflict <res>` clause to the `INSERT OR <res>` lead-in (the only surface the parser still produces it from), restoring round-trip.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## What landed

`insertToString` in `packages/quereus/src/emit/ast-stringify.ts:543-547` now injects an optional `or <res>` between `insert` and `into <table>`, and the old trailing `on conflict <res>` emission (previously at 565-567) is gone. `ConflictResolution.ABORT` is still dropped as a default — symmetric with the `emit-roundtrip-comparator` rule `'insert.onConflict': ABORT`. UPSERT emission (`upsertClauseToString`, 595-618) is unchanged.

Tests:
- `packages/quereus/test/emit-roundtrip-property.spec.ts:660-677` — `insertArb` now draws `conflictResArb` and sets `onConflict` when defined. The note disclaiming round-trip is gone.
- `packages/quereus/test/emit/ast-stringify.spec.ts:297-338` — new `INSERT OR <res> lead-in` describe block: table-driven over ROLLBACK / FAIL / IGNORE / REPLACE (each parses, stringifies, regex-asserts the lead-in form, re-parses, asserts `onConflict` survives) plus an ABORT case that constructs the AST directly and asserts no `or` / no `on conflict` in the emit.

## Review findings

**Approach:** read the implement-stage diff cold (commit `7cbbf9d9`), then verified the surrounding surfaces — call sites of the still-trailing `conflictToString`, parser semantics for the `OR` lead-in vs `ON CONFLICT … DO …`, and the comparator's normalization rule. Tests + lint exercised in foreground.

### Correctness / contract

- **Parser/stringifier symmetry confirmed.** Parser populates `InsertStmt.onConflict` only via the `INSERT OR <res>` lead-in (`parser.ts:332-340`); after the fix the stringifier emits via the same surface. The mutual-exclusivity check at `parser.ts:418-420` rejects ASTs that mix `INSERT OR …` with an UPSERT `ON CONFLICT … DO …`, so the case the property arbitrary deliberately omits (`onConflict` ∧ `upsertClauses`) is one the parser would already reject — not a coverage gap, an actual non-shape.
- **ABORT-drop is intentional and consistent.** `INSERT OR ABORT INTO …` parses to `onConflict = ABORT`, stringifies without any `OR` clause, re-parses to `onConflict = undefined`. The `emit-roundtrip-comparator.ts:66` rule `'insert.onConflict': ABORT` treats these as equivalent, so property-test round-trip still holds. The new `'drops the OR clause for the default ABORT resolution'` case pins this behavior explicitly.
- **Other emit surfaces.** `conflictToString` (`ast-stringify.ts:960-965`) still emits `on conflict <res>` — verified at all 8 call sites (lines 977, 981, 985, 989, 997, 1030, 1034, 1042) it's only consumed for column / table constraint contexts (`primary key`, `not null`, `null`, `unique`, `check`). None flow into INSERT emission. No drive-by cleanup needed; that production is still valid in CREATE TABLE.

### Tests

- Verified all three targeted suites green:
  - `yarn workspace @quereus/quereus run test --grep "round-trip"` → **187 passing**
  - `yarn workspace @quereus/quereus run test --grep "INSERT"` → **36 passing**
  - `yarn workspace @quereus/quereus run test --grep "Emit"` → **204 passing**
- The new lead-in describe block contributes 5 cases (4 conflict resolutions + 1 ABORT default). The property arbitrary now exercises non-default `onConflict` through `parse(stringify(ast)) ≡ ast` via the comparator.
- `conflictResArb` (`emit-roundtrip-property.spec.ts:65-74`) excludes ABORT by construction, so the property test never tries the "ABORT round-trips as undefined" path — but the new unit test in `ast-stringify.spec.ts` covers it directly.

### Style / DRY / modularity

- Three-line lead-in is the simplest expression; no helper warranted (called from exactly one site).
- No type laxness; the `ConflictResolution[stmt.onConflict].toLowerCase()` lookup is the same idiom the file already uses in `conflictToString`.
- No new imports needed — `ConflictResolution` was already imported at `ast-stringify.ts:14`.

### Lint

- `yarn workspace @quereus/quereus run lint` → exit 0, no output. The implementer's stated "lint not run" gap is closed.

### Docs

- `docs/sql.md`, `docs/architecture.md`, `packages/quereus/README.md` were checked — none describe the INSERT-OR / ON-CONFLICT emission surface at a level that would be affected by this fix (the AST stringifier is an internal round-trip tool, not user-facing surface). No doc update required.

### What was **not** checked

- Full repo-wide test suite (`yarn test`). The three grep'd suites cover the touched surface comprehensively; the engine logic tests (sqllogic) execute SQL but do not exercise the stringifier round-trip.
- `yarn test:store` (LevelDB-backed). Out of scope — this change is parser-emit only, no storage code path is affected.

### Findings

- **Minor / fixed inline:** none — the implement-stage diff already addressed the review-time concerns the handoff flagged (conflictToString call sites surveyed, lint run).
- **Major / new tickets:** none.

## End
