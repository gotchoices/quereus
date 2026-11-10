import type { ScalarType } from '../common/datatype.js';
import type { DeepReadonly, SqlValue } from '../common/types.js';
import type { LogicalType } from '../types/logical-type.js';
import type { AggregateArgBinding } from './function.js';

/** The pieces a window bind may replace. Any field omitted keeps the declared default,
 *  except `inverse`: it undoes one `step`, so a binding that replaces `step` without
 *  supplying an `inverse` drops the declared one (see {@link bindWindowSchema}). */
export interface WindowFunctionBinding {
	readonly step?: WindowFunctionSchema['step'];
	readonly final?: WindowFunctionSchema['final'];
	readonly inverse?: WindowFunctionSchema['inverse'];
}

export interface WindowFunctionSchema {
	name: string;                    // 'ROW_NUMBER', 'RANK', 'SUM', etc.
	argCount: number | 'variadic';   // Number of arguments, or 'variadic' for any
	returnType: ScalarType;          // Return type
	requiresOrderBy: boolean;        // Whether ORDER BY is required
	kind: 'ranking' | 'aggregate' | 'value' | 'navigation';

	/**
	 * Optional type inference for polymorphic window functions. Mirrors
	 * AggregateFunctionSchema.inferReturnType — called at planning time with the
	 * argument logical types to derive the return type (e.g. window MIN/MAX
	 * return their argument's type rather than the fixed `returnType`).
	 */
	inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;

	/**
	 * A fresh accumulator for an aggregate-style window. Every execution shape starts
	 * each frame or partition from this; absent ⇒ `null`. `count(x)` is why it exists:
	 * its accumulator starts at `0`, not `null`.
	 */
	initial?: () => unknown;

	// Optional custom step/final hooks for aggregate-style windows
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	step?: (state: any, value: SqlValue) => any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	final?: (state: any, rowCount: number) => SqlValue;

	/**
	 * Remove one earlier `step(…, value)` contribution from `state` (SQLite's
	 * `xInverse`). Lets the streaming ROWS sliding frame drop the row leaving the frame
	 * instead of refolding the whole frame. Absent ⇒ the sliding path refolds.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	inverse?: (state: any, value: SqlValue) => any;

	/**
	 * Specialize step/final to this call site's argument comparison context —
	 * the arguments' declared logical types and resolved collations. Called ONCE
	 * at emit time, never per row; apply via {@link bindWindowSchema}. Returning
	 * undefined (or omitting a field) keeps the declared default.
	 *
	 * Mirrors `AggregateFunctionSchema.bindArgs`, and shares its argument type
	 * ({@link AggregateArgBinding}) so the comparison-routing rule
	 * (`createSemanticValueComparator`) has exactly one home: window MIN/MAX must
	 * rank exactly as the MIN/MAX aggregate does.
	 */
	readonly bindArgs?: (args: readonly AggregateArgBinding[]) => WindowFunctionBinding | undefined;
}

// Global registry for window functions
const windowRegistry = new Map<string, WindowFunctionSchema>();

export function registerWindowFunction(schema: WindowFunctionSchema): void {
	windowRegistry.set(schema.name.toLowerCase(), schema);
}

export function resolveWindowFunction(name: string): WindowFunctionSchema | undefined {
	return windowRegistry.get(name.toLowerCase());
}

export function isWindowFunction(name: string): boolean {
	return windowRegistry.has(name.toLowerCase());
}

export function getAllWindowFunctions(): WindowFunctionSchema[] {
	return Array.from(windowRegistry.values());
}

/**
 * Specialize a window schema to one call site's argument comparison context. A
 * schema with no `bindArgs` hook — or a hook that declines — is returned
 * unchanged. Idempotent: the bound schema keeps `bindArgs`, so no call site has
 * to track whether it already bound.
 *
 * Call once per call site at emit time, never per row. All three window execution
 * shapes (the buffered frame walk, the streaming running accumulator and the
 * streaming sliding-frame scan) must run the SAME bound schema, or they rank
 * differently for the same query.
 */
export function bindWindowSchema(
	schema: WindowFunctionSchema,
	args: readonly AggregateArgBinding[],
): WindowFunctionSchema {
	const bound = schema.bindArgs?.(args);
	if (!bound) return schema;
	// Merge field-by-field rather than spreading `bound`: an explicitly-`undefined`
	// field must read as "keep the declared default", matching the documented contract.
	return {
		...schema,
		step: bound.step ?? schema.step,
		final: bound.final ?? schema.final,
		// The declared inverse undoes the declared step only; dropping it under a replaced
		// step costs the sliding path a refold, never a wrong answer.
		inverse: bound.step ? bound.inverse : (bound.inverse ?? schema.inverse),
	};
}
