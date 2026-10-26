description: Give a prepared write statement (INSERT, UPDATE, DELETE) a method that describes the write: which rows it targets and how it chose them, where each written value comes from, what else it reads, which constraints could reject it, and whether re-applying it to its own result would change anything.
prereq: write-scope-provenance
architecture: docs/change-scope.md
files: packages/quereus/src/planner/analysis/write-scope.ts (new), packages/quereus/src/planner/analysis/write-site-analysis.ts (new), packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/schema/assertion.ts, packages/quereus/src/index.ts, docs/write-scope.md (new), docs/change-scope.md, docs/usage.md, docs/architecture.md, packages/quereus/README.md, packages/quereus/test/optimizer/write-scope-analyzer.spec.ts (new)
difficulty: hard
----

Second of three tickets (`write-scope-provenance` shipped per-column value provenance; `write-scope-module-hook` hands the result to a virtual-table module). This one defines the public data contract, computes it, and exposes it on `Statement`.

## Why a separate contract from `ChangeScope`

`Statement.getChangeScope()` describes what a statement *reads* so a watcher can be told when its result might change; for DML without `RETURNING` it deliberately reports no watches. A write needs a different question answered: *if this write is replayed later over state another writer has changed, what could make it fail or land differently?* That needs the written values' provenance, the constraints the write is subject to, and the rows it read to decide its effect, all of which live only in the planner. `WriteScope` is that description. It reuses `ChangeScope`'s vocabulary (`QualifiedName`, `TableWatch`, `ScopeValue`, `NonDetSource`) so a host already consuming change scopes reads it without learning new shapes.

## Data contract

```ts
// packages/quereus/src/planner/analysis/write-scope.ts
export interface WriteScope {
	/** One entry per write site in the statement, in plan order (a plain DML statement has one; a statement writing through a view that fans out to several base tables, or carrying data-modifying CTEs, has several). */
	readonly writes: ReadonlyArray<TableWrite>;
	readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
	readonly unboundParameters: ReadonlyArray<number | string>;
}

export interface TableWrite {
	readonly table: QualifiedName;
	readonly operation: 'insert' | 'update' | 'delete';
	/** What happens on a constraint conflict. */
	readonly disposition: WriteDisposition;
	/** How existing target rows were chosen. INSERT: `none`. */
	readonly selection: TargetSelection;
	/** The values written, with provenance. INSERT: every table column in schema order. UPDATE: assigned columns, assignment order. DELETE: empty. */
	readonly columns: ReadonlyArray<WrittenColumn>;
	/** Everything the write reads to decide its effect, other than the target rows' own key: WHERE and SET inputs, the INSERT source query, constraint-check subqueries. A watch on the target table itself appears here only for non-key columns it reads (`set n = n + 1` reads `n`; a predicate on a non-key column reads that column). */
	readonly reads: ReadonlyArray<TableWatch>;
	/** The constraints this write is subject to, each classed by whether other rows can affect it. */
	readonly constraints: ReadonlyArray<WriteConstraint>;
	/** True when no written value depends on the target row's own previous values or on other rows — re-applying the write to its own result changes nothing. Distinct from `PhysicalProperties.idempotent` ("safe to evaluate twice in one transaction"). */
	readonly selfIndependent: boolean;
}

export type WriteDisposition =
	| { readonly kind: 'abort' } | { readonly kind: 'fail' } | { readonly kind: 'rollback' }
	| { readonly kind: 'ignore' } | { readonly kind: 'replace' }
	| { readonly kind: 'upsert'; readonly clauses: ReadonlyArray<UpsertClause> };

export interface UpsertClause {
	/** Conflict-target columns, or `'primary-key'` when the clause named none. */
	readonly target: ReadonlyArray<string> | 'primary-key';
	readonly action: 'nothing' | 'update';
	/** DO UPDATE assignments with provenance (empty for `nothing`). */
	readonly columns: ReadonlyArray<WrittenColumn>;
	/** True when the DO UPDATE arm carries a WHERE. */
	readonly conditional: boolean;
}

export type TargetSelection =
	| { readonly kind: 'none' }
	/** Chosen by equality on a unique key; `values` as in `WatchScope.rows` (literals, or parameter placeholders until bound). */
	| { readonly kind: 'rows'; readonly key: ReadonlyArray<string>; readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> }
	/** Chosen by any other predicate, or no predicate, or a key the analysis could not decode. */
	| { readonly kind: 'global' };

export interface WriteConstraint {
	readonly name?: string;
	readonly kind: 'primary-key' | 'unique' | 'not-null' | 'check' | 'foreign-key-child' | 'foreign-key-parent' | 'assertion';
	/** Target-table columns the constraint involves (the key columns; the NOT NULL column; the columns an FK references or is referenced by; empty when unknown, e.g. an assertion). */
	readonly columns: ReadonlyArray<string>;
	/** `row`: decidable from the written row alone. `cross-row`: other rows can make it pass or fail — every key, every FK, every assertion, and a CHECK that contains a subquery or a committed-state reference. */
	readonly locality: 'row' | 'cross-row';
	/** When it is enforced. Assertions are always `deferred` (commit time). */
	readonly timing: 'immediate' | 'deferred';
	/** For `unique`: the constraint has a predicate. */
	readonly partial?: boolean;
	/** For FKs and assertions: the other table involved (an assertion lists its first other dependent table, if any). */
	readonly references?: QualifiedName;
}
```

`WrittenColumn` / `ValueProvenance` come from `value-provenance.ts`; re-export them from `write-scope.ts` and from the package index alongside the `ChangeScope` exports.

Helpers, mirroring change-scope: `bindWriteParameters(scope, params)` substitutes `ScopeValue` placeholders inside every `selection` and `reads` watch and drops the bound indices from `unboundParameters` and from `nonDeterministicSources` — same key spellings and the same `MisuseError` on double binding as `bindParameters`, which it should call per watch rather than reimplement. `serializeWriteScope` / `deserializeWriteScope` — the only non-plain field is `TableWatch.columns`; reuse change-scope's per-watch serializer.

## Where the analysis runs: a memo on the write site

Every write site in a plan is one `DmlExecutorNode`, built by `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt` (the only three constructors of that node). The analysis needs the **logical** shape under it — the `ConstraintCheckNode`, the `InsertNode` / `UpdateNode` / `DeleteNode`, the `Filter` over the target `TableReferenceNode` — which physical optimization replaces with access-path operators. So the builder captures that shape at build time:

```ts
// packages/quereus/src/planner/analysis/write-site-analysis.ts
export class WriteSiteAnalysis {
	constructor(private readonly inputs: {
		readonly check: ConstraintCheckNode;      // the logical node, holding the DML node as its source
		readonly table: TableReferenceNode;
		readonly operation: RowOp;
		readonly onConflict: ConflictResolution | undefined;
		readonly upsertClauses: ReadonlyArray<UpsertClausePlan> | undefined;
	}) {}
	private cached?: TableWrite;
	/** Analyze once; later calls return the same object. `db` is needed for the assertion catalog only and is not retained. */
	analyze(db: Database): TableWrite;
}
```

`DmlExecutorNode` gains a trailing constructor parameter `writeSite?: WriteSiteAnalysis`, carried through `withChildren` unchanged, so the memo (and the single analysis) is shared by every optimized copy of the node. The three builders construct it from the same values they pass the executor.

The analysis runs on the captured subtree **as built** (no optimizer passes): `where id = :p` and `where id = 7` are a `Filter` over the target reference, which `extractBindings` / `extractConstraintsForTable` already decode; shapes that need constant folding or structural rewriting to decode (`where id = 1 + 1`, `where id = (select 1)`) classify as `global`, the conservative answer the contract allows. Leave a `NOTE:` at the memo saying so, with the revisit condition (a host needing one of those shapes decoded: run `optimizeForAnalysis` over the captured subtree first — the pass pipeline accepts any node — and re-check that `relationKeyOf` labels survive).

This placement is what lets the module-hook ticket serve the same object to a module from inside the executor on every execution path (`Statement`, `db.exec`, internal plans), with no per-row and no per-execution cost beyond one memo read.

## Computing each field

- **`operation`, `table`, `disposition`** — straight from the inputs. `onConflict` maps `ROLLBACK/ABORT/FAIL/IGNORE/REPLACE` to the kinds; `undefined` is `abort` (UPDATE and DELETE never carry a statement-level OR clause today — see the builders' comments). Upsert clauses map `conflictTargetIndices` to names (`'primary-key'` when undefined) and `action`; DO UPDATE columns come from `classifyUpsertUpdateColumns`.
- **`columns`** — `classifyInsertColumns` / `classifyUpdateColumns` / empty.
- **`selection`** — for UPDATE and DELETE, run `extractBindings` over the DML node's `source` relation and read the mode of the *source's* target `TableReferenceNode` (the builder creates it with `buildTableReference`, separately from the `.table` reference the executor holds; match by `tableSchema` identity, not node identity). `row` with a non-empty key → `rows` via change-scope's `buildScopeForMode` (export it, together with `extractRowKeyValues` and `scopeValueFromExpr`, from `change-scope.ts`; do not copy them). `row` with an empty key, `group`, `global`, or undecodable values → `global`. INSERT → `none`.
- **`reads`** — factor the read side of `analyzeChangeScope` into an exported `analyzeReads(root, options)` returning `{ watches, nonDeterministicSources, unboundParameters }` *without* the DML-without-RETURNING gate and with the whole-row (`'all'`) output rule switched off (a write serves no rows to a caller; the rule would otherwise pin the target to `'all'` through the DELETE node's forwarded attributes). Call it with the captured `ConstraintCheckNode` as root, walking `getChildren()` only — never `getRelations()` — so the executor's write target (reachable only through `.table`) is not reported as a read. That walk covers the DML node's source and assignment expressions, the CHECK and FK check expressions (their subqueries make the parent or child table a read), the NOT NULL default evaluators, and the mutation-context values. Then post-process the target table's own watch: remove the selection's key columns from its column set; if nothing remains, drop the watch. `analyzeChangeScope` becomes a thin wrapper over `analyzeReads` plus its gate and MV projection, so there is one walker.
- **`constraints`** — from three sources, in this order: the schema (`primaryKeyDefinition` → `primary-key`; `uniqueConstraints` → `unique`, `partial` when a predicate is present; each `notNull` column → `not-null`), the captured `ConstraintCheckNode.constraintChecks` (`kind` `check` / `fk-child` / `fk-parent`; `references` from the FK schema; `timing` is `deferred` when `needsDeferred || initiallyDeferred`; a `check` is `cross-row` when `needsDeferred` — that flag is set exactly when the expression has a relational descendant or a committed-state reference), and the assertion catalog (every `IntegrityAssertionSchema` across the schema manager's schemas whose `dependentTables` names the target's lowercased `schema.table` base key → `assertion`, `cross-row`, `deferred`). For UPDATE, include `primary-key` / `unique` / `foreign-key-child` only when an assigned column is among the constraint's columns, and `not-null` only for assigned columns; `fk-parent` checks already carry `referencedColumnIndices`, keep them as the node built them. For DELETE, only `fk-parent` checks and assertions apply. Locality: every key, FK and assertion is `cross-row`; `not-null` and a non-deferred `check` are `row`.
- **`selfIndependent`** — true iff every provenance in `columns`, and in every upsert clause's `columns`, has a kind other than `self` and `other`. DELETE is trivially true.
- **Statement level** — `Statement.getWriteScope(params?)` sits beside `getChangeScope`: build the analysis plan with the existing `getAnalysisPlan()`, collect every `DmlExecutorNode` in plan order (walk `getChildren()` and `getRelations()`, dedupe by node), call `writeSite.analyze(db)` on each, union their `nonDeterministicSources` / `unboundParameters` (sorted and deduped as change-scope does), apply `bindWriteParameters` when params are given or already bound. A statement with no write site returns `{ writes: [], … }`, never `undefined`, matching how `getChangeScope` returns an empty scope for a statement that reads nothing.

## Edge cases & interactions

- **Insert of literals / parameters / a fresh default / an INSERT … SELECT** — `selection: none`; `columns` per the provenance ticket; for the SELECT form, `reads` carries the source table; constraints list the PK as `cross-row`. Spec cases.
- **Update by key, `set x = :p`** — `selection: rows` on the PK with a parameter placeholder, `reads` has no target watch (only the key was read), `selfIndependent: true`. **`set n = n + 1`** — `reads` carries the target with columns `{n}`, `selfIndependent: false`. **Update by non-key predicate** — `selection: global`, `reads` carries the predicate column. Spec cases for all three.
- **Delete by key** — `selection: rows`, `columns: []`, `selfIndependent: true`, constraints only FK-parent (if any) and assertions. Spec case.
- **Write under a foreign key** — `constraints` has `foreign-key-child` with `references` the parent and locality `cross-row`; `reads` carries the parent table (the synthesized EXISTS subquery references it; the watch is `full`, which is sound but coarse — leave a `NOTE:` that it could narrow to `rows` keyed by the FK columns' provenance when those are literal or input). Spec case.
- **CHECK with a subquery** — `constraints` has `check` with `locality: 'cross-row'`, `timing: 'deferred'`; a plain CHECK is `row` / `immediate`. Spec case for the pair.
- **Assertion over the target table** — appears as `assertion`, `cross-row`, `deferred`. Spec case; it is the only path through the assertion catalog.
- **Upsert** — `insert … on conflict (email) do update set hits = hits + 1`: `disposition.kind: 'upsert'`, clause `target: ['email']`, `action: 'update'`, clause column `hits` is `self`, and `selfIndependent: false` even though the insert row itself is independent. Spec case. `do nothing` → `action: 'nothing'`, `selfIndependent` unaffected.
- **`or ignore` / `or replace`** — `disposition` `ignore` / `replace`; nothing else changes. One spec assertion on the disposition.
- **Non-DML statement** — `getWriteScope()` returns empty `writes`. One assertion.
- **FROM-position DML and data-modifying CTEs** — each nested executor is its own `TableWrite`; the outer statement's `ChangeScope` already reports the write target as a watch (change-scope.md § DML write-target propagation), unchanged. By inspection; name it in the doc.
- **Write through a view or a maintained-table target** — the view-mutation substrate rewrites to base-table statements that go through the same three builders, so every base write site carries a memo and shows up in `writes`. By inspection; name it in the doc.
- **Target reference identity** — the executor's `.table` and the source's `TableReferenceNode` are different node instances with different relation keys; match the selection's reference by `tableSchema`, and exclude the write target from `reads` by walking children only. Assert at the seam: no source reference for the target schema → selection `global` (never throw).
- **Memo sharing across `withChildren`** — one analysis per built plan. `getWriteScope()` builds a fresh analysis plan each call (as `getChangeScope()` does), so the host API is not cached across calls — consistent with the existing method and not hot. By inspection; a `NOTE:` at the memo records per-statement caching as the revisit if a host calls it per execution.
- **`db` not retained** — the memo takes `db` as an argument for the assertion catalog and keeps only the result. By inspection.
- **Schema change after analysis** — a `Statement` is already invalidated on schema change through `validateStatement`; the memo lives on a plan that dies with it. By inspection.
- **Serialization round trip** — `deserializeWriteScope(JSON.parse(JSON.stringify(serializeWriteScope(s))))` deep-equals `s`. One spec case over the richest fixture (the upsert-with-FK one), the way change-scope pins its round trip.
- **Existing change-scope specs** (`test/logic/change-scope.spec.ts`, `test/optimizer/change-scope-analyzer.spec.ts`) must pass unchanged after the `analyzeReads` factoring — they are the regression net for it.

## Documentation

New `docs/write-scope.md` (Beta banner per `docs/stability.md`): the use case, the contract above with one worked example per operation, the conservative-by-construction rule (undecodable selection → `global`, undescribable value → `other`, unknown constraint reach → `cross-row`), the fresh-source rule and the `randomblob` special case, the self-independence definition and why it is not `idempotent`, the memo placement and the "analysis runs on the built logical shape" tradeoff, and known imprecisions. Cross-link from `docs/change-scope.md` (a short "Writes" paragraph pointing over), `docs/usage.md` next to the change-scope paragraph, `docs/architecture.md` beside its change-scope bullet, and the docs index in `packages/quereus/README.md`.

The provenance rules (the six kinds, the rank join, the fresh-wrapper allowlist, the `randomblob` rule, context variables as inputs) already live in `docs/change-scope.md` § Written-value provenance, written by `write-scope-provenance` while there was no write-scope doc. Move that section into `docs/write-scope.md` and leave the "Writes" pointer in its place; `docs/plugins.md` § Fresh scalar functions and the header of `value-provenance.ts` link to it and need re-pointing.

## Tests

One spec, `test/optimizer/write-scope-analyzer.spec.ts`, driven through `db.prepare(sql).getWriteScope()` (the public surface), with the cases named above. Each case asserts the fields that case is about, not the whole object, so a later refinement of an unrelated field does not break every case.

## TODO

- Phase 1 — contract and memo
  - Write `write-scope.ts` (types, `bindWriteParameters`, serializers) and `write-site-analysis.ts` (the memo); add the `writeSite` parameter to `DmlExecutorNode` and its `withChildren`; construct it in the three builders.
- Phase 2 — analysis
  - Factor `analyzeReads` out of `analyzeChangeScope`; export `buildScopeForMode` and friends; implement selection, reads, constraints, disposition, self-independence.
  - Add `Statement.getWriteScope(params?)`; export the new types and helpers from the package index.
- Phase 3 — verify and document
  - Write the spec; run `yarn workspace @quereus/quereus test` and `yarn lint` from `packages/quereus`.
  - Write `docs/write-scope.md`; add the cross-links listed above.
