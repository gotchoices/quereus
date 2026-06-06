import { IndexConstraintOp } from '../common/constants.js';

/**
 * Information about a specific constraint in the WHERE clause
 */
export interface IndexConstraint {
	/** Column index constrained (0 based) */
	iColumn: number;
	/** Constraint operator (EQ, GT, etc.) */
	op: IndexConstraintOp;
	/** True if the constraint expression is usable */
	usable: boolean;
	/** Internal offset used by Quereus - ignore in xBestIndex */
	iTermOffset?: number;
}

/**
 * Information about a term in the ORDER BY clause
 */
export interface IndexOrderBy {
	/** Column index */
	iColumn: number;
	/** True for DESC, False for ASC */
	desc: boolean;
}

/**
 * Usage information for a constraint, filled by xBestIndex
 */
export interface IndexConstraintUsage {
	/** If >0, constraint value becomes the (argvIndex-1)-th arg to xFilter */
	argvIndex: number;
	/** If true, Quereus might skip re-checking this constraint */
	omit: boolean;
}

/**
 * Structure passed to xBestIndex method containing information about
 * WHERE and ORDER BY clauses relevant to the virtual table.
 * The xBestIndex method must fill the output fields to describe the chosen query plan.
 */
export interface IndexInfo {
	// --- Inputs ---

	/** Number of entries in aConstraint */
	nConstraint: number;
	/** Array of WHERE clause constraints */
	aConstraint: ReadonlyArray<IndexConstraint>;

	/** Number of terms in the ORDER BY clause */
	nOrderBy: number;
	/** Array of ORDER BY terms */
	aOrderBy: ReadonlyArray<IndexOrderBy>;

	/** Mask of columns used by the statement (bit N set if column N is used) */
	colUsed: bigint;

	// --- Outputs ---

	/** Usage details for each constraint */
	aConstraintUsage: IndexConstraintUsage[];

	/** Number identifying the chosen index strategy (passed to xFilter) */
	idxNum: number;
	/** String identifying the chosen index strategy (passed to xFilter) */
	idxStr: string | null;

	/** True if output from xFilter/xNext will satisfy ORDER BY */
	orderByConsumed: boolean;

	/** Estimated cost of this strategy (lower is better) */
	estimatedCost: number;
	/** Estimated number of rows returned by this strategy */
	estimatedRows: bigint;

	/** Mask of SQLITE_INDEX_SCAN_* flags */
	idxFlags: number;
}

/** Flags for IndexInfo.idxFlags */
export enum IndexScanFlags {
	/** Scan visits at most 1 row */
	UNIQUE = 0x0001,
}
