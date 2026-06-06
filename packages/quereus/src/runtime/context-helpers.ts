import type { RuntimeContext } from './types.js';
import type { RowDescriptor, RowGetter } from '../planner/nodes/plan-node.js';
import type { SqlValue, Row } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const ctxLog = createLogger('runtime:context');
const ctxLookupLog = createLogger('runtime:context:lookup');

type IndexEntry = { rowGetter: RowGetter; columnIndex: number };

/**
 * Iterate the attribute IDs in a descriptor, yielding [attrId, columnIndex].
 * Uses for...in to handle both sparse arrays and plain objects (e.g. spread-created
 * descriptors in aggregate.ts).
 */
function* descriptorEntries(descriptor: RowDescriptor): Generator<[number, number]> {
	for (const key in descriptor) {
		const attrId = +key;
		const columnIndex = descriptor[attrId];
		if (columnIndex !== undefined) {
			yield [attrId, columnIndex];
		}
	}
}

/**
 * A Map-like container for row contexts that maintains a secondary
 * attribute index for O(1) column reference resolution.
 *
 * All mutations (set/delete) automatically update the index,
 * so callers that directly manipulate the context (e.g. aggregate.ts)
 * get correct index behavior for free.
 */
export class RowContextMap {
	private map = new Map<RowDescriptor, RowGetter>();

	/** Direct attribute-ID → resolver for O(1) column lookup. */
	readonly attributeIndex: Array<IndexEntry | undefined> = [];

	set(descriptor: RowDescriptor, rowGetter: RowGetter): this {
		this.map.set(descriptor, rowGetter);
		// Index this descriptor's attribute IDs (overwrites previous bindings)
		for (const [attrId, columnIndex] of descriptorEntries(descriptor)) {
			this.attributeIndex[attrId] = { rowGetter, columnIndex };
		}
		return this;
	}

	delete(descriptor: RowDescriptor): boolean {
		// Collect affected attribute IDs before removing
		const affectedAttrIds: number[] = [];
		for (const [attrId] of descriptorEntries(descriptor)) {
			affectedAttrIds.push(attrId);
			this.attributeIndex[attrId] = undefined;
		}
		const result = this.map.delete(descriptor);
		if (affectedAttrIds.length > 0) {
			// Rebuild affected index entries from remaining contexts.
			// Map preserves insertion order; iterating forward means the last
			// (newest) matching entry wins — matching original newest→oldest semantics.
			// Must iterate ALL remaining entries (no early termination) so newer
			// entries correctly overwrite older ones.
			for (const [desc, getter] of this.map) {
				for (const attrId of affectedAttrIds) {
					const colIdx = desc[attrId];
					if (colIdx !== undefined) {
						this.attributeIndex[attrId] = { rowGetter: getter, columnIndex: colIdx };
					}
				}
			}
		}
		return result;
	}

	get(descriptor: RowDescriptor): RowGetter | undefined {
		return this.map.get(descriptor);
	}

	entries(): MapIterator<[RowDescriptor, RowGetter]> {
		return this.map.entries();
	}

	get size(): number {
		return this.map.size;
	}
}

/**
 * A mutable slot for efficient row context management in streaming operations.
 * Avoids per-row Map mutations while maintaining context safety.
 */
export interface RowSlot {
	/** Replace the current row (cheap field write) */
	set(row: Row): void;
	/**
	 * Re-claim this slot's descriptor in the context map so its `attributeIndex`
	 * entries point back at this slot. Useful when a child iterator (e.g. an
	 * underlying scan) creates and `set`s its own slot for the same attribute
	 * IDs in between this slot's `set` calls — without re-claiming, downstream
	 * lookups would resolve through the child's slot whose row is the iterator's
	 * cursor position, not this slot's matched row.
	 */
	reactivate(): void;
	/** Tear down (removes descriptor from context) */
	close(): void;
}

/**
 * Create a row slot for efficient streaming context management.
 * The slot installs a context entry once and updates it by reference.
 * Perfect for scan/join/window operations that process many rows.
 */
export function createRowSlot(
	rctx: RuntimeContext,
	descriptor: RowDescriptor
): RowSlot {
	// Internal boxed reference - one allocation per slot
	const ref = { current: undefined as Row | undefined };

	const getter: RowGetter = () => ref.current!;

	// Install only once — RowContextMap maintains the attribute index
	rctx.context.set(descriptor, getter);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'createRowSlot');
	}

	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('CREATE slot with attrs=[%s]', attrs.join(','));

	return {
		set(row: Row) {
			ref.current = row;
		},
		reactivate() {
			// Re-call set() on the context map so attributeIndex points back at
			// this slot's getter for all attribute IDs in `descriptor`.
			rctx.context.set(descriptor, getter);
		},
		close() {
			rctx.context.delete(descriptor);
			if (ctxLog.enabled && rctx.contextTracker) {
				rctx.contextTracker.removeContext(descriptor);
			}
			ctxLog('CLOSE slot with attrs=[%s]', attrs.join(','));
		}
	};
}

/**
 * Resolve an attribute ID to its column value in the current context.
 * Uses the attribute index for O(1) fast-path lookup. Falls back to a
 * linear scan when the indexed entry's row is not yet populated (e.g.
 * a slot created but not yet set).
 */
export function resolveAttribute(rctx: RuntimeContext, attributeId: number, columnName?: string): SqlValue {
	const entry = rctx.context.attributeIndex[attributeId];
	if (entry !== undefined) {
		const row = entry.rowGetter();
		if (Array.isArray(row) && entry.columnIndex < row.length) {
			ctxLookupLog('FOUND column %s (attr#%d) at index %d', columnName || '?', attributeId, entry.columnIndex);
			return row[entry.columnIndex];
		}
	}

	// Fallback: the index entry's row may not be populated yet (slot created
	// but not set). Scan remaining contexts newest→oldest, matching the
	// original behavior of skipping entries with invalid rows.
	const contextsReversed = Array.from(rctx.context.entries()).reverse();
	for (const [descriptor, rowGetter] of contextsReversed) {
		const columnIndex = descriptor[attributeId];
		if (columnIndex !== undefined) {
			const row = rowGetter();
			if (Array.isArray(row) && columnIndex < row.length) {
				return row[columnIndex];
			}
		}
	}

	// Error path: attribute not found
	if (ctxLookupLog.enabled) {
		ctxLookupLog('LOOKUP FAILED for column %s (attr#%d)', columnName || '?', attributeId);

		const contextsReversed = Array.from(rctx.context.entries()).reverse();
		ctxLookupLog('Available contexts:');
		for (const [descriptor, _] of contextsReversed) {
			const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
			ctxLookupLog('  - Descriptor with attrs=[%s]', attrs.join(','));
		}

		if (rctx.planStack && rctx.planStack.length > 0) {
			const currentNode = rctx.planStack[rctx.planStack.length - 1];
			ctxLookupLog('LOOKUP FAILED in node %s id=%d', currentNode.nodeType, currentNode.id);
			ctxLookupLog('Execution stack: %s',
				rctx.planStack.map(n => `${n.nodeType}#${n.id}`).join(' → '));
		}
	}

	throw new QuereusError(
		`No row context found for column ${columnName || `attr#${attributeId}`}. The column reference must be evaluated within the context of its source relation.`,
		StatusCode.ERROR
	);
}

/**
 * Look up a specific column by descriptor and index.
 * Useful when you already know which descriptor contains the column.
 */
export function lookupColumn(rctx: RuntimeContext, descriptor: RowDescriptor, columnIndex: number): SqlValue | undefined {
	const rowGetter = rctx.context.get(descriptor);
	if (!rowGetter) {
		ctxLookupLog('LOOKUP by index %d - no context found', columnIndex);
		return undefined;
	}

	const row = rowGetter();
	if (Array.isArray(row) && columnIndex < row.length) {
		ctxLookupLog('LOOKUP by index %d - found value', columnIndex);
		return row[columnIndex];
	}
	ctxLookupLog('LOOKUP by index %d - index out of bounds', columnIndex);
	return undefined;
}

/**
 * Execute an async function with a temporary row context (Map.set + Map.delete).
 *
 * Useful for **one-off** evaluations such as constraint checks and DML context
 * setup where a full {@link createRowSlot} lifecycle is unnecessary.
 */
export async function withAsyncRowContext<T>(
	rctx: RuntimeContext,
	descriptor: RowDescriptor,
	rowGetter: RowGetter,
	fn: () => T | Promise<T>
): Promise<T> {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('PUSH async context with attrs=[%s]', attrs.join(','));

	rctx.context.set(descriptor, rowGetter);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'withAsyncRowContext');
	}
	try {
		return await fn();
	} finally {
		rctx.context.delete(descriptor);
		if (ctxLog.enabled && rctx.contextTracker) {
			rctx.contextTracker.removeContext(descriptor);
		}
		ctxLog('POP async context with attrs=[%s]', attrs.join(','));
	}
}

/**
 * Execute a synchronous function with a temporary row context (Map.set + Map.delete).
 *
 * Useful for **one-off** evaluations where a full {@link createRowSlot}
 * lifecycle is unnecessary.
 */
export function withRowContext<T>(
	rctx: RuntimeContext,
	descriptor: RowDescriptor,
	rowGetter: RowGetter,
	fn: () => T
): T {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('PUSH context with attrs=[%s]', attrs.join(','));

	rctx.context.set(descriptor, rowGetter);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'withRowContext');
	}
	try {
		return fn();
	} finally {
		rctx.context.delete(descriptor);
		if (ctxLog.enabled && rctx.contextTracker) {
			rctx.contextTracker.removeContext(descriptor);
		}
		ctxLog('POP context with attrs=[%s]', attrs.join(','));
	}
}
