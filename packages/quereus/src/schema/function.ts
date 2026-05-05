import type { MaybePromise, Row, SqlValue, DeepReadonly } from '../common/types.js';
import { FunctionFlags } from '../common/constants.js';

import type { Database } from '../core/database.js';
import type { BaseType, ScalarType, RelationType } from '../common/datatype.js';
import type { AggValue } from '../func/registration.js';
import type { LogicalType } from '../types/logical-type.js';
import type { ScalarFunctionCallNode } from '../planner/nodes/function.js';
import type { EmissionContext } from '../runtime/emission-context.js';
import type { Instruction } from '../runtime/types.js';

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
 * Schema for table-valued functions that return rows.
 */
export interface TableValuedFunctionSchema extends BaseFunctionSchema {
	returnType: RelationType;
	/** Table-valued function implementation */
	implementation: TableValuedFunc | IntegratedTableValuedFunc;
	/** Whether this TVF requires database access as first parameter */
	isIntegrated?: boolean;
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

