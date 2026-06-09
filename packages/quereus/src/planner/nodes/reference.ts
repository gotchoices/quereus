import type { BaseType, ScalarType, RelationType } from '../../common/datatype.js';
import { PlanNode, type ZeroAryRelationalNode, type ZeroAryScalarNode, type Attribute, type InjectivityResult, type MonotonicityResult, type PhysicalProperties, type FunctionalDependency, type ConstantBinding, type DomainConstraint, type InclusionDependency, type UpdateSite, type AttributeDefault } from './plan-node.js';
import { addFd, closeConstantBindingsOverEcs, isSuperkey, mergeConstantBindings, mergeDomainConstraints, mergeEquivClasses } from '../util/fd-utils.js';
import { seedTableForeignKeyInds } from '../util/ind-utils.js';
import { getCheckExtraction, type CheckExtraction } from '../analysis/check-extraction.js';
import { getPartialUniqueGuardedFds } from '../analysis/partial-unique-extraction.js';
import { getAssertionHoistedConstraints } from '../analysis/assertion-hoist-cache.js';
import type { SchemaManager } from '../../schema/manager.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableSchema } from '../../schema/table.js';
import type { Scope } from '../scopes/scope.js';
import type * as AST from '../../parser/ast.js';
import { relationTypeFromTableSchema } from '../type-utils.js';
import { Cached } from '../../util/cached.js';
import type { FunctionSchema } from '../../schema/function.js';
import { isTableValuedFunctionSchema } from '../../schema/function.js';
import { formatScalarType } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';
import { getModuleConcurrencyMode } from '../../vtab/concurrency.js';
import type { ColumnBindingProvider } from '../framework/characteristics.js';
import type { TableAccessCapable } from '../framework/characteristics.js';

/** Shared empty `CheckExtraction` instance used when a vtab module's
 *  `permitsGrandfatheredCheckViolators` capability suppresses the CHECK
 *  contribution lift in `TableReferenceNode.computePhysical`. */
const EMPTY_CHECK_EXTRACTION: CheckExtraction = {
	fds: [],
	equivPairs: [],
	constantBindings: [],
	domainConstraints: [],
};

/**
 * Fold a producer's FDs (declared-CHECK-derived or assertion-hoisted) onto
 * `fds`, gating the over-claiming bi-directional value-equality pair.
 *
 * A `col1 = col2` CHECK / hoisted assertion emits the mutual determination
 * `{a}↔{b}` (both `{a}→{b}` and `{b}→{a}`). That pair is a uniqueness claim only
 * when one endpoint is a genuine declared key here — over a narrow non-unique
 * relation (e.g. `check (a = b)` then `select distinct a, b`) it otherwise lets
 * `deriveKeysFromFds` read a phantom all-columns key (a bag read as a set) and
 * `rule-distinct-elimination` drops a REQUIRED DISTINCT. So fold a single↔single
 * FD `{a}→{b}` whose unordered pair `{a,b}` is in the producer's `equivPairs`
 * only when `a` or `b` is a superkey of `realKeyFds`; otherwise drop it.
 *
 * Everything else passes through unchanged: `∅ → col` constant FDs, one-way
 * `other → col` expression FDs (e.g. `check (b = a + 1)` ⇒ `a → b`, which carries
 * NO equiv pair), and guarded implication-form FDs (they never participate in key
 * derivation until Filter activation, and `isSuperkey`/closure skip guards
 * anyway). `equivPairs` is the producer's authoritative value-equality marker —
 * `handleEquality` pushes a pair ONLY for the `col = col` shape — so it precisely
 * separates the over-claiming bi-FD from legitimate one-way single↔single FDs.
 *
 * Mirrors the filter consumption gate (`FilterNode.computePhysical`); the EC
 * merge stays unconditional in the caller. See ticket
 * `fd-check-assertion-key-bag-overclaim` (and its sibling
 * `fd-derived-key-bag-overclaim` for the four shipped sites).
 */
function foldGatedProducerFds(
	fds: ReadonlyArray<FunctionalDependency>,
	producerFds: ReadonlyArray<FunctionalDependency>,
	equivPairs: ReadonlyArray<readonly [number, number]>,
	realKeyFds: ReadonlyArray<FunctionalDependency>,
	colCount: number,
): ReadonlyArray<FunctionalDependency> {
	const equivPairKeys = new Set<string>();
	for (const [a, b] of equivPairs) {
		equivPairKeys.add(`${Math.min(a, b)},${Math.max(a, b)}`);
	}
	let out = fds;
	for (const fd of producerFds) {
		if (
			fd.guard === undefined &&
			fd.determinants.length === 1 &&
			fd.dependents.length === 1
		) {
			const a = fd.determinants[0];
			const b = fd.dependents[0];
			if (equivPairKeys.has(`${Math.min(a, b)},${Math.max(a, b)}`)) {
				if (
					!isSuperkey(new Set([a]), realKeyFds, colCount) &&
					!isSuperkey(new Set([b]), realKeyFds, colCount)
				) {
					continue;
				}
			}
		}
		out = addFd(out, fd);
	}
	return out;
}

/** Represents a reference to a table in the global schema. */
export class TableReferenceNode extends PlanNode implements ZeroAryRelationalNode, TableAccessCapable, ColumnBindingProvider {
	override readonly nodeType = PlanNodeType.TableReference;

	private typeCache: Cached<RelationType>;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly tableSchema: TableSchema,
		public readonly vtabModule: AnyVirtualTableModule,
		public readonly vtabAuxData?: unknown,
		estimatedCostOverride?: number,
		public readonly readCommitted: boolean = false,
		/**
		 * Optional reference to the schema manager that owns `tableSchema`.
		 * Threaded through so `computePhysical` can hoist qualifying CREATE
		 * ASSERTION predicates into FD / EC / binding / domain contributions
		 * via `assertion-hoist-cache`. When undefined (e.g. tests that
		 * construct a TableReferenceNode in isolation), assertion-hoisting is
		 * skipped — declared CHECK / partial-unique contributions are
		 * unaffected.
		 */
		public readonly schemaManager?: SchemaManager,
	) {
		super(scope, estimatedCostOverride ?? 1);
		this.typeCache = new Cached(() => relationTypeFromTableSchema(tableSchema));
		this.attributesCache = new Cached(() => {
			// Create attributes from table schema columns
			return this.tableSchema.columns.map((column) => ({
				id: PlanNode.nextAttrId(),
				name: column.name,
				type: {
					typeClass: 'scalar' as const,
					logicalType: column.logicalType,
					nullable: !column.notNull,
					isReadOnly: false,
					collationName: column.collation
				},
				sourceRelation: `${this.tableSchema.schemaName}.${this.tableSchema.name}`,
				relationName: this.tableSchema.name
			}));
		});
	}

	getType(): RelationType {
		return this.typeCache.value;
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`TableReferenceNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	get estimatedRows(): number | undefined {
		return this.tableSchema.estimatedRows;
	}

	computePhysical(_childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		// Seed FDs from declared keys: each declared key (PK + UNIQUE) becomes
		// `key → other-columns`. This is the canonical encoding of "K is a unique
		// key" — downstream consumers query `physical.fds` (via `isSuperkey` /
		// `hasAnyKey`) without special-casing keys.
		const relType = this.getType();
		const colCount = relType.columns.length;
		let fds: ReadonlyArray<FunctionalDependency> = [];
		for (const key of relType.keys) {
			if (key.length === 0) continue;
			const det = key.map(k => k.index);
			const detSet = new Set(det);
			const dep: number[] = [];
			for (let i = 0; i < colCount; i++) {
				if (!detSet.has(i)) dep.push(i);
			}
			if (dep.length === 0) continue;
			fds = addFd(fds, { determinants: det, dependents: dep });
		}

		// Immutable snapshot of the FD set built from declared PK/UNIQUE keys
		// ONLY — captured before any CHECK / partial-unique / hoisted FD is folded.
		// `addFd` returns a fresh array and never mutates its input, so this
		// reference stays pinned to the declared-key FDs and is the gate's real-key
		// probe. (ticket fd-check-assertion-key-bag-overclaim)
		const realKeyFds = fds;

		// Merge in CHECK-derived FDs/ECs/bindings/domains. Cached per-schema.
		//
		// Skipped wholesale when the owning vtab module declares the
		// `permitsGrandfatheredCheckViolators` capability: under that contract
		// `ALTER TABLE … ADD CHECK` against non-conforming rows succeeds and
		// grandfathers the violators, so a declared CHECK is no longer a
		// universal invariant over the current row set and lifting it into
		// physical properties would let consumers (e.g. the filter-contradiction
		// rule) fold WHERE predicates that would have matched the violators.
		// Assertion-hoist and partial-UNIQUE contributions are independent
		// paths and are NOT gated by this flag.
		const permitsCheckViolators =
			this.vtabModule.getCapabilities?.().permitsGrandfatheredCheckViolators === true;
		const checkExt: CheckExtraction = permitsCheckViolators
			? EMPTY_CHECK_EXTRACTION
			: getCheckExtraction(this.tableSchema);
		// Gate the over-claiming bi-directional value-equality pair against the
		// declared keys; everything else folds unchanged. See `foldGatedProducerFds`.
		fds = foldGatedProducerFds(fds, checkExt.fds, checkExt.equivPairs, realKeyFds, colCount);

		// Guarded FDs from partial UNIQUE constraints (`CREATE UNIQUE INDEX (K)
		// WHERE P`). The unconditional UC path in relationTypeFromTableSchema
		// skips these (uniqueness only holds within P's scope); here we emit
		// `K → others [guard=P]` so Filter activation can discharge the guard
		// for queries whose WHERE clause entails P.
		for (const fd of getPartialUniqueGuardedFds(this.tableSchema)) {
			fds = addFd(fds, fd);
		}

		// Assertion-hoist contributions. CREATE ASSERTION predicates in canonical
		// `not exists (select 1 from T [where P])` shape are folded onto T as
		// if they were per-row CHECKs — see `assertion-hoist-cache.ts`. Merged
		// AFTER declared-check / partial-unique so structurally-identical
		// dedup'd entries keep the declared-check provenance.
		const hoisted = this.schemaManager !== undefined
			? getAssertionHoistedConstraints(this.schemaManager, this.tableSchema)
			: undefined;
		if (hoisted) {
			// Same gate as checkExt, against the hoisted producer's own equivPairs
			// and the shared declared-key probe. Folded AFTER checkExt so
			// structurally-identical entries keep `declared-check` provenance.
			fds = foldGatedProducerFds(fds, hoisted.fds, hoisted.equivPairs, realKeyFds, colCount);
		}

		let equivClasses: ReadonlyArray<ReadonlyArray<number>> = [];
		const allEquivPairs: Array<[number, number]> = [];
		for (const p of checkExt.equivPairs) allEquivPairs.push([p[0], p[1]]);
		if (hoisted) for (const p of hoisted.equivPairs) allEquivPairs.push([p[0], p[1]]);
		if (allEquivPairs.length > 0) {
			equivClasses = mergeEquivClasses([], allEquivPairs);
		}

		let constantBindings: ReadonlyArray<ConstantBinding> = [];
		const hasBindings = checkExt.constantBindings.length > 0
			|| (hoisted?.constantBindings.length ?? 0) > 0;
		if (hasBindings) {
			constantBindings = mergeConstantBindings([], checkExt.constantBindings);
			if (hoisted && hoisted.constantBindings.length > 0) {
				constantBindings = mergeConstantBindings(constantBindings, hoisted.constantBindings);
			}
			if (equivClasses.length > 0) {
				constantBindings = closeConstantBindingsOverEcs(constantBindings, equivClasses);
			}
		}

		let domainConstraints: ReadonlyArray<DomainConstraint> = checkExt.domainConstraints;
		if (hoisted && hoisted.domainConstraints.length > 0) {
			domainConstraints = mergeDomainConstraints(domainConstraints, hoisted.domainConstraints);
		}

		// Seed inclusion dependencies from declared foreign keys whose referenced
		// columns are the parent's primary key. Output indices equal table column
		// indices here, so the FK child columns are used verbatim as `cols`. Needs
		// the schema manager to resolve parent tables; when absent (isolated test
		// construction) no INDs are seeded.
		let inds: ReadonlyArray<InclusionDependency> = [];
		if (this.schemaManager !== undefined) {
			const sm = this.schemaManager;
			inds = seedTableForeignKeyInds(this.tableSchema, (t, s) => sm.findTable(t, s));
		}

		const out: Partial<PhysicalProperties> = {};
		if (fds.length > 0) out.fds = fds;
		if (equivClasses.length > 0) out.equivClasses = equivClasses;
		if (constantBindings.length > 0) out.constantBindings = constantBindings;
		if (domainConstraints.length > 0) out.domainConstraints = domainConstraints;
		if (inds.length > 0) out.inds = inds;

		// Backward update-lineage seed (the derived dual of the forward FDs above):
		// every output attribute traces to its own base column; generated columns
		// are read-only at every level (`computed`); declared column defaults seed
		// `attributeDefaults`. `table` is this node's numeric plan-node id — the
		// relation discriminator the orchestrator uses across multi-source bodies
		// (a self-join produces two TableReferenceNodes with distinct ids).
		const attrs = this.getAttributes();
		const tableId = Number(this.id);
		const updateLineage = new Map<number, UpdateSite>();
		const attributeDefaults = new Map<number, AttributeDefault>();
		this.tableSchema.columns.forEach((col, i) => {
			const attr = attrs[i];
			if (!attr) return;
			if (col.generated) {
				updateLineage.set(attr.id, { kind: 'computed', expr: col.generatedExpr ?? { type: 'column', name: col.name } });
			} else {
				updateLineage.set(attr.id, { kind: 'base', table: tableId, baseColumn: col.name });
				if (col.defaultValue) attributeDefaults.set(attr.id, { kind: 'base-default', value: col.defaultValue });
			}
		});
		if (updateLineage.size > 0) out.updateLineage = updateLineage;
		if (attributeDefaults.size > 0) out.attributeDefaults = attributeDefaults;
		// Concurrency safety: read-only subtree over a module that tolerates
		// concurrent calls. The base PlanNode `physical` getter ANDs children's
		// `concurrencySafe` automatically; here we set the leaf value.
		out.concurrencySafe = getModuleConcurrencyMode(this.vtabModule) !== 'serial';
		// expectedLatencyMs: pick up the module's declared hint. Local in-process
		// modules omit it (0). Remote modules declare a non-zero value so the
		// parallel fan-out rule can amortize per-branch latency. With no remote
		// plugin in tree this stays 0 and the cost gate is inert by design.
		const moduleLatency = this.vtabModule.expectedLatencyMs;
		if (typeof moduleLatency === 'number' && moduleLatency > 0) {
			out.expectedLatencyMs = moduleLatency;
		}
		return out;
	}

	override toString(): string {
		const prefix = this.readCommitted ? 'committed.' : '';
		return `${prefix}${this.tableSchema.schemaName}.${this.tableSchema.name}`;
	}

	getAccessMethod(): 'sequential' | 'index-scan' | 'index-seek' | 'virtual' {
		// Logical table reference - will be converted to physical by optimizer
		return 'virtual';
	}

	// ColumnBindingProvider implementation
	getBindingRelationName(): string {
		return `${this.tableSchema.schemaName}.${this.tableSchema.name}`;
	}

	getBindingAttributes(): ReadonlyArray<{ id: number; name: string }> {
		return this.getAttributes().map(a => ({ id: a.id, name: a.name }));
	}

	getColumnIndexForAttribute(attributeId: number): number | undefined {
		return this.getAttributeIndex().get(attributeId);
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			schema: this.tableSchema.schemaName,
			table: this.tableSchema.name,
			columns: this.tableSchema.columns.map(col => col.name),
			...(this.readCommitted ? { readCommitted: true } : {}),
			estimates: {
				rows: this.tableSchema.estimatedRows
			}
		};
	}
}

export class TableFunctionReferenceNode extends PlanNode implements ZeroAryRelationalNode {
	override readonly nodeType = PlanNodeType.TableFunctionReference;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly functionSchema: FunctionSchema,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride ?? 1);

		this.attributesCache = new Cached(() => {
			// Create attributes from function schema return type
			if (isTableValuedFunctionSchema(this.functionSchema)) {
				return this.functionSchema.returnType.columns.map((column) => ({
					id: PlanNode.nextAttrId(),
					name: column.name,
					type: column.type,
					sourceRelation: `${this.functionSchema.name}()`,
					relationName: this.functionSchema.name
				}));
			}
			return [];
		});
	}

	getType(): RelationType {
		if (isTableValuedFunctionSchema(this.functionSchema)) {
			return this.functionSchema.returnType;
		}
		quereusError(
			`Function ${this.functionSchema.name} is not a table-valued function`,
			StatusCode.INTERNAL
		);
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`TableFunctionReferenceNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	get estimatedRows(): number | undefined {
		return 100; // Default estimate for table functions
	}

	override toString(): string {
		return `${this.functionSchema.name}()`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			function: this.functionSchema.name,
			numArgs: this.functionSchema.numArgs
		};

		if (isTableValuedFunctionSchema(this.functionSchema)) {
			props.columns = this.functionSchema.returnType.columns.map(col => col.name);
		}

		return props;
	}
}

/**
 * Represents a reference to a column from a relational node.
 * Uses attribute IDs for stable references across plan transformations.
 */
export class ColumnReferenceNode extends PlanNode implements ZeroAryScalarNode {
	override readonly nodeType = PlanNodeType.ColumnReference;

	constructor(
		scope: Scope,
		public readonly expression: AST.ColumnExpr, // Original AST expression for this reference
		public readonly columnType: ScalarType,
		public readonly attributeId: number, // Stable attribute ID instead of node reference
		public readonly columnIndex: number, // Position in the row (for runtime efficiency)
	) {
		super(scope, 0);
	}

	getType(): ScalarType {
		return this.columnType;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`ColumnReferenceNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		const columnName = this.expression.alias ??
			(this.expression.schema ? this.expression.schema + '.' : '') + this.expression.name;
		return columnName;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			column: this.expression.alias ?? this.expression.name,
			schema: this.expression.schema,
			attributeId: this.attributeId,
			resultType: formatScalarType(this.columnType)
		};
	}

	override isInjectiveIn(inputAttrId: number): InjectivityResult {
		// f(x) = x is injective; references to other attributes are not (they don't depend on x).
		return inputAttrId === this.attributeId
			? { injective: true }
			: { injective: false };
	}

	override monotonicityIn(inputAttrId: number): MonotonicityResult {
		return inputAttrId === this.attributeId
			? { monotonicity: 'increasing' }
			: { monotonicity: 'constant' };
	}
}

/**
 * Represents a reference to a parameter (placeholder in a prepared statement).
 * The actual value will be provided at execution time.
 */
export class ParameterReferenceNode extends PlanNode implements ZeroAryScalarNode {
	override readonly nodeType = PlanNodeType.ParameterReference;

	constructor(
		scope: Scope,
		public readonly expression: AST.ParameterExpr, // Original AST expression for this parameter
		public readonly nameOrIndex: string | number, // Parameter name (e.g., ':foo') or 1-based index
		public readonly targetType: ScalarType,
	) {
		super(scope, 0.01);
	}

	getType(): ScalarType {
		return this.targetType;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`ParameterReferenceNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		return `:${this.nameOrIndex}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			parameter: this.nameOrIndex,
			resultType: formatScalarType(this.targetType)
		};
	}

	override monotonicityIn(_inputAttrId: number): MonotonicityResult {
		// A parameter does not depend on any input attribute; its value is fixed
		// for the duration of one execution.
		return { monotonicity: 'constant' };
	}
}

export class FunctionReferenceNode extends PlanNode {
	override readonly nodeType = PlanNodeType.FunctionReference;

	constructor(
		scope: Scope,
		public readonly functionSchema: FunctionSchema,
		public readonly targetType: BaseType,
	) {
		super(scope);
	}

	// Type has to be determined by scalar or relation call node
	getType(): BaseType {
		return this.targetType;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`FunctionReferenceNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		return `${this.functionSchema.name}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			function: this.functionSchema.name,
			numArgs: this.functionSchema.numArgs,
			targetType: this.targetType.typeClass
		};
	}
}
