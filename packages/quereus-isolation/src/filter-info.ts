import type { FilterInfo, IndexDescriptor, SqlValue } from '@quereus/quereus';
import { PRIMARY_INDEX_NAME, makeFullScanFilterInfo, makeIndexEqSeekFilterInfo } from '@quereus/quereus';

/**
 * Creates a FilterInfo for a full table scan (no constraints).
 *
 * Shared by the overlay-merge read paths, the ALTER/DROP INDEX overlay
 * migrations, and the commit flush — a single definition keeps the several
 * scan sites from drifting. Delegates to the engine's builder so the overlay
 * scans present the same access path the planner would.
 */
export { makeFullScanFilterInfo };

/**
 * Creates a FilterInfo for a primary key point lookup (equality on all PK
 * columns). Produces O(log n) lookups instead of O(n) full scans.
 *
 * The overlay always names its primary-key index `_primary_`, so the descriptor is
 * built here rather than resolved from a schema.
 */
export function makePkPointLookupFilter(pkIndices: number[], pk: SqlValue[]): FilterInfo {
	const index: IndexDescriptor = {
		name: PRIMARY_INDEX_NAME,
		role: 'primary',
		keyColumns: pkIndices.map(columnIndex => ({ columnIndex, desc: false })),
		unique: true,
	};
	return makeIndexEqSeekFilterInfo(index, pkIndices, pk);
}
