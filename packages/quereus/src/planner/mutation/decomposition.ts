import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableReferenceNode } from '../nodes/reference.js';
import { buildTableReference } from '../building/table.js';
import type { StorageShape, DecompositionMember } from '../../vtab/mapping-advertisement.js';
import type { ScalarType } from '../../common/datatype.js';
import type { TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import type { SqlValue } from '../../common/types.js';
import { PhysicalType } from '../../types/logical-type.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { transformExpr, cloneExpr } from './scope-transform.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';

/**
 * Advertisement-driven **put** fan-out for a logical table backed by an n-way
 * decomposition (columnar split / column-family / EAV), the write dual of the
 * `get` join `schema/lens-compiler.ts` synthesizes (`compileDecompositionBody`).
 * See `docs/lens.md` § The Default Mapper and `docs/view-updateability.md`
 * § Decomposition put fan-out.
 *
 * A decomposition lens is registered as an ordinary view whose `selectAst` is the
 * synthesized `anchor ⋈ members` join, so writing it would otherwise route to the
 * generic two-table-inner-join `multi-source.ts` path — which has the **wrong**
 * semantics for a decomposition (it picks a single delete side, rejects > 2
 * members, and rejects the outer joins optional members ride). `propagate()`
 * intercepts a decomposition body (the slot carries a `primary-storage`
 * advertisement and no override) and routes it here instead.
 *
 * **Scope shipped here (DELETE / UPDATE in this module; INSERT off the envelope
 * built in `building/view-mutation-builder.ts`):**
 *
 * - **DELETE** fans out to *every* member (mandatory, optional, and EAV pivot) so
 *   the logical row ceases to exist across the whole decomposition. Members are
 *   ordered **anchor-last**; each non-anchor member's identifying set is read from
 *   the **anchor alone** (never the full join), so an earlier member's delete can
 *   never shrink a later member's identifying set. This is what keeps the fan-out
 *   sound without the snapshot-consistent multi-member execution substrate.
 * - **UPDATE** routes each assignment to the single **mandatory, non-EAV** member
 *   that backs it, keyed off the anchor the same anchor-last way.
 * - **INSERT** fans out to one insert per member, **anchor first** (FK-order root).
 *   It rides the shared-surrogate mutation envelope `view-mutation-shared-surrogate-insert`
 *   ships (`ViewMutationNode.envelope` + `EnvelopeScanNode`): the user source is
 *   materialized once, a surrogate is minted once per row (`integer-auto`,
 *   per-row/per-statement) and threaded into every member's key column(s), and each
 *   member reads the identical rows back. `logical-tuple` keys thread the supplied
 *   logical PK; no generation. Optional members are inserted only for rows that
 *   supply ≥1 of their columns (a per-row presence filter — the outer-join
 *   semantics the read preserves); EAV pivot members emit one triple insert per
 *   supplied attribute, gated on a non-null value. The plan-agnostic decomposition
 *   is {@link analyzeDecompositionInsert} here; the plan-node build (envelope +
 *   per-member projections) is `buildDecompositionInsert` in the builder, mirroring
 *   the multi-source insert split.
 *
 * **Deferred (raised here with a precise diagnostic), because each rides a
 * substrate that is not yet present:**
 *
 * - A DELETE/UPDATE **WHERE that references a non-anchor member** — needs the
 *   snapshot-consistent multi-member base-op execution the predicate-honest
 *   multi-side fan-out is deferred onto (see `multi-source.ts` § delete + the
 *   `view-mutation-lenient-multiside-delete-fanout` backlog ticket).
 * - **UPDATE of an optional-member / EAV / shared-key column** — an optional or
 *   EAV write transition (null→non-null materializes a member row, non-null→all-null
 *   deletes it) needs per-row insert-or-delete branching inside an update group,
 *   which the static base-op fan-out cannot yet express; a key write is an identity
 *   change.
 * - **non-integer / declared-default surrogate generators** (`uuid7`, `callback`)
 *   — v1 mints `integer-auto` only (mirrors the multi-source surrogate boundary).
 * - **composite shared keys** — v1 threads a single-column key (mirrors the
 *   single-column-PK boundary in `multi-source.ts`).
 */

/** Resolved view of one decomposition for the put fan-out. */
interface DecompShape {
	readonly storage: StorageShape;
	readonly anchor: DecompositionMember;
	/** logical-column-name (lowercased) → its backing expression in the get body. */
	readonly viewColToBaseRef: ReadonlyMap<string, AST.Expression>;
}

/**
 * Decompose a mutation through a decomposition-backed logical table into an
 * ordered `BaseOp[]`. Throws a structured diagnostic for any deferred shape.
 */
export function propagateDecomposition(
	ctx: PlanningContext,
	view: MutableViewLike,
	storage: StorageShape,
	req: MutationRequest,
): BaseOp[] {
	const anchor = storage.members.find(m => m.relationId === storage.anchorRelationId);
	if (!anchor) {
		// Validated at advertisement resolution; defensive.
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through logical table '${view.name}': decomposition anchor '${storage.anchorRelationId}' is not among its members`,
		});
	}
	const shape: DecompShape = { storage, anchor, viewColToBaseRef: buildViewColMap(view) };

	switch (req.op) {
		case 'delete': return decomposeDelete(ctx, view, shape, req.stmt);
		case 'update': return decomposeUpdate(ctx, view, shape, req.stmt);
		case 'insert':
			// INSERT needs the plan-level shared-surrogate envelope (materialized
			// source + per-row mint), which the AST `BaseOp[]` model cannot express,
			// so it is built directly by `building/view-mutation-builder.ts`
			// (`buildDecompositionInsert`, off `analyzeDecompositionInsert` below).
			// `buildViewMutation` routes a decomposition insert there before
			// `propagate` runs, so this case is unreachable on the supported path.
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-insert',
				table: view.name,
				message: `internal: decomposition insert must be built via buildDecompositionInsert, not propagate`,
			});
	}
}

// --- INSERT (shared-surrogate / logical-tuple envelope analysis) ----------

/**
 * One target column of a member insert: its value comes from the materialized
 * envelope (by index) or is a constant literal (the EAV attribute name).
 */
export interface DecompInsertColumn {
	readonly baseColumn: string;
	/** Index into the materialized envelope row supplying the value. */
	readonly envelopeIndex?: number;
	/** Constant value (the EAV attribute literal) when no envelope column supplies it. */
	readonly literal?: SqlValue;
}

/**
 * One base insert a decomposition insert fans out to — one per columnar member,
 * or one per supplied EAV attribute (a triple).
 */
export interface DecompInsertOp {
	readonly table: TableReferenceNode;
	readonly schema: TableSchema;
	readonly columns: readonly DecompInsertColumn[];
	/**
	 * Envelope indices whose non-null presence gates this op per-row: an optional
	 * member inserts only for rows that supply ≥1 of its columns; an EAV triple only
	 * when its value is non-null (the outer-join absence semantics the read
	 * preserves). Empty ⇒ unconditional (mandatory member / singleton).
	 */
	readonly presenceGateIndices: readonly number[];
}

/**
 * The plan-agnostic decomposition of a decomposition INSERT, consumed by
 * `buildDecompositionInsert` (`building/view-mutation-builder.ts`). The **envelope**
 * leading columns are the supplied logical columns (in user-source order),
 * optionally followed by a minted surrogate shared key (`mint`). Each member op
 * reads its values back out of that one materialized envelope, so a generated key
 * is minted once per produced row and threaded across every member insert
 * (docs/view-updateability.md § Mutation Context, docs/lens.md § The Default Mapper).
 */
export interface DecompInsertAnalysis {
	readonly suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[];
	/** Member base inserts, anchor first (then advertisement order). */
	readonly ops: readonly DecompInsertOp[];
	/** Set when the shared key is a surrogate minted at the envelope (`integer-auto`). */
	readonly mint?: {
		readonly seedTable: TableReferenceNode;
		readonly seedColumn: string;
		readonly cadence: 'per-row' | 'per-statement';
	};
}

/** One supplied logical column routed to its backing member. */
interface RoutedInsertColumn {
	/** Lowercased logical column name (for routing / key matching). */
	readonly name: string;
	readonly envelopeIndex: number;
	readonly type: ScalarType;
	/** A direct (identity) column mapping on a member. */
	readonly columnar?: { readonly relationId: string; readonly basisColumn: string };
	/** An EAV pivot member backing this column as a triple. */
	readonly eav?: DecompositionMember;
	/**
	 * The attribute literal to store for an EAV column — the logical column's
	 * **declared** name (case preserved), since the get body matches the pivot's
	 * attribute column against that literal by exact value (it does not case-fold).
	 */
	readonly eavAttribute?: string;
}

/**
 * Decompose an INSERT through a decomposition-backed logical table into the
 * per-member base inserts plus the shared-surrogate envelope they fan out from
 * (anchor first — the FK-order root). Throws a structured diagnostic for any
 * deferred shape (composite/absent key, non-integer surrogate, an uncoverable
 * not-null member column, a computed/unbacked logical column).
 */
export function analyzeDecompositionInsert(
	ctx: PlanningContext,
	view: MutableViewLike,
	storage: StorageShape,
	stmt: AST.InsertStmt,
): DecompInsertAnalysis {
	rejectReturning(view, stmt.returning);

	const anchor = storage.members.find(m => m.relationId === storage.anchorRelationId);
	if (!anchor) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot insert into logical table '${view.name}': decomposition anchor '${storage.anchorRelationId}' is not among its members`,
		});
	}
	const shape: DecompShape = { storage, anchor, viewColToBaseRef: buildViewColMap(view) };

	// Resolve every member's table once (reused for schema lookups + the seed table).
	const memberRefs = new Map<string, TableReferenceNode>();
	for (const m of storage.members) memberRefs.set(m.relationId, resolveMemberTable(ctx, m));

	// Supplied logical columns: the explicit list, or every projected logical column.
	const suppliedNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: [...shape.viewColToBaseRef.keys()];

	// Declared-case logical column names (the get body's projection aliases) — the
	// exact attribute literals an EAV write must store (the read does not case-fold).
	const declaredNames = declaredColumnNames(view);

	const routed = suppliedNames.map((raw, idx): RoutedInsertColumn =>
		routeInsertColumn(view, shape, memberRefs, declaredNames, raw, idx));

	// Shared key: a surrogate is minted at the envelope; a logical-tuple threads the
	// supplied logical PK. `keyEnvelopeIndex` is the envelope column every member's
	// key column reads (the minted column for a surrogate, the supplied PK column for
	// a logical-tuple, or undefined for the singleton empty key).
	const { keyEnvelopeIndex, mint } = resolveInsertSharedKey(view, shape, memberRefs, routed);

	// Member ops, anchor first (FK-order root: members may FK-reference the anchor).
	const ops: DecompInsertOp[] = [];
	emitMemberInsert(view, shape, memberRefs, routed, keyEnvelopeIndex, anchor, ops);
	for (const member of storage.members) {
		if (member.relationId === anchor.relationId) continue;
		emitMemberInsert(view, shape, memberRefs, routed, keyEnvelopeIndex, member, ops);
	}

	return {
		suppliedColumns: routed.map(r => ({ name: r.name, type: r.type })),
		ops,
		mint,
	};
}

/** Route one supplied logical column to a columnar member mapping or an EAV pivot. */
function routeInsertColumn(
	view: MutableViewLike,
	shape: DecompShape,
	memberRefs: ReadonlyMap<string, TableReferenceNode>,
	declaredNames: ReadonlyMap<string, string>,
	rawName: string,
	idx: number,
): RoutedInsertColumn {
	const name = rawName.toLowerCase();

	// Columnar: a direct (identity) `member.columns` mapping.
	for (const member of shape.storage.members) {
		const mapping = member.columns.find(c => c.logicalColumn.toLowerCase() === name);
		if (!mapping) continue;
		if (mapping.basisExpr.type !== 'column') {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: rawName,
				table: view.name,
				message: `cannot insert into logical table '${view.name}': column '${rawName}' is a computed (non-invertible) decomposition mapping and cannot receive an inserted value`,
			});
		}
		const ref = memberRefs.get(member.relationId)!;
		const basisColumn = (mapping.basisExpr as AST.ColumnExpr).name;
		const col = columnByName(view, ref.tableSchema, basisColumn);
		return { name, envelopeIndex: idx, type: columnScalarType(col), columnar: { relationId: member.relationId, basisColumn } };
	}

	// EAV: a logical column the get body projects as a non-column expression (the
	// correlated triple subquery) + a sole pivot member ⇒ an attribute write.
	const projected = shape.viewColToBaseRef.get(name);
	if (projected && projected.type !== 'column') {
		const eav = shape.storage.members.find(m => m.attributePivot);
		if (eav) {
			const ref = memberRefs.get(eav.relationId)!;
			const valCol = columnByName(view, ref.tableSchema, eav.attributePivot!.valueColumn);
			return { name, envelopeIndex: idx, type: columnScalarType(valCol), eav, eavAttribute: declaredNames.get(name) ?? rawName };
		}
	}

	raiseMutationDiagnostic({
		reason: 'no-inverse',
		column: rawName,
		table: view.name,
		message: `cannot insert into logical table '${view.name}': column '${rawName}' is not backed by any decomposition member`,
	});
}

/** Resolve the shared key envelope index + optional surrogate mint for an insert. */
function resolveInsertSharedKey(
	view: MutableViewLike,
	shape: DecompShape,
	memberRefs: ReadonlyMap<string, TableReferenceNode>,
	routed: readonly RoutedInsertColumn[],
): { keyEnvelopeIndex: number | undefined; mint: DecompInsertAnalysis['mint'] } {
	const sharedKey = shape.storage.sharedKey;
	const anchor = shape.anchor;

	if (sharedKey.kind === 'surrogate') {
		const generator = sharedKey.generator; // resolver guarantees presence
		if (!generator || generator.strategy !== 'integer-auto') {
			raiseMutationDiagnostic({
				reason: 'no-default',
				table: view.name,
				message: `cannot insert into logical table '${view.name}': the decomposition shares a '${generator?.strategy ?? 'missing'}' surrogate generator; v1 mints only an 'integer-auto' surrogate (non-integer / declared-default generators are deferred — supply the key as a logical column instead)`,
			});
		}
		const anchorKeys = memberKeyColumns(view, shape, anchor);
		if (anchorKeys.length !== 1) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-key',
				table: view.name,
				message: `cannot insert into logical table '${view.name}': a surrogate decomposition needs a single-column key on the anchor '${anchor.relationId}' (v1 mints a single-column surrogate)`,
			});
		}
		const anchorRef = memberRefs.get(anchor.relationId)!;
		requireIntegerSurrogate(view, anchorRef.tableSchema, columnByName(view, anchorRef.tableSchema, anchorKeys[0]));
		return {
			keyEnvelopeIndex: routed.length, // the minted column is appended last
			mint: { seedTable: anchorRef, seedColumn: anchorKeys[0], cadence: generator.cadence },
		};
	}

	// logical-tuple: the supplied logical PK threads to every member's key column.
	const anchorKeys = memberKeyColumns(view, shape, anchor);
	if (anchorKeys.length === 0) {
		return { keyEnvelopeIndex: undefined, mint: undefined }; // singleton — no key to thread
	}
	const anchorKeyCol = anchorKeys[0].toLowerCase();
	const keyRouted = routed.find(r => r.columnar
		&& r.columnar.relationId === anchor.relationId
		&& r.columnar.basisColumn.toLowerCase() === anchorKeyCol);
	if (!keyRouted) {
		raiseMutationDiagnostic({
			reason: 'no-default',
			table: view.name,
			message: `cannot insert into logical table '${view.name}': the logical-tuple shared key (anchor '${anchor.relationId}' column '${anchorKeys[0]}') is not supplied through the logical table; a logical-tuple key has no generator, so it must be provided`,
		});
	}
	return { keyEnvelopeIndex: keyRouted.envelopeIndex, mint: undefined };
}

/** Emit the base insert op(s) for one member (one columnar op, or one triple per supplied EAV attribute). */
function emitMemberInsert(
	view: MutableViewLike,
	shape: DecompShape,
	memberRefs: ReadonlyMap<string, TableReferenceNode>,
	routed: readonly RoutedInsertColumn[],
	keyEnvelopeIndex: number | undefined,
	member: DecompositionMember,
	ops: DecompInsertOp[],
): void {
	const ref = memberRefs.get(member.relationId)!;
	const schema = ref.tableSchema;

	if (member.attributePivot) {
		// EAV pivot: one triple insert per supplied attribute, gated on a non-null value.
		const pivot = member.attributePivot;
		for (const r of routed) {
			if (r.eav?.relationId !== member.relationId) continue;
			const columns: DecompInsertColumn[] = [
				{ baseColumn: pivot.entityColumn, envelopeIndex: requireKeyIndex(view, member, keyEnvelopeIndex) },
				{ baseColumn: pivot.attributeColumn, literal: r.eavAttribute ?? r.name },
				{ baseColumn: pivot.valueColumn, envelopeIndex: r.envelopeIndex },
			];
			assertNoMissingNotNull(view, schema, columns);
			ops.push({ table: ref, schema, columns, presenceGateIndices: [r.envelopeIndex] });
		}
		return;
	}

	const ownedSupplied = routed.filter(r => r.columnar?.relationId === member.relationId);
	// An optional member with no supplied columns materializes no row (the read's
	// outer join already yields null for an absent component).
	if (member.presence === 'optional' && ownedSupplied.length === 0) return;

	const memberKeys = memberKeyColumns(view, shape, member);
	const columns: DecompInsertColumn[] = [];
	if (memberKeys.length === 1) {
		columns.push({ baseColumn: memberKeys[0], envelopeIndex: requireKeyIndex(view, member, keyEnvelopeIndex) });
	}
	const keyColLower = memberKeys[0]?.toLowerCase();
	for (const r of ownedSupplied) {
		// The anchor's own key column is already threaded above; don't double-insert it.
		if (keyColLower && r.columnar!.basisColumn.toLowerCase() === keyColLower) continue;
		columns.push({ baseColumn: r.columnar!.basisColumn, envelopeIndex: r.envelopeIndex });
	}
	assertNoMissingNotNull(view, schema, columns);

	// Optional members are gated per-row on supplying ≥1 of their (non-key) values.
	const gate = member.presence === 'optional'
		? ownedSupplied.filter(r => r.columnar!.basisColumn.toLowerCase() !== keyColLower).map(r => r.envelopeIndex)
		: [];
	ops.push({ table: ref, schema, columns, presenceGateIndices: gate });
}

/** The shared-key columns for a member (0 for a singleton; >1 is a deferred composite key). */
function memberKeyColumns(view: MutableViewLike, shape: DecompShape, member: DecompositionMember): string[] {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
	if (keys.length > 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-key',
			table: view.name,
			message: `cannot write through a decomposition with a composite shared key on member '${member.relationId}': v1 fan-out threads a single-column key`,
		});
	}
	return [...keys];
}

/** A member needs a shared key value to thread, but the decomposition's key is empty (singleton). */
function requireKeyIndex(view: MutableViewLike, member: DecompositionMember, keyEnvelopeIndex: number | undefined): number {
	if (keyEnvelopeIndex === undefined) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-key',
			table: view.name,
			message: `cannot insert into logical table '${view.name}': member '${member.relationId}' needs a shared key value to thread, but the decomposition has an empty (singleton) key`,
		});
	}
	return keyEnvelopeIndex;
}

/** Reject a not-null base column with no declared default that no envelope value covers. */
function assertNoMissingNotNull(view: MutableViewLike, schema: TableSchema, columns: readonly DecompInsertColumn[]): void {
	const covered = new Set(columns.map(c => c.baseColumn.toLowerCase()));
	for (const col of schema.columns) {
		if (col.generated || !col.notNull || col.defaultValue !== null) continue;
		if (covered.has(col.name.toLowerCase())) continue;
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: col.name,
			table: view.name,
			message: `cannot insert into logical table '${view.name}': basis relation '${schema.name}' column '${col.name}' is NOT NULL with no default and no value reaches it through the decomposition`,
		});
	}
}

/** The surrogate generator (`integer-auto`) mints integers — reject a non-integer key. */
function requireIntegerSurrogate(view: MutableViewLike, schema: TableSchema, keyCol: ColumnSchema): void {
	if (keyCol.logicalType.physicalType !== PhysicalType.INTEGER) {
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: keyCol.name,
			table: view.name,
			message: `cannot insert into logical table '${view.name}': the surrogate shared key '${schema.name}.${keyCol.name}' is not an integer the engine can auto-generate (non-integer surrogates are deferred)`,
		});
	}
}

function columnByName(view: MutableViewLike, schema: TableSchema, name: string): ColumnSchema {
	const col = schema.columns.find(c => c.name.toLowerCase() === name.toLowerCase());
	if (!col) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			column: name,
			message: `cannot write through logical table '${view.name}': column '${name}' not found on basis relation '${schema.name}'`,
		});
	}
	return col;
}

function columnScalarType(col: ColumnSchema): ScalarType {
	return { typeClass: 'scalar', logicalType: col.logicalType, nullable: !col.notNull, isReadOnly: false };
}

/**
 * Map each logical column's lowercased name → its **declared** name, read off the
 * get body's projection aliases (`<expr> as <col.name>`). The declared name is the
 * exact attribute literal `compileDecompositionBody` matches an EAV column against,
 * so an EAV write must store that spelling (the read does not case-fold).
 */
function declaredColumnNames(view: MutableViewLike): Map<string, string> {
	const map = new Map<string, string>();
	const sel = view.selectAst;
	if (sel.type !== 'select') return map;
	for (const rc of sel.columns) {
		if (rc.type !== 'column') continue;
		const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined);
		if (name) map.set(name.toLowerCase(), name);
	}
	return map;
}

// --- DELETE ---------------------------------------------------------------

/**
 * Fan a logical delete out to every member. Order anchor-last; each non-anchor
 * member's identifying set is `select <anchorKey> from <anchor> where <pred>`, so
 * deleting other members never changes it. The anchor's own delete then applies
 * the predicate directly against the anchor (its IN subquery would self-reference
 * the rows it removes, so the bare-predicate form is both simpler and clearer).
 */
function decomposeDelete(ctx: PlanningContext, view: MutableViewLike, shape: DecompShape, stmt: AST.DeleteStmt): BaseOp[] {
	rejectReturning(view, stmt.returning);
	const pred = anchorPredicate(view, shape, stmt.where);

	const ops: BaseOp[] = [];
	// Non-anchor members first (each reads the still-intact anchor), anchor last.
	for (const member of shape.storage.members) {
		if (member.relationId === shape.anchor.relationId) continue;
		ops.push(memberDeleteOp(ctx, view, shape, member, pred, stmt));
	}
	ops.push(anchorDeleteOp(ctx, view, shape, pred, stmt));
	return ops;
}

/**
 * One member's delete. No predicate ⇒ an unconditional `delete from <member>`
 * (truncate the component — also the sound singleton path, which has no key to
 * thread). With an anchor predicate ⇒ `delete from <member> where
 * <memberKeyOrEntity> in (select <anchorKey> from <anchor> where <pred>)`.
 */
function memberDeleteOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	pred: AST.Expression | undefined,
	stmt: AST.DeleteStmt,
): BaseOp {
	let where: AST.Expression | undefined;
	if (pred) {
		const memberCol = member.attributePivot
			? member.attributePivot.entityColumn // EAV: delete every triple for the matched entities
			: singleKeyColumn(view, shape, member);
		where = { type: 'in', expr: { type: 'column', name: memberCol }, subquery: anchorKeySubquery(shape, pred) };
	}
	const statement: AST.DeleteStmt = {
		type: 'delete',
		table: memberIdentifier(member),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, member), op: 'delete', statement };
}

/** `delete from <anchor> [where <pred bare>]`. */
function anchorDeleteOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	pred: AST.Expression | undefined,
	stmt: AST.DeleteStmt,
): BaseOp {
	const statement: AST.DeleteStmt = {
		type: 'delete',
		table: memberIdentifier(shape.anchor),
		where: pred ? stripAnchorQualifier(pred, shape) : undefined,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, shape.anchor), op: 'delete', statement };
}

// --- UPDATE ---------------------------------------------------------------

/**
 * Route each assignment to the mandatory, non-EAV member that backs it and emit
 * one per-member UPDATE, anchor-last (so a member whose column the predicate reads
 * is not mutated before a sibling's identifying set is computed). Optional / EAV /
 * key / computed targets and cross-member value references are deferred or rejected.
 */
function decomposeUpdate(ctx: PlanningContext, view: MutableViewLike, shape: DecompShape, stmt: AST.UpdateStmt): BaseOp[] {
	rejectReturning(view, stmt.returning);
	const pred = anchorPredicate(view, shape, stmt.where);

	// member relationId → its routed (basisColumn, value) assignments.
	const perMember = new Map<string, Array<{ column: string; value: AST.Expression }>>();
	for (const asg of stmt.assignments) {
		const routed = routeAssignment(view, shape, asg);
		let list = perMember.get(routed.relationId);
		if (!list) { list = []; perMember.set(routed.relationId, list); }
		list.push({ column: routed.basisColumn, value: routed.value });
	}

	const ops: BaseOp[] = [];
	const emit = (member: DecompositionMember): void => {
		const assignments = perMember.get(member.relationId);
		if (!assignments || assignments.length === 0) return;
		ops.push(memberUpdateOp(ctx, view, shape, member, assignments, pred, stmt));
	};
	for (const member of shape.storage.members) {
		if (member.relationId === shape.anchor.relationId) continue;
		emit(member);
	}
	emit(shape.anchor); // anchor last
	return ops;
}

interface RoutedAssignment {
	readonly relationId: string;
	readonly basisColumn: string;
	readonly value: AST.Expression;
}

/** Resolve one `set <col> = <value>` to its backing member + basis column. */
function routeAssignment(view: MutableViewLike, shape: DecompShape, asg: AST.UpdateStmt['assignments'][number]): RoutedAssignment {
	const logical = asg.column.toLowerCase();
	if (isSharedKeyColumn(shape, logical)) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-update',
			column: asg.column,
			table: view.name,
			message: `cannot update logical table '${view.name}': column '${asg.column}' is part of the decomposition shared key; an identity change is not a value write`,
		});
	}
	for (const member of shape.storage.members) {
		const mapping = member.columns.find(c => c.logicalColumn.toLowerCase() === logical);
		if (!mapping) continue;
		if (member.presence !== 'mandatory' || member.attributePivot) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-update',
				column: asg.column,
				table: view.name,
				message: `cannot update logical table '${view.name}': column '${asg.column}' is backed by ${member.attributePivot ? 'an EAV pivot' : 'an optional'} member ('${member.relationId}'); materializing/removing that component row needs the insert/delete fan-out (deferred)`,
			});
		}
		if (mapping.basisExpr.type !== 'column') {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: asg.column,
				table: view.name,
				message: `cannot update logical table '${view.name}': column '${asg.column}' is a computed (non-invertible) decomposition mapping and is read-only`,
			});
		}
		return { relationId: member.relationId, basisColumn: mapping.basisExpr.name, value: rewriteAssignedValue(view, shape, member, asg.value) };
	}
	// An EAV pivot member backs its logical columns as attribute *rows*, not via
	// `member.columns` (the get body projects them as correlated scalar subqueries,
	// not join columns), so the loop above never matches them. Detect that here off
	// the projection map: a logical column the get body projects as a non-column
	// expression is EAV-served (writing it is an insert-or-delete of a triple — the
	// deferred component fan-out), whereas a column the body never projects is a
	// name that is simply not part of the decomposition.
	const projected = shape.viewColToBaseRef.get(logical);
	if (projected && projected.type !== 'column') {
		const eav = shape.storage.members.find(m => m.attributePivot);
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-update',
			column: asg.column,
			table: view.name,
			message: `cannot update logical table '${view.name}': column '${asg.column}' is backed by ${eav ? `an EAV pivot member ('${eav.relationId}')` : 'a computed projection'}; materializing/removing that component needs the insert/delete fan-out (deferred)`,
		});
	}
	raiseMutationDiagnostic({
		reason: 'no-inverse',
		column: asg.column,
		table: view.name,
		message: `cannot update logical table '${view.name}': column '${asg.column}' is not backed by any decomposition member`,
	});
}

/** `update <member> set <cols> where <memberKey> in (select <anchorKey> from <anchor> where <pred>)`. */
function memberUpdateOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	assignments: ReadonlyArray<{ column: string; value: AST.Expression }>,
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
): BaseOp {
	const memberKey = singleKeyColumn(view, shape, member);
	const where: AST.InExpr = {
		type: 'in',
		expr: { type: 'column', name: memberKey },
		subquery: anchorKeySubquery(shape, pred),
	};
	const statement: AST.UpdateStmt = {
		type: 'update',
		table: memberIdentifier(member),
		assignments: assignments.map(a => ({ column: a.column, value: a.value })),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, member), op: 'update', statement };
}

/**
 * Rewrite an assigned value from logical terms into the owning member's base
 * terms, then strip the member's own alias qualifier (the per-member UPDATE
 * targets that table directly). A reference to a *different* member is a
 * cross-source assignment a single-table SET cannot express — rejected.
 */
function rewriteAssignedValue(view: MutableViewLike, shape: DecompShape, owner: DecompositionMember, value: AST.Expression): AST.Expression {
	const base = substituteViewColumns(value, shape, view);
	return transformExpr(base, (col) => {
		if (!col.table) return undefined;
		if (col.table === owner.relationId) return { type: 'column', name: col.name };
		raiseMutationDiagnostic({
			reason: 'cross-source-assignment',
			column: col.name,
			table: view.name,
			message: `cannot update logical table '${view.name}': an update value references column '${col.name}' on decomposition member '${col.table}', a different member than the column it assigns; cross-member assignment is not supported`,
		});
	});
}

// --- predicate / subquery construction ------------------------------------

/**
 * The user WHERE rewritten from logical columns into the get body's base terms,
 * validated to reference **only the anchor** (so each member's identifying set
 * can be read from the anchor alone — see the file header). A predicate touching
 * a non-anchor member is deferred onto the snapshot-consistent substrate.
 */
function anchorPredicate(view: MutableViewLike, shape: DecompShape, where: AST.Expression | undefined): AST.Expression | undefined {
	if (!where) return undefined;
	const base = substituteViewColumns(where, shape, view);
	const refs = collectColumnQualifiers(base);
	if (refs.hasSubquery || [...refs.tables].some(t => t !== shape.anchor.relationId)) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-predicate',
			table: view.name,
			message: `cannot write through logical table '${view.name}': the WHERE references a non-anchor decomposition member; a predicate-honest multi-member fan-out needs snapshot-consistent base-op execution (deferred — filter only on the anchor / shared key, or pin the rows via the anchor)`,
		});
	}
	return base;
}

/** `select <anchorKey> from <anchorTable> <anchorAlias> [where <pred>]` — the shared identifying set. */
function anchorKeySubquery(shape: DecompShape, pred: AST.Expression | undefined): AST.SelectStmt {
	const anchorKey = singleKeyColumn(undefined, shape, shape.anchor);
	return {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } }],
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where: pred ? cloneExpr(pred) : undefined,
	};
}

/**
 * Substitute references to logical columns (unqualified, or qualified by the
 * logical table's own name) with their backing get-body expression. Base-member-
 * qualified references are left untouched.
 */
function substituteViewColumns(expr: AST.Expression, shape: DecompShape, view: MutableViewLike): AST.Expression {
	const viewName = view.name.toLowerCase();
	return transformExpr(expr, (col) => {
		if (col.table && col.table.toLowerCase() !== viewName) return undefined;
		const repl = shape.viewColToBaseRef.get(col.name.toLowerCase());
		return repl ? cloneExpr(repl) : undefined;
	});
}

/** Strip the anchor's alias qualifier so a predicate targets the bare anchor UPDATE/DELETE. */
function stripAnchorQualifier(expr: AST.Expression, shape: DecompShape): AST.Expression {
	return transformExpr(expr, (col) => (col.table === shape.anchor.relationId ? { type: 'column', name: col.name } : undefined));
}

// --- shape helpers --------------------------------------------------------

/**
 * logical-column → backing get-body expression, read off the synthesized body's
 * projection (`<backingExpr> as <logicalColumn>`). This is the exact inverse of
 * the projection `compileDecompositionBody` emitted, so a user predicate over a
 * logical column maps to the same base term the read uses.
 */
function buildViewColMap(view: MutableViewLike): Map<string, AST.Expression> {
	const map = new Map<string, AST.Expression>();
	const sel = view.selectAst;
	if (sel.type !== 'select') return map;
	for (const rc of sel.columns) {
		if (rc.type !== 'column') continue;
		const name = (rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined));
		if (name) map.set(name.toLowerCase(), rc.expr);
	}
	return map;
}

/** True when `logical` (lowercased) is one of the anchor's shared-key columns. */
function isSharedKeyColumn(shape: DecompShape, logical: string): boolean {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(shape.anchor.relationId) ?? [];
	return keys.some(k => k.toLowerCase() === logical);
}

/**
 * The single shared-key column for a member. v1 threads a single-column key
 * (mirrors `multi-source.ts`' single-column-PK boundary); a composite/absent key
 * is deferred. `view` is optional purely so the deferral message can name the
 * logical table (the anchor-subquery call site has none in scope).
 */
function singleKeyColumn(view: MutableViewLike | undefined, shape: DecompShape, member: DecompositionMember): string {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
	if (keys.length !== 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-key',
			table: view?.name,
			message: `cannot write through a decomposition with a ${keys.length === 0 ? 'missing' : 'composite'} shared key on member '${member.relationId}': v1 fan-out threads a single-column key`,
		});
	}
	return keys[0];
}

function memberIdentifier(member: DecompositionMember): AST.IdentifierExpr {
	return { type: 'identifier', name: member.relation.table, schema: member.relation.schema };
}

function memberIdentifierSource(member: DecompositionMember): AST.TableSource {
	return { type: 'table', table: memberIdentifier(member) };
}

function resolveMemberTable(ctx: PlanningContext, member: DecompositionMember): TableReferenceNode {
	return buildTableReference(memberIdentifierSource(member), ctx).tableRef;
}

/** Collect the member aliases (`ColumnExpr.table`) a mapped predicate references, and whether it holds a subquery. */
function collectColumnQualifiers(expr: AST.Expression): { tables: Set<string>; hasSubquery: boolean } {
	const tables = new Set<string>();
	let hasSubquery = false;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) { node.forEach(walk); return; }
		if (!node || typeof node !== 'object' || !('type' in (node as object))) return;
		const n = node as Record<string, unknown> & { type: string };
		if (n.type === 'column') {
			if (typeof n.table === 'string') tables.add(n.table);
			return;
		}
		if (n.type === 'subquery' || n.type === 'select' || n.type === 'exists') { hasSubquery = true; return; }
		for (const v of Object.values(n)) walk(v);
	};
	walk(expr);
	return { tables, hasSubquery };
}

function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `RETURNING through logical table '${view.name}' is not yet supported`,
		});
	}
}
