/**
 * Inclusion-dependency reasoning helpers.
 *
 * Foreign keys are inclusion dependencies (`child.fk ⊆ parent.pk`). The rules
 * under `planner/rules/{join,subquery}/` that exploit this — join elimination,
 * anti-join-to-empty, semi-join trivialization, FK-covered aggregate elim —
 * all need the same primitives:
 *   - find a declared FK on the child that covers a given set of equi-pairs
 *     against a parent table,
 *   - extract the underlying `TableSchema` of a relational subtree (through
 *     standard row-preserving wrappers),
 *   - decide whether a relational subtree exposes the full row set of its
 *     underlying base table (no row-reducing wrapper between the join and the
 *     table).
 *
 * `extractTableSchema` and `checkFkPkAlignment` live in `key-utils.ts` because
 * they also serve non-IND callers (key coverage, FD propagation). This file
 * adds the IND-specific extensions: a covering-FK lookup that *returns* the
 * matched FK (so callers can inspect nullability), and the row-preserving
 * path walker.
 */

import type { TableSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import { resolveReferencedColumns } from '../../schema/table.js';
import type { InclusionDependency, RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { RetrieveNode } from '../nodes/retrieve-node.js';
import { AliasNode } from '../nodes/alias-node.js';
import { SortNode } from '../nodes/sort.js';
import { extractTableSchema } from './key-utils.js';

/**
 * Result of a successful covering-FK lookup.
 *
 * `fk` is the matched declaration; `nullable` is true iff any child column in
 * the FK is nullable (the IND child→parent inclusion only guarantees the
 * non-null FK rows have a parent; NULL FK rows are not covered by the FK).
 */
export interface CoveringFKMatch {
	fk: ForeignKeyConstraintSchema;
	nullable: boolean;
}

/**
 * Look up a foreign key on `childSchema` that references `parentSchema` whose
 * `(fk_columns → referenced_pk_columns)` mapping equals the requested equi-pairs
 * — preserving the FK's declared column pairing — and where every referenced
 * column is a primary-key column of the parent.
 *
 * Returns the matched FK plus a nullability bit (true iff any FK child column
 * is nullable).
 *
 * Alignment is *positional*: for each `i`, the equi-pair partner of
 * `fk.columns[i]` must equal `fk.referencedColumns[i]`. A composite FK
 * `(fa, fb) REFERENCES p(a, b)` guarantees `fa → a` and `fb → b` in that
 * pairing only; a permuted equi-pair set (e.g. `fa = b AND fb = a`) is NOT
 * covered by the FK and must not fold. A defensive cross-check additionally
 * requires every `fk.referencedColumns[i]` to be a PK column so a malformed FK
 * referencing non-PK columns never produces an IND on the PK.
 */
export function lookupCoveringFK(
	childSchema: TableSchema,
	parentSchema: TableSchema,
	childEquiCols: ReadonlyArray<number>,
	parentEquiCols: ReadonlyArray<number>,
): CoveringFKMatch | undefined {
	if (!childSchema.foreignKeys) return undefined;
	if (childEquiCols.length !== parentEquiCols.length) return undefined;
	if (childEquiCols.length === 0) return undefined;

	const equiMap = new Map<number, number>();
	for (let i = 0; i < childEquiCols.length; i++) {
		equiMap.set(childEquiCols[i], parentEquiCols[i]);
	}

	const pkColSet = new Set(parentSchema.primaryKeyDefinition.map(p => p.index));

	for (const fk of childSchema.foreignKeys) {
		if (fk.referencedTable.toLowerCase() !== parentSchema.name.toLowerCase()) continue;
		if (parentSchema.primaryKeyDefinition.length === 0) continue;
		if (fk.columns.length !== parentSchema.primaryKeyDefinition.length) continue;
		if (fk.columns.length !== childEquiCols.length) continue;

		// FK schemas store an empty referencedColumns at CREATE TABLE time;
		// indices are resolved against the parent via resolveReferencedColumns.
		let refCols: ReadonlyArray<number>;
		try {
			refCols = resolveReferencedColumns(fk, parentSchema);
		} catch {
			continue;
		}
		if (refCols.length !== fk.columns.length) continue;

		let aligned = true;
		for (let i = 0; i < fk.columns.length; i++) {
			// Defensive: a malformed FK referencing a non-PK column must never be
			// treated as an IND on the parent PK.
			if (!pkColSet.has(refCols[i])) {
				aligned = false;
				break;
			}
			// Positional match: the equi-partner of fk.columns[i] must be exactly
			// the parent column the FK declares at position i. A permuted equi-pair
			// set on a composite FK is NOT covered by the FK.
			const partner = equiMap.get(fk.columns[i]);
			if (partner !== refCols[i]) {
				aligned = false;
				break;
			}
		}
		if (!aligned) continue;

		return { fk, nullable: fkChildNullable(childSchema, fk) };
	}
	return undefined;
}

/**
 * True iff any child column of `fk` is nullable on `childSchema`. The single
 * source of the FK-nullability bit: both `lookupCoveringFK` (as
 * `CoveringFKMatch.nullable`) and the IND seeding in `TableReferenceNode`
 * consume it, so the rule helper and the propagated property cannot diverge.
 *
 * A nullable child column means the FK→parent inclusion only guarantees the
 * non-null FK rows have a parent (a NULL FK row is excluded — `nullRejecting`).
 */
export function fkChildNullable(
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
): boolean {
	for (const colIdx of fk.columns) {
		if (!childSchema.columns[colIdx]?.notNull) return true;
	}
	return false;
}

/**
 * Seed one inclusion dependency per declared FK on `childSchema` whose
 * referenced columns are exactly the primary key of the parent table. The
 * propagated companion to `lookupCoveringFK` — it mirrors that helper's FK→PK
 * validation (the FK must cover the whole PK and every referenced column must be
 * a PK column) so a malformed FK referencing non-PK columns never seeds an IND
 * against the PK.
 *
 * `cols` are the FK child column indices, which equal output indices at a
 * `TableReferenceNode` (output = table columns 1:1) — `cols[i]` pairs
 * positionally with `targetCols[i]`. `nullRejecting` is the shared
 * `fkChildNullable` bit. Parent schemas are resolved through `findParent`; an FK
 * whose parent cannot be resolved, has no PK, or has a mismatched PK seeds
 * nothing.
 */
export function seedTableForeignKeyInds(
	childSchema: TableSchema,
	findParent: (tableName: string, schemaName: string) => TableSchema | undefined,
): InclusionDependency[] {
	const fks = childSchema.foreignKeys;
	if (!fks || fks.length === 0) return [];

	const inds: InclusionDependency[] = [];
	for (const fk of fks) {
		const parentSchemaName = fk.referencedSchema ?? childSchema.schemaName;
		const parent = findParent(fk.referencedTable, parentSchemaName);
		if (!parent) continue;

		const pkDef = parent.primaryKeyDefinition;
		if (pkDef.length === 0) continue;
		if (fk.columns.length !== pkDef.length) continue;

		let refCols: ReadonlyArray<number>;
		try {
			refCols = resolveReferencedColumns(fk, parent);
		} catch {
			continue;
		}
		if (refCols.length !== fk.columns.length) continue;

		// Every referenced column must be a PK column — mirror lookupCoveringFK's
		// defensive cross-check so a malformed FK referencing non-PK columns never
		// seeds an IND against the PK.
		const pkColSet = new Set(pkDef.map(p => p.index));
		let allPk = true;
		for (const rc of refCols) {
			if (!pkColSet.has(rc)) { allPk = false; break; }
		}
		if (!allPk) continue;

		inds.push({
			cols: fk.columns.slice(),
			target: {
				kind: 'table',
				schema: parent.schemaName,
				table: parent.name,
				targetCols: refCols.slice(),
			},
			nullRejecting: fkChildNullable(childSchema, fk),
		});
	}
	return inds;
}

/**
 * Convenience wrapper around `extractTableSchema` — same behaviour, exported
 * under a name that matches the IND-rules' vocabulary so callers don't need
 * to reach into key-utils for an unrelated import.
 */
export function tableSchemaOf(node: RelationalPlanNode): TableSchema | undefined {
	return extractTableSchema(node);
}

/**
 * True when `node` is a chain of wrappers that produces the full row set of
 * its underlying base table — i.e. nothing between the node and the table can
 * filter, limit, or deduplicate rows.
 *
 * Allowed wrappers: TableReferenceNode (base), RetrieveNode whose pipeline is
 * the bare TableReferenceNode (no pushed-down pipeline filter), AliasNode,
 * SortNode — all preserve row count *and* attribute-id mapping of their
 * source. ProjectNode is intentionally excluded: it may reorder/drop columns
 * which would invalidate the table-column-index→attribute-index assumption
 * the FK→PK alignment check relies on. Anything else (Filter, LimitOffset,
 * Distinct, Project, Join, Aggregate, Window, CTE, SetOperation, …)
 * disqualifies.
 *
 * Used by: INNER join elimination (PK side must be unfiltered) and aggregate
 * elimination over FK-covered joins (same reason — a row-reducing wrapper on
 * the eliminable side would have dropped rows the FK→PK guarantee assumes
 * are present).
 */
export function isRowPreservingPathToTable(node: RelationalPlanNode): boolean {
	if (node instanceof TableReferenceNode) return true;
	if (node instanceof RetrieveNode) {
		return node.source instanceof TableReferenceNode;
	}
	if (node instanceof AliasNode) return isRowPreservingPathToTable(node.source);
	if (node instanceof SortNode) return isRowPreservingPathToTable(node.source);
	return false;
}
