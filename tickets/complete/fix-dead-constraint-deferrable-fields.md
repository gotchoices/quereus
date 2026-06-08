description: Removed dead `deferrable` / `initiallyDeferred` fields from `ColumnConstraint` and `TableConstraint` AST nodes, plus the four downstream consumer sites that forwarded the always-undefined values into `RowConstraintSchema`.
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/runtime/emit/add-constraint.ts
  packages/quereus/src/runtime/emit/alter-table.ts
----

## What landed

Two unused optional fields were dropped from each of `ColumnConstraint` and `TableConstraint` in `parser/ast.ts`. The parser populates deferrability only on `ForeignKeyClause` (`parser.ts:3681-3720`), so these AST fields were never written. Four downstream sites read them and forwarded into the still-active `RowConstraintSchema.deferrable` / `.initiallyDeferred` fields; all four were trimmed:

- `schema/manager.ts:extractCheckConstraints` — column-level and table-level CHECK push (2 sites).
- `runtime/emit/add-constraint.ts:runAddCheck` — `RowConstraintSchema` construction for `ALTER TABLE ADD CONSTRAINT CHECK`.
- `runtime/emit/alter-table.ts:extractColumnLevelCheckConstraints` — `RowConstraintSchema` construction for `ALTER TABLE ADD COLUMN` checks.

`RowConstraintSchema.deferrable` / `.initiallyDeferred` are intentionally retained — they are populated by `planner/building/constraint-builder.ts:160-164` (heuristic from `needsDeferred`) and `planner/building/foreign-key-builder.ts:370-371` (synthetic FK existence checks), and read by `runtime/emit/constraint-check.ts:108` to set `shouldDefer`.

## Review findings

**Method.** Reviewed the implement commit (`0d0530d`) fresh: 4 file edits, 8 lines removed total. Cross-checked AST type removal against every consumer found via `find_references` over `.deferrable` and `.initiallyDeferred` in `packages/quereus/src/**` and `packages/quereus/test/**`. Ran `yarn lint` (clean) and `yarn test` (3291 passing).

**Correctness — clean.**
- Parser confirmed to set deferrability *only* on `ForeignKeyClause` (`parser.ts:3681-3720`). The two removed AST fields had no writer, so removal is sound.
- Every surviving `.deferrable` / `.initiallyDeferred` site in `src/` was inventoried and confirmed to read from one of: `ForeignKeyClause` (parser-populated; stringified at `emit/ast-stringify.ts:1073-1077`, consumed at `schema/manager.ts:862,896` and `runtime/emit/alter-table.ts:355`), `RowConstraintSchema` (set by FK builder & constraint builder; read by `func/builtins/schema.ts:430-431` for `sys_check_constraints` and `runtime/emit/constraint-check.ts:108`), `IntegrityAssertionSchema` (separate concept), or the planner-level `ConstraintCheck` interface (set by `constraint-builder.ts:160-164` from `needsDeferred`, not from the AST). None of them touch the removed `ColumnConstraint` / `TableConstraint` fields.
- Test-side references all target `ForeignKeyClause` (`ast-stringify.spec.ts:154-166`, `emit-roundtrip-property.spec.ts:205-206,316-317`), `RowConstraintSchema` (`schema-equivalence.ts:140-141` — uses `?? false` default so the now-permanently-undefined values still compare equal), or `IntegrityAssertionSchema` (`schema-equivalence.ts:243-244`, `assertion-as-premise.spec.ts:61-62`). None depend on the removed fields.

**Type safety — clean.** TypeScript's removal of interface fields would have surfaced any remaining reader as a compile error; `yarn lint` (which runs the full ESLint + type-aware rules over `src/**/*.ts`) returned exit 0. No `any`-cast escape hatches were introduced.

**DRY / dead code — clean.** This *is* the dead-code cleanup. One follow-up candidate considered and rejected: `RowConstraintSchema.deferrable` itself could be re-examined for trimming, but it is genuinely live (see consumers above), so no follow-up ticket warranted.

**Behavior preservation — clean.**
- `sys_check_constraints` introspection (`func/builtins/schema.ts:430-431`) coerces `undefined → 0` via `cc.deferrable ? 1 : 0`, so the user-visible `deferrable` / `initially_deferred` columns remain `0` for user-written CHECKs. They were always `0` previously (parser never set the field), so this is a pure no-op for downstream observers.
- `test/logic/06.3.3-introspection-tags.sqllogic:159` continues to assert `deferrable: 0, initially_deferred: 0` for a user CHECK and still passes.
- The implement-stage handoff flagged that `yarn test:store` was not exercised. The change is purely AST-field removal with no semantic shift, so the store path is unaffected — confirmed by grep over `quereus-store/**/*.ts` finding no references to either field.

**Modularity / scalability / performance — N/A.** Pure removal of optional fields. No allocation, layering, or hot-path change.

**Error handling / resource cleanup — N/A.** No error paths or resources involved.

**Docs — clean.**
- `docs/sql.md:3500-3503` already restricts `[ NOT ] DEFERRABLE [ INITIALLY ... ]` to `foreign_key_clause`; the `column_constraint` (3485-3489) and `table_constraint` (3493-3498) grammars never showed it as a standalone constraint-level option, so the grammar is *already* consistent with the new AST and needs no edit.
- `docs/functions.md:551-553,575-576` describes the `sys_check_constraints` / `sys_assertions` introspection columns; behavior unchanged, no edit needed.

**Tests — happy/edge/regression coverage assessed.** No new tests were added by the implement stage. Justified: the change is a type-level removal whose correctness is entirely guaranteed by the existing test surface — `06.3.3-introspection-tags.sqllogic` pins the visible `sys_check_constraints` output for CHECKs (regression guard), `schema-equivalence.ts` round-trips schemas (catches any silent change to `RowConstraintSchema`), and `emit-roundtrip-property.spec.ts` exercises FK deferrability stringification at scale. Adding a new test for "the AST no longer has these fields" would be testing TypeScript's type system.

**Validation run.**
- `yarn lint` (from `packages/quereus`) — exit 0.
- `yarn test` (from `packages/quereus`) — 3291 passing, exit 0.
- `yarn test:store` — not run (per repo guidance, only when diagnosing a store-specific issue or preparing a release; no store-path code touched).

**Disposition.** No minor fixes needed in this pass. No major findings — no new tickets filed.
