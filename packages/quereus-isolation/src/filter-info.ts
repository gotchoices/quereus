import type { FilterInfo, SqlValue } from '@quereus/quereus';
import { IndexConstraintOp } from '@quereus/quereus';

/**
 * Creates a FilterInfo for a full table scan (no constraints).
 *
 * Shared by the overlay-merge read paths, the ALTER/DROP INDEX overlay
 * migrations, and the commit flush — a single definition keeps the several
 * scan sites from drifting.
 */
export function makeFullScanFilterInfo(): FilterInfo {
	return {
		idxNum: 0,
		idxStr: null,
		constraints: [],
		args: [],
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: 0n,
			aConstraintUsage: [],
			idxNum: 0,
			idxStr: null,
			orderByConsumed: false,
			estimatedCost: 1000000,
			estimatedRows: 1000000n,
			idxFlags: 0,
		},
	};
}

/**
 * Creates a FilterInfo for a primary key point lookup (equality on all PK
 * columns). Produces O(log n) lookups instead of O(n) full scans.
 */
export function makePkPointLookupFilter(pkIndices: number[], pk: SqlValue[]): FilterInfo {
	const constraints = pkIndices.map((colIdx, i) => ({
		constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
		argvIndex: i + 1,
	}));

	return {
		idxNum: 0,
		idxStr: 'idx=_primary_(0);plan=2',
		constraints,
		args: pk,
		indexInfoOutput: {
			nConstraint: constraints.length,
			aConstraint: constraints.map(c => c.constraint),
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: 0n,
			aConstraintUsage: constraints.map(c => ({ argvIndex: c.argvIndex, omit: true })),
			idxNum: 0,
			idxStr: 'idx=_primary_(0);plan=2',
			orderByConsumed: false,
			estimatedCost: 1,
			estimatedRows: 1n,
			idxFlags: 0,
		},
	};
}
