description: Closed the AnalyzeStmt round-trip gap by adding SQLite's `ANALYZE <schema>.*` surface syntax — the schema-only shape (`{schemaName}`, no `tableName`) now both parses and stringifies.
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/planner/nodes/analyze-node.ts
  packages/quereus/src/planner/building/analyze.ts
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit-missing-types.spec.ts
  packages/quereus/test/optimizer/statistics.spec.ts
  docs/sql.md
----

## Summary

`AnalyzeStmt` had four meaningful shapes but the parser could only produce three; the
stringifier emitted a schema-only form (`analyze <schema>`) that silently re-parsed to a
*different* AST (`{tableName: <schema>}`). The implementation added SQLite's
`ANALYZE <schema>.*` surface so the schema-only shape round-trips cleanly:

```
analyze        → {}                            → "analyze"
analyze foo    → {tableName:"foo"}             → "analyze foo"
analyze a.b    → {schemaName:"a",tableName:"b"} → "analyze a.b"
analyze main.* → {schemaName:"main"}           → "analyze main.*"   ← closed gap
```

Parser branches on `ASTERISK` after the `DOT`; stringifier and plan-node `toString()`
emit `<schema>.*`. The runtime emitter already analyzed every non-view table in
`targetSchemaName` when `targetTableName` was undefined, so `main.*` semantics were
already correct — no emitter change needed.

## Review findings

### Method
- Read the implement-stage diff (`a121d507`) first, then traced the full
  parse → AST → build → emit → runtime path: `parser.ts:analyzeStatement`,
  `ast-stringify.ts:analyzeToString`, `building/analyze.ts:buildAnalyzeStmt`,
  `nodes/analyze-node.ts`, and `runtime/emit/analyze.ts`.
- Verified the round-trip harness (`checkRoundTrip` → `assertAstEquivalent`) ignores
  `loc` and treats missing/undefined as equivalent, so the property genuinely guards
  shape preservation.
- Re-ran build, the three touched specs, a full lint of the touched source, and the
  full `@quereus/quereus` suite.

### Correctness — clean
- `buildAnalyzeStmt` passes `stmt.schemaName`/`stmt.tableName` straight through; for the
  schema-only AST it builds `AnalyzePlanNode(scope, stmt, undefined, 'main')`, and the
  emitter iterates all non-view tables in that schema. Confirmed end-to-end by the new
  `optimizer/statistics.spec.ts` integration test (products=100, widgets=3).
- `ANALYZE *` (bare asterisk, no schema) is correctly rejected by `consumeIdentifier`
  ("Expected table name after ANALYZE") — matches SQLite, which has no such form.
- Quoted-identifier path: confirmed `analyze "select".*` round-trips (see new test below);
  `quoteIdentifier` + `.*` re-parses back to the schema-only shape.

### Tests — one weak spot fixed inline (minor)
- The implementer flagged that the property arbitrary (`identArb`) only samples safe
  lowercase names, so the `quoteIdentifier` + `.*` emit path was never exercised, and the
  `emit-missing-types` unit test used loose `.include('main') + .include('.*')` assertions.
  **Fixed in this pass**: added `schema-only ANALYZE round-trips a schema name that
  requires quoting` to `emit-roundtrip-property.spec.ts`, using a reserved word (`select`)
  as the schema name to force quoting and assert exact re-parse to `{schemaName:'select',
  tableName: undefined}`. This is the real guard the implementer's note asked for.

### Findings filed — none (major)
No major findings. The change is small, the semantics match SQLite, and the runtime path
was already correct.

### Noted, not acted on
- **Stray doc edits in the implement commit**: `a121d507` also bundles unrelated edits to
  `docs/incremental-maintenance.md` (+Database.watch consumer) and `docs/lens.md`
  (+unique/PK auto-index note). These have nothing to do with ANALYZE — almost certainly
  concurrent working-tree changes swept into the commit. The content itself reads as valid
  documentation for other features, so reverting would risk losing legitimate work; left
  in place. Flagging as a process note, not a defect in this ticket's feature.
- The runtime emitter's EXPLAIN `note` still says `all tables` for the schema-only case
  rather than `<schema>.*` — purely cosmetic, left per the original ticket's "optional
  polish only".

## Validation
- `yarn workspace @quereus/quereus run build` — exit 0.
- Touched specs (`emit-roundtrip-property`, `emit-missing-types`, `optimizer/statistics`)
  — 72 passing.
- ESLint on `parser.ts`, `ast-stringify.ts`, `analyze-node.ts` — exit 0.
- Full `yarn workspace @quereus/quereus test` — **3609 passing, 9 pending, 0 failing**
  (3608 → 3609 from the added quoted-identifier round-trip test).
