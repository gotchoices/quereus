import type { ScalarType } from '../../common/datatype.js';
import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type NaryScalarNode, type ScalarPlanNode, type PhysicalProperties, type InjectivityResult, type MonotonicityResult, type Monotonicity, type RangeRewrite, addMonotonicity } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { formatExpressionList, formatScalarType } from '../../util/plan-formatter.js';
import type { FunctionSchema } from '../../schema/function.js';
import { FunctionFlags } from '../../common/constants.js';
import type { SqlValue } from '../../common/types.js';
import { ColumnReferenceNode } from './reference.js';

export class ScalarFunctionCallNode extends PlanNode implements NaryScalarNode {
	override readonly nodeType = PlanNodeType.ScalarFunctionCall;
	private readonly _inferredType?: ScalarType;

	constructor(
		scope: Scope,
		public readonly expression: AST.FunctionExpr,
		public readonly functionSchema: FunctionSchema,
		public readonly operands: ScalarPlanNode[],
		inferredType?: ScalarType
	) {
		super(scope);
		this._inferredType = inferredType;
	}

	getType(): ScalarType {
		// Use inferred type if available, otherwise use schema's return type
		return this._inferredType ?? (this.functionSchema.returnType as ScalarType);
	}

	getChildren(): readonly ScalarPlanNode[] {
		return this.operands;
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== this.operands.length) {
			throw new Error(`ScalarFunctionCallNode expects ${this.operands.length} children, got ${newChildren.length}`);
		}

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				throw new Error('ScalarFunctionCallNode: all children must be ScalarPlanNodes');
			}
		}

		// Check if anything changed
		const childrenChanged = newChildren.some((child, i) => child !== this.operands[i]);
		if (!childrenChanged) {
			return this;
		}

		// Create new instance
		return new ScalarFunctionCallNode(
			this.scope,
			this.expression,
			this.functionSchema,
			newChildren as ScalarPlanNode[],
			this._inferredType
		);
	}

	override toString(): string {
		return `${this.expression.name}(${formatExpressionList(this.operands)})`;
	}

	override computePhysical(_childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		// Function calls derive properties from their arguments and the function itself
		const result: Partial<PhysicalProperties> = {};

		// Use function schema to determine deterministic and readonly properties
		const functionIsDeterministic = (this.functionSchema.flags & FunctionFlags.DETERMINISTIC) !== 0;
		const functionIsReadonly = (this.functionSchema.returnType as ScalarType).isReadOnly ?? true;

		// Function is deterministic only if both function and all arguments are deterministic
		if (!functionIsDeterministic) {
			result.deterministic = false;
		}

		// Function is readonly only if both function and all arguments are readonly
		if (!functionIsReadonly) {
			result.readonly = false;
		}

		return result;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			function: this.expression.name,
			arguments: this.operands.map(op => op.toString()),
			resultType: formatScalarType(this.functionSchema.returnType as ScalarType)
		};
	}

	/**
	 * Find the unique operand index that depends on `inputAttrId`.
	 * Returns the index when exactly one operand is non-constant in attrId,
	 * undefined when zero or multiple operands are.
	 */
	private uniqueDependentOperand(inputAttrId: number): number | undefined {
		let foundIdx: number | undefined = undefined;
		for (let i = 0; i < this.operands.length; i++) {
			const m = this.operands[i].monotonicityIn(inputAttrId).monotonicity;
			if (m !== 'constant') {
				if (foundIdx !== undefined) return undefined;
				foundIdx = i;
			}
		}
		return foundIdx;
	}

	override isInjectiveIn(inputAttrId: number): InjectivityResult {
		const claimed = this.functionSchema.injectiveOnArgs;
		if (!claimed || claimed.length === 0) return { injective: false };
		const idx = this.uniqueDependentOperand(inputAttrId);
		if (idx === undefined) return { injective: false };
		if (!claimed.includes(idx)) return { injective: false };
		// f(...) is injective in arg `idx` (with all other args constant).
		// When the operand at `idx` is itself injective in attrId, the composition is injective.
		return this.operands[idx].isInjectiveIn(inputAttrId);
	}

	override monotonicityIn(inputAttrId: number): MonotonicityResult {
		const monoTraits = this.functionSchema.monotoneOnArgs;
		// If no operand depends on attrId, the call is constant in attrId.
		const idx = this.uniqueDependentOperand(inputAttrId);
		if (idx === undefined) {
			// Either zero dependents (truly constant) or two-or-more (combined unknown).
			const allConst = this.operands.every(o =>
				o.monotonicityIn(inputAttrId).monotonicity === 'constant');
			return { monotonicity: allConst ? 'constant' : 'unknown' };
		}
		if (!monoTraits) return { monotonicity: 'unknown' };
		const dir = monoTraits[idx];
		if (!dir) return { monotonicity: 'unknown' };
		const childMon = this.operands[idx].monotonicityIn(inputAttrId).monotonicity;
		// Compose: f is `dir` in arg idx; arg idx is `childMon` in attrId.
		// `increasing ∘ increasing = increasing`; flip when either side is decreasing.
		const composed: Monotonicity = (() => {
			if (childMon === 'constant') return 'constant';
			if (childMon === 'unknown' || childMon === 'non_monotone') return childMon;
			// childMon ∈ {increasing, decreasing}
			const sameDirection = dir === childMon;
			return sameDirection ? 'increasing' : 'decreasing';
		})();
		// Sanity-combine via addMonotonicity to keep this consistent with operator rules:
		// composing with a 'constant' wrapper is identity.
		return { monotonicity: addMonotonicity(composed, 'constant') };
	}

	override rangeRewriteIn(inputAttrId: number, constant: SqlValue): RangeRewrite | undefined {
		const traits = this.functionSchema.rangeRewriteOnArg;
		if (!traits) return undefined;
		const idx = this.uniqueDependentOperand(inputAttrId);
		if (idx === undefined) return undefined;
		const trait = traits[idx];
		if (!trait) return undefined;
		// The operand at idx must be an identity reference to attrId (a bare
		// ColumnReferenceNode) for the range to apply directly to the input
		// attribute. We can only rewrite `f(x) op c`, not `f(g(x)) op c` —
		// bucketBounds returns bounds in the operand's value space, which
		// only equals attrId's value space when the operand IS the column.
		const operand = this.operands[idx];
		if (!(operand instanceof ColumnReferenceNode) || operand.attributeId !== inputAttrId) {
			return undefined;
		}
		// Defer boundary computation to the operand's logical type.
		const argType = operand.getType();
		const bucketBounds = argType.logicalType.bucketBounds;
		if (!bucketBounds) return undefined;
		const bounds = bucketBounds(trait.kind, constant);
		if (!bounds) return undefined;
		return {
			lowerInclusive: bounds.lowerInclusive,
			upperExclusive: bounds.upperExclusive,
		};
	}
}
