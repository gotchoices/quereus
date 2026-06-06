import type { MaybePromise, Row, SqlValue, DeepReadonly } from '../common/types.js';
import { FunctionFlags } from '../common/constants.js';

import type { Database } from '../core/database.js';
import type { BaseType, ScalarType, RelationType, ColRef } from '../common/datatype.js';
import type { AggValue } from '../func/registration.js';
import type { LogicalType } from '../types/logical-type.js';
import type { ScalarFunctionCallNode } from '../planner/nodes/function.js';
import type { EmissionContext } from '../runtime/emission-context.js';
import type { Instruction } from '../runtime/types.js';
import type {
	ScalarPlanNode,
	ConstantBinding,
	FunctionalDependency,
	MonotonicOnInfo,
	PhysicalProperties,
} from '../planner/nodes/plan-node.js';

/**
 * Type for a scalar function implementation.
 */
export type ScalarFunc = (...args: SqlValue[]) => MaybePromise<SqlValue>;

/**
 * Type for a table-valued function implementation.
 */
export type TableValuedFunc = (...args: SqlValue[]) => MaybePromise<AsyncIterable<Row>>;

/**
 * Type for a database-aware table-valued function implementation.
 * Takes a database instance and SQL values, returns an async iterable of rows.
 */
export type IntegratedTableValuedFunc = (db: Database, ...args: SqlValue[]) => MaybePromise<AsyncIterable<Row>>;

/**
 * Type for aggregate step function.
 */
// Accumulator type is opaque to the framework; concrete reducers know their state shape.
// Using `unknown` here would require contravariant casts at every aggregate registration site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggregateReducer<T = any> = (accumulator: T, ...args: SqlValue[]) => T;

/**
 * Type for aggregate finalizer function.
 */
// See AggregateReducer above for rationale on `any` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggregateFinalizer<T = any> = (accumulator: T) => SqlValue;

/**
 * Custom emitter hook for functions that need special emission logic.
 * This allows functions to cache compiled state in the EmissionContext,
 * optimize constant arguments, or perform other emission-time optimizations.
 */
export type CustomEmitterHook = (
	plan: ScalarFunctionCallNode,
	ctx: EmissionContext,
	defaultEmit: (plan: ScalarFunctionCallNode, ctx: EmissionContext) => Instruction
) => Instruction;

/**
 * Base interface for all function schemas with common properties.
 */
interface BaseFunctionSchema {
	/** Function name (lowercase for consistent lookup) */
	name: string;
	/** Number of arguments (-1 for variable) */
	numArgs: number;
	/** Combination of FunctionFlags */
	flags: FunctionFlags;
	/** User data pointer passed during registration */
	userData?: unknown;
	/** Return type information */
	returnType: BaseType;
	/**
	 * Optional custom emitter hook for emission-time optimizations.
	 * If provided, this function will be called during plan emission instead of
	 * the default scalar function emitter. The hook receives the plan node,
	 * emission context, and a reference to the default emitter.
	 */
	customEmitter?: CustomEmitterHook;
	/**
	 * Argument indices on which this function is injective when all other
	 * arguments are held constant. Combines with operand-level recursion in
	 * `ScalarFunctionCallNode.isInjectiveIn`.
	 */
	injectiveOnArgs?: readonly number[];
	/**
	 * Per-argument monotonicity when all other arguments are held constant.
	 * Keys are zero-based argument indices.
	 */
	monotoneOnArgs?: { readonly [argIndex: number]: 'increasing' | 'decreasing' };
	/**
	 * Per-argument range-rewrite kind for monotone-but-lossy functions.
	 * The actual boundary computation lives on the argument's logical type
	 * (`LogicalType.bucketBounds(kind, value)`), so the function schema only
	 * names the bucketing kind here.
	 */
	rangeRewriteOnArg?: { readonly [argIndex: number]: { readonly kind: string } };
}

/**
 * Schema for scalar functions that return a single value.
 */
export interface ScalarFunctionSchema extends BaseFunctionSchema {
	returnType: ScalarType;
	/** Direct scalar function implementation */
	implementation: ScalarFunc;
	/**
	 * Optional type inference function for polymorphic functions.
	 * If provided, this function will be called at planning time to determine
	 * the return type based on the actual argument types.
	 * This allows functions like abs() to return INTEGER when given INTEGER,
	 * and REAL when given REAL.
	 */
	inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;
	/**
	 * Optional argument type validation function.
	 * If provided, this function will be called at planning time to validate
	 * that the argument types are acceptable for this function.
	 * Should return true if types are valid, false otherwise.
	 */
	validateArgTypes?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => boolean;
}

/**
 * Function form for parameter-dependent advertisements. Receives the call
 * operands so the implementation can read literal values, parameter slots, or
 * operand types. Return `undefined` to decline (no property advertised).
 */
export type TVFAdvertiseFn<T> = (
	operands: ReadonlyArray<ScalarPlanNode>,
	schema: TableValuedFunctionSchema,
) => T | undefined;

/**
 * Column-keyed monotonicity declaration. The TVF schema author talks in column
 * indices; `TableFunctionCallNode` translates these to live attribute IDs when
 * it builds physical properties.
 */
export interface MonotonicOnColumnInfo {
	readonly column: number;
	readonly direction: 'asc' | 'desc';
	readonly strict?: boolean;
}

/**
 * Optional advertisement of a TVF's relational and physical properties.
 * Each field may be a static value or a function of the call's operands.
 * Bad advertisements (invalid indices, wrong shape) are dropped at use time
 * with a single warning rather than throwing.
 */
export interface TVFAdvertisement {
	isSet?: boolean | TVFAdvertiseFn<boolean>;
	keys?: ReadonlyArray<ReadonlyArray<ColRef>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<ColRef>>>;
	fds?: ReadonlyArray<FunctionalDependency> | TVFAdvertiseFn<ReadonlyArray<FunctionalDependency>>;
	equivClasses?: ReadonlyArray<ReadonlyArray<number>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<number>>>;
	ordering?: ReadonlyArray<{ column: number; desc: boolean }> | TVFAdvertiseFn<ReadonlyArray<{ column: number; desc: boolean }>>;
	monotonicOn?: ReadonlyArray<MonotonicOnInfo> | TVFAdvertiseFn<ReadonlyArray<MonotonicOnInfo>>;
	/**
	 * Column-keyed monotonicOn declarations. Preferred over `monotonicOn` for
	 * schema-time annotations because attribute IDs are per-call and only the
	 * node knows them.
	 */
	monotonicOnColumns?: ReadonlyArray<MonotonicOnColumnInfo> | TVFAdvertiseFn<ReadonlyArray<MonotonicOnColumnInfo>>;
	constantBindings?: ReadonlyArray<ConstantBinding> | TVFAdvertiseFn<ReadonlyArray<ConstantBinding>>;
	estimatedRows?: number | TVFAdvertiseFn<number>;
	accessCapabilities?: PhysicalProperties['accessCapabilities'];
	deterministic?: boolean;
	readonly?: boolean;
	idempotent?: boolean;
}

/**
 * Resolves a possibly-functional advertisement spec to a concrete value.
 * Returns `undefined` when the spec is absent or when the closure throws —
 * a broken closure must never break planning.
 */
export function resolveAdvertisement<T>(
	spec: T | TVFAdvertiseFn<T> | undefined,
	operands: ReadonlyArray<ScalarPlanNode>,
	schema: TableValuedFunctionSchema,
): T | undefined {
	if (spec === undefined) return undefined;
	if (typeof spec === 'function') {
		try {
			return (spec as TVFAdvertiseFn<T>)(operands, schema);
		} catch {
			return undefined;
		}
	}
	return spec;
}

/**
 * Returns the literal value of a scalar operand, or `undefined` when the
 * operand is not a literal. Used by advertisement closures that want to read
 * compile-time operand values (e.g. `generate_series(1, 100)` advertising
 * `estimatedRows: 100`).
 */
export function evaluateLiteralOperand(operand: ScalarPlanNode): SqlValue | undefined {
	const candidate = operand as ScalarPlanNode & { readonly expression?: { type?: string; value?: SqlValue } };
	if (candidate.expression && candidate.expression.type === 'literal') {
		return candidate.expression.value;
	}
	return undefined;
}

/**
 * Schema for table-valued functions that return rows.
 */
export interface TableValuedFunctionSchema extends BaseFunctionSchema {
	returnType: RelationType;
	/** Table-valued function implementation */
	implementation: TableValuedFunc | IntegratedTableValuedFunc;
	/** Whether this TVF requires database access as first parameter */
	isIntegrated?: boolean;
	/** Optional advertisement of relational / physical properties. */
	relationalAdvertisement?: TVFAdvertisement;
}

/**
 * Schema for aggregate functions.
 */
export interface AggregateFunctionSchema extends BaseFunctionSchema {
	returnType: ScalarType;
	/** Aggregate step function */
	stepFunction: AggregateReducer;
	/** Aggregate finalizer function */
	finalizeFunction: AggregateFinalizer;
	/** Initial accumulator value for aggregates */
	initialValue?: AggValue;
	/**
	 * Optional type inference function for polymorphic aggregate functions.
	 * If provided, this function will be called at planning time to determine
	 * the return type based on the actual argument types.
	 */
	inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;
	/**
	 * Optional argument type validation function.
	 * If provided, this function will be called at planning time to validate
	 * that the argument types are acceptable for this function.
	 */
	validateArgTypes?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => boolean;
}

/**
 * Union type representing all possible function schemas.
 */
export type FunctionSchema =
	| ScalarFunctionSchema
	| TableValuedFunctionSchema
	| AggregateFunctionSchema;

/**
 * Type guards for function schema types.
 */
export function isScalarFunctionSchema(schema: FunctionSchema): schema is ScalarFunctionSchema {
	return schema.returnType.typeClass === 'scalar' && 'implementation' in schema && typeof schema.implementation === 'function';
}

export function isTableValuedFunctionSchema(schema: FunctionSchema): schema is TableValuedFunctionSchema {
	return schema.returnType.typeClass === 'relation';
}

export function isAggregateFunctionSchema(schema: FunctionSchema): schema is AggregateFunctionSchema {
	return 'stepFunction' in schema && 'finalizeFunction' in schema;
}

/**
 * Creates a consistent key for storing/looking up functions
 *
 * @param name Function name
 * @param numArgs Number of arguments (-1 for variable argument count)
 * @returns A string key in the format "name/numArgs"
 */
export function getFunctionKey(name: string, numArgs: number): string {
	return `${name.toLowerCase()}/${numArgs}`;
}

