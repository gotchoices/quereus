description: (schema, table)-aware hardening of the coverage prover's qualifier-aware AST resolver. A schema-qualified ORDER BY / WHERE term whose *table* name collides with the base table's (different schema) can no longer mis-resolve onto the base table's same-named column and yield a false `Covers`. Defense-in-depth (SQL cannot currently produce a 3-part column ref); the guard is exercised by a hand-built-AST unit test at the prover boundary.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts
----

## Summary of the landed change

Two localized edits to `coverage-prover.ts` plus a doc update and a new
unit-test `describe`:

- **`columnRefParts`** now returns `{ schema?, qualifier?, name }` (all
  lowercased) — `ColumnExpr.schema` is surfaced instead of dropped. The
  `IdentifierExpr` branch still rejects a schema-qualified identifier.
- **`makeBodyColumnResolver`** is now (schema, table)-aware: in the *qualified*
  branch, a present `ref.schema` must equal `baseTable.schemaName` (lowercased)
  or the resolver returns `undefined`; the existing `tQualifiers.has(...)` check
  then applies. An *absent* schema keeps today's table-name-only match.
  Unqualified resolution is byte-for-byte unchanged.
- **Module doc** documents the guard as defense-in-depth (the binder rejects
  every 3-part `schema.table.column` reference before the prover runs).

The single resolver (`resolveBodyColumn`) is shared by both the ORDER BY check
(`bodyOrderByColumns`) and the WHERE check (`provePredicateAlignment`), so the
guard applies uniformly to both paths.

## Review findings

### What was checked

- **Soundness boundary (the implementer's explicit ask).** Confirmed the change
  *only narrows*. The qualified branch gains exactly one early-return
  (`if (ref.schema !== undefined && ref.schema !== baseSchema) return undefined`).
  When `ref.schema` is absent or equals the base schema, behavior is identical to
  before; when it denotes a foreign schema, the result is `undefined` (a
  `NotCovers`), which is always safe (a false `NotCovers` only forgoes an
  optimization). There is **no path** where a present schema makes a reference
  resolve that previously did not — the new condition can only suppress a match,
  never create one. The unqualified branch ignores `ref.schema` entirely.
- **Type safety.** `AST.ColumnExpr` carries `schema?: string` (ast.ts:46–53), so
  surfacing it is type-clean; `yarn build` (tsc, `noEmitOnError`) is green.
- **Reachability framing.** Verified empirically against the built engine that
  the binder rejects *both* `select main.t.uc from t` and
  `select s2.t.uc from t left join s2.t on lkref = pkid` with
  `"<schema>.<table>.<col> isn't a column"` (resolve.ts:45). So the cross-schema
  scenario is genuinely **not SQL-reachable** — the "defense-in-depth, not a
  regression" framing is accurate, and the hand-built-AST test is the only way to
  exercise the guard.
- **Test validity.** The prover reads ordering from `mv.selectAst.orderBy`
  (coverage-prover.ts:382) while the shape/projection/fan-out walk uses the real
  plannable `root` — so replacing only the stub's `orderBy` with a 3-part
  `ColumnExpr` faithfully drives the resolver while the rest of the proof runs on
  a real body. The `s2` case returning `ordering-mismatch` (not `shape`/`fanout`)
  confirms the shape walk and fan-out gate pass first and the rejection is
  specifically the ordering resolver. AST shapes used by the test (`OrderByClause
  { expr, direction }`, `proveCoverage(root, mv, uc, baseTable)`) match the
  definitions.
- **Edge / interaction coverage.** Three cases cover the new guard: foreign
  schema (`s2` → not covers), base schema (`main` → covers), absent schema
  (reachable bare/2-part floor → covers). The WHERE path is not separately tested,
  but it consumes the *same* `resolveBodyColumn` object, so the guard logic is
  covered at its single chokepoint — a WHERE variant would be redundant at the
  resolver level.
- **Docs.** Module doc, `makeBodyColumnResolver` doc, and `columnRefParts` doc all
  updated to the new reality; the old "schema qualifier is dropped / known gap"
  wording is gone. No other doc references the dropped-schema behavior.
- **Build / lint / tests.** `yarn workspace @quereus/quereus run build` clean;
  `eslint` clean; `node test-runner.mjs --grep 'coverage prover'` → 44 passing
  (3 new + all pre-existing unchanged).

### Findings

- **Correctness / soundness — none.** The change is a strict narrowing with a
  verified no-widening property.
- **Type safety / error handling / resource cleanup — none.** Tests close their
  DBs in `finally`; no new error paths.
- **DRY — minor, no action.** Schema-equality is now checked in two parallel
  spots — `collectBaseTableQualifiers` (FROM side: `ts.table.schema === undefined
  || ts.table.schema.toLowerCase() === baseTable.schemaName.toLowerCase()`) and
  `makeBodyColumnResolver` (reference side: `ref.schema !== undefined &&
  ref.schema !== baseSchema`). They operate on different structures
  (`TableSource` vs the `columnRefParts` shape) and read clearly in place;
  extracting a shared helper would add indirection for two one-liners. Left as-is.
- **Parallel blind spot (`columnIndexFromExpr` in predicate-shape.ts) — no ticket
  filed, by design.** It ignores both the table qualifier *and* the schema on a
  `ColumnExpr`. Its only callers (`check-extraction.ts`,
  `partial-unique-extraction.ts`) operate over **single-table** CHECK / partial-
  index predicates with no joins or schema qualifiers (asserted by the inline
  comment "Partial-index predicates are single-table … so plain bare-name
  resolution … is faithful"), so the blind spot cannot mis-resolve there. A
  parallel one-line hardening would be defensive only against a non-existent
  caller; filing a ticket would be busywork. Documented here instead.

### Disposition

No major findings — nothing spawned to fix/plan/backlog. No minor findings needed
an inline fix (the implementation, tests, and docs were already correct and
complete). The single judgment call (the `columnIndexFromExpr` parallel blind
spot) is intentionally left untouched with the rationale above.
