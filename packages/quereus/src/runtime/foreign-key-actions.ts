import type { Database } from '../core/database.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../schema/table.js';
import { resolveReferencedColumns } from '../schema/table.js';
import type { ForeignKeyAction } from '../parser/ast.js';
import type { Row, SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { expressionToString, quoteIdentifier } from '../emit/ast-stringify.js';
import { sqlValuesEqual } from '../util/comparison.js';
import type { LensSlot } from '../schema/lens.js';
import { resolveSlotBasisSource } from '../schema/lens-prover.js';
import {
	findLogicalParentFkRefs,
	logicalToBasisColumnMap,
	matchingBasisFksForLensRef,
	basisFksOverriddenByDivergentLensFk,
	type LogicalParentFkRef,
} from '../schema/lens-fk-discovery.js';

const log = createLogger('runtime:fk-actions');

/**
 * Executes cascading foreign key actions when a parent row is deleted or updated.
 *
 * @param db Database instance
 * @param parentTable Parent table schema being mutated
 * @param operation 'delete' or 'update'
 * @param oldRow The old row values from the parent table
 * @param newRow The new row values (undefined for delete)
 * @param visitedTables Set of table names already visited (for cycle detection)
 */
export async function executeForeignKeyActions(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
	visitedTables?: Set<string>,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const visited = visitedTables ?? new Set<string>();
	const parentKey = `${parentTable.schemaName}.${parentTable.name}`.toLowerCase();

	if (visited.has(parentKey)) {
		throw new QuereusError(
			`Foreign key cascade cycle detected involving table '${parentTable.name}'`,
			StatusCode.CONSTRAINT
		);
	}
	visited.add(parentKey);

	// Basis FKs a divergent non-RESTRICT logical FK overrides — their physical action is
	// suppressed here so the logical action (fired by the lens walker) governs alone.
	// Cheap-empty when no lens slot is backed by `parentTable` (the common non-lens case).
	const suppressed = basisFksOverriddenByDivergentLensFk(parentTable, operation, db.schemaManager);

	try {
		// Find all child tables with FKs referencing this parent
		for (const schema of db.schemaManager._getAllSchemas()) {
			for (const childTable of schema.getAllTables()) {
				if (!childTable.foreignKeys) continue;

				for (const fk of childTable.foreignKeys) {
					if (fk.referencedTable.toLowerCase() !== parentTable.name.toLowerCase()) continue;

					const targetSchema = fk.referencedSchema ?? childTable.schemaName;
					if (targetSchema.toLowerCase() !== parentTable.schemaName.toLowerCase()) continue;

					const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;

					// RESTRICT is handled by parent-side constraint checks, not actions
					if (action === 'restrict') continue;

					// Suppressed: a divergent non-RESTRICT logical FK over the same columns
					// replaces this basis action (the lens walker fires the logical action).
					if (suppressed.has(fk)) continue;

					const parentColIndices = resolveReferencedColumns(fk, parentTable);
					if (parentColIndices.length !== fk.columns.length) continue;

					// Get old parent values for the referenced columns
					const oldParentValues = parentColIndices.map(idx => oldRow[idx]);

					// Skip if any old value is NULL (NULLs don't participate in FK matching)
					if (oldParentValues.some(v => v === null || v === undefined)) continue;

					await executeSingleFKAction(
						db, childTable, fk, action, parentTable, parentColIndices,
						oldParentValues, operation === 'update' ? newRow : undefined,
						visited
					);
				}
			}
		}
	} finally {
		visited.delete(parentKey);
	}
}

/**
 * The combined physical + lens FK-action entry point the DML executor fires after
 * every basis row delete/update. Runs the physical {@link executeForeignKeyActions}
 * (cascade / set-null / set-default over declared basis `TableSchema.foreignKeys`)
 * and then the logical dual {@link executeLensForeignKeyActions} (the same actions
 * over a *logical* FK that lives only on a lens slot's `enforced-fk` obligation). A
 * single wrapper keeps the two sites from drifting — wherever a basis row write fires
 * physical FK actions, the logical cascade fires too. The lens half is a cheap early
 * return when `foreign_keys` is off or no lens slot is backed by `parentTable`.
 */
export async function executeForeignKeyActionsAndLens(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
): Promise<void> {
	await executeForeignKeyActions(db, parentTable, operation, oldRow, newRow);
	await executeLensForeignKeyActions(db, parentTable, operation, oldRow, newRow);
}

/**
 * Pre-walk the FK action graph rooted at `parentTable` and assert that no
 * RESTRICT child anywhere in the transitive cascade closure blocks the
 * mutation. Reads happen at call time — the caller is responsible for
 * invoking this BEFORE `vtab.update` runs, so OLD-value scans still resolve
 * for backends with rowid-mode FK columns (lamina) where post-mutation
 * scans would dereference through the new parent value.
 *
 * The walk:
 *   1. Runs the existing direct RESTRICT scan
 *      (`assertNoRestrictedChildrenForParentMutation`) for `parentTable`.
 *   2. For each child FK with action `cascade` / `setNull` / `setDefault`
 *      that would propagate a column change (UPDATE: parent's referenced
 *      column changed; DELETE: always), enumerates the matching child
 *      rows and computes the would-be post-cascade row. Recurses with the
 *      child as the new "parent" — for UPDATE with `cascade` the recursion
 *      carries the new FK column values forward; for DELETE the recursion
 *      treats the cascade as another DELETE; SET NULL recurses with the
 *      child's projected new row.
 *   3. Cycle detection via a `visited` set keyed by
 *      `${schemaName}.${tableName}` (matches the existing walker's key).
 */
export async function assertTransitiveRestrictsForParentMutation(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
	visited?: Set<string>,
): Promise<void> {
	log('TRANSITIVE entry: parent=%s op=%s fk-pragma=%o', parentTable.name, operation, db.options.getBooleanOption('foreign_keys'));
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const visitedSet = visited ?? new Set<string>();
	const parentKey = `${parentTable.schemaName}.${parentTable.name}`.toLowerCase();
	if (visitedSet.has(parentKey)) return;
	visitedSet.add(parentKey);

	try {
		// Step 1: direct RESTRICT scan for this parent.
		log('TRANSITIVE step1: parent=%s op=%s', parentTable.name, operation);
		await assertNoRestrictedChildrenForParentMutation(db, parentTable, operation, oldRow, newRow);

		// Step 2: recurse through cascading children that would propagate a
		// referenced-column change. For each FK whose action would rewrite or
		// delete child rows, scan the matching children NOW (pre-mutation, so
		// the parent's OLD values still resolve), compute the projected child
		// row, and recurse with that child as the new "parent".
		const parentSchemaLower = parentTable.schemaName.toLowerCase();
		const parentTableLower = parentTable.name.toLowerCase();

		// Basis cascading FKs a divergent non-RESTRICT logical FK overrides — skip them in
		// the recursion: the physical cascade they walk will not run (the logical action
		// replaces it), and the logical action's own transitivity is enforced when its
		// child-view DML re-enters this walk at the next level.
		const suppressed = basisFksOverriddenByDivergentLensFk(parentTable, operation, db.schemaManager);

		for (const schema of db.schemaManager._getAllSchemas()) {
			for (const childTable of schema.getAllTables()) {
				if (!childTable.foreignKeys) continue;

				for (const fk of childTable.foreignKeys) {
					if (fk.referencedTable.toLowerCase() !== parentTableLower) continue;
					const targetSchema = fk.referencedSchema ?? childTable.schemaName;
					if (targetSchema.toLowerCase() !== parentSchemaLower) continue;

					const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;
					if (action !== 'cascade' && action !== 'setNull' && action !== 'setDefault') continue;

					// Suppressed: the logical action replaces this basis cascade, so the
					// physical cascade it would walk never runs — do not recurse through it.
					if (suppressed.has(fk)) continue;

					const parentColIndices = resolveReferencedColumns(fk, parentTable);
					if (parentColIndices.length !== fk.columns.length) continue;

					// MATCH SIMPLE: NULL parent values cannot be referenced.
					const oldParentValues = parentColIndices.map(idx => oldRow[idx]) as SqlValue[];
					if (oldParentValues.some(v => v === null || v === undefined)) continue;

					// UPDATE-only short-circuit: skip if no referenced parent column changed.
					let newParentValues: SqlValue[] | undefined;
					if (operation === 'update' && newRow !== undefined) {
						let anyChanged = false;
						for (const idx of parentColIndices) {
							if (!sqlValuesEqual(oldRow[idx] as SqlValue, newRow[idx] as SqlValue)) {
								anyChanged = true;
								break;
							}
						}
						if (!anyChanged) continue;
						newParentValues = parentColIndices.map(idx => newRow[idx]) as SqlValue[];
					}

					// Scan child rows that match the OLD parent values.
					const childColQuoted = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
					const whereClause = childColQuoted.map(c => `${c} = ?`).join(' AND ');
					const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
						? `${quoteIdentifier(childTable.schemaName)}.`
						: '';
					const sql = `select * from ${schemaPrefix}${quoteIdentifier(childTable.name)} where ${whereClause}`;

					log('TRANSITIVE pre-walk: %s with params %o', sql, oldParentValues);

					const stmt = db.prepare(sql);
					try {
						stmt.bindAll(oldParentValues);
						for await (const childOldRow of stmt._iterateRowsRaw()) {
							let childNewRow: Row | undefined;
							let childOp: 'delete' | 'update';

							if (action === 'cascade' && operation === 'delete') {
								childOp = 'delete';
								childNewRow = undefined;
							} else if (action === 'cascade' && operation === 'update' && newParentValues) {
								childOp = 'update';
								const next = [...(childOldRow as Row)] as SqlValue[];
								for (let i = 0; i < fk.columns.length; i++) {
									next[fk.columns[i]] = newParentValues[i];
								}
								childNewRow = next as Row;
							} else if (action === 'setNull') {
								childOp = 'update';
								const next = [...(childOldRow as Row)] as SqlValue[];
								for (let i = 0; i < fk.columns.length; i++) {
									next[fk.columns[i]] = null;
								}
								childNewRow = next as Row;
							} else if (action === 'setDefault') {
								// SET DEFAULT recursion: pass the child OLD row as both
								// old and new. The recursion's column-change short-circuit
								// will treat this as "no FK column moved" and the per-target
								// cascade SQL (executeSingleFKAction) still fires its own
								// RESTRICT enforcement for non-rowid-chained backends. This
								// matches the coverage gap SET DEFAULT already has in
								// rowid-chained backends — no regression beyond status quo.
								childOp = 'update';
								childNewRow = childOldRow as Row;
							} else {
								continue;
							}

							await assertTransitiveRestrictsForParentMutation(
								db, childTable, childOp, childOldRow as Row, childNewRow, visitedSet,
							);
						}
					} finally {
						await stmt.finalize();
					}
				}
			}
		}
	} finally {
		visitedSet.delete(parentKey);
	}
}

/**
 * Backend-agnostic RESTRICT pre-check fired by the runtime DML executor BEFORE
 * a parent DELETE or UPDATE hits the vtab. Mirrors the plan-time `NOT EXISTS`
 * synthesized by `buildParentSideFKChecks`, but uses a direct `select 1 ... limit 1`
 * against the child table so any vtab module sees a consistent enforcement path.
 *
 * The plan-time check remains in force; this runtime pass is defense-in-depth
 * for vtab modules where the embedded subquery's evaluation diverges from a
 * plain row scan (correlation handling, isolation snapshots, predicate
 * pushdown quirks, etc.).
 *
 * No-op when `foreign_keys` is off, when no FK references this parent table
 * with action `'restrict'`, when any old referenced value is NULL (MATCH SIMPLE),
 * or — for UPDATE — when no referenced parent column changed.
 */
export async function assertNoRestrictedChildrenForParentMutation(
	db: Database,
	parentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const parentSchemaLower = parentTable.schemaName.toLowerCase();
	const parentTableLower = parentTable.name.toLowerCase();

	// Basis RESTRICT FKs a divergent non-RESTRICT logical FK overrides — their RESTRICT
	// pre-check is suppressed so the parent mutation a logical cascade must complete is
	// not aborted. Cheap-empty when no lens slot is backed by `parentTable`.
	const suppressed = basisFksOverriddenByDivergentLensFk(parentTable, operation, db.schemaManager);

	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const childTable of schema.getAllTables()) {
			if (!childTable.foreignKeys) continue;

			for (const fk of childTable.foreignKeys) {
				if (fk.referencedTable.toLowerCase() !== parentTableLower) continue;
				const targetSchema = fk.referencedSchema ?? childTable.schemaName;
				if (targetSchema.toLowerCase() !== parentSchemaLower) continue;

				const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;
				if (action !== 'restrict') continue;

				// Suppressed: a divergent non-RESTRICT logical FK over the same columns
				// replaces this basis RESTRICT (the logical cascade must run, not abort).
				if (suppressed.has(fk)) continue;

				const parentColIndices = resolveReferencedColumns(fk, parentTable);
				if (parentColIndices.length !== fk.columns.length) continue;

				// UPDATE: only enforce when at least one referenced parent column changed.
				if (operation === 'update' && newRow !== undefined) {
					let anyChanged = false;
					for (const idx of parentColIndices) {
						if (!sqlValuesEqual(oldRow[idx] as SqlValue, newRow[idx] as SqlValue)) {
							anyChanged = true;
							break;
						}
					}
					if (!anyChanged) continue;
				}

				// MATCH SIMPLE: NULL parent values cannot be referenced.
				const oldParentValues = parentColIndices.map(idx => oldRow[idx]) as SqlValue[];
				if (oldParentValues.some(v => v === null || v === undefined)) continue;

				const childColNames = fk.columns.map(idx => quoteIdentifier(childTable.columns[idx].name));
				const whereClause = childColNames.map(c => `${c} = ?`).join(' AND ');
				const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
					? `${quoteIdentifier(childTable.schemaName)}.`
					: '';
				const sql = `select 1 from ${schemaPrefix}${quoteIdentifier(childTable.name)} where ${whereClause} limit 1`;

				log('RESTRICT check (%s): %s with params %o', operation, sql, oldParentValues);

				const stmt = db.prepare(sql);
				try {
					stmt.bindAll(oldParentValues);
					let referenced = false;
					for await (const _row of stmt._iterateRowsRaw()) {
						referenced = true;
						break;
					}
					if (referenced) {
						const opName = operation === 'delete' ? 'DELETE' : 'UPDATE';
						throw new QuereusError(
							`FOREIGN KEY constraint failed: ${opName} on '${parentTable.name}' violates RESTRICT from '${childTable.name}'`,
							StatusCode.CONSTRAINT,
						);
					}
				} finally {
					await stmt.finalize();
				}
			}
		}
	}
}

async function executeSingleFKAction(
	db: Database,
	childTable: TableSchema,
	fk: ForeignKeyConstraintSchema,
	action: 'cascade' | 'setNull' | 'setDefault',
	parentTable: TableSchema,
	parentColIndices: number[],
	oldParentValues: SqlValue[],
	newRow: Row | undefined,
	_visited: Set<string>,
): Promise<void> {
	const childColNames = fk.columns.map(idx => childTable.columns[idx].name);
	const whereClause = childColNames
		.map(name => `"${name}" = ?`)
		.join(' AND ');
	const qualifiedChildTable = `"${childTable.schemaName}"."${childTable.name}"`;

	switch (action) {
		case 'cascade': {
			if (newRow === undefined) {
				// CASCADE DELETE: delete matching child rows
				const sql = `DELETE FROM ${qualifiedChildTable} WHERE ${whereClause}`;
				log('CASCADE DELETE: %s with params %o', sql, oldParentValues);
				await db._execWithinTransaction(sql, oldParentValues);
			} else {
				// CASCADE UPDATE: update child FK columns to new parent values
				const newParentValues = parentColIndices.map(idx => newRow[idx]);
				const setClauses = childColNames
					.map(name => `"${name}" = ?`)
					.join(', ');
				const whereParamsClause = childColNames
					.map(name => `"${name}" = ?`)
					.join(' AND ');
				const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereParamsClause}`;
				const params = [...newParentValues, ...oldParentValues];
				log('CASCADE UPDATE: %s with params %o', sql, params);
				await db._execWithinTransaction(sql, params);
			}
			break;
		}
		case 'setNull': {
			const setClauses = childColNames.map(name => `"${name}" = NULL`).join(', ');
			const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereClause}`;
			log('SET NULL: %s with params %o', sql, oldParentValues);
			await db._execWithinTransaction(sql, oldParentValues);
			break;
		}
		case 'setDefault': {
			const setClauses = childColNames.map((name, i) => {
				const col = childTable.columns[fk.columns[i]];
				const defaultVal = col.defaultValue;
				if (defaultVal === null || defaultVal === undefined) {
					return `"${name}" = NULL`;
				}
				// defaultValue is always an AST Expression — stringify it
				return `"${name}" = (${expressionToString(defaultVal)})`;
			}).join(', ');
			const sql = `UPDATE ${qualifiedChildTable} SET ${setClauses} WHERE ${whereClause}`;
			log('SET DEFAULT: %s with params %o', sql, oldParentValues);
			await db._execWithinTransaction(sql, oldParentValues);
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Lens cascade walker — the logical dual of executeForeignKeyActions.
//
// A logical FK lives only on a child lens slot's `enforced-fk` obligation (on no
// basis table), so executeForeignKeyActions — which scans declared
// `TableSchema.foreignKeys` — never sees it. When a lens-backed logical *parent* is
// deleted / re-keyed, the basis op runs but no logical cascade fires. This walker is
// fired (via executeForeignKeyActionsAndLens) right after each basis row write: it
// reverse-maps the basis parent table to the logical parent slot(s) it backs,
// discovers the referencing logical FKs, and — for the non-RESTRICT actions
// (cascade / set-null / set-default) — issues the propagating DML against the logical
// child *view*. Issuing against the view (not the basis child) re-enters the full
// lens write path, so the child's own constraints + any nested logical cascade fire,
// exactly as a user-issued `delete from x.child` would. Recursion + termination work
// identically to executeSingleFKAction's SQL-issuing path: each cascade is a real
// nested statement and a cycle terminates by data exhaustion.
// ---------------------------------------------------------------------------

/**
 * Propagates the non-RESTRICT parent-side actions (cascade / set-null / set-default)
 * of a *logical* FK through the lens when a lens-backed logical parent is deleted or
 * updated. The logical dual of {@link executeForeignKeyActions}.
 *
 * No-op (early return) when `foreign_keys` is off, or when no lens slot resolves to
 * `basisParentTable` as its single basis spine — so non-lens DML pays only one cheap
 * scan over the lens slots (most databases have none). The single-source-spine
 * boundary is identical to the RESTRICT collector's: a parent slot with no single
 * basis spine never matches.
 */
export async function executeLensForeignKeyActions(
	db: Database,
	basisParentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow?: Row,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;

	const sm = db.schemaManager;
	const basisNameLower = basisParentTable.name.toLowerCase();
	const basisSchemaLower = basisParentTable.schemaName.toLowerCase();

	// Reverse-map basis → logical parent slots: every lens slot whose single basis
	// spine is `basisParentTable` (usually 0 or 1). A multi-source / decomposition
	// parent resolves to no single spine and never matches (documented boundary).
	for (const schema of sm._getAllSchemas()) {
		for (const parentSlot of schema.getAllLensSlots()) {
			const basis = resolveSlotBasisSource(parentSlot, sm);
			if (!basis) continue;
			if (basis.name.toLowerCase() !== basisNameLower) continue;
			if (basis.schemaName.toLowerCase() !== basisSchemaLower) continue;
			await executeLensFkActionsForParentSlot(db, parentSlot, basisParentTable, operation, oldRow, newRow);
		}
	}
}

/** A non-RESTRICT parent-side action propagated by the lens cascade walker. */
type LensFkAction = Extract<ForeignKeyAction, 'cascade' | 'setNull' | 'setDefault'>;

/**
 * Fires the logical cascade for one logical parent slot backed by `basisParentTable`.
 * For each referencing logical FK with a non-RESTRICT op-action it: elides when an
 * equivalent basis FK with an **agreeing** op-action already propagates over the basis
 * (a divergent basis action is instead suppressed and the logical action wins — see
 * {@link basisFksOverriddenByDivergentLensFk}), applies MATCH SIMPLE + the UPDATE
 * referenced-column-change short-circuit, and issues the logical-child DML.
 */
async function executeLensFkActionsForParentSlot(
	db: Database,
	parentSlot: LensSlot,
	basisParentTable: TableSchema,
	operation: 'delete' | 'update',
	oldRow: Row,
	newRow: Row | undefined,
): Promise<void> {
	const sm = db.schemaManager;
	const refs = findLogicalParentFkRefs(parentSlot, sm);
	if (refs.length === 0) return;

	// Maps each logical parent referenced column → its basis column, so the OLD/NEW
	// referenced values can be read off the basis write row by basis index.
	const parentMap = logicalToBasisColumnMap(parentSlot);

	for (const ref of refs) {
		const { fk } = ref;
		const rawAction = operation === 'delete' ? fk.onDelete : fk.onUpdate;
		if (rawAction !== 'cascade' && rawAction !== 'setNull' && rawAction !== 'setDefault') continue;
		const action: LensFkAction = rawAction;

		// Action-aware elision (compose with the physical walker): elide the lens cascade
		// only when an equivalent basis FK exists whose op-action AGREES with the logical
		// action — then the physical executeForeignKeyActions already propagates the same
		// action over the basis (and the logical view reflects it), so firing on top would
		// double-mutate. When the matches DIVERGE (e.g. logical set-null over basis cascade,
		// or logical cascade over basis restrict) the logical action wins: the basis FK is
		// suppressed at every enforcement site (basisFksOverriddenByDivergentLensFk) and the
		// lens cascade fires here. With no match the basis enforces nothing ⇒ fire. The two
		// halves are exact complements in the single-equivalent-basis-FK case (one action).
		const matches = matchingBasisFksForLensRef(ref, parentSlot, basisParentTable, sm);
		const agree = matches.length > 0
			&& matches.every(m => (operation === 'delete' ? m.onDelete : m.onUpdate) === action);
		if (agree) {
			log('lens cascade %s on %s: elided — basis child carries an AGREEING equivalent FK (the physical walker propagates over the basis)',
				fk.name ?? '<anon>', parentSlot.logicalTable.name);
			continue;
		}

		// Read the parent's referenced OLD (and NEW) values off the basis row: logical
		// referenced column → basis column → basis index. A column with no plain basis
		// projection disqualifies the cascade (cannot read its basis value).
		const basisIndices: number[] = [];
		let mappable = true;
		for (const logicalCol of ref.parentLogicalColumns) {
			const basisColName = parentMap.get(logicalCol.toLowerCase());
			const basisIdx = basisColName !== undefined
				? basisParentTable.columnIndexMap.get(basisColName.toLowerCase())
				: undefined;
			if (basisIdx === undefined) { mappable = false; break; }
			basisIndices.push(basisIdx);
		}
		if (!mappable) continue;

		// MATCH SIMPLE: a NULL referenced value participates in no FK match ⇒ no cascade.
		const oldParentValues = basisIndices.map(i => oldRow[i]) as SqlValue[];
		if (oldParentValues.some(v => v === null || v === undefined)) continue;

		// UPDATE short-circuit: skip when no referenced parent column actually changed.
		let newParentValues: SqlValue[] | undefined;
		if (operation === 'update' && newRow !== undefined) {
			let anyChanged = false;
			for (const i of basisIndices) {
				if (!sqlValuesEqual(oldRow[i] as SqlValue, newRow[i] as SqlValue)) { anyChanged = true; break; }
			}
			if (!anyChanged) continue;
			newParentValues = basisIndices.map(i => newRow[i]) as SqlValue[];
		}

		await issueLensFkAction(db, ref, action, operation, oldParentValues, newParentValues);
	}
}

/**
 * Issues the propagating DML against the logical child *view* — the logical dual of
 * {@link executeSingleFKAction}. Uses the logical child schema / table / column names
 * and binds the OLD parent values (and NEW for cascade-update) as parameters (never
 * inlined). The default for SET DEFAULT is the **logical** child column's
 * `defaultValue` AST (stringified), or NULL when none. Because the target is the
 * registered logical view, the DML re-enters the lens write path and its own
 * constraints + nested cascades fire.
 */
async function issueLensFkAction(
	db: Database,
	ref: LogicalParentFkRef,
	action: LensFkAction,
	operation: 'delete' | 'update',
	oldParentValues: SqlValue[],
	newParentValues: SqlValue[] | undefined,
): Promise<void> {
	const childTable = ref.childSlot.logicalTable;
	const childLogicalColumns = ref.childLogicalColumns;
	const schemaPrefix = childTable.schemaName.toLowerCase() !== 'main'
		? `${quoteIdentifier(childTable.schemaName)}.`
		: '';
	const qualifiedChild = `${schemaPrefix}${quoteIdentifier(childTable.name)}`;
	const whereClause = childLogicalColumns.map(c => `${quoteIdentifier(c)} = ?`).join(' and ');

	switch (action) {
		case 'cascade': {
			if (operation === 'delete') {
				const sql = `delete from ${qualifiedChild} where ${whereClause}`;
				log('LENS CASCADE DELETE: %s with params %o', sql, oldParentValues);
				await db._execWithinTransaction(sql, oldParentValues);
			} else {
				// CASCADE UPDATE: rewrite the child FK columns to the NEW parent values
				// (SET) for rows that still reference the OLD values (WHERE).
				const setClauses = childLogicalColumns.map(c => `${quoteIdentifier(c)} = ?`).join(', ');
				const sql = `update ${qualifiedChild} set ${setClauses} where ${whereClause}`;
				const params = [...(newParentValues ?? []), ...oldParentValues];
				log('LENS CASCADE UPDATE: %s with params %o', sql, params);
				await db._execWithinTransaction(sql, params);
			}
			break;
		}
		case 'setNull': {
			const setClauses = childLogicalColumns.map(c => `${quoteIdentifier(c)} = null`).join(', ');
			const sql = `update ${qualifiedChild} set ${setClauses} where ${whereClause}`;
			log('LENS SET NULL: %s with params %o', sql, oldParentValues);
			await db._execWithinTransaction(sql, oldParentValues);
			break;
		}
		case 'setDefault': {
			const setClauses = childLogicalColumns.map((c, i) => {
				const defaultVal = childTable.columns[ref.fk.columns[i]]?.defaultValue;
				if (defaultVal === null || defaultVal === undefined) return `${quoteIdentifier(c)} = null`;
				// The logical child column's default AST, stringified (parametrizing it is
				// unnecessary — a default is a constant expression).
				return `${quoteIdentifier(c)} = (${expressionToString(defaultVal)})`;
			}).join(', ');
			const sql = `update ${qualifiedChild} set ${setClauses} where ${whereClause}`;
			log('LENS SET DEFAULT: %s with params %o', sql, oldParentValues);
			await db._execWithinTransaction(sql, oldParentValues);
			break;
		}
	}
}
