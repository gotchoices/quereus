import type { SqlValue } from '../common/types.js';
import type { IndexConstraint, IndexInfo } from './index-info.js';

/**
 * Structure to pass all necessary filter and planning information
 * to a virtual table's xOpen method when cursors are not used.
 */
export interface FilterInfo {
	/** The index number chosen by xBestIndex (output of xBestIndex) */
	idxNum: number;
	/** The index string chosen by xBestIndex (output of xBestIndex) */
	idxStr: string | null;
	/** Array of WHERE clause constraints (input to xBestIndex/xOpen) */
	constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>;
	/** Values for ?. argvIndex in constraints (input to xOpen) */
	args: ReadonlyArray<SqlValue>;
	/**
	 * The IndexInfo object AFTER xBestIndex has populated its output fields
	 * (aConstraintUsage, orderByConsumed, estimatedCost, estimatedRows, idxFlags).
	 * This is needed by xOpen to understand how constraints were used by the planner.
	 */
	indexInfoOutput: IndexInfo;

	/**
	 * If set, the access plan honors a soft row cap — the vtab should stop
	 * emitting after this many rows. Pushed down by OrdinalSlice / future
	 * limit-pushdown rules. Modules without limit-pushdown support may ignore
	 * this; a downstream slice operator will still enforce the cap.
	 */
	limit?: number;

	/**
	 * If set, the access plan walks its monotonic index and seeks directly
	 * to the kth row in monotonic order before emitting. Only honored when
	 * the chosen access plan advertised `supportsOrdinalSeek`; otherwise the
	 * field must be ignored (a slice operator above will buffer-and-discard).
	 */
	offset?: number;
}
