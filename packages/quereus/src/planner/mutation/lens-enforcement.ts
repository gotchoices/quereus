import type * as AST from '../../parser/ast.js';
import type { LensSlot } from '../../schema/lens.js';
import type { RowConstraintSchema } from '../../schema/table.js';
import { RowOpFlag } from '../../schema/table.js';
import { transformExpr } from './single-source.js';

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
 * Set-level (`unique` / primary key) and `enforced-fk` obligations are NOT handled
 * here — they enforce via an existence lookup (covering structure / commit-time
 * `DeltaExecutor` scan), a separate path. `proved` / `vacuous` need no enforcement.
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
