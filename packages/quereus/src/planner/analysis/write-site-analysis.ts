/**
 * Per-write-site analysis behind `WriteScope`.
 *
 * Every write site in a plan is one `DmlExecutorNode`, and the analysis needs the
 * LOGICAL shape under it — the `ConstraintCheckNode`, the Insert / Update / Delete
 * node, the Filter over the target reference — which physical optimization replaces
 * with access-path operators. So the three DML builders capture that shape here at
 * build time and hang the memo on the executor; `withChildren` carries it, so every
 * optimized copy of the node shares one analysis, and the executor can serve the
 * same object to a module on every execution path at the cost of one memo read.
 *
 * Conservative by construction: a selection the analysis cannot decode is `global`,
 * a value it cannot describe is `other` (value-provenance.ts), a constraint whose
 * reach is unknown is `cross-row`. It never throws on an unexpected shape.
 */
import type { Database } from '../../core/database.js';
import { ConflictResolution } from '../../common/constants.js';
import type { RowOp } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import { resolveReferencedColumns } from '../../schema/table.js';
import type { PlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import type { ConstraintCheckNode, ConstraintCheck } from '../nodes/constraint-check-node.js';
import type { UpsertClausePlan } from '../nodes/dml-executor-node.js';
import { InsertNode } from '../nodes/insert-node.js';
import { UpdateNode } from '../nodes/update-node.js';
import { DeleteNode } from '../nodes/delete-node.js';
import { extractBindings } from './binding-extractor.js';
import { relationBaseName, relationKeyOf } from './relation-key.js';
import {
	analyzeReads,
	buildScopeForMode,
	qualifiedNameOf,
	sortedDedupParamIndices,
	type QualifiedName,
	type TableWatch,
} from './change-scope.js';
import { classifyInsertColumns, classifyUpdateColumns, classifyUpsertUpdateColumns, type WrittenColumn } from './value-provenance.js';
import type { TableWrite, TargetSelection, UpsertClause, WriteConstraint, WriteDisposition, WriteScope } from './write-scope.js';

const log = createLogger('planner:analysis:write-site');

export interface WriteSiteInputs {
	/** The logical constraint-check node, holding the DML prep node as its source. */
	readonly check: ConstraintCheckNode;
	/** The executor's write target. */
	readonly table: TableReferenceNode;
	readonly operation: RowOp;
	readonly onConflict: ConflictResolution | undefined;
	readonly upsertClauses: ReadonlyArray<UpsertClausePlan> | undefined;
}

/**
 * Memo of one write site's analysis. `analyze` runs once; later calls return the
 * same object. The result is a `WriteScope` holding exactly one `TableWrite`, so a
 * statement over several sites merges them and a module reads `writes[0]`.
 *
 * NOTE: the analysis runs on the captured subtree AS BUILT, with no optimizer pass.
 * `where id = :p` and `where id = 7` are a Filter over the target reference, which
 * the binding extractor already decodes; a shape that needs constant folding or a
 * structural rewrite to decode (`where id = 1 + 1`, `where id = (select 1)`)
 * classifies `global`, the conservative answer the contract allows. Revisit when a
 * host needs one of those shapes decoded: run `optimizeForAnalysis` over the
 * captured subtree first — the pass pipeline accepts any node — and re-check that
 * the `relationKeyOf` labels survive the rewrite.
 *
 * NOTE: `Statement.getWriteScope()` builds a fresh analysis plan, and so a fresh
 * memo, on every call — consistent with `getChangeScope()`, and not hot. Revisit
 * with per-statement caching if a host calls it per execution.
 *
 * NOTE: the cached result freezes catalog facts read through `db` at first
 * `analyze` — the `foreign_keys` option, the inbound-FK index, the assertion
 * list. A fresh memo per `getWriteScope()` call never sees them change. The
 * module hook (`UpdateArgs.writeScope`, emit/dml-executor.ts) reads one memo
 * across every execution of a prepared plan: a schema change invalidates the
 * statement and so the memo; a `foreign_keys` toggle does not, but the DML
 * builders bake that option into the plan's own FK checks too, so the
 * description is no staler than the enforcement it describes until recompile.
 * Revisit if `foreign_keys` ever invalidates prepared plans on change.
 */
export class WriteSiteAnalysis {
	private cached?: WriteScope;

	constructor(private readonly inputs: WriteSiteInputs) {}

	/** `db` is needed for the constraint catalog (inbound foreign keys, assertions) only and is not retained. */
	analyze(db: Database): WriteScope {
		if (!this.cached) this.cached = analyzeWriteSite(this.inputs, db);
		return this.cached;
	}
}

const NONE: TargetSelection = { kind: 'none' };

/** The lowercased name a scope reports a column under. */
function columnName(tableSchema: TableSchema, index: number): string {
	return tableSchema.columns[index].name.toLowerCase();
}
const GLOBAL: TargetSelection = { kind: 'global' };

function analyzeWriteSite(inputs: WriteSiteInputs, db: Database): WriteScope {
	const { check, operation } = inputs;
	const tableSchema = inputs.table.tableSchema;
	const dml = check.source;
	const unbound = new Set<number | string>();

	const columns = writtenColumns(operation, dml, tableSchema);
	const upsertClauses = inputs.upsertClauses?.map(clause => describeUpsertClause(clause, tableSchema, columns));
	const { selection, targetRef } = selectTargetRows(operation, dml, tableSchema, unbound);
	// NOTE: a foreign key's parent arrives here as a `full` watch — the child-side
	// existence probe is a correlated subquery, which the binding extractor cannot pin
	// to a key. Sound but coarse; revisit by narrowing it to `rows` keyed by the FK
	// columns' provenance when every one of them is a literal or an input.
	const reads = analyzeReads(check, {
		// The executor's own target is reachable only through `.table` (a relation, not
		// a child), so a children-only walk is what keeps it out of the reads.
		followRelations: false,
		wholeRowOutputs: false,
		refineWatch: (ref, watch) => ref === targetRef ? targetReads(watch, selection) : watch,
	});
	const assigned = operation === 'update' ? new Set(columns.map(c => c.column)) : undefined;
	const written = [...columns, ...(upsertClauses ?? []).flatMap(clause => clause.columns)];

	const write: TableWrite = {
		table: qualifiedNameOf(tableSchema),
		operation,
		disposition: disposition(inputs.onConflict, upsertClauses),
		selection,
		columns,
		reads: reads.watches,
		constraints: writeConstraints(operation, tableSchema, check.constraintChecks, db, assigned),
		selfIndependent: written.every(c => c.provenance.kind !== 'self' && c.provenance.kind !== 'other'),
	};
	for (const id of reads.unboundParameters) unbound.add(id);
	return {
		writes: [write],
		nonDeterministicSources: reads.nonDeterministicSources,
		unboundParameters: sortedDedupParamIndices(unbound),
	};
}

/* --- Written values ----------------------------------------------------------- */

function writtenColumns(operation: RowOp, dml: RelationalPlanNode, tableSchema: TableSchema): WrittenColumn[] {
	switch (operation) {
		case 'insert':
			if (dml instanceof InsertNode) return classifyInsertColumns(dml);
			log('insert site %s: expected an InsertNode under the check, got %s; every column is other', tableSchema.name, dml.nodeType);
			return tableSchema.columns.map(col => ({ column: col.name.toLowerCase(), provenance: { kind: 'other' } }));
		case 'update':
			if (dml instanceof UpdateNode) return classifyUpdateColumns(dml);
			log('update site %s: expected an UpdateNode under the check, got %s; no assignment described', tableSchema.name, dml.nodeType);
			return [];
		case 'delete':
			return [];
	}
}

function describeUpsertClause(clause: UpsertClausePlan, tableSchema: TableSchema, insertColumns: ReadonlyArray<WrittenColumn>): UpsertClause {
	return {
		target: clause.conflictTargetIndices
			? clause.conflictTargetIndices.map(i => columnName(tableSchema, i))
			: 'primary-key',
		action: clause.action,
		columns: classifyUpsertUpdateColumns(clause, tableSchema, insertColumns),
		conditional: clause.whereCondition !== undefined,
	};
}

/** An upsert clause takes precedence over a statement-level OR clause; `undefined` is the ABORT default. */
function disposition(onConflict: ConflictResolution | undefined, upsertClauses: ReadonlyArray<UpsertClause> | undefined): WriteDisposition {
	if (upsertClauses && upsertClauses.length > 0) return { kind: 'upsert', clauses: upsertClauses };
	switch (onConflict) {
		case ConflictResolution.ROLLBACK: return { kind: 'rollback' };
		case ConflictResolution.FAIL: return { kind: 'fail' };
		case ConflictResolution.IGNORE: return { kind: 'ignore' };
		case ConflictResolution.REPLACE: return { kind: 'replace' };
		default: return { kind: 'abort' };
	}
}

/* --- Target selection --------------------------------------------------------- */

/**
 * How UPDATE / DELETE chose their rows: the binding mode of the source's reference
 * to the target table (built by the DML builder separately from the executor's
 * `.table` reference, so it is matched by schema, never by node identity). `row`
 * mode on a decodable non-empty key is `rows`; anything else is `global`.
 */
function selectTargetRows(
	operation: RowOp,
	dml: RelationalPlanNode,
	tableSchema: TableSchema,
	unbound: Set<number | string>,
): { selection: TargetSelection; targetRef?: TableReferenceNode } {
	if (operation === 'insert') return { selection: NONE };
	if (!(dml instanceof UpdateNode) && !(dml instanceof DeleteNode)) return { selection: GLOBAL };
	const targetRef = findTargetReference(dml.source, tableSchema);
	if (!targetRef) {
		log('%s site %s: no source reference to the target table; selection is global', operation, tableSchema.name);
		return { selection: GLOBAL };
	}
	const relKey = relationKeyOf(targetRef);
	const mode = extractBindings(dml.source).perRelation.get(relKey);
	if (!mode || mode.kind !== 'row' || mode.keyColumns.length === 0) return { selection: GLOBAL, targetRef };
	const scope = buildScopeForMode(dml.source, targetRef, relKey, mode, unbound);
	return {
		selection: scope.kind === 'rows' ? { kind: 'rows', key: scope.key, values: scope.values } : GLOBAL,
		targetRef,
	};
}

/** The source's scan of the target table: the same schema object when the builders agree, the same name otherwise. */
function findTargetReference(source: RelationalPlanNode, tableSchema: TableSchema): TableReferenceNode | undefined {
	const base = relationBaseName(tableSchema);
	let byName: TableReferenceNode | undefined;
	const pending: PlanNode[] = [source];
	while (pending.length > 0) {
		const node = pending.shift()!;
		if (node instanceof TableReferenceNode) {
			if (node.tableSchema === tableSchema) return node;
			if (!byName && relationBaseName(node.tableSchema) === base) byName = node;
		}
		pending.push(...(node.getChildren() as readonly PlanNode[]));
	}
	return byName;
}

/**
 * The target's own watch keeps only the non-key columns the write read; the key is
 * the selection's business. Nothing column-specific read (`'all'` here can only mean
 * that, with the whole-row rule off) or nothing left → no watch.
 */
function targetReads(watch: TableWatch, selection: TargetSelection): TableWatch | undefined {
	if (watch.columns === 'all') return undefined;
	const remaining = new Set(watch.columns);
	if (selection.kind === 'rows') for (const key of selection.key) remaining.delete(key);
	return remaining.size === 0 ? undefined : { ...watch, columns: remaining };
}

/* --- Constraints -------------------------------------------------------------- */

/**
 * Keys, NOT NULLs and foreign keys come from the catalog; CHECKs from the checks the
 * builder planned for this operation (their `needsDeferred` is exactly "has a
 * relational descendant or a committed-state reference"); assertions from the
 * catalog's dependent-table lists. For UPDATE, a key or FK applies only when an
 * assigned column is among its columns, NOT NULL only for assigned columns.
 *
 * Foreign keys are read from the catalog rather than the planned checks because the
 * parent-side per-row probes are not built when the engine batches RESTRICT
 * enforcement at statement end (`getBatchableRestrictFks`) — the common plain
 * DELETE — and the child-side check does not carry its FK schema.
 */
function writeConstraints(
	operation: RowOp,
	tableSchema: TableSchema,
	checks: ReadonlyArray<ConstraintCheck>,
	db: Database,
	assigned: ReadonlySet<string> | undefined,
): WriteConstraint[] {
	const touches = (columns: ReadonlyArray<string>): boolean => assigned === undefined || columns.some(c => assigned.has(c));
	const out: WriteConstraint[] = [];
	if (operation !== 'delete') {
		out.push(...keyConstraints(tableSchema, touches));
		out.push(...notNullConstraints(tableSchema, assigned));
	}
	out.push(...checkConstraints(checks));
	if (db.options.getBooleanOption('foreign_keys')) {
		if (operation !== 'delete') out.push(...childForeignKeys(tableSchema, touches));
		if (operation !== 'insert') out.push(...parentForeignKeys(operation, tableSchema, db, touches));
	}
	out.push(...assertionConstraints(tableSchema, db));
	return out;
}

function keyConstraints(tableSchema: TableSchema, touches: (columns: ReadonlyArray<string>) => boolean): WriteConstraint[] {
	const name = (i: number): string => columnName(tableSchema, i);
	const out: WriteConstraint[] = [];
	const pk = tableSchema.primaryKeyDefinition.map(d => name(d.index));
	if (touches(pk)) out.push({ kind: 'primary-key', columns: pk, locality: 'cross-row', timing: 'immediate' });
	for (const unique of tableSchema.uniqueConstraints ?? []) {
		const columns = unique.columns.map(name);
		if (!touches(columns)) continue;
		out.push({
			...(unique.name !== undefined ? { name: unique.name } : {}),
			kind: 'unique',
			columns,
			locality: 'cross-row',
			timing: 'immediate',
			partial: unique.predicate !== undefined,
		});
	}
	return out;
}

function notNullConstraints(tableSchema: TableSchema, assigned: ReadonlySet<string> | undefined): WriteConstraint[] {
	return tableSchema.columns
		.filter(col => col.notNull && (assigned === undefined || assigned.has(col.name.toLowerCase())))
		.map(col => ({ kind: 'not-null', columns: [col.name.toLowerCase()], locality: 'row', timing: 'immediate' }));
}

function checkConstraints(checks: ReadonlyArray<ConstraintCheck>): WriteConstraint[] {
	return checks
		.filter(check => check.kind === 'check')
		.map(check => ({
			...(check.constraint.name !== undefined ? { name: check.constraint.name } : {}),
			kind: 'check',
			columns: [],
			locality: check.needsDeferred ? 'cross-row' : 'row',
			timing: check.needsDeferred || check.initiallyDeferred ? 'deferred' : 'immediate',
		}));
}

/** The table's own FKs. The engine checks parent existence with a subquery, so the probe always runs at commit. */
function childForeignKeys(tableSchema: TableSchema, touches: (columns: ReadonlyArray<string>) => boolean): WriteConstraint[] {
	const out: WriteConstraint[] = [];
	for (const fk of tableSchema.foreignKeys ?? []) {
		const columns = fk.columns.map(i => columnName(tableSchema, i));
		if (!touches(columns)) continue;
		out.push({
			...(fk.name !== undefined ? { name: fk.name } : {}),
			kind: 'foreign-key-child',
			columns,
			locality: 'cross-row',
			timing: 'deferred',
			references: { schema: (fk.referencedSchema ?? tableSchema.schemaName).toLowerCase(), table: fk.referencedTable.toLowerCase() },
		});
	}
	return out;
}

/**
 * FKs declared on other tables that reference this one, whatever their action: a
 * RESTRICT rejects the write when children exist, and a cascading action lands it
 * differently depending on which children exist — both are "other rows can affect
 * it". Only the action for THIS operation counts (`on delete` for a DELETE,
 * `on update` for an UPDATE — the same split `getBatchableRestrictFks` and
 * `buildParentSideFKChecks` make): a RESTRICT is checked within the statement; the
 * engine treats the others as deferrable.
 */
function parentForeignKeys(
	operation: 'update' | 'delete',
	tableSchema: TableSchema,
	db: Database,
	touches: (columns: ReadonlyArray<string>) => boolean,
): WriteConstraint[] {
	const out: WriteConstraint[] = [];
	for (const { childTable, fk } of db.schemaManager.getReferencingForeignKeys(tableSchema.schemaName, tableSchema.name)) {
		const columns = referencedColumnNames(fk, tableSchema, childTable);
		if (!touches(columns)) continue;
		const restrict = (operation === 'delete' ? fk.onDelete : fk.onUpdate) === 'restrict';
		out.push({
			...(fk.name !== undefined ? { name: fk.name } : {}),
			kind: 'foreign-key-parent',
			columns,
			locality: 'cross-row',
			timing: restrict ? 'immediate' : 'deferred',
			references: qualifiedNameOf(childTable),
		});
	}
	return out;
}

function referencedColumnNames(fk: ForeignKeyConstraintSchema, parent: TableSchema, child: TableSchema): string[] {
	try {
		return resolveReferencedColumns(fk, parent).map(i => columnName(parent, i));
	} catch (e) {
		// A malformed FK is refused when the write runs; until then its reach is unknown.
		log('FK from %s to %s does not resolve on the parent: %s', child.name, parent.name, e instanceof Error ? e.message : String(e));
		return [];
	}
}

/**
 * Every assertion, in any schema, whose body depends on the target table. Always
 * commit-time, always over other rows.
 *
 * NOTE: `dependentTables` is recorded once at CREATE ASSERTION and is informational
 * (see its doc in schema/assertion.ts): it goes stale when a view in the body is
 * redefined over different tables, so this list can then miss or over-list an
 * assertion. If a host needs it live, re-derive it on schema change as that doc
 * describes rather than planning every assertion body here.
 */
function assertionConstraints(tableSchema: TableSchema, db: Database): WriteConstraint[] {
	const base = relationBaseName(tableSchema);
	const out: WriteConstraint[] = [];
	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const assertion of schema.getAllAssertions()) {
			const dependents = assertion.dependentTables ?? [];
			if (!dependents.some(d => d.base === base)) continue;
			const other = dependents.find(d => d.base !== base);
			out.push({
				name: assertion.name,
				kind: 'assertion',
				columns: [],
				locality: 'cross-row',
				timing: 'deferred',
				...(other ? { references: qualifiedNameFromBase(other.base) } : {}),
			});
		}
	}
	return out;
}

/** The inverse of `relationBaseName`: a schema name never contains a dot, so the first one splits. */
function qualifiedNameFromBase(base: string): QualifiedName {
	const dot = base.indexOf('.');
	return dot < 0 ? { schema: 'main', table: base } : { schema: base.slice(0, dot), table: base.slice(dot + 1) };
}
