import type { SqlValue, Row, CompareFn } from '../common/types.js';

/**
 * Capability flags that modules can advertise to consumers.
 * Used for runtime capability discovery and isolation layer decisions.
 */
export interface ModuleCapabilities {
	/** Module provides transaction isolation (read-your-own-writes, snapshot reads) */
	isolation?: boolean;

	/** Module supports savepoints within transactions */
	savepoints?: boolean;

	/** Module persists data across restarts */
	persistent?: boolean;

	/** Module supports secondary indexes */
	secondaryIndexes?: boolean;

	/** Module supports range scans (not just point lookups) */
	rangeScans?: boolean;

	/**
	 * Module owns ADD-COLUMN NOT-NULL-backfill semantics and opts out of the
	 * engine-generic rejection.
	 *
	 * Default/absent ⇒ the engine rejects `ALTER TABLE … ADD COLUMN <NOT NULL,
	 * no usable DEFAULT>` on a non-empty table before dispatching to the module
	 * (see `validateNotNullBackfill` in `runtime/emit/alter-table.ts`).
	 *
	 * When true, the engine skips that pre-check and delegates the decision to
	 * the module's `alterTable`. Intended for modules that are structurally
	 * total for schema changes — a migration always commits and NOT NULL is
	 * declared on the new schema and enforced at write time going forward,
	 * rather than applied retroactively to pre-existing rows. Such a module must
	 * still perform its own validation in `alterTable` if it wants any.
	 *
	 * Native modules (memory, store) leave this off, so their behavior — and
	 * Quereus's own conformance suite — is unchanged.
	 */
	delegatesNotNullBackfill?: boolean;

	/**
	 * Module may carry rows that violate a currently-declared CHECK constraint
	 * (i.e. `ALTER TABLE … ADD CHECK` against a non-conforming table succeeds
	 * and grandfathers the violator while declaring the CHECK on the new schema
	 * and enforcing it on forward writes).
	 *
	 * Default/absent ⇒ the planner treats declared CHECKs as universal
	 * invariants over the current row set and lifts them into FD / EC /
	 * constant-binding / domain-constraint contributions on the
	 * `TableReferenceNode`'s physical properties. The filter-contradiction
	 * rule (`rules/predicate/rule-filter-contradiction.ts`) and other
	 * consumers then constant-fold WHERE predicates that are unsatisfiable
	 * with the CHECK — sound under the third-manifesto reading where CHECKs
	 * are gate-on-add.
	 *
	 * When true, that lift is skipped for declared CHECKs on this table: the
	 * CHECK is still enforced at write time (the engine's CHECK enforcer is
	 * unchanged) but the planner can no longer prove `count(*) where v <= 0`
	 * folds to `0` from `CHECK (v > 0)` alone, because a grandfathered violator
	 * might satisfy the WHERE. Native modules (memory, store) leave this off,
	 * so their behaviour — and Quereus's own conformance suite — is unchanged.
	 *
	 * Note: assertion-hoist (CREATE ASSERTION) and partial-UNIQUE FDs are
	 * lifted by separate paths and are NOT gated by this flag.
	 */
	permitsGrandfatheredCheckViolators?: boolean;
}

/**
 * Extended interface for tables that can be wrapped by the isolation layer.
 * Provides key extraction and comparison functions needed for merge operations.
 */
export interface IsolationCapableTable {
	/**
	 * Extract primary key values from a full row.
	 * The returned array contains only the PK column values in PK order.
	 */
	extractPrimaryKey(row: Row): SqlValue[];

	/**
	 * Compare two rows by their primary key values.
	 * Must use the module's native key ordering (e.g., binary encoding order for store modules).
	 * @returns negative if a < b, 0 if equal, positive if a > b
	 */
	comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number;

	/**
	 * Get per-column comparator functions for a specific index.
	 * Used when merging index scans from overlay and underlying tables.
	 * Each comparator incorporates DESC ordering and collation for its column.
	 * @param indexName The name of the index
	 * @returns Array of per-column comparators, or undefined if index doesn't exist
	 */
	getIndexComparator?(indexName: string): CompareFn[] | undefined;

	/**
	 * Get the primary key column indices in the row.
	 * Used to extract PK values from rows.
	 */
	getPrimaryKeyIndices(): number[];
}
