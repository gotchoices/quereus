/**
 * Written-value provenance: for every column a write statement produces, where the
 * value comes from — a literal, a statement input, a fresh unique-per-call source, a
 * clock or random source, the target row's own previous values, or other rows.
 *
 * The question each class answers for a conflict predictor: could a second writer,
 * acting on newer state, make this value collide or go stale? See
 * docs/change-scope.md § Written-value provenance.
 *
 * Runs over the logical plan the DML builders produce (before optimization), so the
 * attribute ids it resolves are the builder's. Anything it cannot describe classifies
 * `other` — it never throws.
 */
import type { SqlValue } from '../../common/types.js';
import { FunctionFlags } from '../../common/constants.js';
import { createLogger } from '../../common/logger.js';
import { PhysicalType, type LogicalType } from '../../types/logical-type.js';
import { ANY_TYPE, BLOB_TYPE, TEXT_TYPE } from '../../types/builtin-types.js';
import { buildCellCoercion } from '../../types/validation.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { RelationalPlanNode, RowDescriptor, ScalarPlanNode, Attribute } from '../nodes/plan-node.js';
import type { ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import type { ScalarFunctionCallNode } from '../nodes/function.js';
import type { BinaryOpNode, CollateNode, WriteCoercionNode } from '../nodes/scalar.js';
import type { InNode } from '../nodes/subquery.js';
import type { ProjectNode } from '../nodes/project-node.js';
import type { ValuesNode } from '../nodes/values-node.js';
import type { InsertNode } from '../nodes/insert-node.js';
import type { UpdateNode } from '../nodes/update-node.js';
import type { UpsertClausePlan } from '../nodes/dml-executor-node.js';
import type { ColumnSchema } from '../../schema/column.js';
import type { TableSchema } from '../../schema/table.js';
import type { NonDetSource } from './change-scope.js';
import { classifyNonDetFunction } from './non-det-functions.js';
import { planTimeLiteralValue } from './predicate-shape.js';
import { sqlValueIdentical } from '../../util/comparison.js';

const log = createLogger('planner:analysis:value-provenance');

export type ValueProvenance =
	/** A constant. `value` is present when the expression is a single literal — reported as the write stores it, after conversion to the column's declared type (`'1'` into an integer column is `1`); absent when several different literals were joined (multi-row VALUES), the constant is computed from literals, or the conversion rejects the literal. */
	| { readonly kind: 'literal'; readonly value?: SqlValue }
	/** A deterministic function of statement inputs and literals: bound parameters and/or mutation-context variables (`with context`). */
	| { readonly kind: 'input'; readonly parameters: ReadonlyArray<number | string>; readonly contexts: ReadonlyArray<string> }
	/** Unique per call with at least 128 bits of entropy — a call to a function flagged FRESH, or an injective wrapper over exactly one such call. `function` is the lowercased name of the fresh call. */
	| { readonly kind: 'fresh'; readonly function: string }
	/** Depends on a clock, a non-fresh random source, or a volatile UDF — plus possibly inputs and literals. Not unique per call. */
	| { readonly kind: 'volatile'; readonly sources: ReadonlyArray<NonDetSource> }
	/** Depends on the target row's own previous values — plus possibly anything above. `columns` lists the previous-value columns read. */
	| { readonly kind: 'self'; readonly columns: ReadonlyArray<string> }
	/** Depends on other rows (a subquery, an INSERT … SELECT source column, a join), or anything the classifier cannot describe. The conservative fallback. */
	| { readonly kind: 'other' };

export interface WrittenColumn {
	/** Lowercased table column name. */
	readonly column: string;
	readonly provenance: ValueProvenance;
}

/** What an attribute id an expression references stands for. */
export type AttributeBinding =
	/** The target row's previous value of `column`. */
	| { readonly kind: 'self'; readonly column: string }
	/** The value this same write produces for `column` — resolved through {@link ProvenanceEnv.newColumns}. */
	| { readonly kind: 'new'; readonly column: string }
	/** A mutation-context variable. */
	| { readonly kind: 'context'; readonly name: string }
	/** An attribute whose provenance is already known (a projection or VALUES column the walk classified). */
	| { readonly kind: 'value'; readonly provenance: ValueProvenance };

export interface ProvenanceEnv {
	readonly attributes: ReadonlyMap<number, AttributeBinding>;
	/** Provenance already computed for this write's NEW-row columns, by lowercased name. */
	readonly newColumns?: ReadonlyMap<string, ValueProvenance>;
}

/**
 * Operators that keep a `fresh` operand fresh: injective over the values a fresh source
 * produces, so a unique input stays unique. Holds only when the fresh operand is the
 * operator's single non-literal operand (`||` qualifies only against a literal).
 *
 * Only `hex` is injective over a blob. The others render a blob operand as text first,
 * and that decode is non-fatal — invalid UTF-8 collapses to U+FFFD (`util/value-text.ts`)
 * — so over a statically blob-typed fresh operand they yield `other`. A `cast`, and the
 * planner's write coercion (otherwise looked through, like `collate`), keep `fresh` only
 * across a lossless conversion: see {@link conversionKeepsFresh}.
 *
 * NOTE: `lower` / `upper` are injective only over single-case text — they are listed for
 * the common `lower(hex(randomblob(16)))` id spelling. Revisit when a module needs another
 * wrapper recognised, or a case-mixed fresh text source makes lowercasing lossy.
 */
export const FRESH_PRESERVING_WRAPPERS = {
	functions: new Set(['hex', 'lower', 'upper']),
	/** The subset of `functions` injective over a blob operand too. */
	blobSafeFunctions: new Set(['hex']),
	nodeTypes: new Set<PlanNodeType>([PlanNodeType.Cast]),
	binaryOperators: new Set(['||']),
} as const;

/** `randomblob(n)` is fresh only for a literal n of at least this many bytes (128 bits). */
const FRESH_RANDOMBLOB_MIN_BYTES = 16;

const OTHER: ValueProvenance = { kind: 'other' };

const RANK: Record<ValueProvenance['kind'], number> = {
	literal: 0, input: 1, fresh: 2, volatile: 3, self: 4, other: 5,
};

const OPERATOR_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.UnaryOp, PlanNodeType.BinaryOp, PlanNodeType.CaseExpr, PlanNodeType.Cast, PlanNodeType.Between,
]);

/* --- Expression classification ------------------------------------------------ */

/** Classify one scalar expression bottom-up against `env`. */
export function classifyExpression(expr: ScalarPlanNode, env: ProvenanceEnv): ValueProvenance {
	switch (expr.nodeType) {
		case PlanNodeType.Literal: {
			const value = planTimeLiteralValue(expr);
			return value === undefined ? { kind: 'literal' } : { kind: 'literal', value };
		}
		case PlanNodeType.ParameterReference:
			return { kind: 'input', parameters: [(expr as ParameterReferenceNode).nameOrIndex], contexts: [] };
		case PlanNodeType.ColumnReference:
			return classifyColumnReference(expr as ColumnReferenceNode, env);
		case PlanNodeType.ScalarFunctionCall:
			return classifyFunctionCall(expr as ScalarFunctionCallNode, env);
		case PlanNodeType.WriteCoercion:
			return classifyWriteCoercion(expr as WriteCoercionNode, env);
		case PlanNodeType.Collate:
			// Identity on the value: only the comparison collation changes.
			return classifyExpression((expr as CollateNode).operand, env);
		case PlanNodeType.In:
			return (expr as InNode).source ? OTHER : classifyOperator(expr, env);
		default:
			// ScalarSubquery / Exists read other rows; anything else is undescribable.
			return OPERATOR_NODE_TYPES.has(expr.nodeType) ? classifyOperator(expr, env) : OTHER;
	}
}

/**
 * The planner's conversion of an inserted cell to its column's declared type. The insert
 * builder wraps nearly every cell in one, so it is not an operator (that would strip
 * `value` from almost every inserted literal).
 */
function classifyWriteCoercion(node: WriteCoercionNode, env: ProvenanceEnv): ValueProvenance {
	const operand = classifyExpression(node.operand, env);
	return afterWriteConversion(operand, node.operand.getType().logicalType, node.targetType.logicalType, node.columnName);
}

/**
 * `provenance` of a value of static type `from` once the write converts it to a column of
 * declared type `to` (`buildCellCoercion` — the insert path's write coercion and the
 * UPDATE / DO UPDATE assignment conversion alike): a literal's `value` becomes its stored
 * form, and a fresh value stays fresh only across a lossless conversion.
 */
function afterWriteConversion(provenance: ValueProvenance, from: LogicalType, to: LogicalType, columnName: string): ValueProvenance {
	switch (provenance.kind) {
		case 'fresh':
			return conversionKeepsFresh(from, to) ? provenance : OTHER;
		case 'literal':
			return provenance.value === undefined ? provenance : writtenLiteral(provenance.value, from, to, columnName);
		default:
			return provenance;
	}
}

function writtenLiteral(value: SqlValue, from: LogicalType, to: LogicalType, columnName: string): ValueProvenance {
	const coerce = buildCellCoercion(from, to, columnName);
	if (!coerce) return { kind: 'literal', value };
	try {
		return { kind: 'literal', value: coerce(value) };
	} catch (e) {
		// The write raises this same mismatch when the statement runs; until then there is
		// no stored value to report.
		log('literal for column %s does not convert to its declared type: %s', columnName, e instanceof Error ? e.message : String(e));
		return { kind: 'literal' };
	}
}

/**
 * Whether converting a fresh value of static type `from` to `to` keeps it unique. Identity
 * and text→blob (UTF-8 encoding) do; blob→text decodes non-fatally, and a numeric,
 * temporal or JSON parse normalizes, so neither does. A source of unknown type (`ANY` —
 * e.g. a function registered without a return type) is trusted on the registrant's promise.
 *
 * NOTE: so an untyped fresh function returning a blob, written to a text column, stays
 * `fresh` although the decode is lossy. Revisit if `fresh: true` comes to require a
 * declared return type.
 */
function conversionKeepsFresh(from: LogicalType, to: LogicalType): boolean {
	if (from === to || from === ANY_TYPE || to === ANY_TYPE) return true;
	if (to === TEXT_TYPE) return from.physicalType === PhysicalType.TEXT;
	if (to === BLOB_TYPE) return from.physicalType === PhysicalType.TEXT || from.physicalType === PhysicalType.BLOB;
	return false;
}

function classifyColumnReference(ref: ColumnReferenceNode, env: ProvenanceEnv): ValueProvenance {
	const binding = env.attributes.get(ref.attributeId);
	switch (binding?.kind) {
		case 'self': return { kind: 'self', columns: [binding.column] };
		case 'context': return { kind: 'input', parameters: [], contexts: [binding.name] };
		// A column this write has not classified yet (a cycle the builder's topological
		// ordering should make impossible) has no known provenance.
		case 'new': return env.newColumns?.get(binding.column) ?? OTHER;
		case 'value': return binding.provenance;
		default: return OTHER;
	}
}

function classifyFunctionCall(call: ScalarFunctionCallNode, env: ProvenanceEnv): ValueProvenance {
	const schema = call.functionSchema;
	const name = schema.name.toLowerCase();
	if ((schema.flags & FunctionFlags.FRESH) !== 0) return { kind: 'fresh', function: name };
	if ((schema.flags & FunctionFlags.DETERMINISTIC) !== 0) return classifyOperator(call, env);
	if (name === 'randomblob' && isFreshRandomblobLength(call.operands)) return { kind: 'fresh', function: name };
	// A volatile call is itself a volatile operand over its arguments.
	const operands = call.operands.map(operand => classifyExpression(operand, env));
	return combineOperands([{ kind: 'volatile', sources: [classifyNonDetFunction(name)] }, ...operands], false);
}

function isFreshRandomblobLength(operands: ReadonlyArray<ScalarPlanNode>): boolean {
	if (operands.length !== 1) return false;
	const n = planTimeLiteralValue(operands[0]);
	return (typeof n === 'number' && Number.isInteger(n) && n >= FRESH_RANDOMBLOB_MIN_BYTES)
		|| (typeof n === 'bigint' && n >= BigInt(FRESH_RANDOMBLOB_MIN_BYTES));
}

function classifyOperator(expr: ScalarPlanNode, env: ProvenanceEnv): ValueProvenance {
	const children = expr.getChildren() as ReadonlyArray<ScalarPlanNode>;
	const operands = children.map(child => classifyExpression(child, env));
	const freshIndex = operands.findIndex(p => p.kind === 'fresh');
	return combineOperands(operands, freshIndex >= 0 && wrapperKeepsFresh(expr, children[freshIndex]));
}

/** Whether `expr` is a fresh-preserving wrapper over its operand `freshOperand`. */
function wrapperKeepsFresh(expr: ScalarPlanNode, freshOperand: ScalarPlanNode): boolean {
	const operandType = freshOperand.getType().logicalType;
	const isBlob = operandType.physicalType === PhysicalType.BLOB;
	switch (expr.nodeType) {
		case PlanNodeType.ScalarFunctionCall: {
			const name = (expr as ScalarFunctionCallNode).functionSchema.name.toLowerCase();
			return FRESH_PRESERVING_WRAPPERS.functions.has(name)
				&& (!isBlob || FRESH_PRESERVING_WRAPPERS.blobSafeFunctions.has(name));
		}
		case PlanNodeType.BinaryOp:
			return !isBlob && FRESH_PRESERVING_WRAPPERS.binaryOperators.has((expr as BinaryOpNode).expression.operator);
		default:
			return FRESH_PRESERVING_WRAPPERS.nodeTypes.has(expr.nodeType)
				&& conversionKeepsFresh(operandType, expr.getType().logicalType);
	}
}

/**
 * Combine an operator's operand provenances: the highest rank wins and the detail
 * arrays of that kind are unioned. A computed constant drops its literal `value`.
 * A fresh operand survives only through a fresh-preserving wrapper whose single
 * non-literal operand it is; otherwise a non-injective function of a unique value is
 * not unique, so the result is `other`.
 */
function combineOperands(operands: ReadonlyArray<ValueProvenance>, preservesFresh: boolean): ValueProvenance {
	const fresh = operands.find(p => p.kind === 'fresh');
	if (fresh) {
		const nonLiteral = operands.filter(p => p.kind !== 'literal');
		return preservesFresh && nonLiteral.length === 1 ? fresh : OTHER;
	}
	return joinByRank(operands);
}

/** Highest-rank kind among `parts` (no `fresh` among them), with that kind's details unioned. */
function joinByRank(parts: ReadonlyArray<ValueProvenance>): ValueProvenance {
	let top: ValueProvenance['kind'] = 'literal';
	for (const part of parts) {
		if (RANK[part.kind] > RANK[top]) top = part.kind;
	}
	switch (top) {
		case 'literal':
			return { kind: 'literal' };
		case 'input':
			return {
				kind: 'input',
				parameters: unionDetails(parts, p => p.kind === 'input' ? p.parameters : [], String),
				contexts: unionDetails(parts, p => p.kind === 'input' ? p.contexts : [], String),
			};
		case 'volatile':
			return { kind: 'volatile', sources: unionDetails(parts, p => p.kind === 'volatile' ? p.sources : [], nonDetSourceKey) };
		case 'self':
			return { kind: 'self', columns: unionDetails(parts, p => p.kind === 'self' ? p.columns : [], String) };
		default:
			return OTHER;
	}
}

function unionDetails<T>(
	parts: ReadonlyArray<ValueProvenance>,
	pick: (part: ValueProvenance) => ReadonlyArray<T>,
	keyOf: (item: T) => string,
): T[] {
	const seen = new Map<string, T>();
	for (const part of parts) {
		for (const item of pick(part)) {
			const key = keyOf(item);
			if (!seen.has(key)) seen.set(key, item);
		}
	}
	return [...seen.values()];
}

function nonDetSourceKey(source: NonDetSource): string {
	switch (source.kind) {
		case 'volatileUdf': return `udf:${source.name}`;
		case 'parameter': return `param:${String(source.index)}`;
		default: return source.kind;
	}
}

/**
 * Join one column's cells across the rows of a multi-row VALUES. Not an operator: each
 * row's value is written as is, so a column stays fresh only when every row draws from
 * the same fresh source, and stays a literal with a `value` only when every row agrees.
 */
function joinRows(cells: ReadonlyArray<ValueProvenance>): ValueProvenance {
	if (cells.length === 1) return cells[0];
	if (cells.some(cell => cell.kind === 'fresh')) {
		const first = cells[0];
		return first.kind === 'fresh' && cells.every(cell => cell.kind === 'fresh' && cell.function === first.function)
			? first
			: OTHER;
	}
	const joined = joinByRank(cells);
	if (joined.kind === 'literal') {
		const first = cells[0];
		const value = first?.kind === 'literal' ? first.value : undefined;
		const agree = value !== undefined
			&& cells.every(cell => cell.kind === 'literal' && cell.value !== undefined && sqlValueIdentical(cell.value, value));
		return agree ? { kind: 'literal', value } : joined;
	}
	return joined;
}

/* --- Relational walk (INSERT source) ------------------------------------------- */

/**
 * Provenance of each output attribute of an INSERT source: walks the ProjectNode chain
 * the insert builder stacks (row expansion, expression defaults, generated columns) down
 * to a ValuesNode. A chain that bottoms out in any other relational node contributes
 * nothing, so references into it classify `other`.
 */
function relationProvenance(rel: RelationalPlanNode, env: ProvenanceEnv): Map<number, ValueProvenance> {
	switch (rel.nodeType) {
		case PlanNodeType.Values:
			return valuesProvenance(rel as ValuesNode, env);
		case PlanNodeType.Project:
			return projectProvenance(rel as ProjectNode, env);
		default:
			return new Map();
	}
}

function valuesProvenance(values: ValuesNode, env: ProvenanceEnv): Map<number, ValueProvenance> {
	const out = new Map<number, ValueProvenance>();
	values.getAttributes().forEach((attr, colIdx) => {
		out.set(attr.id, joinRows(values.rows.map(row => classifyExpression(row[colIdx], env))));
	});
	return out;
}

function projectProvenance(project: ProjectNode, env: ProvenanceEnv): Map<number, ValueProvenance> {
	const inner = relationProvenance(project.source, env);
	const innerEnv = withValueBindings(env, inner);
	const out = new Map<number, ValueProvenance>();
	const attributes = project.getAttributes();
	project.projections.forEach((projection, i) => {
		out.set(attributes[i].id, classifyExpression(projection.node, innerEnv));
	});
	return out;
}

function withValueBindings(env: ProvenanceEnv, provenances: ReadonlyMap<number, ValueProvenance>): ProvenanceEnv {
	if (provenances.size === 0) return env;
	const attributes = new Map(env.attributes);
	for (const [id, provenance] of provenances) attributes.set(id, { kind: 'value', provenance });
	return { ...env, attributes };
}

/* --- Environments ---------------------------------------------------------------- */

function contextBindings(contextAttributes: ReadonlyArray<Attribute> | undefined): Map<number, AttributeBinding> {
	const out = new Map<number, AttributeBinding>();
	for (const attr of contextAttributes ?? []) {
		out.set(attr.id, { kind: 'context', name: attr.name.toLowerCase() });
	}
	return out;
}

/** Each attribute id of a row descriptor, paired with the column name at its index. */
function descriptorColumns(descriptor: RowDescriptor | undefined, columnNames: ReadonlyArray<string>): Map<number, string> {
	const out = new Map<number, string>();
	descriptor?.forEach((colIdx, attrId) => {
		const column = columnNames[colIdx];
		if (column !== undefined) out.set(attrId, column);
	});
	return out;
}

/**
 * Classify a list of assignments in order. A user assignment reads the target row's
 * previous values (`baseEnv`); a generated-column recompute is evaluated against the
 * post-assignment row, so its reference to a previous-value attribute of a column already
 * assigned resolves to that assignment's provenance instead.
 */
function classifyAssignments(
	assignments: ReadonlyArray<Assignment>,
	baseEnv: ProvenanceEnv,
	selfAttributeColumns: ReadonlyMap<number, string>,
): WrittenColumn[] {
	const written: WrittenColumn[] = [];
	const assigned = new Map<string, ValueProvenance>();
	for (const { target, value, isGenerated } of assignments) {
		const column = target.name.toLowerCase();
		const env = isGenerated ? postAssignmentEnv(baseEnv, selfAttributeColumns, assigned) : baseEnv;
		// Assignments carry no write-coercion node; the executor converts each value to
		// the column's declared type before storing it (and before a generated column reads it).
		const provenance = afterWriteConversion(classifyExpression(value, env), value.getType().logicalType, target.logicalType, target.name);
		assigned.set(column, provenance);
		written.push({ column, provenance });
	}
	return written;
}

interface Assignment {
	readonly target: ColumnSchema;
	readonly value: ScalarPlanNode;
	readonly isGenerated: boolean;
}

function postAssignmentEnv(
	baseEnv: ProvenanceEnv,
	selfAttributeColumns: ReadonlyMap<number, string>,
	assigned: ReadonlyMap<string, ValueProvenance>,
): ProvenanceEnv {
	const attributes = new Map(baseEnv.attributes);
	for (const [attrId, column] of selfAttributeColumns) {
		const provenance = assigned.get(column);
		if (provenance) attributes.set(attrId, { kind: 'value', provenance });
	}
	return { ...baseEnv, attributes };
}

/* --- Entry points ---------------------------------------------------------------- */

/** One entry per table column, in schema order: the value the INSERT writes there. */
export function classifyInsertColumns(node: InsertNode): WrittenColumn[] {
	const env: ProvenanceEnv = { attributes: contextBindings(node.contextAttributes) };
	const provenances = relationProvenance(node.source, env);
	const sourceAttributes = node.source.getAttributes();
	return node.table.tableSchema.columns.map((col, i) => {
		const attr = sourceAttributes[i] as Attribute | undefined;
		return { column: col.name.toLowerCase(), provenance: (attr && provenances.get(attr.id)) ?? OTHER };
	});
}

/** One entry per assignment (user SETs, then generated recomputes), in assignment order. */
export function classifyUpdateColumns(node: UpdateNode): WrittenColumn[] {
	const { columns, columnIndexMap } = node.table.tableSchema;
	// SET and WHERE bind to the source relation's attributes — the target row's previous values.
	const selfAttributeColumns = new Map<number, string>();
	node.source.getAttributes().forEach((attr, i) => {
		selfAttributeColumns.set(attr.id, (columns[i]?.name ?? attr.name).toLowerCase());
	});
	const attributes = contextBindings(node.contextAttributes);
	for (const [attrId, column] of selfAttributeColumns) attributes.set(attrId, { kind: 'self', column });
	const assignments = node.assignments.flatMap(a => {
		const target = columns[columnIndexMap.get(a.targetColumn.name.toLowerCase()) ?? -1] as ColumnSchema | undefined;
		return target ? [{ target, value: a.value, isGenerated: a.isGenerated === true }] : [];
	});
	return classifyAssignments(assignments, { attributes }, selfAttributeColumns);
}

/**
 * The DO UPDATE arm's assignments (empty for DO NOTHING) on `table`, the statement's
 * target. `insertColumns` is the statement's {@link classifyInsertColumns} result: NEW
 * references resolve to it; existing-row references are `self`.
 */
export function classifyUpsertUpdateColumns(
	clause: UpsertClausePlan,
	table: TableSchema,
	insertColumns: ReadonlyArray<WrittenColumn>,
): WrittenColumn[] {
	if (clause.action !== 'update' || !clause.assignments) return [];
	const columnNames = table.columns.map(c => c.name.toLowerCase());
	const selfAttributeColumns = descriptorColumns(clause.existingRowDescriptor, columnNames);
	const attributes = new Map<number, AttributeBinding>();
	for (const [attrId, column] of descriptorColumns(clause.newRowDescriptor, columnNames)) {
		attributes.set(attrId, { kind: 'new', column });
	}
	for (const [attrId, column] of selfAttributeColumns) attributes.set(attrId, { kind: 'self', column });
	const env: ProvenanceEnv = {
		attributes,
		newColumns: new Map(insertColumns.map(c => [c.column, c.provenance])),
	};
	const generated = new Set(clause.generatedAssignmentColumns ?? []);
	const assignments = [...clause.assignments].flatMap(([colIdx, value]) => {
		const target = table.columns[colIdx] as ColumnSchema | undefined;
		return target ? [{ target, value, isGenerated: generated.has(colIdx) }] : [];
	});
	return classifyAssignments(assignments, env, selfAttributeColumns);
}
