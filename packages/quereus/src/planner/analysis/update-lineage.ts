import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import { classifyProjectionExpr, traceInvertibleColumn, composeDomain } from './scalar-invertibility.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import type { Attribute, AttributeDefault, ConstantBinding, ConstantValue, ScalarPlanNode, UpdateSite } from '../nodes/plan-node.js';

/**
 * Update-lineage model — per-output-column provenance back onto base columns,
 * per `docs/view-updateability.md` § The Update Site Model.
 *
 * **Shipped scope (Phase 1).** This is the AST-driven, single-source lineage
 * the view-mutation rewrite consumes: a view body's projection list maps each
 * output column to either a writable base column (`base`) or a read-only
 * computed expression (`computed`). It is the dual of the optimizer's FD walk,
 * restricted to the single-source projection-and-filter shape.
 *
 * The doc additionally describes threading a richer `UpdateSite` /
 * `AttributeDefault` surface through `PhysicalProperties.computePhysical`
 * (so `query_plan()` can surface lineage and so arbitrary operator nesting
 * composes). That plan-node-threaded generalization is the Phase-2 foundation
 * and is intentionally NOT wired here — see the Status note in
 * docs/view-updateability.md.
 */

/** Attribute id — matches the `number` keys used by `attribute-provenance.ts`. */
export type AttributeId = number;

/** Where one view output column traces back to on the base table. */
export type ViewColumnLineage =
	| { readonly kind: 'base'; readonly baseColumnName: string }
	| { readonly kind: 'computed'; readonly expr: AST.Expression };

/** One output column of an updateable view body. */
export interface ViewColumn {
	readonly name: string;
	readonly lineage: ViewColumnLineage;
	/** True when the underlying base column is a generated column. */
	readonly generated: boolean;
}

/**
 * Derive the per-output-column lineage of a single-source projection-and-filter
 * view body from its `SELECT` AST and the resolved base table.
 *
 * - `select *` expands to every base column, each tracing to itself.
 * - a bare/aliased column reference traces to that base column (identity /
 *   rename — the only invertible profile in Phase 1).
 * - any other projection expression is `computed` (read-only).
 *
 * An explicit `CREATE VIEW v(a, b)` column list overrides the output names
 * positionally, leaving the lineage targets unchanged.
 */
export function deriveViewColumns(
	sel: AST.SelectStmt,
	baseTable: TableSchema,
	viewColumnsOverride?: ReadonlyArray<string>,
): ViewColumn[] {
	const columns: ViewColumn[] = [];

	for (const rc of sel.columns) {
		if (rc.type === 'all') {
			for (const col of baseTable.columns) {
				columns.push({
					name: col.name,
					lineage: { kind: 'base', baseColumnName: col.name },
					generated: !!col.generated,
				});
			}
			continue;
		}

		const lineage = classifyProjectionExpr(rc.expr);
		const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : expressionToString(rc.expr));
		if (lineage.kind === 'base') {
			const baseCol = baseTable.columns.find(c => c.name.toLowerCase() === lineage.baseColumnName.toLowerCase());
			columns.push({
				name,
				lineage: { kind: 'base', baseColumnName: baseCol?.name ?? lineage.baseColumnName },
				generated: !!baseCol?.generated,
			});
		} else {
			columns.push({ name, lineage: { kind: 'computed', expr: rc.expr }, generated: false });
		}
	}

	if (viewColumnsOverride && viewColumnsOverride.length > 0) {
		for (let i = 0; i < viewColumnsOverride.length && i < columns.length; i++) {
			columns[i] = { ...columns[i], name: viewColumnsOverride[i] };
		}
	}

	return columns;
}

// ---------------------------------------------------------------------------
// Plan-node-threaded backward walk (the derived dual of the forward FD walk).
//
// These helpers are invoked from each operator's `computePhysical` and READ the
// forward annotation that pass already produced (the node's own `fds` /
// `constantBindings`, the children's `updateLineage`). They never re-derive a
// parallel FD/EC walk — see `docs/view-updateability.md` § Round-Trip Laws and
// the Derived Backward Walk. The result is the `PhysicalProperties.updateLineage`
// / `attributeDefaults` surface the view-mutation orchestrator consumes.
// ---------------------------------------------------------------------------

/** Result of one operator's backward method. */
export interface BackwardLineage {
	readonly updateLineage?: ReadonlyMap<number, UpdateSite>;
	readonly attributeDefaults?: ReadonlyMap<number, AttributeDefault>;
}

/**
 * Compose an outer invertible transform (from `traceInvertibleColumn`) onto a
 * child UpdateSite. For `out = f(child)` where the child traces to base via its
 * own inverse `g⁻¹`, a written `out` binds `base = g⁻¹(f⁻¹(out))` — the child's
 * inverse wraps the outer one; domains conjoin.
 */
function composeUpdateSite(
	child: UpdateSite,
	outerInverse: ((w: AST.Expression) => AST.Expression) | undefined,
	outerDomain: AST.Expression | undefined,
): UpdateSite {
	switch (child.kind) {
		case 'base': {
			const childInv = child.inverse;
			const inverse = childInv && outerInverse
				? (w: AST.Expression) => childInv(outerInverse(w))
				: (childInv ?? outerInverse);
			const domain = composeDomain(child.domain, outerDomain);
			return {
				kind: 'base',
				table: child.table,
				baseColumn: child.baseColumn,
				...(inverse ? { inverse } : {}),
				...(domain ? { domain } : {}),
			};
		}
		case 'computed':
			return child;
		case 'null-extended':
			return { kind: 'null-extended', guard: child.guard, inner: composeUpdateSite(child.inner, outerInverse, outerDomain) };
	}
}

/**
 * Project backward method. For each projection, trace the output back to a base
 * column through the invertible-transform chain (`traceInvertibleColumn`) and
 * compose its `UpdateSite` from the child lineage; a non-invertible / multi-
 * column / leaf-less projection becomes `computed`. Insert defaults carry
 * forward for surviving (traced) columns. Keys thread implicitly: the lineage
 * is keyed by output attribute id and the forward FD walk (already emitted by
 * the caller) carries key-ness along the same projection map.
 */
export function deriveProjectUpdateLineage(
	projections: ReadonlyArray<{ readonly node: ScalarPlanNode }>,
	outputAttrs: readonly Attribute[],
	childLineage: ReadonlyMap<number, UpdateSite> | undefined,
	childDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
): BackwardLineage {
	const lineage = new Map<number, UpdateSite>();
	const defaults = new Map<number, AttributeDefault>();
	projections.forEach((proj, i) => {
		const outId = outputAttrs[i]?.id;
		if (outId === undefined) return;
		const trace = childLineage ? traceInvertibleColumn(proj.node) : null;
		const childSite = trace ? childLineage!.get(trace.attrId) : undefined;
		if (trace && childSite) {
			lineage.set(outId, composeUpdateSite(childSite, trace.inverse, trace.domain));
			const carried = childDefaults?.get(trace.attrId);
			if (carried) defaults.set(outId, carried);
		} else {
			lineage.set(outId, { kind: 'computed', expr: proj.node.expression });
		}
	});
	return {
		updateLineage: lineage.size > 0 ? lineage : undefined,
		attributeDefaults: defaults.size > 0 ? defaults : undefined,
	};
}

/** Build a symbolic default expression from a forward `ConstantBinding` value. */
function constantValueToExpr(value: ConstantValue): AST.Expression {
	if (value.kind === 'literal') return { type: 'literal', value: value.value };
	return typeof value.paramRef === 'number'
		? { type: 'parameter', index: value.paramRef }
		: { type: 'parameter', name: value.paramRef };
}

/**
 * Filter backward method. `updateLineage` passes through unchanged (a filter
 * removes rows, never columns). Insert defaults gain a `constant-fd` entry for
 * every column the forward pass pinned to a constant (`∅ → c = v`), read off the
 * node's already-computed `constantBindings` — NOT a re-scan of the predicate
 * AST. This is the replacement for `building/view-mutation.ts`'s
 * `extractFilterConstants` (deleted by the orchestrator ticket).
 */
export function deriveFilterAttributeDefaults(
	childDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
	outputAttrs: readonly Attribute[],
	constantBindings: ReadonlyArray<ConstantBinding>,
): ReadonlyMap<number, AttributeDefault> | undefined {
	const defaults = new Map<number, AttributeDefault>(childDefaults ?? []);
	for (const binding of constantBindings) {
		const valueExpr = constantValueToExpr(binding.value);
		for (const colIdx of binding.attrs) {
			const attr = outputAttrs[colIdx];
			if (attr) defaults.set(attr.id, { kind: 'constant-fd', value: valueExpr });
		}
	}
	return defaults.size > 0 ? defaults : undefined;
}

/**
 * Join backward method (composition along the forward join FDs). Output
 * attribute ids are preserved per side, so each side's `updateLineage` merges
 * directly; for an outer join the non-preserved side's sites are wrapped
 * `null-extended` under the join predicate as guard (materialization-on-write
 * is a later phase — this only annotates the lineage). `guard` is the join
 * predicate AST; absent for `cross` (which never null-extends).
 */
export function deriveJoinUpdateLineage(
	joinType: string,
	leftLineage: ReadonlyMap<number, UpdateSite> | undefined,
	rightLineage: ReadonlyMap<number, UpdateSite> | undefined,
	leftDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
	rightDefaults: ReadonlyMap<number, AttributeDefault> | undefined,
	guard: AST.Expression | undefined,
): BackwardLineage {
	const lineage = new Map<number, UpdateSite>();
	const defaults = new Map<number, AttributeDefault>();

	const addSide = (
		l: ReadonlyMap<number, UpdateSite> | undefined,
		d: ReadonlyMap<number, AttributeDefault> | undefined,
		nullExtended: boolean,
	): void => {
		if (l) for (const [id, site] of l) {
			lineage.set(id, nullExtended && guard !== undefined ? { kind: 'null-extended', guard, inner: site } : site);
		}
		if (d) for (const [id, def] of d) defaults.set(id, def);
	};

	switch (joinType) {
		case 'inner':
		case 'cross':
			addSide(leftLineage, leftDefaults, false);
			addSide(rightLineage, rightDefaults, false);
			break;
		case 'left':
			addSide(leftLineage, leftDefaults, false);
			addSide(rightLineage, rightDefaults, true);
			break;
		case 'right':
			addSide(leftLineage, leftDefaults, true);
			addSide(rightLineage, rightDefaults, false);
			break;
		case 'full':
			addSide(leftLineage, leftDefaults, true);
			addSide(rightLineage, rightDefaults, true);
			break;
		case 'semi':
		case 'anti':
			// Only the left side's columns appear in the output.
			addSide(leftLineage, leftDefaults, false);
			break;
	}
	return {
		updateLineage: lineage.size > 0 ? lineage : undefined,
		attributeDefaults: defaults.size > 0 ? defaults : undefined,
	};
}

/**
 * The Phase-1 *writable* base column of an UpdateSite: the base column reached
 * by the identity transform (a bare column / rename), else `undefined` (a
 * computed, null-extended, or non-identity-inverse site, which the Phase-1
 * `ViewColumn` model cannot represent as writable). The bridge that keeps the
 * plan-node `updateLineage` and the AST `deriveViewColumns` in agreement on the
 * writable-column set.
 *
 * **Identity-only by design** — this is the *single-source* reader, paired with
 * the identity-only AST classifier (`classifyProjectionExpr`) the single-source
 * mutation spine still consumes; widening it would break that parity
 * (`viewColumnsFromUpdateLineage` ⇄ `deriveViewColumns`). It is therefore NOT the
 * authority for an `inverse` site's writability: the n-way {@link resolveBaseSite}
 * (consumed by the multi-source join path and the decomposition fan-out) and the
 * static `view_info` / `column_info` surfaces (`func/builtins/schema.ts`
 * `baseSiteOf`) treat a `base`
 * site **with an `inverse`** as writable (docs § Scalar Invertibility, § Inner
 * Join). The single-source dynamic path does not yet consume inverses, so this
 * reader's identity-only divergence is the honest single-source reading.
 */
export function identityBaseColumn(site: UpdateSite | undefined): string | undefined {
	return site && site.kind === 'base' && site.inverse === undefined ? site.baseColumn : undefined;
}

/**
 * The base-table site an {@link UpdateSite} resolves to, with the outer-join
 * `null-extended` layer unwrapped so the **owning base relation is always
 * surfaced** (a null-extended column still names the base table its inner site
 * targets, just non-writably). This is the *n-way* backward-site reader the put
 * fan-out consumers share — the generalization of the two single-purpose readers
 * above it: the former multi-source-local identity-or-inverse reader (which
 * discarded the table on null-extension) and the single-source identity-only
 * {@link identityBaseColumn}. One reader, consumed by single-source, the
 * multi-source join walk, and the decomposition fan-out (docs/view-updateability.md
 * § Round-Trip Laws and the Derived Backward Walk).
 *
 * - `base` → `{ table, baseColumn, writable: true, nullExtended: false, inverse?, domain? }`.
 * - `null-extended` → the inner base site, but `writable: false`,
 *   `nullExtended: true` (a write would need materialization of the missing side —
 *   deferred; the decomposition fan-out reports it as an optional-member write).
 * - `computed` / absent → `{ writable: false, nullExtended: false }` (read-only).
 *
 * `writable` is **identity-or-inverse base** (matching the multi-source reader it
 * subsumes). A consumer needing *identity-only* writability (the single-source
 * spine and the decomposition value routing) additionally checks
 * `inverse === undefined`.
 */
export interface ResolvedBaseSite {
	/** Producing `TableReferenceNode` plan-node id, or `undefined` for a `computed` site. */
	readonly table?: number;
	readonly baseColumn?: string;
	readonly writable: boolean;
	readonly nullExtended: boolean;
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	readonly domain?: AST.Expression;
}

export function resolveBaseSite(site: UpdateSite | undefined): ResolvedBaseSite {
	if (!site) return { writable: false, nullExtended: false };
	switch (site.kind) {
		case 'base':
			return { table: site.table, baseColumn: site.baseColumn, writable: true, nullExtended: false, inverse: site.inverse, domain: site.domain };
		case 'null-extended': {
			const inner = resolveBaseSite(site.inner);
			return { ...inner, writable: false, nullExtended: true };
		}
		case 'computed':
			return { writable: false, nullExtended: false };
	}
}

/**
 * Re-express the Phase-1 `ViewColumn[]` surface as a thin reader over a planned
 * node's `updateLineage`, for the single-source case. Identity-base sites map to
 * writable `base` columns; everything else (computed, null-extended, non-
 * identity inverse) maps to `computed`, exactly matching `deriveViewColumns`'s
 * conservative AST classification on the same body. Verified equal in the
 * `bx-roundtrip-law-harness` parity check (`test/property.spec.ts`).
 *
 * `generated` is reported `false` here (the writable set is what callers consume);
 * the AST `deriveViewColumns` remains the authority for the generated-column flag
 * until the orchestrator migrates its call sites to a planned node.
 */
export function viewColumnsFromUpdateLineage(
	outputAttrs: readonly Attribute[],
	updateLineage: ReadonlyMap<number, UpdateSite> | undefined,
	viewColumnsOverride?: ReadonlyArray<string>,
): ViewColumn[] {
	const columns: ViewColumn[] = outputAttrs.map((attr) => {
		const site = updateLineage?.get(attr.id);
		const baseCol = identityBaseColumn(site);
		if (baseCol !== undefined) {
			return { name: attr.name, lineage: { kind: 'base', baseColumnName: baseCol }, generated: false };
		}
		const expr: AST.Expression = site && site.kind === 'computed' ? site.expr : { type: 'column', name: attr.name };
		return { name: attr.name, lineage: { kind: 'computed', expr }, generated: false };
	});
	if (viewColumnsOverride && viewColumnsOverride.length > 0) {
		for (let i = 0; i < viewColumnsOverride.length && i < columns.length; i++) {
			columns[i] = { ...columns[i], name: viewColumnsOverride[i] };
		}
	}
	return columns;
}
