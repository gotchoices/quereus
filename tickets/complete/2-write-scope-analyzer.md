description: Give a prepared write statement (INSERT, UPDATE, DELETE) a method that describes the write: which rows it targets and how it chose them, where each written value comes from, what else it reads, which constraints could reject it, and whether re-applying it to its own result would change anything.
prereq: write-scope-provenance
architecture: docs/write-scope.md
files: packages/quereus/src/planner/analysis/write-scope.ts, packages/quereus/src/planner/analysis/write-site-analysis.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/index.ts, packages/quereus/src/schema/assertion.ts, packages/quereus/test/optimizer/write-scope-analyzer.spec.ts, docs/write-scope.md, docs/change-scope.md, docs/usage.md, docs/architecture.md, docs/plugins.md, packages/quereus/README.md
difficulty: hard
----

Second of three tickets (`write-scope-provenance` shipped per-column value provenance; `write-scope-module-hook` will hand the result to a virtual-table module). Defines the public `WriteScope` contract, computes it from a memo the three DML builders attach to the executor node, and exposes it as `Statement.getWriteScope(params?)`. Contract and rules are in `docs/write-scope.md`.

## What shipped (`ticket(implement): write-scope-analyzer`)

- **Contract** (`write-scope.ts`): `WriteScope`, `TableWrite`, `WriteDisposition`, `UpsertClause`, `TargetSelection`, `WriteConstraint`; `analyzeWriteScope(plan, db)`; `bindWriteParameters`; `serializeWriteScope` / `deserializeWriteScope`. Exported from the package index beside the change-scope exports.
- **Memo** (`write-site-analysis.ts`): `WriteSiteAnalysis` captures the logical constraint-check node, the executor's target reference, the operation, the OR clause and the upsert clauses at build time; `analyze(db)` runs once and caches. `DmlExecutorNode` gained a trailing `writeSite?` parameter carried through `withChildren`.
- **Read-side factoring** (`change-scope.ts`): `analyzeReads(root, options)` is the one plan walker; `analyzeChangeScope` wraps it with the DML-without-RETURNING gate and the maintained-table projection.
- **Statement API**: `getWriteScope(params?)` beside `getChangeScope`, same analysis plan, same parameter precedence.
- **Docs**: new `docs/write-scope.md`; provenance section moved there from `change-scope.md`; cross-links in `usage.md`, `architecture.md`, `plugins.md`, package README.
- **Deliberate deviations from the implement ticket**, all kept on review: foreign keys read from the catalog rather than the planned checks (the engine builds no per-row parent probe when it batches RESTRICT at statement end, so the planned checks would omit `foreign-key-parent` for the common plain DELETE); inbound FKs listed whatever their action; `analyze(db)` returns a one-write `WriteScope` rather than a bare `TableWrite`; DELETE lists `on delete`-scoped CHECKs; CHECK `columns` always empty.

## Review findings

Read the implement diff first, then every file it touched and the docs it points at. Probed the public surface with sixteen extra statements beyond the spec (IN lists, OR'd keys, constant-folded keys, a subquery key, a CTE-driven key, `delete` with no WHERE, a write through a view, FROM-position DML, a self-referencing FK, a mixed-action FK, a conditional upsert, a key plus non-key predicate, a subquery self-read) in a throwaway spec, deleted afterwards. Lint (eslint + test-file type pass) clean; full package suite 10812 passing, 25 pending (pre-existing, unchanged).

**Fixed inline (minor):**

- **Inbound FK timing used the wrong action.** `parentForeignKeys` reported `immediate` only when both `on delete` and `on update` were RESTRICT. The engine keys RESTRICT enforcement on the action for the operation at hand (`getBatchableRestrictFks` and `buildParentSideFKChecks` both pick `onDelete` for DELETE, `onUpdate` for UPDATE), so `delete from p` under a child declared `on delete restrict on update cascade` reported `deferred` while the engine rejects it within the statement. Now takes the operation and reads the matching action. One spec case added (both arms, one fixture). The doc's constraints table states the per-operation rule.
- **Doc claimed `where id in (1, 2)` decodes to `rows`.** It is `global`: the IN-to-OR rewrite is an optimizer pass and the analysis runs on the subtree as built (the `NOTE:` on the memo already says so). Verified by probe; `id = 1 or id = 2` is `global` for the same reason. The doc now lists both under the undecoded forms and the selection paragraph no longer promises them.
- **Repeated column-name lowering** in four sites collapsed into one `columnName(tableSchema, i)` helper.
- **`collectWriteSites` used a structural `{ analyze(db) }` type** to dodge an import; a type-only import of `WriteSiteAnalysis` carries no runtime cycle, so it now names the real type.

**Checked and found sound (no change):**

- `targetReads` treating `'all'` as "nothing column-specific read": confirmed `collectColumnReads` only pins `'all'` inside the whole-row-output block, which `wholeRowOutputs: false` skips, so under write-scope `'all'` arises solely from `buildColumnSet`'s empty-set fallback.
- `findTargetReference` on routed writes: the view-mutation builder rewrites to base-table AST and re-enters the same builders, and the UPDATE builder resolves the source reference through the schema manager, so the source scan carries the same schema object. Probe: `update tv set …` through a view reports a `rows` selection on the base table; FROM-position DML is collected.
- Catalog-sourced FKs (deviation 1): right call. The batched-RESTRICT route is the common DELETE and builds no probe; the probe reproduces (`delete from p where id = 7` with a RESTRICT child has no `fk-parent` check on the node). The self-referencing case, which the engine refuses to batch, agrees: per-row probe present, write-scope reports `immediate`.
- UPDATE / DELETE `disposition` is always `abort`: `update or <action>` is pinned closed by design (`test/logic/47.2`), so the builders' `undefined` is the only reachable value.
- Memo lifetime: the memo holds the logical subtree beside the physical one on every prepared statement's cached plan; there is no separate plan cache, so the cost is one extra subtree per live statement. Acceptable; no action.
- `bindWriteParameters` calling change-scope's `bindParameters` three times per write: not hot; the handoff's own tripwire stands.

**Tripwires recorded (conditional, not tickets):**

- `NOTE:` on `WriteSiteAnalysis` (write-site-analysis.ts): the cached result freezes catalog facts read through `db` at first `analyze` — the `foreign_keys` option, the inbound-FK index, the assertion list. Harmless for `getWriteScope()`, which builds a fresh memo per call; the module-hook ticket, which will read the memo on a long-lived execution plan, must rebuild the plan when they change (schema changes already invalidate the statement; an option toggle does not).
- `NOTE:` on `assertionConstraints` (same file) plus a bullet in `docs/write-scope.md` § Known imprecisions: assertion membership comes from `dependentTables`, recorded once at CREATE and never re-derived, so an assertion whose body reads a later-redefined view can be missed or over-listed. The revisit (re-derive on schema change) is already described on the field's doc in `schema/assertion.ts`, which now names write-scope as a second reader.
- Carried over unchanged from the handoff: the FK parent read is a `full` watch (`NOTE:` at the reads call); `getWriteScope()` builds a fresh plan per call (`NOTE:` on the memo); the target watch is trimmed by reference identity, so a subquery self-read stays whole (doc § Known imprecisions).

**Major findings / tickets filed:** none. Nothing crossed the filing bar — every defect found was a one-site fix, and no class-level invariant emerged beyond the tripwires above.

**Tests cut:** none. Each of the implementer's seventeen cases pins a distinct field of the contract through the public surface; none restates the implementation or verifies a mock.

**Docs:** every file the change touches was read against the new reality; the two doc corrections above were the only drift found.

## For the next ticket (`write-scope-module-hook`)

- Read `scope.writes[0]` from the memo; the one-write `WriteScope` shape is deliberate so per-site `nonDeterministicSources` / `unboundParameters` travel with the write.
- Mind the catalog-freeze tripwire on the memo before serving it from a long-lived execution plan.
