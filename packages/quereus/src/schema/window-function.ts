import type { ScalarType } from '../common/datatype.js';
import type { SqlValue } from '../common/types.js';

export interface WindowFunctionSchema {
	name: string;                    // 'ROW_NUMBER', 'RANK', 'SUM', etc.
	argCount: number | 'variadic';   // Number of arguments, or 'variadic' for any
	returnType: ScalarType;          // Return type
	requiresOrderBy: boolean;        // Whether ORDER BY is required
	kind: 'ranking' | 'aggregate' | 'value' | 'navigation';

	// Optional custom step/final hooks for aggregate-style windows
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	step?: (state: any, value: SqlValue) => any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	final?: (state: any, rowCount: number) => SqlValue;
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

// Helper to create ranking function state
export function createRankingState() {
	return {
		rowNumber: 0,
		rank: 0,
		denseRank: 0,
		lastValues: null as SqlValue[] | null
	};
}

// Helper for aggregate window function state
export function createAggregateState(schema: WindowFunctionSchema) {
	if (schema.step && schema.final) {
		return {
			accumulator: null,
			rowCount: 0
		};
	}
	return null;
}
