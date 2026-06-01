import type * as AST from '../../parser/ast.js';
import type { LensSlot, LogicalConstraint } from '../../schema/lens.js';
import type { RowConstraintSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import { RowOpFlag } from '../../schema/table.js';
import type { SchemaManager } from '../../schema/manager.js';
import { transformExpr } from './single-source.js';
import { synthesizeFKExistsExpr } from '../building/foreign-key-builder.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:lens-enforcement');

/**
 * Lens row-local constraint enforcement (the write side of the lens prover's
 * `enforced-row-local` obligation class — `docs/lens.md` § Constraint Attachment).
 *
 * The prover (`schema/lens-prover.ts`) classifies every logical constraint into a
 * {@link import('../../schema/lens-prover.js').ConstraintObligation} on
 * `LensSlot.obligations`. A scalar `check` over non-computed (reconstructible)
 * columns is `enforced-row-local`: it is evaluable on the projected row being
 * written, so a non-materialized lens enforces it for free at the write boundary.
 *
 * The view-mutation substrate re-plans a lens write against the **basis table by
 * name** (`mutation/single-source.ts`), which drops the logical context. This
 * module re-attaches it: it rewrites each row-local logical CHECK from
 * logical-column terms into basis-column terms (using the slot's reconstructible
 * projection — the same logical→basis mapping the prover proves over) and hands
 * the result to the base-table builder, which merges them into the per-row
 * `ConstraintCheckNode` exactly as if the basis table had declared them. The
 * effect: a logical CHECK fires at the lens write even when the basis carries no
 * such check.
 *
 * The `enforced-fk` obligation is also handled here (see
 * {@link collectLensForeignKeyConstraints}): each logical FK becomes a deferred,
 * basis-term `EXISTS` existence check against the schema-qualified logical parent,
 * routed through the same constraint pipeline. Because the synthesized check
 * contains an `EXISTS`, the pipeline auto-defers it to commit — matching physical
 * child-side FK timing.
 *
 * The `enforced-set-level` obligation with `mode: 'commit-time'` (a logical
 * `unique` / primary key with no basis covering structure) is the third class
 * handled here (see {@link collectLensSetLevelConstraints}): each becomes a
 * deferred `(select count(*) from <logicalView> as _u where _u.lk = NEW.bk …) <= 1`
 * CHECK over the logical key columns (logical names inside the subquery, basis
 * names on the `NEW.*` side). Because it contains a scalar subquery the pipeline
 * auto-defers it to commit, where the logical view reflects the post-mutation
 * basis: a unique key sees count `1` (itself) and a duplicate count `≥ 2` ⇒ ABORT.
 * Detection-only (no covering structure ⇒ O(n) per changed row). The row-time
 * variant (`enforced-set-level` `mode: 'row-time'`, which unlocks conflict
 * resolution) is **delivered without any code here**: by the prover's own
 * precondition a row-time obligation is backed by a matching **basis `UNIQUE` +
 * non-stale row-time covering MV**, and the single-source spine re-plans the lens
 * write to that basis table (in basis terms), so the basis UC's physical
 * enforcement-through-covering-MV path (`vtab/memory/layer/manager.ts`
 * `checkUniqueViaMaterializedView`) fires for free — an O(log n) existence lookup
 * that honors `ABORT` / `IGNORE` / `REPLACE`. That is why this collector emits
 * nothing for row-time. `proved` / `vacuous` need no enforcement.
 */

/** Marker tag stamped on a routed basis-term constraint so its lens origin is visible. */
export const LENS_BOUNDARY_ATTACHED_TAG = 'quereus.lens.boundary.attached';

/**
 * Maps each reconstructible logical column (lowercased) to the basis column it
 * projects from, read off the slot's compiled-body projection. Mirrors the
 * prover's `mappedBasisColumn`: a logical column is reconstructible iff its
 * body-output term is a plain `column` reference, in which case a written value
 * maps straight back to that basis column. Hidden columns are skipped (they have
 * no body-output term), keeping the output index aligned with `compiledBody.columns`.
 */
function logicalToBasisColumnMap(slot: LensSlot): Map<string, string> {
	const map = new Map<string, string>();
	let outputIndex = 0;
	for (const p of slot.columnProvenance) {
		if (p.source === 'hidden') continue;
		const rc = slot.compiledBody.columns[outputIndex];
		outputIndex++;
		if (rc && rc.type === 'column' && rc.expr.type === 'column') {
			map.set(p.logicalColumn.toLowerCase(), (rc.expr as AST.ColumnExpr).name);
		}
	}
	return map;
}

/**
 * Rewrites a logical-column expression into basis-column terms: a column that
 * maps to a basis column is replaced by an unqualified reference to it; any other
 * column reference has its table/schema qualifier stripped so it resolves against
 * the single basis source after the rewrite. (The prover already errored at deploy
 * on a check over a non-reconstructible column, so every referenced logical column
 * maps cleanly here.)
 */
function rewriteToBasisTerms(expr: AST.Expression, map: ReadonlyMap<string, string>): AST.Expression {
	return transformExpr(expr, (col) => {
		const basisColumn = map.get(col.name.toLowerCase());
		if (basisColumn !== undefined) return { type: 'column', name: basisColumn };
		if (col.table || col.schema) return { type: 'column', name: col.name };
		return undefined;
	});
}

/**
 * Builds the basis-term row-local CHECK constraints a lens write must enforce.
 * Reads the slot's `enforced-row-local` obligations, rewrites each to basis terms,
 * and tags it with {@link LENS_BOUNDARY_ATTACHED_TAG}. The result is merged into
 * the basis INSERT/UPDATE's constraint-check pipeline by the base-table builder.
 *
 * Returns `[]` when the slot is un-proved (`obligations` undefined) or carries no
 * row-local checks — the common case, so a non-lens / check-free write pays nothing.
 */
export function collectLensRowLocalConstraints(slot: LensSlot): RowConstraintSchema[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];
	const map = logicalToBasisColumnMap(slot);
	const constraints: RowConstraintSchema[] = [];
	for (const obligation of slot.obligations) {
		if (obligation.kind !== 'enforced-row-local') continue;
		if (obligation.constraint.kind !== 'check') continue;
		const source = obligation.constraint.constraint;
		constraints.push({
			name: source.name ? `lens:${source.name}` : 'lens:check',
			expr: rewriteToBasisTerms(source.expr, map),
			// A logical CHECK guards the row being written: insert and update only.
			operations: RowOpFlag.INSERT | RowOpFlag.UPDATE,
			tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
		});
	}
	return constraints;
}

/**
 * Resolves a logical FK's referenced (parent) column **names** — the terms the
 * synthesized `EXISTS` subquery filters the parent on. The names resolve against
 * the registered logical parent view, so logical names are correct here. Prefers
 * the FK's stored `referencedColumnNames` (populated for every declared FK); when
 * a bare `references parent` (no column list) leaves them empty, falls back to the
 * parent logical table's primary-key column names (resolved via the parent's lens
 * slot, or a plain table lookup as a backstop).
 */
function resolveLogicalReferencedColumns(
	fk: ForeignKeyConstraintSchema,
	referencedSchema: string,
	schemaManager: SchemaManager,
): string[] {
	if (fk.referencedColumnNames && fk.referencedColumnNames.length > 0) {
		return [...fk.referencedColumnNames];
	}
	const parent = schemaManager.getSchema(referencedSchema)?.getLensSlot(fk.referencedTable)?.logicalTable
		?? schemaManager.findTable(fk.referencedTable, referencedSchema);
	if (!parent) return [];
	return parent.primaryKeyDefinition.map(pk => parent.columns[pk.index]?.name).filter((n): n is string => n !== undefined);
}

/**
 * Builds the basis-term child-side FK existence constraints a lens write must
 * enforce (the write side of the prover's `enforced-fk` obligation). For each FK
 * obligation it synthesizes a MATCH SIMPLE-guarded `EXISTS` against the
 * schema-qualified logical parent relation, with the child (NEW) columns rewritten
 * from logical to basis terms via the slot's reconstructible projection; the parent
 * side stays in logical terms (it resolves against the logical view). The result is
 * tagged with {@link LENS_BOUNDARY_ATTACHED_TAG} and routed through the basis
 * write's constraint pipeline, where the contained `EXISTS` auto-defers it to commit
 * — matching physical child-side FK gating + timing.
 *
 * Gated by the caller on the `foreign_keys` pragma. Returns `[]` when the slot is
 * un-proved (`obligations` undefined) or carries no FK obligation — the common case.
 */
export function collectLensForeignKeyConstraints(slot: LensSlot, schemaManager: SchemaManager): RowConstraintSchema[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];
	const map = logicalToBasisColumnMap(slot);
	const logicalSchemaName = slot.logicalTable.schemaName;
	const constraints: RowConstraintSchema[] = [];
	for (const obligation of slot.obligations) {
		if (obligation.kind !== 'enforced-fk') continue;
		if (obligation.constraint.kind !== 'foreignKey') continue;
		const fk = obligation.constraint.constraint;
		const referencedSchema = fk.referencedSchema ?? logicalSchemaName;
		const parentColumns = resolveLogicalReferencedColumns(fk, referencedSchema, schemaManager);
		// Parity with the physical child-side builder's count-mismatch guard: if the
		// parent columns cannot be resolved to the same arity as the child columns
		// (an unresolvable parent ⇒ `[]`, or a malformed FK the prover did not catch),
		// skip rather than synthesize an `EXISTS` with `undefined` parent column names.
		if (parentColumns.length !== fk.columns.length) {
			log('lens FK %s: parent column count (%d) != child column count (%d); skipping',
				fk.name ?? '<anon>', parentColumns.length, fk.columns.length);
			continue;
		}
		// Rewrite each FK child column index → logical name → basis column. A column
		// the prover proved reconstructible maps; otherwise it falls back to the logical
		// name (the prover would have errored on a non-reconstructible FK child column).
		const childColumns = fk.columns.map(childIdx => {
			const logicalName = slot.logicalTable.columns[childIdx]?.name ?? `#${childIdx}`;
			return map.get(logicalName.toLowerCase()) ?? logicalName;
		});
		const expr = synthesizeFKExistsExpr(fk.referencedTable, parentColumns, childColumns, 'NEW', referencedSchema);
		constraints.push({
			name: fk.name ? `lens:fk:${fk.name}` : 'lens:fk',
			expr,
			// Child-side FK guards the row being written: insert and update only.
			operations: RowOpFlag.INSERT | RowOpFlag.UPDATE,
			tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
		});
	}
	return constraints;
}

/** The logical key column indices forming a primary-key / unique constraint. */
function setLevelKeyColumns(c: Extract<LogicalConstraint, { kind: 'primaryKey' | 'unique' }>): readonly number[] {
	return c.kind === 'primaryKey' ? c.columns.map(col => col.index) : c.constraint.columns;
}

/** The routed-constraint name for a set-level key (mirrors the FK `lens:fk:<name>` convention). */
function setLevelConstraintName(c: Extract<LogicalConstraint, { kind: 'primaryKey' | 'unique' }>): string {
	if (c.kind === 'primaryKey') return 'lens:pk';
	return c.constraint.name ? `lens:unique:${c.constraint.name}` : 'lens:unique';
}

/**
 * Builds the deferred count-subquery uniqueness predicate for one logical key:
 *
 *   (select count(*) from <logicalSchema>.<logicalTable> as _u
 *      where _u.lk1 = NEW.bk1 and … and _u.lkn = NEW.bkn) <= 1
 *
 * The subquery FROM is the **logical view** (schema-qualified + aliased `_u`), so
 * `_u.<logicalCol>` resolves against the registered logical relation while
 * `NEW.<basisCol>` is the basis write row (a correlated reference resolved from the
 * surrounding constraint scope, exactly as the FK `EXISTS` resolves `NEW.*`). The
 * `count(*)` is a `count` with empty args — `astToString` renders it `count(*)` and
 * the planner treats it as the row-count aggregate. The contained scalar subquery
 * makes the constraint pipeline auto-defer the check to commit. NULL key columns
 * fall out for free: `_u.lk = NEW.bk` is `NULL` (never true) when either side is
 * NULL, so a NULL-key row is never counted — SQL UNIQUE's NULL-distinct rule.
 */
function synthesizeUniqueCountExpr(
	logicalSchema: string,
	logicalTable: string,
	keyColumns: ReadonlyArray<{ logicalColumn: string; basisColumn: string }>,
): AST.Expression {
	const alias = '_u';
	const conditions: AST.Expression[] = keyColumns.map(({ logicalColumn, basisColumn }) => ({
		type: 'binary',
		operator: '=',
		left: { type: 'column', name: logicalColumn, table: alias } as AST.ColumnExpr,
		right: { type: 'column', name: basisColumn, table: 'NEW' } as AST.ColumnExpr,
	} as AST.BinaryExpr));

	const whereExpr = conditions.reduce((acc, cond) => ({
		type: 'binary',
		operator: 'AND',
		left: acc,
		right: cond,
	} as AST.BinaryExpr));

	const subquery: AST.SelectStmt = {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'function', name: 'count', args: [] } as AST.FunctionExpr }],
		from: [{
			type: 'table',
			table: { type: 'identifier', name: logicalTable, schema: logicalSchema },
			alias,
		} as AST.TableSource],
		where: whereExpr,
	};

	return {
		type: 'binary',
		operator: '<=',
		left: { type: 'subquery', query: subquery } as AST.SubqueryExpr,
		right: { type: 'literal', value: 1 } as AST.LiteralExpr,
	} as AST.BinaryExpr;
}

/**
 * Builds the deferred set-level uniqueness CHECK constraints a lens write must
 * enforce (the write side of the prover's `enforced-set-level` `commit-time`
 * obligation). For each commit-time set-level key (no basis covering structure) it
 * synthesizes the count-subquery `<= 1` predicate via {@link synthesizeUniqueCountExpr},
 * with the logical key columns mapped to their basis columns on the `NEW.*` side
 * (via the slot's reconstructible projection) and kept logical inside the subquery
 * (they resolve against the registered logical view). The result is tagged with
 * {@link LENS_BOUNDARY_ATTACHED_TAG} and routed through the basis write's constraint
 * pipeline, where the contained scalar subquery auto-defers it to commit.
 *
 * Only the `commit-time` mode is emitted: a `row-time` key is already enforced by
 * the basis `UNIQUE` it is (by the classifier's precondition) backed by — the
 * single-source re-plan reaches that basis UC, whose covering-MV enforcement path
 * does the O(log n) lookup and honors the conflict action, so no constraint is
 * synthesized here. `proved` / `vacuous` keys need no enforcement. Returns `[]`
 * when the slot is un-proved (`obligations` undefined) or
 * carries no commit-time set-level key — the common case, so a non-lens / plain
 * view / proved-key write pays nothing. DELETE never introduces a duplicate, so the
 * caller restricts this to insert/update.
 */
export function collectLensSetLevelConstraints(slot: LensSlot): RowConstraintSchema[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];
	const map = logicalToBasisColumnMap(slot);
	const logicalSchemaName = slot.logicalTable.schemaName;
	const logicalTableName = slot.logicalTable.name;
	const constraints: RowConstraintSchema[] = [];
	for (const obligation of slot.obligations) {
		if (obligation.kind !== 'enforced-set-level' || obligation.mode !== 'commit-time') continue;
		const c = obligation.constraint;
		if (c.kind !== 'primaryKey' && c.kind !== 'unique') continue;
		const logicalColumns = setLevelKeyColumns(c);
		// The empty (singleton) key classifies `vacuous`, never commit-time set-level;
		// guard defensively so an empty WHERE is never synthesized.
		if (logicalColumns.length === 0) continue;
		// Each logical key column → its basis column for the NEW.* side. A column the
		// prover proved reconstructible maps; otherwise it falls back to the logical
		// name (a non-reconstructible key would have made the table read-only — no
		// write reaches here — but the fallback keeps the synthesis total).
		const keyColumns = logicalColumns.map(li => {
			const logicalColumn = slot.logicalTable.columns[li]?.name ?? `#${li}`;
			return { logicalColumn, basisColumn: map.get(logicalColumn.toLowerCase()) ?? logicalColumn };
		});
		constraints.push({
			name: setLevelConstraintName(c),
			expr: synthesizeUniqueCountExpr(logicalSchemaName, logicalTableName, keyColumns),
			// A duplicate is only introduced by an insert or a key-changing update;
			// a delete cannot create one (and is excluded by the caller anyway).
			operations: RowOpFlag.INSERT | RowOpFlag.UPDATE,
			tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
		});
	}
	return constraints;
}

/**
 * Whether the slot carries any `enforced-set-level` `commit-time` obligation — the
 * detection-only set-level class. The view-mutation builder consults this to reject
 * `or replace` / `or ignore` (and matching upserts), which the commit-time scan
 * cannot honor (row-time conflict resolution needs a covering structure). Returns
 * `false` for a non-lens / plain view / proved- or row-time-keyed slot.
 */
export function hasCommitTimeSetLevelObligation(slot: LensSlot): boolean {
	return (slot.obligations ?? []).some(o => o.kind === 'enforced-set-level' && o.mode === 'commit-time');
}
