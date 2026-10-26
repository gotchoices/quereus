description: Give a prepared write statement (INSERT, UPDATE, DELETE) a method that describes the write: which rows it targets and how it chose them, where each written value comes from, what else it reads, which constraints could reject it, and whether re-applying it to its own result would change anything.
prereq: write-scope-provenance
architecture: docs/write-scope.md
files: packages/quereus/src/planner/analysis/write-scope.ts (new), packages/quereus/src/planner/analysis/write-site-analysis.ts (new), packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/index.ts, packages/quereus/test/optimizer/write-scope-analyzer.spec.ts (new), docs/write-scope.md (new), docs/change-scope.md, docs/usage.md, docs/architecture.md, docs/plugins.md, packages/quereus/README.md
difficulty: hard
----

Second of three tickets (`write-scope-provenance` shipped per-column value provenance; `write-scope-module-hook` will hand the result to a virtual-table module). This one defines the public `WriteScope` contract, computes it from a memo the three DML builders attach to the executor node, and exposes it as `Statement.getWriteScope(params?)`. The contract and the rules are documented in `docs/write-scope.md`; this handoff covers what was built, where it deviates from the implement ticket, and what the reviewer should press on.

## What shipped

- **Contract** (`write-scope.ts`): `WriteScope`, `TableWrite`, `WriteDisposition`, `UpsertClause`, `TargetSelection`, `WriteConstraint`, re-exported `WrittenColumn` / `ValueProvenance`; `analyzeWriteScope(plan, db)`; `bindWriteParameters`; `serializeWriteScope` / `deserializeWriteScope`. All exported from the package index beside the change-scope exports.
- **Memo** (`write-site-analysis.ts`): `WriteSiteAnalysis` holds the logical `ConstraintCheckNode` (and through it the Insert / Update / Delete node and the Filter over the target scan), the executor's target reference, the operation, the OR clause and the upsert clause plans. `analyze(db)` runs once and caches. `DmlExecutorNode` gained a trailing `writeSite?` constructor parameter, carried through `withChildren`; the three builders construct it from the same values they pass the executor.
- **Read-side factoring** (`change-scope.ts`): `analyzeReads(root, options)` is now the one plan walker; `analyzeChangeScope` is a wrapper that adds the DML-without-RETURNING gate and the maintained-table projection (the projection rides a `refineWatch` hook, which is also how write-scope trims the target's own watch). Options: `followRelations` (off for write-scope so the executor's `.table` is not a read), `wholeRowOutputs` (off for write-scope), `refineWatch`. Also exported: `buildScopeForMode`, `extractRowKeyValues`, `scopeValueFromExpr`, `normalizeNonDet`, `sortedDedupParamIndices`, `qualifiedNameOf`, `serializeTableWatch` / `deserializeTableWatch`.
- **Statement API**: `getWriteScope(params?)` beside `getChangeScope`, same analysis plan, same parameter precedence (explicit params, else already-bound ones).
- **Docs**: new `docs/write-scope.md` (contract, worked examples, conservative rule, the provenance section moved here from change-scope.md, constraints table, memo placement tradeoff, serialization, known imprecisions). `docs/change-scope.md` now has a short *Writes* pointer where the provenance section was; cross-links added in `usage.md`, `architecture.md`, `plugins.md` and the package README; `value-provenance.ts` header re-pointed.

## Deviations from the implement ticket (deliberate, please weigh)

1. **Foreign keys come from the catalog, not from the planned checks.** The ticket sourced `fk-child` / `fk-parent` from `ConstraintCheckNode.constraintChecks`. But the parent-side per-row probes are *not built* when the engine batches RESTRICT enforcement at statement end (`getBatchableRestrictFks` admits every plain DELETE / UPDATE with ABORT, no lens, all-RESTRICT inbound FKs) — the common case — so the node alone would silently omit `foreign-key-parent`. Both sides are now read from the schema: own FKs via `tableSchema.foreignKeys`, inbound via `schemaManager.getReferencingForeignKeys`. Timing rule: child side is `deferred` (the engine's existence probe is a subquery and always runs at commit); parent side is `immediate` for RESTRICT, `deferred` otherwise. Both are gated on the `foreign_keys` option, as enforcement is.
2. **Inbound FKs are listed whatever their action.** A CASCADE / SET NULL cannot reject the write, but which children exist changes what it does, so it is "other rows can affect it". Documented in write-scope.md § Constraints and § Known imprecisions.
3. **`WriteSiteAnalysis.analyze(db)` returns a `WriteScope` with one write**, not a bare `TableWrite`: the per-site `nonDeterministicSources` / `unboundParameters` have to travel with the write for the statement-level union, and a module reading `writes[0]` is a natural shape for the hook ticket. If the hook ticket wants a bare `TableWrite`, it is `scope.writes[0]`.
4. **DELETE lists `check` constraints scoped to delete** (`check (…) on delete`), in addition to the FK-parent and assertion entries the ticket named — the planner builds them for the operation, and they can reject the write.
5. **CHECK `columns` is always empty.** The planned check carries no column list; deriving one from the AST was not asked for. Documented as "empty when unknown".

## Known gaps and tripwires (indexed here; the analysis is at the site)

- `NOTE:` in `write-site-analysis.ts` (memo class doc): analysis runs on the built logical subtree with no optimizer pass, so `where id = 1 + 1` / `where id = (select 1)` classify `global`; revisit condition and the `optimizeForAnalysis` route are stated there.
- `NOTE:` same file: `getWriteScope()` builds a fresh plan and memo per call (consistent with `getChangeScope`); per-statement caching is the revisit if a host calls it per execution.
- `NOTE:` same file, at the reads call: an FK parent read is a `full` watch (correlated existence probe); it could narrow to `rows` keyed by the FK columns' provenance.
- The target watch is trimmed by reference identity (the source scan's `TableReferenceNode`, found by schema identity then by name); a subquery read of the same table (`set x = (select max(x) from t)`) stays a whole separate watch. By design, noted in the doc's imprecisions.
- `disposition` reflects the statement-level OR clause / upsert only; a constraint-level `on conflict` default is not surfaced. Noted in the doc.
- `bindWriteParameters` calls change-scope's `bindParameters` three times per write (reads, selection-as-watch, top level), so `normalizeBoundParams` re-runs per call. Not hot; flag if a host binds many writes in a loop.
- Serialization caveat inherited from change-scope: a `bigint` or blob literal (in a selection value or a `literal` provenance) is not JSON-representable; `structuredClone` carries it. Stated in the doc.

## Tests (`test/optimizer/write-scope-analyzer.spec.ts`, 17 cases, all through `db.prepare(sql).getWriteScope()`)

Each case asserts only the fields it is about.

- insert of literals and parameters → `selection: none`, per-column provenance, PK `cross-row`, `selfIndependent: true`, disposition `abort`.
- insert … select → source table in `reads`, source-fed columns `other`, not self-independent.
- `or ignore` / `or replace` → disposition.
- upsert `on conflict (email) do update set hits = hits + 1` → clause target / action / `conditional`, `hits` is `self`, `selfIndependent: false`, unique constraint on `email` with `partial: false`.
- upsert `do nothing` → target `'primary-key'`, empty clause columns, self-independent.
- update by key with parameters → `rows` selection with a placeholder, no target read, assigned-column provenance `input`, `unboundParameters` sorted, no `primary-key` entry (key not assigned).
- `set n = n + 1 where id = 1` → target read `{n}`, provenance `self`, not self-independent.
- update by non-key predicate → `global`, target read `{name}` on a `full` scope.
- delete by key → `rows`, empty columns and reads, self-independent, constraints are the assertion only.
- write under an FK → `foreign-key-child` referencing the parent, parent appears in reads.
- delete of a referenced row → `foreign-key-parent` referencing the child, `immediate`.
- plain CHECK vs subquery CHECK → `row/immediate` vs `cross-row/deferred`, subquery table in reads.
- assertion over the target → `assertion`, `cross-row`, `deferred`, named.
- NOT NULL → row-local; UPDATE lists assigned columns only (every column is NOT NULL by default in this engine, so the key column is listed on INSERT).
- non-DML statement → `{ writes: [], … }`.
- parameter binding via `getWriteScope(params)` and `bindWriteParameters` (partial bind leaves the rest unbound; double binding throws `MisuseError`).
- serialize → JSON → deserialize deep-equals the live scope (upsert-under-FK fixture with a parameter).

Regression nets run unchanged and green: `test/optimizer/change-scope-analyzer.spec.ts`, `test/logic/change-scope.spec.ts`, `test/optimizer/value-provenance.spec.ts`, `test/optimizer/dml-child-exposure.spec.ts`. Full package: `yarn workspace @quereus/quereus test` — 10811 passing, 25 pending (pre-existing). `yarn lint` in `packages/quereus` (eslint + test-file type pass) clean.

## What the reviewer should press on

- Whether deviation 1 (catalog-sourced FKs) is the right call versus correlating the planned checks; the batched-RESTRICT gap is real and reproducible (`delete from p where id = 7` with a RESTRICT child builds no `fk-parent` check).
- `findTargetReference` picks the first pre-order `TableReferenceNode` matching by schema identity, else the first by name. For a view-routed or lens-routed write the source scan's schema object should still be the same one the executor holds; worth a look at the multi-source decomposition path.
- `targetReads` drops the target watch when its columns are `'all'` — with `wholeRowOutputs: false` that can only mean "no column read", but confirm no other path yields `'all'` for a DML source scan.
- Memo lifetime: the memo (and the logical subtree it holds) now lives on every cached execution plan's executor node. It is one object per statement build; confirm that is acceptable for the plan cache's memory profile.
