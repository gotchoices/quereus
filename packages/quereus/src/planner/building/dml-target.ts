import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { MutableViewLike } from '../mutation/single-source.js';
import { raiseMutationDiagnostic } from '../mutation/mutation-diagnostic.js';
import { isRecursiveCte } from './with.js';

/**
 * Resolve a DML target identifier against the statement's own leading WITH clause,
 * returning an ephemeral {@link MutableViewLike} over the named CTE's body — the
 * adapter the view-mutation substrate routes through exactly as for a named view —
 * or `undefined` when the target is not a CTE (a schema table / view / MV, whose
 * dispatch is unchanged).
 *
 * A CTE name **shadows** a same-named schema table / view / MV as a write target,
 * matching read semantics (a CTE shadows a base table in FROM). So the three DML
 * builders call this *ahead* of their `getView` / `getMaintainedTable` /
 * `buildTableReference` dispatch; a match short-circuits to the ephemeral substrate.
 *
 * Behavior:
 *  - No leading WITH, or a schema-qualified target (`main.t` — a CTE is never
 *    schema-qualified) → `undefined` (ordinary schema dispatch).
 *  - Name miss against `withClause.ctes` → `undefined`.
 *  - A genuinely-recursive (self-referential) target → the structured `recursive-cte`
 *    diagnostic (never a generic table-not-found miss). Gated on the actual recursive
 *    shape ({@link isRecursiveCte}), so a `with recursive` clause whose *target* member
 *    is a plain non-self-referential body is still writable.
 *  - Otherwise → an ephemeral view-like over the CTE body.
 *
 * The CTE body itself is re-planned by the substrate against its own base table(s);
 * the caller threads the statement's CTEs into the planning context so any
 * sibling-CTE read in the user `where` / `set` / source resolves.
 */
export function resolveCteTarget(
	ctx: PlanningContext,
	table: AST.IdentifierExpr,
	withClause: AST.WithClause | undefined,
): MutableViewLike | undefined {
	// No leading WITH, or a schema-qualified name (a bare CTE reference can never be
	// schema-qualified): not a CTE target — leave it to the schema lookups.
	if (!withClause || table.schema) return undefined;

	const cte = withClause.ctes.find(c => c.name.toLowerCase() === table.name.toLowerCase());
	if (!cte) return undefined;

	// A recursive (self-referential) CTE has no recoverable single base operation —
	// reject with the structured reason rather than the generic table-not-found miss
	// the schema dispatch would otherwise raise downstream.
	if (isRecursiveCte(withClause.recursive, cte)) {
		raiseMutationDiagnostic({
			reason: 'recursive-cte',
			table: cte.name,
			message: `cannot write through common table expression '${cte.name}': a recursive CTE has no recoverable base operation`,
		});
	}

	return {
		name: cte.name,
		// Cosmetic for an ephemeral target: only lens / dependency lookups read it,
		// and both are suppressed (ephemeral) or return undefined (no schema object).
		// The current schema name keeps any leaked diagnostic readable.
		schemaName: ctx.schemaManager.getCurrentSchemaName(),
		selectAst: cte.query,
		columns: cte.columns,
		ephemeral: true,
		noun: 'common table expression',
	};
}

/**
 * Build an ephemeral {@link MutableViewLike} from an inline parenthesized subquery DML
 * target (`update (select …) as v set …` / `delete from (select …) as v where …`), or
 * `undefined` when the statement carries no `targetSource` (an ordinary named / CTE
 * target — unchanged dispatch). This is the inline-subquery dual of
 * {@link resolveCteTarget}: per docs/view-updateability.md, a subquery in `from` is
 * structurally an inlined CTE, so the body routes through the SAME view-mutation
 * substrate via the same ephemeral adapter.
 *
 *  - `name` is the user's alias `v` — the substrate resolves the user `where`/`set`
 *    column refs (`v.col` and the bare form) against it, exactly as for a named view's
 *    own name.
 *  - `selectAst` is the parenthesized body, re-planned against its own base table(s).
 *  - `columns` carries the optional `as v(a,b)` rename list (the renamed names are what
 *    `where`/`set` reference; the body's own projection names are hidden).
 *
 * A **DML-bodied** inline target (`update (insert … returning …) as v …`) is rejected
 * up front: {@link import('../../parser/parser.js')}'s `subquerySource` admits a
 * RETURNING DML body in a FROM position, but it is not a meaningful *write* target — the
 * body must be a SELECT/VALUES-shaped relation with recoverable base lineage. (A
 * VALUES/`select`-with-no-base body still rejects downstream in `analyzeView`; this
 * guard adds a target-named fast-fail for the DML case.)
 *
 * The caller threads the statement's CTEs into the planning context so a sibling-CTE
 * read in the body / user `where` / `set` resolves. Unlike the CTE-name target, an
 * inline subquery has no own-name to shadow out of its body, so no `cteNodes` deletion
 * is needed.
 */
export function resolveSubqueryTarget(
	ctx: PlanningContext,
	stmt: AST.UpdateStmt | AST.DeleteStmt,
): MutableViewLike | undefined {
	const source = stmt.targetSource;
	if (!source) return undefined;

	const body = source.subquery;
	if (body.type === 'insert' || body.type === 'update' || body.type === 'delete') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: source.alias,
			message: `cannot write through inline subquery target '${source.alias}': a ${body.type.toUpperCase()} body has no recoverable base operation — the write target must be a SELECT-shaped relation`,
		});
	}

	return {
		name: source.alias,
		// Cosmetic for an ephemeral target (see resolveCteTarget): only lens / dependency
		// lookups read it, and both are suppressed (ephemeral) or return undefined.
		schemaName: ctx.schemaManager.getCurrentSchemaName(),
		selectAst: body,
		columns: source.columns,
		ephemeral: true,
		noun: 'derived table',
	};
}

/**
 * The planning context the view-mutation substrate uses for a CTE-name target: the
 * statement's CTE-threaded context with the TARGET CTE's OWN name removed from
 * `cteNodes`.
 *
 * `buildFrom` resolves a FROM name against `cteNodes` *before* the schema, so leaving
 * the target's own name in scope would make its body's same-named FROM source
 * self-resolve to the CTE instead of the real object — silently wrong for the
 * load-bearing shadow case `with base as (select … from base) update base …`, whose
 * body must reach the REAL `base` table. A non-recursive CTE cannot reference itself,
 * so SQL scopes its own name OUT of its body anyway (exactly what
 * {@link import('./with.js').buildCommonTableExpr} does when it builds a body against
 * the PRIOR siblings only) — this mirrors that for the re-planned ephemeral body.
 *
 * SIBLING CTEs stay in scope, so a sibling read in the body or the user predicate /
 * value still resolves. A consequence: a user-predicate self-read of the target name
 * (`… where id in (select id from t)`) does NOT resolve the CTE in v1 — it errors as
 * table-not-found rather than silently producing a Halloween-unsafe plan. See
 * docs/view-updateability.md § CTEs and Subqueries.
 */
export function contextForCteTarget(ctx: PlanningContext, cteName: string): PlanningContext {
	const key = cteName.toLowerCase();
	if (!ctx.cteNodes?.has(key)) return ctx;
	const cteNodes = new Map(ctx.cteNodes);
	cteNodes.delete(key);
	return { ...ctx, cteNodes };
}
