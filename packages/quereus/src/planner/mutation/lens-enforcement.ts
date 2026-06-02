import type * as AST from '../../parser/ast.js';
import type { LensSlot, LogicalConstraint } from '../../schema/lens.js';
import type { RowConstraintSchema, ForeignKeyConstraintSchema, TableSchema } from '../../schema/table.js';
import { RowOpFlag, resolveReferencedColumns } from '../../schema/table.js';
import type { SchemaManager } from '../../schema/manager.js';
import { resolveSlotBasisSource } from '../../schema/lens-prover.js';
import { transformExpr } from './scope-transform.js';
import { synthesizeFKExistsExpr, synthesizeFKNotExistsExpr } from '../building/foreign-key-builder.js';
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
 * Whether the lens body is a faithful, **non-row-reducing** projection of its
 * single basis source — every basis row maps 1:1 to a logical row, so the logical
 * relation's row set equals the basis relation's on any projected column. True iff
 * none of the row-reducing clauses are present. `orderBy` is row-preserving (it
 * reorders, never drops) and is ignored; `from` single-sourcedness is established
 * separately by {@link resolveSlotBasisSource} returning the basis table.
 */
function isNonRowReducingProjection(body: AST.SelectStmt): boolean {
	return body.where === undefined
		&& (body.groupBy === undefined || body.groupBy.length === 0)
		&& body.having === undefined
		&& !body.distinct
		&& body.limit === undefined
		&& body.offset === undefined
		&& body.union === undefined
		&& body.compound === undefined
		&& body.withClause === undefined;
}

/** Encodes a `(childCol, parentCol)` basis index pair as an order-independent set key. */
function pairKey(childCol: number, parentCol: number): string {
	return `${childCol}:${parentCol}`;
}

/**
 * The `(basisChildCol → basisParentCol)` index pair-set of the logical FK, mapped
 * through the child and parent slots' reconstructible projections, or `undefined`
 * when any column is not a plain basis-column projection (a name-only fallback, or
 * an unresolved index) — which disqualifies elision. Implements redundancy
 * conditions (1) and the parent half of (2): every logical FK child column maps
 * with no transform to a `basisChild` column, and every logical referenced column
 * maps with no transform to a `basisParent` column.
 */
function mappedFkBasisPairs(
	slot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	logicalParentColumns: readonly string[],
	basisChild: TableSchema,
	basisParent: TableSchema,
): Set<string> | undefined {
	const childMap = logicalToBasisColumnMap(slot);
	const parentMap = logicalToBasisColumnMap(parentSlot);
	const pairs = new Set<string>();
	for (let i = 0; i < fk.columns.length; i++) {
		const childLogical = slot.logicalTable.columns[fk.columns[i]]?.name;
		if (childLogical === undefined) return undefined;
		const childBasisName = childMap.get(childLogical.toLowerCase());
		if (childBasisName === undefined) return undefined; // name-only fallback ⇒ not value-preserving
		const childBasisCol = basisChild.columnIndexMap.get(childBasisName.toLowerCase());
		if (childBasisCol === undefined) return undefined;

		const parentBasisName = parentMap.get(logicalParentColumns[i].toLowerCase());
		if (parentBasisName === undefined) return undefined; // parent col not a plain projection
		const parentBasisCol = basisParent.columnIndexMap.get(parentBasisName.toLowerCase());
		if (parentBasisCol === undefined) return undefined;

		pairs.add(pairKey(childBasisCol, parentBasisCol));
	}
	return pairs.size > 0 ? pairs : undefined;
}

/**
 * **All** FKs `basisChild` declares whose unordered `(childCol → parentCol)` index
 * pair-set equals `mappedPairs` and that reference `basisParent` (schema + name) —
 * the full match list, not just the first. Implements redundancy condition (2): the
 * basis write's own FK enforcement (`buildChildSideFKChecks` on the child side,
 * `buildParentSideFKChecks` on the parent side) already enforces such an FK, so a
 * matching one subsumes the lens-level check. The comparison is an unordered *set*
 * of index pairs (mirrors `lookupCoveringFK`'s positional `equiMap` reasoning) — a
 * permuted basis FK (same columns, different pairing) yields a different pair-set and
 * must NOT match; a partial FK fails the arity check.
 *
 * Returning *every* match (not the first) is load-bearing for the **parent-side**
 * caller's action gate: a single non-`restrict` matching basis FK means the basis
 * parent write cascades / nulls rather than rejects, so eliding the lens RESTRICT
 * would be unsound even when a *different* matching basis FK is `restrict`. The
 * action-agnostic child-side caller takes `matches[0]`.
 */
function matchingBasisFks(
	basisChild: TableSchema,
	basisParent: TableSchema,
	mappedPairs: ReadonlySet<string>,
): ForeignKeyConstraintSchema[] {
	const matches: ForeignKeyConstraintSchema[] = [];
	for (const bfk of basisChild.foreignKeys ?? []) {
		if (bfk.referencedTable.toLowerCase() !== basisParent.name.toLowerCase()) continue;
		const bfkParentSchema = (bfk.referencedSchema ?? basisChild.schemaName).toLowerCase();
		if (bfkParentSchema !== basisParent.schemaName.toLowerCase()) continue;
		if (bfk.columns.length !== mappedPairs.size) continue;
		let refCols: readonly number[];
		try {
			refCols = resolveReferencedColumns(bfk, basisParent);
		} catch {
			continue;
		}
		if (refCols.length !== bfk.columns.length) continue;
		const bfkPairs = new Set<string>();
		for (let j = 0; j < bfk.columns.length; j++) {
			bfkPairs.add(pairKey(bfk.columns[j], refCols[j]));
		}
		if (bfkPairs.size === mappedPairs.size && [...mappedPairs].every(p => bfkPairs.has(p))) {
			matches.push(bfk);
		}
	}
	return matches;
}

/**
 * The structural core shared by both FK redundancy directions (child-side
 * {@link lensForeignKeyRedundant} and parent-side {@link lensParentSideForeignKeyRedundant})
 * — **structural match only, no action reasoning**. Returns every basis FK that
 * subsumes the lens-level check (`[]` ⇒ none, default to enforce). Three structural
 * conditions, read from the parent→child direction:
 *
 *  1. **Single-source, value-preserving child mapping** + parent half of (2) — every
 *     logical FK child column maps with no transform to a plain `basisChild` column and
 *     every logical referenced column to a plain `basisParent` column ({@link mappedFkBasisPairs}).
 *  2. **Equivalent basis FK** — `basisChild` carries an FK whose unordered index
 *     pair-set equals the mapped one, referencing `basisParent` ({@link matchingBasisFks}).
 *  3. **Faithful non-row-reducing projection** of the slot the subsuming check scans —
 *     `projectionToCheck` selects which: `'parent'` for the child-side check (it scans
 *     the parent), `'child'` for the parent-side check (it scans the child).
 *
 * Any gap returns `[]` ⇒ enforce — a false match silently drops enforcement (a
 * soundness hole), so the bias is hard-coded toward double-enforce.
 */
function basisFksSubsuming(
	childSlot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	logicalParentColumns: readonly string[],
	basisChild: TableSchema,
	basisParent: TableSchema,
	projectionToCheck: 'parent' | 'child',
): ForeignKeyConstraintSchema[] {
	const mappedPairs = mappedFkBasisPairs(childSlot, fk, parentSlot, logicalParentColumns, basisChild, basisParent);
	if (!mappedPairs) return [];
	const projSlot = projectionToCheck === 'parent' ? parentSlot : childSlot;
	if (!isNonRowReducingProjection(projSlot.compiledBody)) return [];
	return matchingBasisFks(basisChild, basisParent, mappedPairs);
}

/**
 * Whether the lens-level child-side FK check for `fk` is **provably** redundant
 * with an equivalent FK the basis child write already enforces via
 * `buildChildSideFKChecks` — so the lens-level `EXISTS` is pure double-enforcement
 * cost (`docs/lens.md` § Constraint Attachment). All three conditions must hold;
 * **any** gap (multi-source child, non-plain mapping, missing/permuted basis FK, no
 * parent lens slot, a parent body that might filter rows) returns `false`, defaulting
 * to enforce — a false `true` would silently drop enforcement (a soundness hole).
 *
 *  1. **Single-source, value-preserving child mapping** — the child slot resolves to
 *     one basis child table and every logical FK child column maps with no transform
 *     to a plain basis child column.
 *  2. **Equivalent basis FK** — `basisChild` carries an FK whose unordered
 *     `(basisChildCol → basisParentCol)` pair-set equals the mapped one, referencing
 *     the basis parent (this also requires every referenced column to map plainly).
 *  3. **Row-set equivalence of the referenced relation** — the logical parent's lens
 *     slot resolves and its compiled body is a faithful, non-row-reducing projection
 *     of the basis parent, so the logical parent's row set ⊇ the basis parent's on the
 *     referenced columns (the basis check therefore implies the lens check).
 *
 * Returns the subsuming basis FK (for the elision log) or `undefined` to enforce.
 */
function lensForeignKeyRedundant(
	slot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	referencedSchema: string,
	logicalParentColumns: readonly string[],
	schemaManager: SchemaManager,
): ForeignKeyConstraintSchema | undefined {
	// (1) single-source child basis table.
	const basisChild = resolveSlotBasisSource(slot, schemaManager);
	if (!basisChild) return undefined;

	// (3) parent lens slot + its single basis source must resolve.
	const parentSlot = schemaManager.getSchema(referencedSchema)?.getLensSlot(fk.referencedTable);
	if (!parentSlot) return undefined;
	const basisParent = resolveSlotBasisSource(parentSlot, schemaManager);
	if (!basisParent) return undefined;

	// Conditions (1)+(2)+(3) via the shared core: the child-side check scans the
	// *parent*, so the parent projection must be non-row-reducing (`'parent'`).
	// Child-side FK enforcement is action-agnostic, so the first match suffices.
	return basisFksSubsuming(slot, fk, parentSlot, logicalParentColumns, basisChild, basisParent, 'parent')[0];
}

/**
 * Whether the lens-level **parent-side** FK check for `fk` (the synthesized `NOT
 * EXISTS` over the logical child) is **provably** redundant with the equivalent
 * parent-side check the re-planned basis parent write already enforces via
 * `buildParentSideFKChecks` — the parent-side dual of {@link lensForeignKeyRedundant},
 * reusing the same structural core ({@link basisFksSubsuming}). Two things differ from
 * the child side:
 *
 *  - **Projection slot.** The parent-side subquery scans the *child*, so condition (3)
 *    (non-row-reducing) applies to the **child** projection (`'child'`). This is a
 *    conservative parity gate: by condition (1) a single-source child already gives
 *    `L ⊆ B` on the FK columns, so the basis check (scanning the superset `B`) would
 *    reject a superset of cases even with a filtered child — but keeping the gate
 *    mirrors the child-side detector exactly and can only *reduce* elision, and
 *    default-to-double-enforce is always sound.
 *  - **Action match (parent-side only).** `buildParentSideFKChecks` emits a check
 *    **only** for a `restrict` basis FK — cascade / set-null / set-default mutate the
 *    children instead of rejecting, so they synthesize no parent-side check. The basis
 *    write therefore subsumes the lens RESTRICT only when the matched basis FK's
 *    op-appropriate action is `restrict`. Because {@link basisFksSubsuming} may return
 *    *several* matching basis FKs, the gate scans **all** of them: if **any** is
 *    non-`restrict` for the op, the basis write would cascade / null rather than reject
 *    ⇒ NOT redundant. (A divergent-action second FK on identical columns referencing
 *    the same parent is pathological, but "any uncertainty defaults to enforce" demands
 *    the defensive scan.) `ForeignKeyAction` has no distinct `'no action'` — NO ACTION
 *    normalizes to the `restrict` default at schema-build time — so "at least as strict
 *    as the lens RESTRICT" reduces to the exact `=== 'restrict'` test, matching the
 *    physical gate verbatim.
 *
 * Every gap returns `undefined` ⇒ enforce; a false "redundant" verdict silently drops
 * a RESTRICT rejection (a soundness hole), so the bias is hard-coded toward
 * double-enforce. Returns the subsuming basis FK (for the elision log) or `undefined`.
 */
function lensParentSideForeignKeyRedundant(
	childSlot: LensSlot,
	fk: ForeignKeyConstraintSchema,
	parentSlot: LensSlot,
	basisParent: TableSchema,
	logicalParentColumns: readonly string[],
	operation: RowOpFlag.DELETE | RowOpFlag.UPDATE,
	schemaManager: SchemaManager,
): ForeignKeyConstraintSchema | undefined {
	const basisChild = resolveSlotBasisSource(childSlot, schemaManager);
	if (!basisChild) return undefined;
	const matches = basisFksSubsuming(childSlot, fk, parentSlot, logicalParentColumns, basisChild, basisParent, 'child');
	if (matches.length === 0) return undefined;
	// Action match: the basis parent-side check fires only for a `restrict` basis FK.
	// If ANY matching basis FK would cascade / null instead of reject, the basis write
	// does not subsume the lens RESTRICT — keep enforcing.
	const actionOf = (m: ForeignKeyConstraintSchema) => operation === RowOpFlag.DELETE ? m.onDelete : m.onUpdate;
	if (!matches.every(m => actionOf(m) === 'restrict')) return undefined;
	return matches[0];
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
 * v1 **double-enforces by design**: the lens check is emitted even when the basis
 * carries the equivalent FK (always sound). The bounded optimization here elides the
 * lens-level check **only when it is provably redundant** with a basis FK the
 * re-planned basis write already enforces (see {@link lensForeignKeyRedundant}) —
 * every uncertain case still double-enforces. Redundancy is decided against the
 * *current* basis FK set (read here, not stored on the obligation) so the elision is
 * exactly as sound as the physical `buildChildSideFKChecks`, which also reads the
 * basis FKs at plan time.
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
		// Elide the lens-level check when the basis child write provably already
		// enforces an equivalent FK (every uncertain case still double-enforces).
		const subsuming = lensForeignKeyRedundant(slot, fk, referencedSchema, parentColumns, schemaManager);
		if (subsuming) {
			log('lens FK %s on %s: elided — provably subsumed by basis FK %s referencing %s (the re-planned basis write enforces it)',
				fk.name ?? '<anon>', slot.logicalTable.name,
				subsuming.name ?? '<anon>', subsuming.referencedTable);
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

/**
 * The parent-side UPDATE short-circuit guard:
 *
 *   ( (OLD.p1 = NEW.p1 and … and OLD.pn = NEW.pn) or <NOT EXISTS over OLD> )
 *
 * Reproduces the physical parent-side UPDATE short-circuit (`emit/constraint-check.ts`
 * skips the `NOT EXISTS` when no referenced parent column changed) — a **correctness**
 * requirement, not just perf: a plain `NOT EXISTS` over OLD values would reject a benign
 * update that does not touch the referenced columns but whose key a child still
 * references. Plain `=` (not a null-safe `IS`) is intentional: every NULL case falls
 * through the guard to the `NOT EXISTS`, which itself passes for a NULL OLD key (MATCH
 * SIMPLE). DELETE never gets this guard — there NEW is all-NULL so `OLD = NEW` is NULL
 * and `NULL or <false NOT EXISTS>` evaluates to NULL, which the deferred-constraint
 * check (`value === false || value === 0`) does not treat as a failure, silently
 * dropping a valid RESTRICT rejection (hence op-specific synthesis).
 */
function buildParentSideUpdateGuard(parentBasisColumns: readonly string[], notExists: AST.Expression): AST.Expression {
	const equalities: AST.Expression[] = parentBasisColumns.map(col => ({
		type: 'binary',
		operator: '=',
		left: { type: 'column', name: col, table: 'OLD' } as AST.ColumnExpr,
		right: { type: 'column', name: col, table: 'NEW' } as AST.ColumnExpr,
	} as AST.BinaryExpr));
	const guard = equalities.reduce((acc, eq) => ({
		type: 'binary',
		operator: 'AND',
		left: acc,
		right: eq,
	} as AST.BinaryExpr));
	return { type: 'binary', operator: 'OR', left: guard, right: notExists } as AST.BinaryExpr;
}

/**
 * Builds the parent-side FK non-existence constraints a lens write through a logical
 * **parent** must enforce — the cross-slot dual of {@link collectLensForeignKeyConstraints}
 * and the lens analogue of `buildParentSideFKChecks`. The physical parent-side builder
 * discovers FKs by scanning declared `TableSchema.foreignKeys` on basis tables; a logical
 * FK lives only on the **child** slot's `enforced-fk` obligation (on no basis table), so
 * this collector walks every schema's lens slots and, for each child slot whose FK
 * references `parentSlot`'s logical table (name + resolved schema, case-insensitive),
 * synthesizes one `NOT EXISTS(SELECT 1 FROM <childLogical> WHERE <child>.<childCol> =
 * OLD.<parentBasisCol> …)` against the schema-qualified logical child relation.
 *
 * The child columns stay **logical** (they resolve against the registered logical child
 * view named in the FROM). The parent's referenced columns are rewritten **logical→basis**
 * via the parent slot's reconstructible projection, because the `OLD.*` / `NEW.*` side is
 * the parent's basis write row. For DELETE the expression is the plain `NOT EXISTS`; for
 * UPDATE it is wrapped in the {@link buildParentSideUpdateGuard} short-circuit. The result
 * is tagged {@link LENS_BOUNDARY_ATTACHED_TAG}, masked to the requested op, and routed
 * through the basis write's constraint pipeline, where the contained `EXISTS` auto-defers
 * it to commit (the accepted v1 timing — identical ABORT outcome, symmetric with the
 * already-shipped child-side).
 *
 * Action gate: only `restrict` (on the op-appropriate `onDelete` / `onUpdate`) emits —
 * **matching `buildParentSideFKChecks` exactly**; CASCADE / SET NULL / SET DEFAULT through
 * the lens are out of scope (backlog). The lens-level check **double-enforces** by default
 * (sound: both the lens-level check and any equivalent basis parent-side check reject the
 * same condition), but is now **elided when provably redundant** with the basis parent
 * write's own `buildParentSideFKChecks` (see {@link lensParentSideForeignKeyRedundant}):
 * a single-source value-preserving child mapping, an equivalent basis FK referencing the
 * basis parent, a faithful non-row-reducing logical-child projection, **and** — the
 * parent-side-only addition the child side does not need — every matching basis FK being
 * `restrict` for the op (a cascade / null basis FK would not reject, so it never subsumes
 * a lens RESTRICT). Any uncertainty defaults to double-enforce.
 *
 * Gated by the caller on the `foreign_keys` pragma (mirroring the child-side). Returns
 * `[]` for a multi-source / decomposition parent (its `OLD.*` is not one basis row — a
 * documented single-source-spine boundary, decided here via {@link resolveSlotBasisSource}),
 * for a non-referenced parent, and for an un-proved slot.
 */
export function collectLensParentSideForeignKeyConstraints(
	parentSlot: LensSlot,
	schemaManager: SchemaManager,
	operation: RowOpFlag.DELETE | RowOpFlag.UPDATE,
): RowConstraintSchema[] {
	// Single-source spine: the parent-side constraint rides the parent's basis base op,
	// so OLD.* / NEW.* must be exactly one basis row. A multi-source / decomposition
	// parent (an opaque or multi-table FROM) routes nothing extra (documented boundary).
	// `basisParent` is also the table the redundancy detector matches basis FKs against.
	const basisParent = resolveSlotBasisSource(parentSlot, schemaManager);
	if (!basisParent) return [];

	const parentMap = logicalToBasisColumnMap(parentSlot);
	const parentLogicalName = parentSlot.logicalTable.name;
	const parentLogicalSchema = parentSlot.logicalTable.schemaName;

	const constraints: RowConstraintSchema[] = [];
	for (const schema of schemaManager._getAllSchemas()) {
		for (const childSlot of schema.getAllLensSlots()) {
			if (!childSlot.obligations || childSlot.obligations.length === 0) continue;
			const childLogicalSchema = childSlot.logicalTable.schemaName;
			for (const obligation of childSlot.obligations) {
				if (obligation.kind !== 'enforced-fk') continue;
				if (obligation.constraint.kind !== 'foreignKey') continue;
				const fk = obligation.constraint.constraint;
				const referencedSchema = fk.referencedSchema ?? childLogicalSchema;
				// This FK must reference *this* parent slot's logical table (name + schema).
				if (fk.referencedTable.toLowerCase() !== parentLogicalName.toLowerCase()) continue;
				if (referencedSchema.toLowerCase() !== parentLogicalSchema.toLowerCase()) continue;
				// Action gate — mirror buildParentSideFKChecks exactly: only RESTRICT
				// synthesizes a parent-side check (cascades handled elsewhere; out of scope here).
				const action = operation === RowOpFlag.DELETE ? fk.onDelete : fk.onUpdate;
				if (action !== 'restrict') continue;
				// Parent referenced columns (logical), rewritten logical→basis through the
				// parent slot's projection for the OLD/NEW correlation side. Parity with the
				// child-side count-mismatch guard: skip a malformed / unresolvable FK rather
				// than synthesize a `NOT EXISTS` with `undefined` parent column names.
				const parentLogicalColumns = resolveLogicalReferencedColumns(fk, referencedSchema, schemaManager);
				if (parentLogicalColumns.length !== fk.columns.length) {
					log('lens parent-side FK %s: parent column count (%d) != child column count (%d); skipping',
						fk.name ?? '<anon>', parentLogicalColumns.length, fk.columns.length);
					continue;
				}
				// Elide the lens-level parent-side check when the re-planned basis parent
				// write provably already enforces an equivalent (RESTRICT) parent-side FK
				// (every uncertain case — including any non-restrict matching basis FK —
				// still double-enforces).
				const subsuming = lensParentSideForeignKeyRedundant(
					childSlot, fk, parentSlot, basisParent, parentLogicalColumns, operation, schemaManager);
				if (subsuming) {
					log('lens parent-side FK %s on %s: elided — provably subsumed by basis FK %s referencing %s (action restrict; the re-planned basis parent write enforces it)',
						fk.name ?? '<anon>', parentSlot.logicalTable.name,
						subsuming.name ?? '<anon>', subsuming.referencedTable);
					continue;
				}
				const parentBasisColumns = parentLogicalColumns.map(name => parentMap.get(name.toLowerCase()) ?? name);
				// Child FK columns stay logical — they resolve against the schema-qualified
				// logical child view named in the NOT EXISTS FROM.
				const childColumns = fk.columns.map(childIdx => childSlot.logicalTable.columns[childIdx]?.name ?? `#${childIdx}`);
				const notExists = synthesizeFKNotExistsExpr(
					childSlot.logicalTable.name,
					childColumns,
					parentBasisColumns,
					'OLD',
					childLogicalSchema,
				);
				const expr = operation === RowOpFlag.DELETE
					? notExists
					: buildParentSideUpdateGuard(parentBasisColumns, notExists);
				constraints.push({
					name: fk.name ? `lens:fk:parent:${fk.name}` : 'lens:fk:parent',
					expr,
					operations: operation,
					tags: { [LENS_BOUNDARY_ATTACHED_TAG]: true },
				});
			}
		}
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
