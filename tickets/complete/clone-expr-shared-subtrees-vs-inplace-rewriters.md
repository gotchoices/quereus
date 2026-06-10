description: COMPLETE — cloneExpr/cloneQueryExpr made truly deep (WITH-clause CTE bodies, IUD-RETURNING subqueries, window functions no longer shared by reference), so in-place rename rewriters over a clone can no longer mutate the DECLARED/stored source AST. Reviewed: all rewriter mutation channels verified against the clone coverage; spec extended from 7 to 10 cases.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts   # all production changes
  - packages/quereus/test/schema/clone-expr-isolation.spec.ts  # regression spec (10 cases after review)
  - packages/quereus/src/schema/rename-rewriter.ts             # unchanged — the in-place mutation channels the clone isolates
  - packages/quereus/src/schema/schema-differ.ts               # unchanged victim (clones at 907 / 1077 before rewriting)
  - packages/quereus/src/planner/building/constraint-builder.ts # unchanged victim (clones at 163 before strip)
----

# Completed: deep-clone the three subtree kinds `cloneExpr` shared with the source AST

## What was wrong

`cloneExpr` / `cloneQueryExpr` (scope-transform.ts) promised a deep structural clone
but shared three subtree kinds by reference: WITH-clause CTE bodies (`rebuildSelect`
never rebuilt `withClause`), IUD-RETURNING subqueries (`mapQueryExprUniform` returned
`{ ...query }` shallow for insert/update/delete), and window functions (`transformExpr`
had no `windowFunction` case). The in-place rename rewriters (`renameTableInAst`,
`renameColumnInCheckExpression`, `stripSelfQualifierInCheckExpression`) descend into
all three, so running them over a "clone" mutated the source — corrupting the
DECLARED ASTs behind the schema differ's rename reconcile and the stored constraint
AST behind the constraint builder's qualifier strip.

## What was changed (all in scope-transform.ts)

- **`transformExpr`**: new `windowFunction` case rebuilding `function` (args mapped
  through `transformExpr`) and `window` via new helpers `transformWindowDefinition` /
  `transformFrameBound`. Substitution/descend are threaded through (deliberate
  semantic widening — before, window subtrees were both shared AND unsubstituted, a
  latent view-mutation substitution gap; the widening is strictly a gap-fix).
- **`rebuildSelect`**: now emits `withClause: cloneWithClause(sel.withClause)` — a
  pure structural clone; CTE bodies go through `cloneQueryExpr`, NOT the substitution
  descend (preserves the documented "CTE bodies are never rewritten" contract).
- **`mapQueryExprUniform`**: the IUD branch's `{ ...query }` replaced with
  `cloneDmlStmt` — a pure structural deep clone. New module-private helpers:
  `cloneWithClause`, `cloneResultColumns`, `cloneContextValues`, `cloneUpsertClause`,
  `cloneDmlStmt`.

## Review findings

**Checked:**

- Read the implement diff fresh, then verified every in-place mutation channel of all
  three rewriters against the clone coverage: `ColumnExpr` name/table/schema writes
  (`transformExpr` column case returns `{ ...expr }`), FROM `TableSource.table`
  identifier writes (`rebuildFrom` clones the nested identifier), DML target
  `IdentifierExpr` writes (`cloneDmlStmt` clones `table`), update/upsert assignment
  `a.column` writes (assignment objects rebuilt), and `stmt.columns` /
  `uc.conflictTarget` array replacements (property assignment on cloned parents —
  safe even where arrays were shared). No reachable shared subtree remains.
- Verified field coverage against ast.ts shapes: `SelectStmt`, `InsertStmt` /
  `UpdateStmt` / `DeleteStmt` (all expression-bearing fields cloned; `ValuesStmt`
  carries no `withClause` so the values branch is complete), `WithClause` /
  `CommonTableExpr`, `WindowDefinition` / `WindowFrame` / `WindowFrameBound`
  (`end: WindowFrameBound | null` handled), `UpsertClause`, `ContextAssignment`.
- Verified the `Expression` union: `FunctionSource` is the only remaining member with
  nested expressions falling to the default `{ ...expr }` branch — and confirmed the
  parser constructs `FunctionSource` only in FROM position (parser.ts:996), where
  `rebuildFrom` deep-clones its args. The residual is unreachable from parsed ASTs.
- Verified every rewriter call site: schema-differ clones before rewriting
  (schema-differ.ts:907, :1077), constraint-builder clones before the strip
  (constraint-builder.ts:163); alter-table.ts mutates live schema ASTs intentionally
  (forward rename propagation — not a clone consumer).
- Docs: docs/schema.md already describes the rewrite-over-`cloneExpr` design; no doc
  claimed the old sharing behavior, so the fix restores the documented contract.
  No doc updates needed.
- Lint clean, tsc build clean, full workspace suite green (5565 passing / 9
  pre-existing pendings in quereus; exit 0) — including the test/logic/93.x
  view-mutation suites that exercise the substitution callers affected by the
  windowFunction semantic widening.

**Minor findings (fixed inline):** three coverage gaps in the regression spec — no
DELETE-RETURNING channel, the third rewriter victim
(`stripSelfQualifierInCheckExpression`, the constraint-builder channel) never
exercised, and the `cloneDmlStmt` → `cloneWithClause` path (WITH attached to a DML
subquery) untested. Added three cases (spec now 10, all passing): table rename
through DELETE-RETURNING, table rename through a WITH clause on a DML subquery, and
self-qualifier strip through a window function.

**Noted, no action (with reasons):**

- Pre-existing rename-rewriter limitation: the `windowDefinition` cases in
  rename-rewriter.ts descend into `partitionBy` / `orderBy` only, never into
  frame-bound value expressions — a column reference in a frame bound would not be
  renamed. Not a clone-sharing leak (the clone rebuilds frame bounds regardless), and
  frame bounds are effectively constant expressions; not worth a ticket.
- Residual reference sharing confirmed safe: `tags` Records, `compound.existence`
  readonly arrays, `loc` objects, and scalar-position `FunctionSource` args — the
  rewriters never mutate any of these, and scalar `FunctionSource` is unreachable
  from the parser.
- `rebuildSelect` shares `SelectStmt.schemaPath` while `cloneDmlStmt` clones the DML
  `schemaPath` — inconsistent but harmless (no rewriter mutates schemaPath entries).

**Major findings:** none — no new tickets filed.

## Validation (final, review pass)

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` (tsc) — clean.
- Focused spec — 10/10 passing.
- `yarn test` (full workspace) — green, exit 0.
