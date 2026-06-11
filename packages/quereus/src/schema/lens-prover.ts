import type { Database } from '../core/database.js';
import type { SchemaManager } from './manager.js';
import type { TableSchema, UniqueConstraintSchema } from './table.js';
import { resolvePkDefaultConflict } from './table.js';
import type { LensSlot, LogicalConstraint } from './lens.js';
import type * as AST from '../parser/ast.js';
import type { DomainConstraint, FunctionalDependency, GuardClause, GuardPredicate, PlanNode, RelationalPlanNode } from '../planner/nodes/plan-node.js';
import { addFd, superkeyToFd } from '../planner/util/fd-utils.js';
import { proveEffectiveKeyUnique } from '../planner/analysis/coverage-prover.js';
import { resolveBaseSite, type ResolvedBaseSite } from '../planner/analysis/update-lineage.js';
import { viewComplement } from '../planner/analysis/view-complement.js';
import { getCheckExtraction, containsNonDeterministicCall, type CheckExtraction } from '../planner/analysis/check-extraction.js';
import { createRuntimeExpressionEvaluator } from '../planner/analysis/const-evaluator.js';
import { classifyViewBody } from '../planner/mutation/propagate.js';
import { substituteNewRefs, transformExpr } from '../planner/mutation/scope-transform.js';
import { ProjectNode } from '../planner/nodes/project-node.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { astToString, expressionToString } from '../emit/ast-stringify.js';
import { PhysicalType } from '../types/logical-type.js';
import { getReservedTagByTemplate, LENS_WRITABLE_INTENT_TAG } from './reserved-tags.js';
import type { AcknowledgedAdvisory } from './lens-ack.js';
import { createLogger } from '../common/logger.js';
import { ConflictResolution, FunctionFlags } from '../common/constants.js';
import { compareSqlValues } from '../util/comparison.js';
import type { SqlValue } from '../common/types.js';

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
 *  - **diagnostics** — the deploy-blocking errors (any one blocks the deploy)
 *    plus the warning-severity diagnostics that flow to the deploy report: the
 *    pure advisories (no-backing-index / no-answering-structure /
 *    partial-override / getput-lossy) plus the read-only verdict
 *    (`pk-not-reconstructible`). See `docs/lens.md` § Coverage checklist.
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
	| 'lens.putget-violation'
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
	'lens.getput-lossy',
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
	/**
	 * The enumerable CHECK `in (...)` domain behind a round-trip advisory
	 * (`lens.getput-lossy`), rendered + sorted — a domain change (the list gains
	 * or loses a value) is a material fact that re-surfaces an acknowledgment.
	 * Serialized into the fingerprint only when present, so advisories without a
	 * domain keep their existing hashes.
	 */
	readonly domainValues?: readonly string[];
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
	proveRoundTrip(ctx, readOnly, errors, warnings);

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
	/** Logical column names, in body-output order. */
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
		basisSource: resolveSingleBasisSource(db.schemaManager, slot.compiledBody, basisSchemaName),
		basisSchemaName,
	};
}

/**
 * The output-index map for a lens slot: logical column name (lower) →
 * body-output column index, plus the columns in declaration order. The single
 * source of truth for the body's output-column-index space — shared by
 * {@link buildProveContext} and {@link computeLensAssertedKeyFds} so the two can
 * never drift (the FD-contribution columns must land in exactly the space the
 * prover proved its keys in).
 */
function buildOutputIndex(slot: LensSlot): { outputIndex: Map<string, number>; outputColumns: string[] } {
	const outputColumns: string[] = [];
	const outputIndex = new Map<string, number>();
	for (const p of slot.columnProvenance) {
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
function resolveSingleBasisSource(schemaManager: SchemaManager, body: AST.SelectStmt, basisSchemaName: string): TableSchema | undefined {
	const from = body.from;
	if (!from || from.length !== 1) return undefined;
	const node = from[0];
	if (node.type !== 'table') return undefined;
	const schemaName = node.table.schema ?? basisSchemaName;
	return schemaManager.getSchema(schemaName)?.getTable(node.table.name);
}

/**
 * The single basis `table` source of a lens slot's compiled body, or undefined for
 * a multi-source / opaque FROM — the exported slot-level entry point. Reused by the
 * lens FK-redundancy detector (`planner/mutation/lens-enforcement.ts`) so it walks
 * the same single-source `from` the prover does, resolving a bare table name against
 * the slot's own default basis schema. Reads only the catalog, so it is safe over a
 * lightweight (un-planned) caller.
 */
export function resolveSlotBasisSource(slot: LensSlot, schemaManager: SchemaManager): TableSchema | undefined {
	return resolveSingleBasisSource(schemaManager, slot.compiledBody, slot.defaultBasis.schemaName);
}

// ---------------------------------------------------------------------------
// Error: column coverage (lens.uncovered-column)
// ---------------------------------------------------------------------------

/**
 * Every logical column resolves to a basis expression. The compiler's gap-fill
 * path already errors on an uncovered column before the prover runs, so this is
 * the formal restatement / backstop: a provenance entry must exist for every
 * column and must be `override` or `default`.
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
		if (oi === undefined) continue; // defensive: column absent from the body output
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
 * When it is not (a computed / aggregated PK column), the table is
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
 * A logical column is reconstructible iff its body-output projection term is a
 * plain column reference (so a written value maps straight back to a basis
 * column). A computed (non-column) projection has no write path.
 */
function isReconstructibleColumn(ctx: ProveContext, columnName: string): boolean {
	const oi = ctx.outputIndex.get(columnName.toLowerCase());
	if (oi === undefined) return false; // not in the body output — not writable through the lens
	const rc = ctx.slot.compiledBody.columns[oi];
	return rc?.type === 'column' && rc.expr.type === 'column';
}

// ---------------------------------------------------------------------------
// Error: round-trip / lens laws (lens.non-invertible) — computed deploy-time form
// ---------------------------------------------------------------------------

/**
 * Round-trip (GetPut / PutGet) over the writable fragment, **computed at deploy**
 * from the predicate-honest complement ({@link viewComplement}). Because Quereus
 * resolves the Bancilhon–Spyratos ambiguity by predicate-honest fan-out, the
 * complement is *determined, not chosen*, which makes the two laws decidable over
 * the single-source projection-and-filter fragment with no theorem prover:
 *
 *  - **GetPut** ("read a row, write the same values back ⇒ base unchanged") holds
 *    iff `put` leaves the complement **fixed**: no writable column's backward
 *    write path targets a base column the complement lists as *hidden*.
 *  - **PutGet** ("write a value through the view, read it back ⇒ get the written
 *    value") holds iff, for every column the lens presents as **writable**, the
 *    composed `get ∘ put` is the identity on the writable value, and any `domain`
 *    restriction the column's inverse carries is **entailed** by the residual
 *    predicate.
 *
 * The firing rule has three branches:
 *  1. a column the lens presents as writable (a `base` {@link ResolvedBaseSite})
 *     whose round-trip the analysis cannot prove faithful (`v.writable &&
 *     !v.faithful`) — the original rule, unchanged.
 *  2. a `computed`/opaque output column (`!v.writable`) the author *declared*
 *     writable via the `quereus.lens.writable = true` intent tag
 *     ({@link intentWritable}): the round-trip law's stronger reading makes this
 *     an authoring error, not a derived column.
 *  3. an **authored** (`with inverse`) column ({@link checkAuthoredInverse}):
 *     writable by construction (it satisfies the writable intent exactly as an
 *     inferred inverse does — branch 2 never fires for it). PutGet is checked by
 *     *composition*: when the logical column carries an enumerable CHECK
 *     `in (...)` domain, `forward(inverse(v))` is const-evaluated per domain
 *     value — a value that fails to reproduce is the hard `lens.putget-violation`
 *     error; no enumerable domain degrades to the safe admit. GetPut is
 *     surrendered by design for a non-injective forward (a write-through
 *     normalizes the base value) and surfaces as the acknowledgeable
 *     `lens.getput-lossy` advisory — suppressed only when the enumeration also
 *     proves the forward bijective over the basis domain.
 *
 * An opaque column carrying no intent tag (or `= false`) is *not* a deploy error
 * — it is an intentional read-only/derived column (its write reds `no-inverse` at
 * mutation time, as today), per the prover's soundness-over-completeness principle
 * and the no-over-block requirement (`docs/lens.md` § Computed and Generated
 * Columns). The intent is a deploy-policy input, not a property of the body's
 * complement, so it lives here in the diagnostic wrapper — `computeRoundTrip` and
 * `roundTripObstruction` are untouched. The branch keys off the round-trip
 * verdict's `v.writable` (which admits an invertible *composed* expression like
 * `(speed + 1) - 2`), NOT `isReconstructibleColumn` (the bare-column test, which
 * would false-fire on such a chain).
 *
 * Degrade-to-safe: returns `[]` (today's behaviour — the mutation-time and
 * key-reconstructibility nets still govern) whenever the complement cannot
 * characterize the body (out of the single-source projection-and-filter fragment,
 * lineage not threaded, or a non-negation-free residual). In that case there are
 * no per-column verdicts and the writable-intent branch does **not** fire — so an
 * out-of-fragment opaque column tagged writable does not deploy-block; it still
 * reds `no-inverse` at mutation time. This completeness gap is intentional. The
 * body is planned **logically** ({@link planLogicalBody}, not `ctx.root`) so the
 * Project/Filter/TableReference operator tree threading `updateLineage` survives.
 * See `docs/lens.md` § Round-trip and `docs/view-updateability.md`
 * § The predicate-honest complement.
 */
function proveRoundTrip(ctx: ProveContext, readOnly: boolean, errors: LensDiagnostic[], warnings: LensDiagnostic[]): void {
	const root = planLogicalBody(ctx);
	if (!root) return; // body failed to plan logically → safe verdict
	const verdicts = computeRoundTrip(root);
	if (!verdicts) return; // out of fragment / indeterminate complement → safe verdict

	verdicts.forEach((v, i) => {
		// Site at the *logical* column (the contract spelling), positionally aligned
		// with the body output — the same space `column_info` derives writability in.
		const column = ctx.outputColumns[i] ?? v.name;

		// (3) An authored (`with inverse`) column: writable by construction (the
		// intent branch below never fires), PutGet checked by composition, GetPut
		// surrendered into the `lens.getput-lossy` advisory.
		if (v.authored) {
			checkAuthoredInverse(ctx, column, v.authored, v.forward, readOnly, errors, warnings);
			return;
		}

		// (1) A column the lens presents as writable whose round-trip cannot be
		// proved faithful — the original firing rule, unchanged.
		if (v.writable && !v.faithful) {
			errors.push({
				code: 'lens.non-invertible',
				severity: 'error',
				site: { table: ctx.table.name, column },
				message: `lens: writable column '${ctx.table.name}.${column}' is not faithfully invertible at the lens boundary (${v.obstruction}); its GetPut/PutGet round-trip cannot be proved, so the declared write path is unsound`,
			});
			return;
		}

		// (2) An opaque / read-only column the author declared writable via the
		// `quereus.lens.writable = true` intent tag. Today it would be silently
		// admitted read-only; the asserted intent turns that into an authoring error.
		if (!v.writable && intentWritable(ctx, column)) {
			errors.push({
				code: 'lens.non-invertible',
				severity: 'error',
				site: { table: ctx.table.name, column },
				message: `lens: column '${ctx.table.name}.${column}' is declared writable ('${LENS_WRITABLE_INTENT_TAG}' = true) but its lens body is computed/opaque with no invertible write path; the round-trip law cannot be satisfied, so the declared writable intent is unsound (map it to an invertible basis expression, or drop the tag to deploy it read-only)`,
			});
		}
	});
}

/**
 * Whether the logical column named `column` carries the writable-intent signal
 * (`quereus.lens.writable = true`). Resolves the logical column case-insensitively
 * via the same `logicalColIndex` the rest of the prover uses, then reads the tag
 * as a real boolean (`=== true`): `validateReservedTags` has already rejected a
 * non-boolean value at deploy, so a surviving non-`true` value is `false`/absent.
 */
function intentWritable(ctx: ProveContext, column: string): boolean {
	const li = ctx.logicalColIndex.get(column.toLowerCase());
	if (li === undefined) return false;
	return ctx.table.columns[li]?.tags?.[LENS_WRITABLE_INTENT_TAG] === true;
}

/**
 * Plan the lens body **logically** (the `view_info`/`column_info` and mutation
 * substrate path via `_buildPlan`, *not* the optimized `ctx.root`), so the clean
 * Project/Filter/TableReference operator tree — and the `updateLineage` it threads
 * — survives (the optimizer degrades a structure-rewriting node's lineage to
 * `computed`; `docs/view-updateability.md` § surface authority). Guarded with the
 * same graceful-degradation `try/catch` as {@link planBody}.
 */
function planLogicalBody(ctx: ProveContext): RelationalPlanNode | undefined {
	try {
		const { plan } = ctx.db._buildPlan([ctx.slot.compiledBody as AST.Statement]);
		return plan.getRelations()[0];
	} catch (e) {
		log('lens-prover: round-trip body failed to plan logically, degrading to safe: %O', e);
		return undefined;
	}
}

/** The per-output-column round-trip verdict over a planned single-source body. */
export interface ColumnRoundTrip {
	readonly attrId: number;
	/** Body-output column name (the lens spells these as the logical columns). */
	readonly name: string;
	/** The lens presents this column as writable (a `base` {@link ResolvedBaseSite}). */
	readonly writable: boolean;
	/** A *writable* column whose GetPut/PutGet round-trip is proved faithful. */
	readonly faithful: boolean;
	/** Names the obstruction for a writable-but-unfaithful column (else undefined). */
	readonly obstruction?: string;
	/**
	 * The authored (`with inverse`) put payload, when the column's write path is
	 * authored. Such a column is writable+faithful *structurally*; its law
	 * treatment is the prover's authored branch ({@link checkAuthoredInverse}) —
	 * PutGet by enumeration, GetPut surrendered into the lossy advisory.
	 */
	readonly authored?: AuthoredSite;
	/** The forward `get` expression off the topmost projection (carried for the authored branch's composition). */
	readonly forward?: AST.Expression;
}

/**
 * The computed per-column GetPut/PutGet verdict over a planned **logical** body —
 * the deploy-time predicate `proveRoundTrip` consumes, exported so the operational
 * round-trip harness (`test/property.spec.ts` § View Round-Trip Laws) can assert
 * it agrees with the operational law per column.
 *
 * Returns `undefined` (the degrade-to-safe signal) for any body the complement
 * does not characterize: not single-source projection-and-filter (multi-source /
 * join / aggregate / set-op / VALUES / recursive-CTE / LIMIT / OFFSET / DISTINCT),
 * `updateLineage` not threaded, or a residual predicate that is not negation-free.
 * Otherwise one verdict per output column, in attribute order.
 *
 * Each writable site is read through {@link resolveBaseSite} — the same n-way
 * reader the single-source, join, and decomposition put paths share — so the
 * GetPut hidden-column and PutGet inverse-domain checks already generalize past
 * single-source when the complement is later defined on the join/decomposition
 * fragment (`view-write-through-shape-gaps`); only the fragment gate here is
 * single-source-only.
 */
export function computeRoundTrip(root: RelationalPlanNode): ColumnRoundTrip[] | undefined {
	if (!isSingleSourceProjectionFilter(root)) return undefined;
	const lineage = root.physical.updateLineage;
	if (!lineage) return undefined; // lineage not threaded ⇒ complement cannot be characterized

	const complement = viewComplement(root);
	if (complement.residualPredicate && !isNegationFree(complement.residualPredicate)) {
		return undefined; // a non-negation-free residual signals the complement is not honestly determined
	}

	const hidden = new Set(complement.hiddenColumns.map(h => h.column.toLowerCase()));
	const forwardByAttr = collectForwardExprs(root);

	return root.getAttributes().map((attr): ColumnRoundTrip => {
		const site = resolveBaseSite(lineage.get(attr.id));
		if (!site.writable) {
			return { attrId: attr.id, name: attr.name, writable: false, faithful: false };
		}
		// An authored (`with inverse`) put: the structural obstructions below are
		// inapplicable (no single verbatim base column, no registry inverse) — the
		// verdict is writable+faithful with the authored payload attached for the
		// prover's dedicated law treatment (enumeration + lossy advisory).
		if (site.authored) {
			return { attrId: attr.id, name: attr.name, writable: true, faithful: true, authored: site.authored, forward: forwardByAttr.get(attr.id) };
		}
		const obstruction = roundTripObstruction(site, hidden, forwardByAttr.get(attr.id), complement.residualPredicate);
		return { attrId: attr.id, name: attr.name, writable: true, faithful: obstruction === undefined, obstruction };
	});
}

/**
 * The GetPut / PutGet obstruction for a writable column, or `undefined` when its
 * round-trip is proved faithful:
 *  - **GetPut** — `put` leaves the complement fixed: the writable base column is
 *    not one the complement lists as hidden (holds structurally over the single-
 *    source fragment — a guard that reds the day a shape violates it).
 *  - **PutGet** — `get ∘ put` reproduces the written value ({@link getPutComposesToIdentity},
 *    over the closed registry vocabulary), and any inverse `domain` is entailed by
 *    the residual. The shipped registry is faithful with unrestricted domains, so
 *    this returns `undefined` for it — the seam stays correct as the registry
 *    grows a domain-restricted or composed profile.
 */
function roundTripObstruction(
	site: ResolvedBaseSite,
	hidden: ReadonlySet<string>,
	forward: AST.Expression | undefined,
	residual: AST.Expression | undefined,
): string | undefined {
	if (site.baseColumn !== undefined && hidden.has(site.baseColumn.toLowerCase())) {
		return `GetPut: the write-back targets base column '${site.baseColumn}', which the view-complement holds fixed`;
	}
	// `get ∘ put = id` is verifiable only with the forward `get` expression; if it is
	// unavailable (no Project node found) degrade to safe — the shipped registry is
	// faithful by construction, so a missing forward never masks a real violation.
	if (site.inverse !== undefined && forward !== undefined && !getPutComposesToIdentity(forward, site.inverse)) {
		return `PutGet: the 'put' inverse does not reproduce the written value back through 'get'`;
	}
	if (site.domain !== undefined && !domainEntailedBy(site.domain, residual)) {
		return `PutGet: the inverse's domain restriction is not entailed by the view predicate`;
	}
	return undefined;
}

/**
 * The single-source projection-and-filter fragment gate. Reuses {@link classifyViewBody}
 * (the substrate's shape classifier) to reject multi-source / join / aggregate /
 * set-op / VALUES / recursive-CTE bodies, then additionally rejects LIMIT / OFFSET /
 * DISTINCT — which that classifier tolerates as pass-through (so its walk can reach
 * the base table) but the complement does not characterize.
 */
function isSingleSourceProjectionFilter(root: RelationalPlanNode): boolean {
	if (classifyViewBody(root).kind !== 'single-source') return false;
	let windowed = false;
	const visit = (n: PlanNode): void => {
		if (n.nodeType === PlanNodeType.LimitOffset || n.nodeType === PlanNodeType.Distinct) windowed = true;
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return !windowed;
}

/**
 * The forward `get` expression per output attribute, read off the topmost
 * {@link ProjectNode}'s projection list (which the planner aligns 1:1 with output
 * attributes, expanding `select *`). The `get` half of the round-trip; the `put`
 * half is the site's `inverse`.
 */
function collectForwardExprs(root: RelationalPlanNode): Map<number, AST.Expression> {
	const map = new Map<number, AST.Expression>();
	const project = findProjectNode(root);
	if (project) {
		for (const p of project.getProjections()) map.set(p.attributeId, p.node.expression);
	}
	return map;
}

/** The topmost {@link ProjectNode} in a planned body's relational spine, or undefined. */
function findProjectNode(node: PlanNode): ProjectNode | undefined {
	if (node instanceof ProjectNode) return node;
	for (const child of node.getRelations()) {
		const found = findProjectNode(child);
		if (found) return found;
	}
	return undefined;
}

/** Numeric probes for the `get ∘ put = id` check — distinct points pin any affine map. */
const ROUND_TRIP_PROBES: readonly number[] = [7, 13, -5];

/**
 * PutGet identity probe: is the composed `get ∘ put` the identity on the writable
 * value? For each probe `w`, lowers it through the `put` inverse to a base value
 * and re-applies the forward `get`, requiring `get(put(w)) === w`. Sound because a
 * writable column's `get` and the inverse's `put` are built **only** from the
 * law-gated invertibility registry's closed vocabulary (column ref, `± k`, no-op
 * cast, collate), which {@link evalClosed} evaluates exactly; an expression outside
 * it yields `undefined` and reds (the analysis cannot prove faithfulness).
 *
 * Exported as the pure core the operational harness's injected-violation self-test
 * drives (an unfaithful forward/inverse pair must red), mirroring the harness's
 * `injected-widening` / `injected-getput` cores.
 */
export function getPutComposesToIdentity(
	forward: AST.Expression,
	inverse: (written: AST.Expression) => AST.Expression,
): boolean {
	for (const w of ROUND_TRIP_PROBES) {
		const baseVal = evalClosed(inverse({ type: 'literal', value: w }), undefined); // put: written → base
		if (baseVal === undefined) return false;
		const got = evalClosed(forward, baseVal); // get: base → written
		if (got === undefined || got !== w) return false;
	}
	return true;
}

/**
 * Synchronous evaluator over the **closed** invertibility-registry vocabulary —
 * literal (int/real), the bound column (`columnValue`), `+`/`-`/`*` binary, unary
 * `±`, and the value-preserving `cast`/`collate` wrappers. Returns `undefined` for
 * anything outside that set (the signal that the expression is not a registry
 * round-trip term). Total and side-effect-free — NOT a general expression
 * interpreter; the writable fragment never contains anything else.
 */
function evalClosed(expr: AST.Expression, columnValue: number | undefined): number | undefined {
	switch (expr.type) {
		case 'literal': {
			const v = (expr as AST.LiteralExpr).value;
			if (typeof v === 'number') return v;
			if (typeof v === 'bigint') return Number(v);
			return undefined;
		}
		case 'column':
			return columnValue;
		case 'cast':
			return evalClosed((expr as AST.CastExpr).expr, columnValue);
		case 'collate':
			return evalClosed((expr as AST.CollateExpr).expr, columnValue);
		case 'unary': {
			const u = expr as AST.UnaryExpr;
			const o = evalClosed(u.expr, columnValue);
			if (o === undefined) return undefined;
			if (u.operator === '-') return -o;
			if (u.operator === '+') return o;
			return undefined;
		}
		case 'binary': {
			const b = expr as AST.BinaryExpr;
			const l = evalClosed(b.left, columnValue);
			const r = evalClosed(b.right, columnValue);
			if (l === undefined || r === undefined) return undefined;
			switch (b.operator) {
				case '+': return l + r;
				case '-': return l - r;
				case '*': return l * r;
				default: return undefined;
			}
		}
		default:
			return undefined;
	}
}

/**
 * Whether a residual predicate is negation-free — `viewComplement` carries the σ
 * conjuncts verbatim, so the presence of `not` / `is not null` / `!=` (`<>`) /
 * `not between` means the complement is **not** honestly determined and the
 * round-trip check must degrade to the safe verdict. A reflective walk mirroring
 * {@link collectColumnRefNames}.
 */
function isNegationFree(expr: AST.Expression): boolean {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'unary') {
			const op = (node as AST.UnaryExpr).operator;
			if (op === 'NOT' || op === 'IS NOT NULL') return false;
		}
		if (node.type === 'binary' && ((node as AST.BinaryExpr).operator === '!=' || (node as AST.BinaryExpr).operator === '<>')) {
			return false;
		}
		if (node.type === 'between' && (node as AST.BetweenExpr).not === true) return false;
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
	return true;
}

/**
 * Best-effort structural entailment of an inverse's `domain` by the residual
 * predicate — the residual's AND-conjuncts include the domain verbatim. Unreachable
 * today (the shipped registry's profiles carry no `domain`); the conservative seam
 * for a future domain-restricted profile (an un-entailed domain ⇒ a value the view
 * admits could be stored that `get` cannot reproduce ⇒ red).
 */
function domainEntailedBy(domain: AST.Expression, residual: AST.Expression | undefined): boolean {
	if (residual === undefined) return false;
	const conjuncts: AST.Expression[] = [];
	const split = (e: AST.Expression): void => {
		if (e.type === 'binary' && (e as AST.BinaryExpr).operator === 'AND') {
			split((e as AST.BinaryExpr).left);
			split((e as AST.BinaryExpr).right);
		} else {
			conjuncts.push(e);
		}
	};
	split(residual);
	const target = expressionToString(domain);
	return conjuncts.some(c => expressionToString(c) === target);
}

// ---------------------------------------------------------------------------
// Authored inverses (`with inverse`) — PutGet by enumeration, GetPut advisory.
// See docs/lens.md § Computed and Generated Columns (authored inverses) and
// docs/view-updateability.md § Authored inverses (law treatment).
// ---------------------------------------------------------------------------

/** The authored put payload off a resolved {@link ResolvedBaseSite}. */
type AuthoredSite = NonNullable<ResolvedBaseSite['authored']>;

/** Enumeration cap — a CHECK `in (...)` domain larger than this degrades to safe. */
const ENUM_DOMAIN_CAP = 64;

/** The outcome of the PutGet composition enumeration over one authored column. */
type PutGetEnumeration =
	| { readonly kind: 'proved'; readonly injective: boolean; readonly domain: readonly SqlValue[] }
	| { readonly kind: 'violation'; readonly value: SqlValue; readonly got: SqlValue; readonly domain: readonly SqlValue[] }
	| { readonly kind: 'indeterminate'; readonly domain?: readonly SqlValue[] };

/**
 * The law treatment for one authored-inverse column (firing-rule branch 3):
 *
 *  - **PutGet** (`forward(inverse(v)) ≡ v`) — checked by composition over the
 *    logical column's enumerable CHECK `in (...)` domain
 *    ({@link provePutGetByEnumeration}). A value that fails to reproduce is the
 *    hard `lens.putget-violation` error (a put that loses the written value is
 *    never acceptable), sited at the column and naming the offending value. No
 *    enumerable domain / non-const-foldable composition → degrade to safe
 *    (admit; mutation-time behavior governs — the prover's usual posture, no
 *    advisory for the unverified case).
 *  - **GetPut** — surrendered by design for a non-injective forward (a
 *    write-through normalizes the base value to the inverse's representative):
 *    the acknowledgeable `lens.getput-lossy` advisory, suppressed only when the
 *    enumeration also proves the forward bijective
 *    ({@link proveForwardInjective}). Suppressed wholesale on a read-only table
 *    (mutations never run the put — same gate as `lens.no-backing-index`); the
 *    PutGet error is NOT read-only-gated, mirroring branch (1)'s posture that a
 *    provably unsound declared write path is an authoring error regardless.
 *
 * The advisory's fingerprint carries the rendered domain values, so a CHECK
 * list change (the domain gains a value) re-surfaces an acknowledgment.
 */
function checkAuthoredInverse(
	ctx: ProveContext,
	column: string,
	authored: AuthoredSite,
	forward: AST.Expression | undefined,
	readOnly: boolean,
	errors: LensDiagnostic[],
	warnings: LensDiagnostic[],
): void {
	const result = provePutGetByEnumeration(ctx, column, authored, forward);
	if (result.kind === 'violation') {
		errors.push({
			code: 'lens.putget-violation',
			severity: 'error',
			site: { table: ctx.table.name, column },
			message: `lens: authored inverse on '${ctx.table.name}.${column}' violates PutGet — writing ${renderSqlValue(result.value)} stores a basis image that reads back as ${renderSqlValue(result.got)}; forward(inverse(v)) must reproduce every value of the column's CHECK domain (fix the 'with inverse' expression or the forward mapping)`,
		});
		return;
	}
	if (result.kind === 'proved' && result.injective) return; // bijective over the enumerated domains ⇒ GetPut holds too
	if (readOnly) return; // the put never runs on a read-only table — the lossy advisory is moot

	warnings.push({
		code: 'lens.getput-lossy',
		severity: 'warning',
		site: { table: ctx.table.name, column },
		message: `lens: column '${ctx.table.name}.${column}' writes through an authored inverse whose forward mapping is not proven injective — GetPut is surrendered (a write-through normalizes the stored basis value to the inverse's representative). Acknowledge with 'quereus.lens.ack.getput-lossy:${column.toLowerCase()}' if intentional, or make the forward bijective over enumerable CHECK domains.`,
		fingerprintInputs: {
			...buildFingerprint(ctx, [column], false),
			...(result.domain ? { domainValues: result.domain.map(renderSqlValue).sort() } : {}),
		},
	});
}

/**
 * PutGet by composition: per logical-domain value `v`, lower `v` through every
 * authored put (substituting the `new.<col>` refs with the literal), then re-read
 * it through the forward `get` with each referenced base column bound to its put
 * image — requiring `forward(inverse(v)) ≡ v` under SQL value equality.
 *
 * Preconditions (any miss ⇒ `indeterminate`, the degrade-to-safe signal):
 * a forward expression resolved off the projection; a single basis source (the
 * forward's column refs name-match against put targets — ambiguous past
 * single-source); an inverse that is a function of the written column alone
 * (every `new.*` ref resolves to this column); a deterministic, subquery-free
 * forward + puts ({@link constEvaluable} — the composition is evaluated with the
 * const evaluator only, never a vtab read); and every forward column ref covered
 * by a put target. A definite per-value violation wins over another value's
 * evaluation failure (it is a proven law break either way).
 */
function provePutGetByEnumeration(
	ctx: ProveContext,
	column: string,
	authored: AuthoredSite,
	forward: AST.Expression | undefined,
): PutGetEnumeration {
	const li = ctx.logicalColIndex.get(column.toLowerCase());
	const domain = li !== undefined ? enumerableDomain(getCheckExtraction(ctx.table), li) : undefined;
	if (!domain) return { kind: 'indeterminate' };

	const oi = ctx.outputIndex.get(column.toLowerCase());
	if (forward === undefined || ctx.basisSource === undefined || oi === undefined) return { kind: 'indeterminate', domain };
	for (const refIdx of authored.newRefIndex.values()) {
		if (refIdx !== oi) return { kind: 'indeterminate', domain };
	}
	if (!constEvaluable(ctx.db, forward) || authored.puts.some(p => !constEvaluable(ctx.db, p.expr))) {
		return { kind: 'indeterminate', domain };
	}
	const putTargets = new Set(authored.puts.map(p => p.baseColumn.toLowerCase()));
	if (collectColumnRefNames(forward).some(n => !putTargets.has(n.toLowerCase()))) {
		return { kind: 'indeterminate', domain }; // the forward reads a base column the inverse does not determine
	}

	// `forward(inverse(v))`, or undefined when any step is not const-evaluable.
	const composition = (v: SqlValue): SqlValue | undefined => {
		const baseImage = new Map<string, SqlValue>();
		for (const p of authored.puts) {
			const bv = evalDeployConstant(ctx.db, substituteNewRefs(p.expr, () => ({ type: 'literal', value: v })));
			if (bv === undefined) return undefined;
			baseImage.set(p.baseColumn.toLowerCase(), bv);
		}
		return evalDeployConstant(ctx.db, substituteBaseRefs(forward, baseImage));
	};

	let indeterminate = false;
	for (const v of domain) {
		const got = composition(v);
		if (got === undefined) { indeterminate = true; continue; }
		if (!sqlValueEquals(got, v)) return { kind: 'violation', value: v, got, domain };
	}
	if (indeterminate) return { kind: 'indeterminate', domain };
	return { kind: 'proved', injective: proveForwardInjective(ctx, authored, forward, domain), domain };
}

/**
 * Forward injectivity over the basis column's own enumerable CHECK domain. With
 * PutGet proved over the logical domain, an injective forward whose image stays
 * *inside* that logical domain makes the pair bijective between the two
 * enumerated domains, so GetPut holds (`put(get(b)) = b` for every basis value)
 * and the lossy advisory is suppressed. Conservative: requires a single put
 * target backed by a NOT NULL basis column (a nullable basis admits a value
 * outside the enumeration) and a const-evaluable, never-NULL forward image at
 * every basis value. The forward's refs ⊆ put targets was already established
 * by the caller, so the single binding covers every ref.
 */
function proveForwardInjective(
	ctx: ProveContext,
	authored: AuthoredSite,
	forward: AST.Expression,
	logicalDomain: readonly SqlValue[],
): boolean {
	const basis = ctx.basisSource;
	if (!basis || authored.puts.length !== 1) return false;
	const put = authored.puts[0];
	const bi = basis.columnIndexMap.get(put.baseColumn.toLowerCase());
	if (bi === undefined || !basis.columns[bi]?.notNull) return false;
	const basisDomain = enumerableDomain(getCheckExtraction(basis), bi);
	if (!basisDomain) return false;

	const seen: SqlValue[] = [];
	for (const b of basisDomain) {
		const got = evalDeployConstant(ctx.db, substituteBaseRefs(forward, new Map([[put.baseColumn.toLowerCase(), b]])));
		if (got === undefined || got === null) return false;
		if (!logicalDomain.some(v => sqlValueEquals(v, got))) return false; // image escapes the PutGet-proved domain
		if (seen.some(s => sqlValueEquals(s, got))) return false;           // two basis values collapse — not injective
		seen.push(got);
	}
	return true;
}

/**
 * The enumerable CHECK domain of one column: the literal `in (...)` value list,
 * intersected across multiple enum CHECKs and filtered through any recognized
 * range CHECK on the same column — the enumeration must never include a value
 * the declared CHECK surface already excludes, since a false
 * `lens.putget-violation` would block a sound deploy. NULLs are dropped (an
 * `in` list never admits one). Undefined when no enum constraint exists, the
 * filtered domain is empty, or it exceeds {@link ENUM_DOMAIN_CAP}.
 */
function enumerableDomain(extraction: CheckExtraction, columnIndex: number): SqlValue[] | undefined {
	let values: SqlValue[] | undefined;
	for (const dc of extraction.domainConstraints) {
		if (dc.column !== columnIndex || dc.kind !== 'enum') continue;
		const list = dc.values.filter(v => v !== null);
		values = values === undefined ? list : values.filter(v => list.some(w => sqlValueEquals(v, w)));
	}
	if (values === undefined) return undefined;
	for (const dc of extraction.domainConstraints) {
		if (dc.column !== columnIndex || dc.kind !== 'range') continue;
		values = values.filter(v => withinRange(v, dc));
	}
	if (values.length === 0 || values.length > ENUM_DOMAIN_CAP) return undefined;
	return values;
}

/** Whether `v` satisfies a recognized range domain constraint. */
function withinRange(v: SqlValue, r: Extract<DomainConstraint, { kind: 'range' }>): boolean {
	if (r.min !== undefined) {
		const c = compareSqlValues(v, r.min);
		if (r.minInclusive ? c < 0 : c <= 0) return false;
	}
	if (r.max !== undefined) {
		const c = compareSqlValues(v, r.max);
		if (r.maxInclusive ? c > 0 : c >= 0) return false;
	}
	return true;
}

/**
 * Whether an expression is sound to fold at deploy with the const evaluator:
 * deterministic functions only and no subquery —
 * {@link containsNonDeterministicCall} flags both (a vtab read can never be a
 * deploy-time constant). An unregistered function is treated deterministic; its
 * evaluation failing falls through {@link evalDeployConstant}'s degrade anyway.
 */
function constEvaluable(db: Database, expr: AST.Expression): boolean {
	const isDeterministic = (name: string, argc: number): boolean => {
		const fn = db.schemaManager.findFunction(name, argc) ?? db.schemaManager.findFunction(name, -1);
		return fn ? (fn.flags & FunctionFlags.DETERMINISTIC) !== 0 : true;
	};
	return !containsNonDeterministicCall(expr, isDeterministic);
}

/** Replace each (qualifier-agnostic) base-column reference with its literal image. */
function substituteBaseRefs(expr: AST.Expression, baseImage: ReadonlyMap<string, SqlValue>): AST.Expression {
	return transformExpr(expr, col => {
		const v = baseImage.get(col.name.toLowerCase());
		return v === undefined ? undefined : { type: 'literal', value: v };
	});
}

/**
 * Evaluate a column-free scalar expression at deploy via the engine's own const
 * evaluator (`createRuntimeExpressionEvaluator`) — never a vtab read; the
 * expression is planned as a bare one-column SELECT so it builds in an empty
 * scope. Returns undefined (the degrade-to-safe signal) when the expression
 * fails to build, evaluates asynchronously (not a deploy-time constant), or
 * throws.
 */
function evalDeployConstant(db: Database, expr: AST.Expression): SqlValue | undefined {
	try {
		const stmt: AST.SelectStmt = { type: 'select', columns: [{ type: 'column', expr }] };
		const { plan } = db._buildPlan([stmt as AST.Statement]);
		const root = plan.getRelations()[0];
		const node = root === undefined ? undefined : findProjectNode(root)?.getProjections()[0]?.node;
		if (!node) return undefined;
		const value = createRuntimeExpressionEvaluator(db)(node);
		if (value instanceof Promise) {
			void value.catch(() => undefined); // async ⇒ not a deploy-time constant; never crash the deploy on it
			return undefined;
		}
		return value as SqlValue;
	} catch (e) {
		log('lens-prover: authored-inverse composition failed to const-evaluate, degrading to safe: %O', e);
		return undefined;
	}
}

/**
 * Maps each authored-inverse logical column (lowercased) to its **forward** `get`
 * expression (basis terms), when that forward is row-local-enforceable — a
 * subquery-free scalar over basis column refs. This is the agreement predicate
 * between the prover's CHECK realizability classifier
 * ({@link classifyCheckConstraint}: a CHECK referencing an authored column is
 * row-local exactly when this map has the column) and the write-time
 * logical→basis rewrite (`planner/mutation/lens-enforcement.ts`), which
 * substitutes the forward — `NEW.`-qualified — for the column ref so the CHECK
 * evaluates over the basis write row's logical image. The two must accept the
 * same set, or a deploy-admitted CHECK would crash at write plan time.
 */
export function authoredForwardMap(slot: LensSlot): Map<string, AST.Expression> {
	const map = new Map<string, AST.Expression>();
	slot.columnProvenance.forEach((p, i) => {
		const rc = slot.compiledBody.columns[i];
		if (rc && rc.type === 'column' && rc.inverse && rc.inverse.length > 0 && !containsRelationalOperand(rc.expr)) {
			map.set(p.logicalColumn.toLowerCase(), rc.expr);
		}
	});
	return map;
}

/** Reflective walk: does the expression contain a relational operand (subquery / exists / in-subquery)? */
function containsRelationalOperand(expr: AST.Expression): boolean {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'subquery' || node.type === 'exists') return true;
		if (node.type === 'in' && (node as AST.InExpr).subquery) return true;
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
	return false;
}

/** SQL value equality for the enumeration (NULL equals only NULL — identity, not three-valued `=`). */
function sqlValueEquals(a: SqlValue, b: SqlValue): boolean {
	if (a === null || b === null) return a === null && b === null;
	return compareSqlValues(a, b) === 0;
}

/** Render a domain value for a sited message / fingerprint (text quoted, so '1' ≠ 1). */
function renderSqlValue(v: SqlValue): string {
	if (v === null) return 'NULL';
	return typeof v === 'string' ? `'${v}'` : String(v);
}

// ---------------------------------------------------------------------------
// Constraint realizability + obligation classification
// ---------------------------------------------------------------------------

/**
 * Classifies every attached logical constraint into a {@link ConstraintObligation}
 * and, in the process, performs the *constraint realizability* error check
 * (`lens.unrealizable-constraint`): a constraint referencing a column with no
 * write path (computed lineage) is neither provable nor attachable.
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
 * resolve to absent a statement-level OR clause. A key declaring REPLACE / IGNORE
 * here is rejected at deploy when the realizing path cannot honor it: the
 * commit-time set-level scan can only ABORT (see {@link classifyKeyConstraint}),
 * and the row-time path honors the *basis* UC's action, not the logical key's
 * (see {@link rejectRowTimeConflictAction}) — both raise `lens.unenforceable-conflict-action`.
 *
 *  - `unique` → the constraint's own `defaultConflict`.
 *  - `primaryKey` → {@link resolvePkDefaultConflict}: table-level
 *    `PRIMARY KEY (...) ON CONFLICT <action>` (`TableSchema.primaryKeyDefaultConflict`),
 *    else the column-level `ColumnSchema.defaultConflict` on **any** PK column —
 *    the precedence the runtime resolvers actually use, so the deploy-time check
 *    agrees with what a duplicate would resolve to. A non-first PK column's
 *    `not null on conflict replace` counts (it sets `defaultConflict` too); the
 *    PK's action is NOT on the `LogicalConstraint` node, so it must come from `ctx.table`.
 *
 * Returns undefined when no action is declared (⇒ ABORT, which the scan honors).
 */
function effectiveKeyDefaultConflict(ctx: ProveContext, constraint: LogicalConstraint): ConflictResolution | undefined {
	switch (constraint.kind) {
		case 'unique':
			return constraint.constraint.defaultConflict;
		case 'primaryKey':
			return resolvePkDefaultConflict(ctx.table);
		default:
			return undefined;
	}
}

/** Render a conflict action for a sited message; an absent action resolves to ABORT. */
function conflictActionName(action: ConflictResolution | undefined): string {
	return ConflictResolution[action ?? ConflictResolution.ABORT].toLowerCase();
}

/**
 * Classifies a key constraint (primary key / unique). Empty key ⇒ vacuous
 * (singleton).
 *
 * A column with no write path (computed lineage) is handled by class:
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
				message: `lens: ${label} on '${ctx.table.name}' references column '${name ?? `#${li}`}', which has no write path at the lens boundary (computed lineage); the constraint can be neither proved nor enforced`,
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
	const covering = findBasisCovering(ctx, logicalColumns);
	if (covering) {
		rejectRowTimeConflictAction(ctx, constraint, covering, label, columnNames, readOnly, errors);
		return { constraint, kind: 'enforced-set-level', mode: 'row-time', structure: covering.ref };
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
 * Row-time sibling of the commit-time `lens.unenforceable-conflict-action` block.
 * A row-time key is enforced by re-planning the lens write against the basis UC,
 * whose conflict action resolves as `statement-OR ?? basis-uc.defaultConflict ??
 * ABORT` (the memory / isolation / store resolvers all agree) — the *logical*
 * key's own `defaultConflict` is never consulted in that re-plan. So a logical
 * `on conflict replace`/`ignore` the backing basis UC does NOT itself carry is
 * silently dropped to ABORT at write time (with no statement-level OR), violating
 * the declared action. Reject it at deploy, mirroring the commit-time channel.
 *
 * Fires only when the logical effective action is REPLACE / IGNORE *and* differs
 * from the basis UC's own `defaultConflict`: when they match, the basis UC already
 * resolves the declared action for free (the documented remediation), so there is
 * nothing to reject. ABORT / FAIL / ROLLBACK (and no declared action) never reject
 * — consistent with the commit-time block, which only rejects REPLACE / IGNORE.
 * Gated on `!readOnly`: a read-only table never writes, so the action is moot.
 */
function rejectRowTimeConflictAction(
	ctx: ProveContext,
	constraint: LogicalConstraint,
	covering: BasisCovering,
	label: string,
	columnNames: readonly string[],
	readOnly: boolean,
	errors: LensDiagnostic[],
): void {
	if (readOnly) return;
	const effectiveConflict = effectiveKeyDefaultConflict(ctx, constraint);
	if (effectiveConflict !== ConflictResolution.REPLACE && effectiveConflict !== ConflictResolution.IGNORE) return;
	if (effectiveConflict === covering.uc.defaultConflict) return; // basis UC honors it for free

	errors.push({
		code: 'lens.unenforceable-conflict-action',
		severity: 'error',
		site: { table: ctx.table.name, constraint: label },
		message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) declares 'on conflict ${conflictActionName(effectiveConflict)}', but its backing basis UNIQUE/PK (covering structure '${covering.ref.name}') resolves a duplicate to '${conflictActionName(covering.uc.defaultConflict)}' — the row-time write path honors the basis UC's action, not the logical key's, so the declared action would be silently dropped. Declare the matching 'on conflict ${conflictActionName(effectiveConflict)}' on the basis UNIQUE/PK, or drop the logical conflict action.`,
	});
}

/**
 * Classifies a `check` constraint. A check referencing a column with no write
 * path (computed lineage) is unrealizable (error). Otherwise it is row-local —
 * evaluable on the projected row at the write boundary. (Vacuous-by-body-predicate
 * detection is deferred; a row-local check is always sound, just possibly redundant.)
 *
 * An **authored-inverse** column ({@link authoredForwardMap}) has a write path —
 * the put expressions — and its CHECK stays row-local: the write-time rewrite
 * substitutes the column's forward `get` (`NEW.`-qualified basis terms) for the
 * ref, so the CHECK evaluates over the written basis row's logical image. The
 * map already excludes a forward the rewrite cannot substitute (subquery-
 * bearing), keeping deploy acceptance and write-time enforceability in lockstep.
 */
function classifyCheckConstraint(
	ctx: ProveContext,
	constraint: LogicalConstraint & { kind: 'check' },
	errors: LensDiagnostic[],
): ConstraintObligation {
	const label = constraintLabel(constraint);
	const authoredForwards = authoredForwardMap(ctx.slot);
	for (const ref of collectColumnRefNames(constraint.constraint.expr)) {
		const li = ctx.logicalColIndex.get(ref.toLowerCase());
		if (li === undefined) continue; // not a logical column of this table — leave to body resolution
		if (!isReconstructibleColumn(ctx, ref) && !authoredForwards.has(ref.toLowerCase())) {
			errors.push({
				code: 'lens.unrealizable-constraint',
				severity: 'error',
				site: { table: ctx.table.name, constraint: label, column: ref },
				message: `lens: ${label} on '${ctx.table.name}' references column '${ref}', which has computed lineage (no write path); a check over it cannot be enforced at the lens boundary`,
			});
			return { constraint, kind: 'enforced-row-local' };
		}
	}
	return { constraint, kind: 'enforced-row-local' };
}

// ---------------------------------------------------------------------------
// Basis covering-structure resolution (row-time vs commit-time)
// ---------------------------------------------------------------------------

/** The matching basis UC and the row-time covering structure that answers it. */
interface BasisCovering {
	readonly ref: CoveringStructureRef;
	readonly uc: UniqueConstraintSchema;
}

/**
 * Resolves the basis covering structure AND the basis UNIQUE constraint backing a
 * logical key: maps each logical column → its basis column (via the single-source
 * body projection), finds a matching basis UNIQUE constraint, and returns a
 * row-time covering MV reference (`coveringStructureName` /
 * `_findRowTimeCoveringStructure`) together with that basis UC. Returning the UC
 * lets two callers inspect it: {@link classifyKeyConstraint}'s row-time
 * conflict-action check (via {@link rejectRowTimeConflictAction} — the basis UC's
 * `defaultConflict` is the action the write path actually honors) and the
 * plan-time FD re-validation ({@link computeLensAssertedKeyFds}, which re-confirms
 * currency and the basis UC's partial predicate against the *current* catalog).
 *
 * Conservative: a multi-source body, an unmapped column, or a missing basis
 * UC/structure all yield `undefined` (⇒ commit-time scan). The retired auto-index
 * is deliberately NOT consulted for a logical schema — the explicit covering MV is
 * the sole row-time structure (`docs/lens.md` § Constraint Attachment). Reads no
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
 * column → its output index; a key column with no output index
 * (not emitted) makes the key inexpressible (⇒ undefined). The
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
		if (oi === undefined) return undefined; // not emitted ⇒ not in the readable relation
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
		basisSource: resolveSingleBasisSource(db.schemaManager, slot.compiledBody, basisSchemaName),
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

/**
 * Collects every `column` reference name in an expression (best-effort reflective walk,
 * qualifier-stripped — returns each `column` node's `.name`). Shared with the lens write
 * side (`planner/mutation/lens-enforcement.ts`), which maps these refs through the slot's
 * logical→basis projection to derive a row-local CHECK's `referencedWriteRowColumns`
 * metadata — keeping the gate's notion of "write-row column" consistent with the prover's
 * notion of "row-local" (both use this walk + logical-column membership; see
 * {@link classifyCheckConstraint}).
 */
export function collectColumnRefNames(expr: AST.Expression): string[] {
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
