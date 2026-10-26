/**
 * Public write-scope data contract.
 *
 * `WriteScope` describes a prepared write statement (INSERT, UPDATE, DELETE) for a
 * host that will replay it later over state another writer may have changed: which
 * rows it targets and how it chose them, where each written value comes from, what
 * else it reads, which constraints could reject it, and whether re-applying it to its
 * own result would change anything. It reuses change-scope's vocabulary
 * (`QualifiedName`, `TableWatch`, `ScopeValue`, `NonDetSource`) so a host already
 * consuming change scopes reads it without learning new shapes.
 *
 * The analysis itself runs on the write site's logical plan, captured at build time
 * (`write-site-analysis.ts`); this module holds the contract, the parameter binder and
 * the serializers. See docs/write-scope.md.
 */
import type { SqlParameters, SqlValue } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { DmlExecutorNode } from '../nodes/dml-executor-node.js';
import type { WriteSiteAnalysis } from './write-site-analysis.js';
import {
	bindParameters,
	deserializeTableWatch,
	normalizeNonDet,
	serializeTableWatch,
	sortedDedupParamIndices,
	type NonDetSource,
	type QualifiedName,
	type ScopeValue,
	type SerializedTableWatch,
	type TableWatch,
} from './change-scope.js';
import type { WrittenColumn } from './value-provenance.js';

export type { ValueProvenance, WrittenColumn } from './value-provenance.js';

export interface WriteScope {
	/**
	 * One entry per write site in the statement, in plan order (a plain DML statement
	 * has one; a statement writing through a view that fans out to several base
	 * tables, or carrying data-modifying CTEs, has several).
	 */
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
	/**
	 * The values written, with provenance. INSERT: every table column in schema order.
	 * UPDATE: assigned columns in assignment order. DELETE: empty.
	 */
	readonly columns: ReadonlyArray<WrittenColumn>;
	/**
	 * Everything the write reads to decide its effect, other than the target rows' own
	 * key: WHERE and SET inputs, the INSERT source query, constraint-check subqueries.
	 * A watch on the target table itself appears here only for non-key columns it
	 * reads (`set n = n + 1` reads `n`; a predicate on a non-key column reads that
	 * column).
	 */
	readonly reads: ReadonlyArray<TableWatch>;
	/** The constraints this write is subject to, each classed by whether other rows can affect it. */
	readonly constraints: ReadonlyArray<WriteConstraint>;
	/**
	 * True when no written value depends on the target row's own previous values or
	 * on other rows — re-applying the write to its own result changes nothing.
	 * Distinct from `PhysicalProperties.idempotent` ("safe to evaluate twice in one
	 * transaction").
	 */
	readonly selfIndependent: boolean;
}

export type WriteDisposition =
	| { readonly kind: 'abort' }
	| { readonly kind: 'fail' }
	| { readonly kind: 'rollback' }
	| { readonly kind: 'ignore' }
	| { readonly kind: 'replace' }
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
	/**
	 * Target-table columns the constraint involves (the key columns; the NOT NULL
	 * column; the columns an FK references or is referenced by; empty when unknown,
	 * e.g. an assertion).
	 */
	readonly columns: ReadonlyArray<string>;
	/**
	 * `row`: decidable from the written row alone. `cross-row`: other rows can make it
	 * pass or fail — every key, every FK, every assertion, and a CHECK that contains a
	 * subquery or a committed-state reference.
	 */
	readonly locality: 'row' | 'cross-row';
	/** When it is enforced. Assertions are always `deferred` (commit time). */
	readonly timing: 'immediate' | 'deferred';
	/** For `unique`: the constraint has a predicate. */
	readonly partial?: boolean;
	/** For FKs and assertions: the other table involved (an assertion lists its first other dependent table, if any). */
	readonly references?: QualifiedName;
}

/* --- Statement-level analysis ------------------------------------------------- */

/**
 * The write scope of a built plan: every write site's memoized analysis, in plan
 * order, with the non-deterministic sources and unbound parameters unioned. A plan
 * with no write site yields empty `writes`, never `undefined`.
 */
export function analyzeWriteScope(plan: PlanNode, db: Database): WriteScope {
	const scopes = collectWriteSites(plan).map(site => site.analyze(db));
	return mergeWriteScopes(scopes);
}

/** Every write site in a plan, in plan order, through the memo its builder attached. */
function collectWriteSites(plan: PlanNode): WriteSiteAnalysis[] {
	const sites: WriteSiteAnalysis[] = [];
	const visited = new Set<PlanNode>();
	function walk(node: PlanNode): void {
		if (visited.has(node)) return;
		visited.add(node);
		if (node instanceof DmlExecutorNode && node.writeSite) sites.push(node.writeSite);
		for (const child of node.getChildren()) walk(child as unknown as PlanNode);
		// A nested DML's write target sits outside its children (see change-scope's
		// table walk); follow relations too so no executor is missed.
		for (const relation of node.getRelations()) walk(relation as unknown as PlanNode);
	}
	walk(plan);
	return sites;
}

function mergeWriteScopes(scopes: ReadonlyArray<WriteScope>): WriteScope {
	const unbound = new Set<number | string>();
	for (const scope of scopes) for (const id of scope.unboundParameters) unbound.add(id);
	return {
		writes: scopes.flatMap(scope => scope.writes),
		nonDeterministicSources: normalizeNonDet(scopes.flatMap(scope => scope.nonDeterministicSources)),
		unboundParameters: sortedDedupParamIndices(unbound),
	};
}

/* --- Parameter binding --------------------------------------------------------- */

/**
 * Substitute bound parameters into every selection and read watch, dropping the bound
 * indices from `unboundParameters` and `nonDeterministicSources`. Same key spellings,
 * and the same `MisuseError` on binding one parameter twice, as change-scope's
 * `bindParameters` — which does the work, per watch.
 */
export function bindWriteParameters(scope: WriteScope, params: SqlParameters | SqlValue[]): WriteScope {
	const top = bindParameters({
		watches: [],
		nonDeterministicSources: scope.nonDeterministicSources,
		unboundParameters: scope.unboundParameters,
	}, params);
	return {
		writes: scope.writes.map(write => bindTableWrite(write, params)),
		nonDeterministicSources: top.nonDeterministicSources,
		unboundParameters: top.unboundParameters,
	};
}

function bindTableWrite(write: TableWrite, params: SqlParameters | SqlValue[]): TableWrite {
	const reads = bindParameters({ watches: write.reads, nonDeterministicSources: [], unboundParameters: [] }, params).watches;
	return { ...write, reads, selection: bindSelection(write.selection, write.table, params) };
}

/** A `rows` selection is a `rows` watch scope by construction, so the watch binder serves it unchanged. */
function bindSelection(selection: TargetSelection, table: QualifiedName, params: SqlParameters | SqlValue[]): TargetSelection {
	if (selection.kind !== 'rows') return selection;
	const asWatch: TableWatch = { table, columns: 'all', scope: { kind: 'rows', key: selection.key, values: selection.values } };
	const bound = bindParameters({ watches: [asWatch], nonDeterministicSources: [], unboundParameters: [] }, params).watches[0].scope;
	return bound.kind === 'rows' ? { kind: 'rows', key: bound.key, values: bound.values } : selection;
}

/* --- Serialization ------------------------------------------------------------- */

export interface SerializedTableWrite extends Omit<TableWrite, 'reads'> {
	readonly reads: ReadonlyArray<SerializedTableWatch>;
}

export interface SerializedWriteScope {
	readonly writes: ReadonlyArray<SerializedTableWrite>;
	readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
	readonly unboundParameters: ReadonlyArray<number | string>;
}

/** The only non-plain field is `TableWatch.columns`; everything else is JSON already. */
export function serializeWriteScope(scope: WriteScope): SerializedWriteScope {
	return {
		writes: scope.writes.map(write => ({ ...write, reads: write.reads.map(serializeTableWatch) })),
		nonDeterministicSources: [...scope.nonDeterministicSources],
		unboundParameters: [...scope.unboundParameters],
	};
}

export function deserializeWriteScope(obj: SerializedWriteScope): WriteScope {
	return {
		writes: obj.writes.map(write => ({ ...write, reads: write.reads.map(deserializeTableWatch) })),
		nonDeterministicSources: [...obj.nonDeterministicSources],
		unboundParameters: [...obj.unboundParameters],
	};
}
