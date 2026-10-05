/**
 * Shared UNIQUE-enforcement collation helpers. {@link uniqueEnforcementCollations}
 * is the single source of truth across packages — it is re-exported from the
 * package index (`@quereus/quereus`) and reached by the store and isolation
 * re-validators (`quereus-store/store-table-constraints.ts`,
 * `quereus-isolation/isolated-table.ts`) through
 * {@link resolveUniqueEnforcementCollations}, which pairs it with the owning
 * database's collation resolver. Cross-package drift is eliminated by construction
 * rather than by a test.
 *
 * Two facts about a UNIQUE constraint that both the row-time covering-MV
 * eligibility gate and memory's covering-MV re-validation need:
 *
 *  - {@link uniqueEnforcementCollations} — the comparison collation per
 *    constrained column. For an index-derived constraint
 *    (`CREATE UNIQUE INDEX … (col COLLATE x)`) it is the index's per-column
 *    COLLATE (resolved BY NAME via `uc.derivedFromIndex`); otherwise the declared
 *    column collation. Positional alignment `uc.columns[i]` ↔ `index.columns[i]`
 *    is guaranteed by `appendIndexToTableSchema`.
 *
 *    Memory's `checkUniqueViaIndex` (manager.ts) is the one resolver that does NOT
 *    import this helper: it reads the collation from the *live* `MemoryIndex`
 *    handle that `findIndexForConstraint` returns. That resolver now looks an
 *    index-derived UC up BY NAME via `uc.derivedFromIndex` (the same key this
 *    helper uses), falling back to a column-set scan only for non-derived UCs, so
 *    the two paths agree per column even when several UNIQUE indexes cover the
 *    SAME column-set with differing collations — each UC resolves to its OWN
 *    index. This `(schema, uc)` signature still has no live `MemoryIndex` handle,
 *    so memory keeps the live-handle read rather than sharing the import; the
 *    agreement is conformance-locked by `test/unique-enforcement-collation.spec.ts`.
 *
 *  - {@link coveringMvHonorsIndexCollation} — whether a row-time covering MV may
 *    soundly answer this constraint. A covering MV generates its candidate set by
 *    re-comparing each backing row under the SOURCE column's DECLARED collation
 *    `D`, while the re-validators filter under the index per-column collation `I`.
 *    The candidate set is therefore a sound *superset* of the `I`-matches — safe
 *    to filter down — iff, per column, `D ⊒ I` (every `I`-equal pair is also
 *    `D`-equal), i.e. `I` refines `D`. That is `collationRefines(I, D)` from
 *    `util/comparison.ts` — the shared decidable test (see its doc for why only
 *    "`I` is BINARY" and "`I` == `D`" are provable over opaque comparators).
 *    Otherwise the candidate set may be a *subset* and the MV must not be used as
 *    a covering structure — the per-scan / auto-index path (already
 *    index-collation-correct) enforces instead.
 */

import { collationRefines, compareSqlValues, compareSqlValuesFast, createTypedComparator, hasSemanticOrdering, resolveCollationFunctions } from '../util/comparison.js';
import type { CollationFunction, CollationResolver } from '../types/logical-type.js';
import type { Row, SqlValue } from '../common/types.js';
import type { ColumnSchema } from './column.js';
import type { IndexSchema, TableSchema, UniqueConstraintSchema } from './table.js';

/**
 * True when populating `indexSchema` must reject duplicate keys: either the index
 * is itself declared UNIQUE, or it is the auto-built covering structure for a
 * declared UNIQUE constraint over the same column set. The latter never carries
 * `unique: true` — insert-time enforcement runs through `uniqueConstraints` — so
 * without this check a re-keying validation (e.g. `ALTER COLUMN ... SET COLLATE`)
 * would silently accept rows that collide under the new collation.
 */
export function indexEnforcesUnique(schema: TableSchema, indexSchema: IndexSchema): boolean {
	if (indexSchema.unique) return true;
	const ucs = schema.uniqueConstraints;
	if (!ucs) return false;
	return ucs.some(uc =>
		uc.columns.length === indexSchema.columns.length &&
		uc.columns.every((colIdx, i) => indexSchema.columns[i].index === colIdx),
	);
}

/**
 * The per-`uc.column` comparison collation for UNIQUE enforcement, one entry per
 * constrained column (positionally aligned with `uc.columns`): the index's
 * per-column COLLATE for an index-derived constraint, else the declared column
 * collation.
 *
 * Falls back to the declared column collation when (a) the constraint is not
 * index-derived (table-level / column UNIQUE — declared IS the enforcement
 * collation), (b) the index metadata did not survive (must not throw — mirrors
 * the gate's tolerance), or (c) a column position carries no explicit index
 * COLLATE (the common `CREATE UNIQUE INDEX ix ON t(b)` case).
 */
export function uniqueEnforcementCollations(
	schema: TableSchema,
	uc: UniqueConstraintSchema,
): (string | undefined)[] {
	const index = uc.derivedFromIndex
		? schema.indexes?.find(ix => ix.name === uc.derivedFromIndex)
		: undefined;
	return uc.columns.map((col, i) => index?.columns[i]?.collation ?? schema.columns[col].collation);
}

/**
 * {@link uniqueEnforcementCollations} resolved to comparison functions against the
 * owning database's registry (`Database.getCollationResolver()`), so a collation
 * registered on the connection is honoured instead of degrading to BINARY.
 *
 * Call ONCE per constraint check, above the candidate loop: the resolver throws on an
 * unregistered name, so a per-candidate call is pure overhead. Every out-of-package
 * UNIQUE re-validator (store, isolation) resolves through here rather than pairing the
 * two calls itself.
 */
export function resolveUniqueEnforcementCollations(
	schema: TableSchema,
	uc: UniqueConstraintSchema,
	resolver: CollationResolver,
): CollationFunction[] {
	return resolveCollationFunctions(resolver, uniqueEnforcementCollations(schema, uc));
}

/**
 * Per-column comparison functions for one row-identity check, one entry per
 * `ucColumns` position: the declared type's `compare` for a semantic-ordering
 * column (so TIMESPAN 'PT1H' conflicts with 'PT60M', matching the memory backend's
 * typed BTree and `=` / DISTINCT / GROUP BY), else the enforcement collation through
 * {@link compareSqlValuesFast} — the exact comparison every re-validator used before.
 *
 * `ucColumns` is usually a UNIQUE constraint's `uc.columns`, but any list of source
 * column indices works: the covering-MV candidate generator
 * (`lookupCoveringConflicts`) also builds a PRIMARY KEY set this way, so a re-spelled
 * PK member still names the same row.
 *
 * Only semantic-ordering types are routed through `compare` ({@link hasSemanticOrdering}
 * is the gate): a TEXT/ANY column's declared `compare` honors the collation it is
 * handed and is equivalent to the generic storage-class + collation path, so the
 * cheaper generic comparator is used for them — only types whose order genuinely
 * diverges from that path need their own `compare` consulted.
 *
 * Takes PRE-RESOLVED collations rather than `(schema, uc, resolver)` because the call
 * sites do not share one collation resolution. Memory's `checkUniqueViaIndex`
 * deliberately reads them from the LIVE `MemoryIndex` handle rather than from
 * {@link uniqueEnforcementCollations} (see the divergence note in this file's docstring;
 * it is conformance-locked by `test/unique-enforcement-collation.spec.ts`), while the
 * store, the isolation overlay, and memory's MV/scan paths resolve by name. A
 * pre-resolved-collation signature lets all of them share the comparator construction
 * while each keeps its own collation resolution.
 *
 * Call ONCE per constraint check, above the candidate loop — same discipline as
 * {@link resolveUniqueEnforcementCollations}.
 */
export function uniqueEnforcementComparators(
	columns: readonly ColumnSchema[],
	ucColumns: readonly number[],
	collations: readonly CollationFunction[],
): Array<(a: SqlValue, b: SqlValue) => number> {
	return ucColumns.map((colIdx, i) => {
		const logicalType = columns[colIdx]?.logicalType;
		if (hasSemanticOrdering(logicalType)) return createTypedComparator(logicalType, collations[i]);
		return (a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collations[i]);
	});
}

/**
 * Same-primary-key UPDATE gate: true if any column covered by a UNIQUE constraint
 * changed between `oldRow` and `newRow`, or — for a partial UNIQUE — any column its
 * predicate references changed (which can move the row into or out of the
 * predicate's scope). False means no UNIQUE constraint can newly conflict, so the
 * caller may skip its UNIQUE check. Shared by memory, store and the isolation
 * overlay so the three backends gate identically.
 *
 * `predicateColumns` supplies a partial constraint's referenced columns; each
 * backend already holds (or memoizes) a compiled predicate, so the lookup is
 * delegated rather than recompiled here. Only called for constraints that carry a
 * predicate.
 *
 * NOTE: the per-column test is byte-level `compareSqlValues`, not the enforcement
 * comparator, so it OVER-triggers for a semantic-ordering column: rewriting a
 * TIMESPAN 'PT1H' to 'PT60M' reports "changed" and re-runs the UNIQUE check, which
 * then excludes the row's own primary key and passes. Correct — this only gates
 * whether to re-check — just not minimal. If UPDATE-heavy workloads over
 * semantic-ordering UNIQUE columns ever show the redundant re-check as hot, route
 * this through `uniqueEnforcementComparators` too.
 */
export function uniqueColumnsChanged(
	uniqueConstraints: ReadonlyArray<UniqueConstraintSchema> | undefined,
	oldRow: Row,
	newRow: Row,
	predicateColumns: (uc: UniqueConstraintSchema) => Iterable<number> | undefined,
): boolean {
	if (!uniqueConstraints) return false;
	for (const uc of uniqueConstraints) {
		if (anyColumnChanged(uc.columns, oldRow, newRow)) return true;
		if (!uc.predicate) continue;
		const referenced = predicateColumns(uc);
		if (referenced && anyColumnChanged(referenced, oldRow, newRow)) return true;
	}
	return false;
}

function anyColumnChanged(columns: Iterable<number>, oldRow: Row, newRow: Row): boolean {
	for (const colIdx of columns) {
		if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
	}
	return false;
}

/**
 * True iff a row-time covering MV may soundly answer `uc` — i.e. for every
 * constrained column the index per-column collation `I` is coarser-or-equal to
 * the declared column collation `D` (`D ⊒ I`), provable by the BINARY-floor or
 * name-equality tests above. AND over all columns: one finer/incomparable column
 * poisons the whole MV (it covers all UC columns or none).
 *
 * A non-index-derived constraint (`derivedFromIndex` unset) has `I == D` for
 * every column ⇒ always eligible. Defensive on missing index metadata: a
 * `derivedFromIndex` whose index record is gone falls back to `I = D` per column
 * (eligible) rather than throwing — same tolerance as the enforcement-collation
 * resolver.
 */
export function coveringMvHonorsIndexCollation(
	schema: TableSchema,
	uc: UniqueConstraintSchema,
): boolean {
	const index = uc.derivedFromIndex
		? schema.indexes?.find(ix => ix.name === uc.derivedFromIndex)
		: undefined;
	return uc.columns.every((col, i) => {
		const declared = schema.columns[col].collation;
		return collationRefines(index?.columns[i]?.collation ?? declared, declared);
	});
}
