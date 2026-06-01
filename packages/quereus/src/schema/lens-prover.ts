import type { Database } from '../core/database.js';
import type { TableSchema, UniqueConstraintSchema } from './table.js';
import type { LensSlot, LogicalConstraint } from './lens.js';
import type * as AST from '../parser/ast.js';
import type { FunctionalDependency, GuardClause, GuardPredicate, RelationalPlanNode } from '../planner/nodes/plan-node.js';
import { addFd, superkeyToFd } from '../planner/util/fd-utils.js';
import { proveEffectiveKeyUnique } from '../planner/analysis/coverage-prover.js';
import { astToString } from '../emit/ast-stringify.js';
import { PhysicalType } from '../types/logical-type.js';
import { getReservedTagByTemplate } from './reserved-tags.js';
import type { AcknowledgedAdvisory } from './lens-ack.js';
import { createLogger } from '../common/logger.js';
import { ConflictResolution } from '../common/constants.js';

const log = createLogger('schema:lens-prover');

/**
 * Lens prover — proves each logical table's compiled body realizes its logical
 * spec, and classifies how every logical constraint becomes real at the lens
 * boundary. It is the second half of "validate, generate, attach": the foundation
 * generated the effective body; this proves it sound and decides the obligation
 * for each constraint.
 *
 * The prover is a **consumer** of the shipped inference surface — it applies
 * `proveEffectiveKeyUnique` (`planner/analysis/coverage-prover.ts`) and the
 * derived FD/key facts read off the optimized body; it derives no new inference.
 * What it cannot prove, it reports — it never silently assumes coverage.
 *
 * Two outputs per slot ({@link LensProveResult}):
 *  - **diagnostics** — five errors (any one blocks the deploy) + four
 *    warning-severity diagnostics that flow to the deploy report: three pure
 *    advisories (no-backing-index / no-answering-structure / partial-override)
 *    plus the read-only verdict (`pk-not-reconstructible`). See `docs/lens.md`
 *    § Coverage checklist.
 *  - **obligations + readOnly** — per-constraint enforcement classification and
 *    the writable-or-read-only verdict, recorded on the {@link LensSlot}. The
 *    *live* per-write enforcement wiring (`lens-constraint-enforcement-wiring`)
 *    consumes these: the row-local check pipeline, the child-side FK existence
 *    check, and the set-level commit-time uniqueness scan are shipped
 *    (`planner/mutation/lens-enforcement.ts` — the `enforced-fk` obligation is a
 *    deferred basis-term `EXISTS` against the logical parent gated by the
 *    `foreign_keys` pragma; the `enforced-set-level` `commit-time` obligation is a
 *    deferred `(select count(*) … ) <= 1` count-subquery CHECK over the logical key,
 *    detection-only — `or replace`/`or ignore` against such a key is rejected). The
 *    `enforced-set-level` `row-time` write path (covering structure, conflict-
 *    resolution-capable) is **delivered** with no dedicated lens code: by this
 *    classifier's own precondition a row-time key is backed by a matching basis
 *    `UNIQUE` + non-stale covering MV, and the single-source re-plan reaches that
 *    basis UC, whose physical enforcement-through-covering-MV path does the
 *    O(log n) lookup and honors `ABORT`/`IGNORE`/`REPLACE` for free. This module
 *    proves, classifies, and blocks/advises.
 *
 * Soundness over completeness: a false error blocks a sound deploy, so every
 * check is conservative — when a fact cannot be established (e.g. the body fails
 * to plan, a multi-source covering lookup), the prover degrades to the
 * *safe* verdict (no spurious error; default a set-level constraint to the
 * commit-time scan and warn) rather than guessing.
 */

/**
 * Error-severity diagnostic codes — already hard errors that block the deploy
 * before ack/escalation governance runs, so they are *not* valid escalation
 * policy targets (see `docs/lens.md` § Coverage checklist).
 */
export type LensErrorCode =
	| 'lens.uncovered-column'
	| 'lens.type-mismatch'
	| 'lens.nullability-mismatch'
	| 'lens.unrealizable-constraint'
	| 'lens.unenforceable-conflict-action'
	| 'lens.non-invertible'
	| 'lens.unknown-policy-code';

/**
 * The warning-severity advisory codes that flow through ack/escalation
 * governance (`lens-ack.ts`). This is the single authoritative source of the
 * governable vocabulary: a policy (`error-on` / `require-ack`) may legitimately
 * name any of these, and only these. Keeping the list here means it cannot drift
 * from what the prover actually emits.
 */
const ADVISORY_CODE_LIST = [
	'lens.pk-not-reconstructible',
	'lens.no-backing-index',
	'lens.no-answering-structure',
	'lens.partial-override',
] as const;

/** An advisory (warning-severity) code — see {@link ADVISORY_CODE_LIST}. */
export type LensAdvisoryCode = typeof ADVISORY_CODE_LIST[number];

/** The advisory codes a policy may escalate, as a runtime set (drift-locked by a unit test). */
export const ACKNOWLEDGEABLE_ADVISORY_CODES: ReadonlySet<LensAdvisoryCode> =
	new Set(ADVISORY_CODE_LIST);

/** Stable diagnostic codes (see `docs/lens.md` § Coverage checklist). */
export type LensCheckCode = LensErrorCode | LensAdvisoryCode;

/** The logical site a diagnostic concerns (table / constraint / column). */
export interface LensDiagnosticSite {
	readonly table: string;
	readonly constraint?: string;
	readonly column?: string;
}

/**
 * The coarse facts behind a warning, recorded so the sibling acknowledgment
 * ticket (`lens-advisory-acknowledgment`) can fingerprint an advisory without
 * re-deriving it. This ticket *defines and populates* the shape; the sibling
 * computes the hash and persists it when an ack is written, and re-surfaces the
 * advisory when the fingerprint no longer matches. Deliberately coarse — a
 * cardinality *band* rather than a row count — so an ack survives ordinary churn.
 */
export interface FingerprintInputs {
	/** The logical constraint's columns (names, declaration order). */
	readonly constraintColumns?: readonly string[];
	/** Whether a basis covering structure answers the constraint at deploy time. */
	readonly hasCoveringStructure?: boolean;
	/** Coarse cardinality band of the basis anchor: empty | small | medium | large | unknown. */
	readonly cardinalityBand?: string;
	/** The basis relation backing the constraint (lowercased `schema.table`), when resolvable. */
	readonly basisRelation?: string;
}

/** A sited, coded diagnostic. Errors block the deploy; warnings flow to the report. */
export interface LensDiagnostic {
	readonly code: LensCheckCode;
	readonly severity: 'error' | 'warning';
	readonly site: LensDiagnosticSite;
	readonly message: string;
	readonly fingerprintInputs?: FingerprintInputs;
	/**
	 * Set by the acknowledgment governance (`lens-ack.ts`) when a previously
	 * acknowledged advisory re-surfaced because its recorded fingerprint no longer
	 * matches the freshly computed one. The message is annotated accordingly.
	 */
	readonly resurfaced?: boolean;
}

/** A reference to the basis covering structure routing a set-level constraint. */
export interface CoveringStructureRef {
	readonly kind: 'memory-index' | 'materialized-view';
	readonly name: string;
}

/**
 * How one logical constraint becomes real at the lens boundary:
 *  - `proved` — the body intrinsically guarantees it (FD/key); zero runtime cost.
 *  - `enforced-row-local` — evaluable on the projected row being written (a
 *    scalar `check` over non-computed columns); the common, free case.
 *  - `enforced-set-level` — an existence lookup. `row-time` when a covering
 *    structure answers it (O(log n), conflict-resolution-capable); `commit-time`
 *    otherwise (O(n) `DeltaExecutor` scan, detection-only).
 *  - `enforced-fk` — cross-relation existence, realized at the lens boundary as a
 *    deferred synthesized `EXISTS` against the logical parent (gated by the
 *    `foreign_keys` pragma, auto-deferred to commit; `planner/mutation/lens-enforcement.ts`).
 *  - `vacuous` — body + predicate make it trivially satisfied.
 */
export type ConstraintObligation = { readonly constraint: LogicalConstraint } & (
	| { readonly kind: 'proved' }
	| { readonly kind: 'enforced-row-local' }
	| { readonly kind: 'enforced-set-level'; readonly mode: 'row-time' | 'commit-time'; readonly structure?: CoveringStructureRef }
	| { readonly kind: 'enforced-fk' }
	| { readonly kind: 'vacuous' }
);

/**
 * The aggregated result of proving every logical table in one `apply schema X`.
 * `deployLogicalSchema` returns this; `emitApplySchema` surfaces the warnings as
 * advisory rows. Errors are thrown atomically (before any catalog mutation), so a
 * returned report always has `errors: []` — the field is kept for symmetry and so
 * an in-process caller that wants to inspect-without-throwing can.
 */
export interface LensDeployReport {
	readonly errors: LensDiagnostic[];
	/**
	 * Advisories shown by default — un-acknowledged ones plus any that re-surfaced
	 * (`resurfaced: true`) plus empty-rationale meta-warnings. Acknowledged
	 * advisories are removed (and tallied in {@link acknowledged}).
	 */
	readonly warnings: LensDiagnostic[];
	/**
	 * Advisories an in-source `quereus.lens.ack.<code>` tag suppressed from the
	 * default report. The deploy summary tallies `acknowledged: N` (=
	 * `acknowledged.length`) and the `quereus_lens_advisories` TVF expands them on
	 * demand (`docs/lens.md` § Acknowledging advisories). Produced by `lens-ack.ts`.
	 */
	readonly acknowledged: AcknowledgedAdvisory[];
	/** Lowercased logical table name → its constraint obligations. */
	readonly obligationsByTable: ReadonlyMap<string, ReadonlyArray<ConstraintObligation>>;
}

/** The prover's verdict for one lens slot. */
export interface LensProveResult {
	/** Any non-empty ⇒ deploy blocks. */
	readonly errors: LensDiagnostic[];
	/** Advisory; never blocks. Surfaced in the deploy report. */
	readonly warnings: LensDiagnostic[];
	/** Per-constraint enforcement classification. */
	readonly obligations: ConstraintObligation[];
	/** Key not reconstructible ⇒ the table is read-only; mutations error at the lens. */
	readonly readOnly: boolean;
}

/**
 * Proves one lens slot and classifies its constraints. Pure analysis — does not
 * mutate the slot or the catalog; the caller (`lens-compiler.ts`) records the
 * `obligations` / `readOnly` on the slot and aggregates the diagnostics into the
 * deploy report.
 */
export function proveLens(slot: LensSlot, db: Database): LensProveResult {
	const ctx = buildProveContext(slot, db);
	const errors: LensDiagnostic[] = [];
	const warnings: LensDiagnostic[] = [];

	checkColumnCoverage(ctx, errors);
	checkTypeAndNullability(ctx, errors);
	const readOnly = checkKeyReconstructibility(ctx, warnings);
	errors.push(...proveRoundTrip(ctx));

	const obligations = classifyObligations(ctx, readOnly, errors, warnings);

	checkAnsweringStructures(ctx, warnings);
	checkPartialOverride(ctx, warnings);

	return { errors, warnings, obligations, readOnly };
}

// ---------------------------------------------------------------------------
// Prove context — the per-slot facts every check reads.
// ---------------------------------------------------------------------------

interface ProveContext {
	readonly slot: LensSlot;
	readonly db: Database;
	readonly table: TableSchema;
	/** Lowercased logical column name → its index in `logicalTable.columns`. */
	readonly logicalColIndex: ReadonlyMap<string, number>;
	/** Non-hidden logical column names, in body-output order. */
	readonly outputColumns: readonly string[];
	/** Logical column name (lower) → body-output column index. */
	readonly outputIndex: ReadonlyMap<string, number>;
	/**
	 * The optimized body relation (`getRelations()[0]`), or undefined when the
	 * body failed to plan (graceful degradation — plan-derived checks are skipped).
	 */
	readonly root?: RelationalPlanNode;
	/** The single basis source table of the body, when single-source; else undefined. */
	readonly basisSource?: TableSchema;
	readonly basisSchemaName: string;
}

function buildProveContext(slot: LensSlot, db: Database): ProveContext {
	const table = slot.logicalTable;
	const logicalColIndex = new Map<string, number>();
	table.columns.forEach((c, i) => logicalColIndex.set(c.name.toLowerCase(), i));

	const { outputIndex, outputColumns } = buildOutputIndex(slot);

	const basisSchemaName = slot.defaultBasis.schemaName;
	return {
		slot,
		db,
		table,
		logicalColIndex,
		outputColumns,
		outputIndex,
		root: planBody(db, slot.compiledBody),
		basisSource: resolveSingleBasisSource(db, slot.compiledBody, basisSchemaName),
		basisSchemaName,
	};
}

/**
 * The non-hidden output-index map for a lens slot: logical column name (lower) →
 * body-output column index, plus the columns in declaration order. The single
 * source of truth for the body's output-column-index space — shared by
 * {@link buildProveContext} and {@link computeLensAssertedKeyFds} so the two can
 * never drift (the FD-contribution columns must land in exactly the space the
 * prover proved its keys in). Hidden columns are skipped — they are absent from
 * the registered view and the inlined ProjectNode alike.
 */
function buildOutputIndex(slot: LensSlot): { outputIndex: Map<string, number>; outputColumns: string[] } {
	const outputColumns: string[] = [];
	const outputIndex = new Map<string, number>();
	for (const p of slot.columnProvenance) {
		if (p.source === 'hidden') continue;
		outputIndex.set(p.logicalColumn.toLowerCase(), outputColumns.length);
		outputColumns.push(p.logicalColumn);
	}
	return { outputIndex, outputColumns };
}

/**
 * Plans + optimizes the compiled body so `physical.fds` and output column types
 * are available. Returns undefined (graceful) if planning throws — the body the
 * compiler produced should plan, but a prover that itself crashes the deploy is
 * worse than one that skips plan-derived checks.
 */
function planBody(db: Database, body: AST.SelectStmt): RelationalPlanNode | undefined {
	try {
		return db.getPlan(astToString(body)).getRelations()[0];
	} catch (e) {
		log('lens-prover: body failed to plan, skipping plan-derived checks: %O', e);
		return undefined;
	}
}

/** The single basis `table` source of a body, or undefined for a multi-source / opaque FROM. */
function resolveSingleBasisSource(db: Database, body: AST.SelectStmt, basisSchemaName: string): TableSchema | undefined {
	const from = body.from;
	if (!from || from.length !== 1) return undefined;
	const node = from[0];
	if (node.type !== 'table') return undefined;
	const schemaName = node.table.schema ?? basisSchemaName;
	return db.schemaManager.getSchema(schemaName)?.getTable(node.table.name);
}

// ---------------------------------------------------------------------------
// Error: column coverage (lens.uncovered-column)
// ---------------------------------------------------------------------------

/**
 * Every non-hidden logical column resolves to a basis expression. The compiler's
 * gap-fill path already errors on an uncovered column before the prover runs, so
 * this is the formal restatement / backstop: a provenance entry must exist for
 * every column and a non-hidden one must be `override` or `default`.
 */
function checkColumnCoverage(ctx: ProveContext, errors: LensDiagnostic[]): void {
	const provByName = new Map(ctx.slot.columnProvenance.map(p => [p.logicalColumn.toLowerCase(), p]));
	for (const col of ctx.table.columns) {
		const p = provByName.get(col.name.toLowerCase());
		if (!p) {
			errors.push({
				code: 'lens.uncovered-column',
				severity: 'error',
				site: { table: ctx.table.name, column: col.name },
				message: `lens: logical column '${ctx.table.schemaName}.${ctx.table.name}.${col.name}' is not covered by the compiled body (no override mapping and no default gap-fill)`,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Error: type / nullability conformance
// ---------------------------------------------------------------------------

/** Coarse affinity family used for type-conformance (kept lenient to avoid false blocks). */
type AffinityFamily = 'numeric' | 'text' | 'blob' | 'boolean' | 'other';

function physicalFamily(pt: PhysicalType): AffinityFamily {
	switch (pt) {
		case PhysicalType.INTEGER:
		case PhysicalType.REAL: return 'numeric';
		case PhysicalType.TEXT: return 'text';
		case PhysicalType.BLOB: return 'blob';
		case PhysicalType.BOOLEAN: return 'boolean';
		default: return 'other'; // NULL / OBJECT — permissive
	}
}

/**
 * Conservative cross-family compatibility. `other` (NULL/OBJECT) is compatible
 * with anything; numeric and boolean are mutually compatible (SQLite stores
 * booleans as integers). Only a clear cross-family mismatch (numeric↔text,
 * text↔blob, …) is reported, so a faithfully-aligned basis never false-errors.
 */
function familiesCompatible(a: AffinityFamily, b: AffinityFamily): boolean {
	if (a === b) return true;
	if (a === 'other' || b === 'other') return true;
	const numericish = (f: AffinityFamily): boolean => f === 'numeric' || f === 'boolean';
	return numericish(a) && numericish(b);
}

/**
 * Each mapped column's basis-derived type & nullability satisfy the logical
 * declaration. A nullable basis expression under a `not null` logical column
 * errors unless the logical column supplies a total default. Read off the
 * optimized body's output relation; skipped when the body did not plan.
 */
function checkTypeAndNullability(ctx: ProveContext, errors: LensDiagnostic[]): void {
	if (!ctx.root) return;
	const outCols = ctx.root.getType().columns;
	for (const col of ctx.table.columns) {
		const oi = ctx.outputIndex.get(col.name.toLowerCase());
		if (oi === undefined) continue; // hidden column — not in the body output
		const outCol = outCols[oi];
		if (!outCol) continue;
		const outType = outCol.type;
		if (outType.typeClass !== 'scalar') continue;

		const declared = physicalFamily(col.logicalType.physicalType);
		const basis = physicalFamily(outType.logicalType.physicalType);
		if (!familiesCompatible(declared, basis)) {
			errors.push({
				code: 'lens.type-mismatch',
				severity: 'error',
				site: { table: ctx.table.name, column: col.name },
				message: `lens: logical column '${ctx.table.name}.${col.name}' declares type '${col.logicalType.name}' but its basis-derived expression has type '${outType.logicalType.name}' (incompatible storage affinities)`,
			});
			continue;
		}

		// Nullability: not-null logical column over a nullable basis expression with
		// no total default is unsound (a NULL could be read into a not-null column).
		if (col.notNull && outType.nullable === true && col.defaultValue === null) {
			errors.push({
				code: 'lens.nullability-mismatch',
				severity: 'error',
				site: { table: ctx.table.name, column: col.name },
				message: `lens: logical column '${ctx.table.name}.${col.name}' is declared NOT NULL but its basis-derived expression is nullable and no default supplies a value`,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Error→read-only: key reconstructibility (lens.pk-not-reconstructible)
// ---------------------------------------------------------------------------

/**
 * For a writable logical table the logical PK must be reconstructible at the lens
 * boundary — each PK column maps to a plain (invertible) basis column projection.
 * When it is not (a computed / hidden / aggregated PK column), the table is
 * **read-only**: reads still work, but any mutation errors at the lens
 * (`planner/mutation/single-source.ts` `analyzeView` raises). This is not a deploy-blocking error — the table
 * deploys read-only — so it surfaces as a warning, and `readOnly` is set on the
 * slot. The empty (singleton) PK is vacuously reconstructible.
 *
 * @returns whether the table is read-only.
 */
function checkKeyReconstructibility(ctx: ProveContext, warnings: LensDiagnostic[]): boolean {
	const pk = ctx.table.primaryKeyDefinition;
	if (pk.length === 0) return false; // singleton — 0-or-1 row, vacuously reconstructible

	const unreconstructible: string[] = [];
	for (const pkCol of pk) {
		const name = ctx.table.columns[pkCol.index]?.name;
		if (name === undefined || !isReconstructibleColumn(ctx, name)) {
			unreconstructible.push(name ?? `#${pkCol.index}`);
		}
	}
	if (unreconstructible.length === 0) return false;

	warnings.push({
		code: 'lens.pk-not-reconstructible',
		severity: 'warning',
		site: { table: ctx.table.name },
		message: `lens: logical table '${ctx.table.name}' is read-only — its primary key is not reconstructible at the lens boundary (column(s) ${unreconstructible.map(c => `'${c}'`).join(', ')} have no invertible basis write path); mutations against it will error`,
	});
	return true;
}

/**
 * A logical column is reconstructible iff it is non-hidden and its body-output
 * projection term is a plain column reference (so a written value maps straight
 * back to a basis column). A computed (non-column) projection has no write path.
 */
function isReconstructibleColumn(ctx: ProveContext, columnName: string): boolean {
	const oi = ctx.outputIndex.get(columnName.toLowerCase());
	if (oi === undefined) return false; // hidden — not writable through the lens
	const rc = ctx.slot.compiledBody.columns[oi];
	return rc?.type === 'column' && rc.expr.type === 'column';
}

// ---------------------------------------------------------------------------
// Error: round-trip / lens laws (lens.non-invertible) — v1 enumerated form
// ---------------------------------------------------------------------------

/**
 * Round-trip (GetPut / PutGet) over the writable fragment, behind a single
 * swappable function. **v1 is the enumerated failure-shape form**: the predicate-
 * honest *complement* of a lens body that would make GetPut/PutGet *computed*
 * predicates lands with `bx-operator-model-and-roundtrip-laws` +
 * `view-mutation-plan-node-substrate`; until then non-invertibility is already
 * detected where it bites — at mutation time, by view-updateability's own
 * diagnostics (`docs/view-updateability.md` § Diagnostics) — and a non-
 * reconstructible key is caught by {@link checkKeyReconstructibility}. So the v1
 * enumerated check adds no *new* deploy-time error and returns none; it exists as
 * the single seam to tighten to the computed form. See `docs/lens.md` § Round-trip.
 */
function proveRoundTrip(_ctx: ProveContext): LensDiagnostic[] {
	return [];
}

// ---------------------------------------------------------------------------
// Constraint realizability + obligation classification
// ---------------------------------------------------------------------------

/**
 * Classifies every attached logical constraint into a {@link ConstraintObligation}
 * and, in the process, performs the *constraint realizability* error check
 * (`lens.unrealizable-constraint`): a constraint referencing a column with no
 * write path (computed lineage / hidden) is neither provable nor attachable.
 * Set-level constraints with no covering structure emit `lens.no-backing-index`.
 */
function classifyObligations(ctx: ProveContext, readOnly: boolean, errors: LensDiagnostic[], warnings: LensDiagnostic[]): ConstraintObligation[] {
	const obligations: ConstraintObligation[] = [];
	for (const c of ctx.slot.attachedConstraints) {
		obligations.push(classifyConstraint(ctx, c, readOnly, errors, warnings));
	}
	return obligations;
}

function classifyConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	readOnly: boolean,
	errors: LensDiagnostic[],
	warnings: LensDiagnostic[],
): ConstraintObligation {
	switch (constraint.kind) {
		case 'primaryKey':
			return classifyKeyConstraint(ctx, constraint, constraint.columns.map(c => c.index), 'primary key', true, readOnly, errors, warnings);
		case 'unique':
			return classifyKeyConstraint(ctx, constraint, constraint.constraint.columns, constraintLabel(constraint), false, readOnly, errors, warnings);
		case 'check':
			return classifyCheckConstraint(ctx, constraint, errors);
		case 'foreignKey':
			return { constraint, kind: 'enforced-fk' };
	}
}

/** A short human label for a constraint, for sited messages. */
function constraintLabel(constraint: LogicalConstraint): string {
	switch (constraint.kind) {
		case 'primaryKey': return 'primary key';
		case 'check': return constraint.constraint.name ? `check '${constraint.constraint.name}'` : 'check';
		case 'unique': return constraint.constraint.name ? `unique '${constraint.constraint.name}'` : 'unique';
		case 'foreignKey': return constraint.constraint.name ? `foreign key '${constraint.constraint.name}'` : 'foreign key';
	}
}

/**
 * The effective constraint-level default conflict action a duplicate key would
 * resolve to absent a statement-level OR clause. The commit-time set-level scan
 * can only ABORT, so a key declaring REPLACE / IGNORE here cannot honor it — see
 * {@link classifyKeyConstraint}'s `lens.unenforceable-conflict-action` block.
 *
 *  - `unique` → the constraint's own `defaultConflict`.
 *  - `primaryKey` → table-level `PRIMARY KEY (...) ON CONFLICT <action>`
 *    (`TableSchema.primaryKeyDefaultConflict`), else the first PK column's
 *    column-level `ColumnSchema.defaultConflict` — mirroring the precedence
 *    documented on `TableSchema.primaryKeyDefaultConflict`. The PK's action is
 *    NOT on the `LogicalConstraint` node, so it must be read off `ctx.table`.
 *
 * Returns undefined when no action is declared (⇒ ABORT, which the scan honors).
 */
function effectiveKeyDefaultConflict(ctx: ProveContext, constraint: LogicalConstraint): ConflictResolution | undefined {
	switch (constraint.kind) {
		case 'unique':
			return constraint.constraint.defaultConflict;
		case 'primaryKey': {
			if (ctx.table.primaryKeyDefaultConflict !== undefined) return ctx.table.primaryKeyDefaultConflict;
			const firstPkIndex = constraint.columns[0]?.index;
			return firstPkIndex !== undefined ? ctx.table.columns[firstPkIndex]?.defaultConflict : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Classifies a key constraint (primary key / unique). Empty key ⇒ vacuous
 * (singleton).
 *
 * A column with no write path (computed / hidden lineage) is handled by class:
 *  - a **unique** over such a column is `lens.unrealizable-constraint` (you
 *    declared uniqueness on a value with no write path — it can be neither proved
 *    nor enforced);
 *  - a **primary key** over such a column makes the whole table *read-only*
 *    (owned by {@link checkKeyReconstructibility}, surfaced as the
 *    `lens.pk-not-reconstructible` warning) — NOT a blocking error, because the
 *    table still deploys for reads.
 *
 * Otherwise: proved by the body's effective key (`proveEffectiveKeyUnique`) ⇒
 * `proved`; else `enforced-set-level`, row-time when a basis covering structure
 * answers it, commit-time (+ `lens.no-backing-index` warning) when none does. The
 * warning is suppressed for a read-only table — its set-level enforcement is moot.
 */
function classifyKeyConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	logicalColumns: readonly number[],
	label: string,
	isPrimaryKey: boolean,
	readOnly: boolean,
	errors: LensDiagnostic[],
	warnings: LensDiagnostic[],
): ConstraintObligation {
	if (logicalColumns.length === 0) {
		return { constraint, kind: 'vacuous' };
	}

	const columnNames = logicalColumns.map(i => ctx.table.columns[i]?.name ?? `#${i}`);
	const outCols: number[] = [];
	for (const li of logicalColumns) {
		const name = ctx.table.columns[li]?.name;
		const oi = name !== undefined ? ctx.outputIndex.get(name.toLowerCase()) : undefined;
		const reachable = oi !== undefined && isReconstructibleColumn(ctx, name!);
		if (!reachable && !isPrimaryKey) {
			errors.push({
				code: 'lens.unrealizable-constraint',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label, column: name },
				message: `lens: ${label} on '${ctx.table.name}' references column '${name ?? `#${li}`}', which has no write path at the lens boundary (computed or hidden lineage); the constraint can be neither proved nor enforced`,
			});
			return { constraint, kind: 'enforced-set-level', mode: 'commit-time' };
		}
		// A PK over an unreachable column: the table is read-only (warned elsewhere);
		// fall through to classify the obligation without a blocking error.
		if (oi !== undefined) outCols.push(oi);
	}

	// Body proves it? (e.g. unique(x,y) over `group by x,y`, or a faithful
	// projection of a basis key.) Only when every column resolved to the output.
	if (ctx.root && outCols.length === logicalColumns.length && proveEffectiveKeyUnique(ctx.root, outCols).proved) {
		return { constraint, kind: 'proved' };
	}

	// Not proved → enforced set-level. Row-time iff a basis row-time covering
	// structure answers it (a non-stale covering MV); commit-time otherwise.
	const structure = findBasisCoveringStructure(ctx, logicalColumns);
	if (structure) {
		return { constraint, kind: 'enforced-set-level', mode: 'row-time', structure };
	}

	if (!readOnly) {
		warnings.push({
			code: 'lens.no-backing-index',
			severity: 'warning',
			site: { table: ctx.table.name, constraint: label },
			message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) has no basis covering structure — it enforces via an O(n) commit-time scan. Add an explicit basis covering materialized view (order by the constraint columns) to upgrade to row-time enforcement; row-time conflict resolution (insert or replace / or ignore) requires that structure and is otherwise rejected.`,
			fingerprintInputs: buildFingerprint(ctx, columnNames, false),
		});

		// A commit-time scan can only ABORT. A constraint-level `on conflict
		// replace`/`ignore` (the PK's via `ctx.table`, a UNIQUE's via its own
		// `defaultConflict`) is an action the scan can never honor — an unsound
		// schema. Block it at deploy here rather than silently over-ABORTing per
		// write: the statement-level gate (`rejectLensSetLevelConflictResolution`)
		// only inspects `req.stmt.onConflict`, so the constraint-level channel never
		// reaches it. ABORT / FAIL / ROLLBACK (and no declared action) are fine.
		const effectiveConflict = effectiveKeyDefaultConflict(ctx, constraint);
		if (effectiveConflict === ConflictResolution.REPLACE || effectiveConflict === ConflictResolution.IGNORE) {
			errors.push({
				code: 'lens.unenforceable-conflict-action',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label },
				message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) declares 'on conflict replace/ignore' but has no basis covering structure, so the action cannot be honored (a commit-time scan can only ABORT). Add a basis covering materialized view (order by the key columns) to upgrade to row-time enforcement, or drop the conflict action.`,
			});
		}

		// Defensive (close-before-reachable): the commit-time count synthesis
		// (`synthesizeUniqueCountExpr`) counts ALL logical rows matching the key — it
		// does not scope by a partial-UNIQUE predicate, so a partial logical UNIQUE
		// would over-count and falsely ABORT an out-of-scope duplicate. A logical
		// declaration never sets `predicate` today (only `CREATE UNIQUE INDEX … WHERE`
		// does, a path the declaration surface never takes), so this guards an
		// invariant rather than a reachable case — reject loudly if it ever opens.
		if (constraint.kind === 'unique' && constraint.constraint.predicate !== undefined) {
			errors.push({
				code: 'lens.unrealizable-constraint',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label },
				message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) is a partial UNIQUE (declares a predicate), which is unsupported for commit-time set-level enforcement (the O(n) count scan cannot scope by the partial predicate). Add a basis covering materialized view to upgrade to row-time enforcement, or remove the partial predicate.`,
			});
		}
	}
	return { constraint, kind: 'enforced-set-level', mode: 'commit-time' };
}

/**
 * Classifies a `check` constraint. A check referencing a column with no write
 * path (computed / hidden) is unrealizable (error). Otherwise it is row-local —
 * evaluable on the projected row at the write boundary. (Vacuous-by-body-predicate
 * detection is deferred; a row-local check is always sound, just possibly redundant.)
 */
function classifyCheckConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint & { kind: 'check' },
	errors: LensDiagnostic[],
): ConstraintObligation {
	const label = constraintLabel(constraint);
	for (const ref of collectColumnRefNames(constraint.constraint.expr)) {
		const li = ctx.logicalColIndex.get(ref.toLowerCase());
		if (li === undefined) continue; // not a logical column of this table — leave to body resolution
		if (!isReconstructibleColumn(ctx, ref)) {
			errors.push({
				code: 'lens.unrealizable-constraint',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label, column: ref },
				message: `lens: ${label} on '${ctx.table.name}' references column '${ref}', which has computed or hidden lineage (no write path); a check over it cannot be enforced at the lens boundary`,
			});
			return { constraint, kind: 'enforced-row-local' };
		}
	}
	return { constraint, kind: 'enforced-row-local' };
}

// ---------------------------------------------------------------------------
// Basis covering-structure resolution (row-time vs commit-time)
// ---------------------------------------------------------------------------

/**
 * Finds a basis covering structure that answers a logical key constraint: maps
 * each logical column → its basis column (via the single-source body projection),
 * finds a matching basis UNIQUE constraint, and returns a row-time covering MV
 * reference when one is linked (`coveringStructureName` / `_findRowTimeCoveringStructure`).
 *
 * Conservative: a multi-source body, an unmapped column, or a missing basis
 * UC/structure all yield `undefined` (⇒ commit-time scan). The retired auto-index
 * is deliberately NOT consulted for a logical schema — the explicit covering MV
 * is the sole row-time structure (`docs/lens.md` § Constraint Attachment).
 */
function findBasisCoveringStructure(ctx: ProveContext, logicalColumns: readonly number[]): CoveringStructureRef | undefined {
	return findBasisCovering(ctx, logicalColumns)?.ref;
}

/** The matching basis UC and the row-time covering structure that answers it. */
interface BasisCovering {
	readonly ref: CoveringStructureRef;
	readonly uc: UniqueConstraintSchema;
}

/**
 * Resolves the basis covering structure AND the basis UNIQUE constraint backing a
 * logical key, factored out of {@link findBasisCoveringStructure} so the plan-time
 * FD re-validation ({@link computeLensAssertedKeyFds}) can re-confirm currency and
 * inspect the basis UC's partial predicate against the *current* catalog. Reads no
 * `ctx.root`, so it is safe over a lightweight (un-planned) context.
 */
function findBasisCovering(ctx: ProveContext, logicalColumns: readonly number[]): BasisCovering | undefined {
	const basis = ctx.basisSource;
	if (!basis) return undefined;

	const basisCols: number[] = [];
	for (const li of logicalColumns) {
		const name = ctx.table.columns[li]?.name;
		const bc = name !== undefined ? mappedBasisColumn(ctx, name, basis) : undefined;
		if (bc === undefined) return undefined;
		basisCols.push(bc);
	}

	const basisColSet = new Set(basisCols);
	const matching = (basis.uniqueConstraints ?? []).find(uc =>
		uc.columns.length === basisCols.length && uc.columns.every(c => basisColSet.has(c)),
	);
	if (!matching) return undefined;

	// Row-time iff a non-stale row-time covering MV answers the basis UC. A
	// merely *linked* (`coveringStructureName`) but stale / not-row-time-maintained
	// MV does NOT qualify — claiming row-time there would be unsound, so we fall
	// through to the commit-time scan.
	const rowTime = ctx.db._findRowTimeCoveringStructure(basis.schemaName, basis.name, matching);
	return rowTime ? { ref: { kind: 'materialized-view', name: rowTime.name }, uc: matching } : undefined;
}

/** The basis column index a logical column maps to under a single-source body, or undefined. */
function mappedBasisColumn(ctx: ProveContext, logicalColumn: string, basis: TableSchema): number | undefined {
	const oi = ctx.outputIndex.get(logicalColumn.toLowerCase());
	if (oi === undefined) return undefined;
	const rc = ctx.slot.compiledBody.columns[oi];
	if (rc?.type !== 'column' || rc.expr.type !== 'column') return undefined;
	return basis.columnIndexMap.get((rc.expr as AST.ColumnExpr).name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Read-side: declared-key FD contribution to the optimizer (the inlined-view
// boundary). See docs/lens.md § Constraint Attachment and docs/optimizer.md
// § Functional Dependency Tracking.
// ---------------------------------------------------------------------------

/**
 * The declared logical keys a lens *proves* or *actively enforces*, encoded as
 * physical functional dependencies in the body's **output**-column-index space,
 * for the optimizer to consume at the inlined-view boundary
 * (`planner/nodes/asserted-keys-node.ts`, wired in `planner/building/select.ts`).
 *
 * Soundness is gated by the prover's per-constraint {@link ConstraintObligation}
 * kind — a false key FD is a *correctness* defect (it can make
 * DISTINCT/join-elimination/order-by-pruning drop real rows), so the gate
 * under-claims exactly like every other FD-propagation rule:
 *
 *  - `proved`   — the body intrinsically guarantees the key (the same FD surface
 *    the optimizer derives locally); contribute the **unconditional** key FD.
 *    Redundant-but-harmless when local propagation already surfaces it (`addFd`
 *    subsumes), load-bearing when the inlining context loses it.
 *  - `vacuous`  — the empty (singleton) key; contribute `∅ → all_cols` (≤1-row).
 *  - `enforced-set-level` `row-time` — a covering structure enforces uniqueness
 *    per row-write, but only over the **non-null** tuples a plain (NULL-skipping)
 *    UNIQUE governs — SQL UNIQUE permits multiple all-/any-NULL rows, so the key
 *    is conditionally unique. Contribute a **guarded** FD `key → others
 *    [guard: key IS NOT NULL]` (the same shape a partial UNIQUE emits), and only
 *    when the covering structure re-validates against the *current* catalog (it
 *    can be dropped / go stale out-of-band between deploys) and the backing basis
 *    UC is non-partial (so NULL-skip is the *entire* uniqueness scope).
 *  - `enforced-set-level` `commit-time` — **excluded**. Detection-only at commit;
 *    a duplicate can transiently exist mid-statement (read-own-writes / Halloween),
 *    so assuming the FD mid-statement is unsound.
 *  - `enforced-row-local` / `enforced-fk` — not uniqueness facts; excluded.
 *
 * Returns the (deduped) FD list, or `[]` when nothing is contributable — the
 * wiring site inlines no node for an empty list (plain views / MVs / unenforced
 * keys produce none).
 */
export function computeLensAssertedKeyFds(slot: LensSlot, db: Database): FunctionalDependency[] {
	if (!slot.obligations || slot.obligations.length === 0) return [];

	const { outputIndex, outputColumns } = buildOutputIndex(slot);
	const outColCount = outputColumns.length;
	if (outColCount === 0) return [];

	let fds: FunctionalDependency[] = [];
	for (const ob of slot.obligations) {
		const fd = assertedFdForObligation(ob, slot, db, outputIndex, outColCount);
		if (fd) fds = addFd(fds, fd);
	}
	return fds;
}

/** The asserted key FD for one obligation, or undefined when it contributes none. */
function assertedFdForObligation(
	ob: ConstraintObligation,
	slot: LensSlot,
	db: Database,
	outputIndex: ReadonlyMap<string, number>,
	outColCount: number,
): FunctionalDependency | undefined {
	const c = ob.constraint;
	if (c.kind !== 'primaryKey' && c.kind !== 'unique') return undefined; // not a key fact

	switch (ob.kind) {
		case 'vacuous':
			// The empty (singleton) key ⇒ `∅ → all_cols` (≤1-row). superkeyToFd([], n)
			// is the canonical encoding.
			return superkeyToFd([], outColCount);
		case 'proved':
			// The body unconditionally guarantees the key. Contribute it unconditionally.
			return encodeKeyFd(logicalKeyColumns(c), slot.logicalTable, outputIndex, outColCount, undefined);
		case 'enforced-set-level': {
			if (ob.mode !== 'row-time') return undefined; // commit-time gated out (unsound mid-statement)
			const logicalCols = logicalKeyColumns(c);
			// Re-validate the covering structure against the current catalog (currency)
			// and require a non-partial basis UC (so IS-NOT-NULL is the full scope).
			if (!revalidateRowTime(slot, db, logicalCols)) return undefined;
			const guard = buildNotNullGuard(logicalCols, slot.logicalTable, outputIndex);
			if (!guard) return undefined; // no nullable key column ⇒ would be `proved`, not row-time; skip
			return encodeKeyFd(logicalCols, slot.logicalTable, outputIndex, outColCount, guard);
		}
		default:
			return undefined; // enforced-row-local / enforced-fk
	}
}

/** The logical column indices forming a primary-key / unique constraint. */
function logicalKeyColumns(c: Extract<LogicalConstraint, { kind: 'primaryKey' | 'unique' }>): readonly number[] {
	return c.kind === 'primaryKey' ? c.columns.map(col => col.index) : c.constraint.columns;
}

/**
 * Encode `key → others` over the body's output columns. Maps each logical key
 * column → its non-hidden output index; a key column with no output index
 * (hidden / not emitted) makes the key inexpressible (⇒ undefined). The
 * all-columns key has no non-trivial FD encoding (`superkeyToFd` ⇒ undefined) and
 * is skipped (v1). When `guard` is supplied the FD activates only under a
 * surrounding predicate that entails it (the nullable / partial-UNIQUE case).
 */
function encodeKeyFd(
	logicalColumns: readonly number[],
	table: TableSchema,
	outputIndex: ReadonlyMap<string, number>,
	outColCount: number,
	guard: GuardPredicate | undefined,
): FunctionalDependency | undefined {
	const outCols: number[] = [];
	for (const li of logicalColumns) {
		const name = table.columns[li]?.name;
		const oi = name !== undefined ? outputIndex.get(name.toLowerCase()) : undefined;
		if (oi === undefined) return undefined; // hidden / not emitted ⇒ not in the readable relation
		outCols.push(oi);
	}
	const fd = superkeyToFd(outCols, outColCount);
	if (!fd) return undefined;
	return guard ? { ...fd, guard } : fd;
}

/**
 * The `key IS NOT NULL` guard for a conditionally-unique (NULL-skipping) key — one
 * `is-null negated:true` clause per **nullable** key column (a NOT-NULL column
 * needs none; the guard checker discharges it from type info). Returns undefined
 * when every key column is already NOT NULL — that key is unconditional and would
 * have classified `proved`, so a row-time obligation over it is skipped defensively.
 */
function buildNotNullGuard(
	logicalColumns: readonly number[],
	table: TableSchema,
	outputIndex: ReadonlyMap<string, number>,
): GuardPredicate | undefined {
	const clauses: GuardClause[] = [];
	for (const li of logicalColumns) {
		const col = table.columns[li];
		if (!col) return undefined;
		if (col.notNull) continue;
		const oi = outputIndex.get(col.name.toLowerCase());
		if (oi === undefined) return undefined;
		clauses.push({ kind: 'is-null', column: oi, negated: true });
	}
	return clauses.length > 0 ? { clauses } : undefined;
}

/**
 * Re-confirm at plan time that a row-time obligation's covering structure is
 * still valid: a covering MV can be dropped or go stale out-of-band between
 * deploys (the basis is a physical schema whose DDL does not re-run the prover),
 * so the deploy-time snapshot must be re-validated. Also requires the backing
 * basis UC to be **non-partial** — a partial UNIQUE (`… where P`) makes the
 * uniqueness scope `P`, not merely NULL-skip, which the IS-NOT-NULL guard would
 * not capture. Cheap: re-resolves the covering structure against the current
 * catalog without re-planning the body.
 */
function revalidateRowTime(slot: LensSlot, db: Database, logicalColumns: readonly number[]): boolean {
	const ctx = buildLiteProveContext(slot, db);
	const covering = findBasisCovering(ctx, logicalColumns);
	return covering !== undefined && covering.uc.predicate === undefined;
}

/**
 * A lightweight prove context for plan-time covering re-resolution — every field
 * {@link findBasisCovering} reads, with `root` left undefined (the body is NOT
 * re-planned; the covering resolver is plan-independent). Keeps the per-read cost
 * to a couple of map builds + a catalog lookup.
 */
function buildLiteProveContext(slot: LensSlot, db: Database): ProveContext {
	const table = slot.logicalTable;
	const logicalColIndex = new Map<string, number>();
	table.columns.forEach((c, i) => logicalColIndex.set(c.name.toLowerCase(), i));
	const { outputIndex, outputColumns } = buildOutputIndex(slot);
	const basisSchemaName = slot.defaultBasis.schemaName;
	return {
		slot,
		db,
		table,
		logicalColIndex,
		outputColumns,
		outputIndex,
		root: undefined,
		basisSource: resolveSingleBasisSource(db, slot.compiledBody, basisSchemaName),
		basisSchemaName,
	};
}

// ---------------------------------------------------------------------------
// Warning: no answering structure for a declared access pattern
// ---------------------------------------------------------------------------

/**
 * `quereus.lens.access.<col>` declares an expected lookup/ordering. The advisory
 * fires when no basis ordering/index serves it. v1 best-effort: a single-source
 * body's basis table must carry an index whose leading column is the access
 * column (or have that column as the leading PK column); otherwise reads scan.
 */
function checkAnsweringStructures(ctx: ProveContext, warnings: LensDiagnostic[]): void {
	const accessTags = getReservedTagByTemplate(ctx.table.tags, 'quereus.lens.access.<col>');
	if (accessTags.length === 0) return;
	const basis = ctx.basisSource;

	for (const tag of accessTags) {
		const col = tag.segment;
		if (basisServesAccess(ctx, basis, col)) continue;
		warnings.push({
			code: 'lens.no-answering-structure',
			severity: 'warning',
			site: { table: ctx.table.name, column: col },
			message: `lens: declared access pattern 'quereus.lens.access.${col}' on '${ctx.table.name}' has no answering basis ordering or index — reads on '${col}' will scan. Add a basis index/covering materialized view ordered by '${col}'.`,
			fingerprintInputs: buildFingerprint(ctx, [col], false),
		});
	}
}

/** True iff the basis single source has an index / PK whose leading column is `accessCol`. */
function basisServesAccess(ctx: ProveContext, basis: TableSchema | undefined, accessCol: string): boolean {
	if (!basis) return false;
	const basisCol = mappedBasisColumn(ctx, accessCol, basis);
	if (basisCol === undefined) return false;
	if (basis.primaryKeyDefinition[0]?.index === basisCol) return true;
	for (const idx of basis.indexes ?? []) {
		if (idx.columns[0]?.index === basisCol) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Warning: partial override (informational)
// ---------------------------------------------------------------------------

/**
 * When an override covers only some columns and the remainder took the default
 * alignment, list which columns were override-authored vs gap-filled, read
 * straight off the slot's `columnProvenance`.
 */
function checkPartialOverride(ctx: ProveContext, warnings: LensDiagnostic[]): void {
	const authored = ctx.slot.columnProvenance.filter(p => p.source === 'override').map(p => p.logicalColumn);
	const gapFilled = ctx.slot.columnProvenance.filter(p => p.source === 'default').map(p => p.logicalColumn);
	if (authored.length === 0 || gapFilled.length === 0) return; // pure override or pure default — not partial

	warnings.push({
		code: 'lens.partial-override',
		severity: 'warning',
		site: { table: ctx.table.name },
		message: `lens: '${ctx.table.name}' is a partial override — override-authored column(s): ${authored.map(c => `'${c}'`).join(', ')}; default gap-filled column(s): ${gapFilled.map(c => `'${c}'`).join(', ')}`,
	});
}

// ---------------------------------------------------------------------------
// Fingerprint inputs (consumed by the sibling acknowledgment ticket)
// ---------------------------------------------------------------------------

function buildFingerprint(ctx: ProveContext, columnNames: readonly string[], hasCoveringStructure: boolean): FingerprintInputs {
	const basis = ctx.basisSource;
	return {
		constraintColumns: [...columnNames].sort((a, b) => a.localeCompare(b)),
		hasCoveringStructure,
		cardinalityBand: cardinalityBand(basis?.estimatedRows),
		basisRelation: basis ? `${basis.schemaName.toLowerCase()}.${basis.name.toLowerCase()}` : undefined,
	};
}

/** Coarse cardinality band so an acknowledgment survives ordinary row-count churn. */
function cardinalityBand(rows: number | undefined): string {
	if (rows === undefined) return 'unknown';
	if (rows === 0) return 'empty';
	if (rows < 1_000) return 'small';
	if (rows < 1_000_000) return 'medium';
	return 'large';
}

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

/** Collects every `column` reference name in an expression (best-effort reflective walk). */
function collectColumnRefNames(expr: AST.Expression): string[] {
	const names: string[] = [];
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'column' && typeof (node as AST.ColumnExpr).name === 'string') {
			names.push((node as AST.ColumnExpr).name);
		}
		for (const key of Object.keys(node)) {
			const value = (node as unknown as Record<string, unknown>)[key];
			if (!value) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item && typeof item === 'object' && 'type' in item) stack.push(item as AST.AstNode);
				}
			} else if (typeof value === 'object' && 'type' in (value as object)) {
				stack.push(value as AST.AstNode);
			}
		}
	}
	return names;
}
