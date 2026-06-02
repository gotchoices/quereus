import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Structured reason codes raised when a mutation cannot be propagated through a
 * view. The Phase-1 / 1b rows of the diagnostics union in
 * `docs/view-updateability.md`, plus the "body shape not handled yet" rejections
 * that keep the shipped contract honest (`93.2-view-mutation-pending`).
 */
export type MutationDiagnosticReason =
	// --- doc's structured diagnostics ---
	| 'no-inverse'                 // non-invertible scalar on an update path (Project)
	| 'unknown-view-column'        // a top-level where/set/returning ref names something that is not a column of the view (the encapsulation-leak guard)
	| 'no-default'                 // insert missing a NOT NULL column after the recovery chain
	| 'predicate-contradiction'    // insert violates the view's selection at plan time (Filter)
	| 'recursive-cte'              // recursive CTE as mutation target
	| 'tag-target-not-found'       // tag references unknown branch/table
	| 'tag-conflict'               // target/exclude excludes a side the statement must write
	| 'policy-strict-ambiguity'    // quereus.update.policy=strict rejects a residual fan-out ambiguity
	| 'mutual-fk-restrict-delete'  // a two-side join DELETE fan-out spans a mutual FK whose ON DELETE actions cannot be satisfied in ANY side order under immediate enforcement (deleting either side trips the other's RESTRICT, directly or transitively through a cascade) — no delete_via/target override resolves it; break the cycle by clearing the referencing column(s) first (deferring the constraint does not help — RESTRICT is always immediate)
	// --- "not yet shipped" body-shape rejections (Phase 2+) ---
	| 'unsupported-join'           // join body — Phase 2 / 4
	| 'unsupported-aggregate'      // aggregate / grouping body
	| 'unsupported-set-op'         // union / intersect / except body
	| 'unsupported-window'         // window function in body
	| 'unsupported-limit'          // LIMIT / OFFSET body — a mutation would escape the window
	| 'unsupported-distinct'       // DISTINCT body — not row-decomposable (no 1:1 base lineage)
	| 'no-base-lineage'            // VALUES body / no reachable base table
	| 'nested-view'                // body sources another view / CTE (inline-propagation deferred)
	| 'unsupported-source'         // INSERT source shape we cannot thread filter defaults through yet
	| 'unsupported-multisource-insert' // INSERT into a join view — needs the shared-surrogate context (later phase)
	| 'cross-source-assignment'    // UPDATE value references a base table other than the column it assigns
	| 'conflicting-assignment'     // two SET targets lower to the same base column (e.g. two view columns over one base column); an UPDATE cannot assign one column twice
	| 'unsupported-subquery-correlation' // a view-column ref nested in a predicate/value subquery cannot be proven correlated (unresolvable source / select * / TVF / embedded DML)
	| 'returning-through-view'     // RETURNING projected through a view — Phase 6
	| 'lens-read-only'             // logical table whose PK is not reconstructible at the lens boundary
	| 'lens-set-level-conflict-resolution' // or replace / or ignore / upsert against a commit-time set-level lens key (needs a covering structure)
	// --- decomposition (lens multi-source put) fan-out, advertisement-driven ---
	| 'unsupported-decomposition-insert'    // internal guard: a decomposition INSERT is built via buildDecompositionInsert (envelope), not propagate
	| 'unsupported-decomposition-update'    // UPDATE targets an optional/EAV/key column whose write needs insert/delete branching (deferred)
	| 'unsupported-decomposition-predicate' // a decomposition DELETE/UPDATE WHERE references a non-anchor member — needs snapshot-consistent multi-member execution (deferred)
	| 'unsupported-decomposition-key';      // a decomposition member has a composite/absent shared key (v1 is single-column)

/**
 * Structured mutation diagnostic. Mirrors the `MutationDiagnostic` shape in
 * `docs/view-updateability.md` (kept as `reason` + human `message` here; the
 * `planNodeId` field is omitted in Phase 1 since rejection happens at build
 * time before optimization assigns physical ids).
 */
export interface MutationDiagnostic {
	readonly reason: MutationDiagnosticReason;
	readonly message: string;
	/** The obstructing column, when one applies. */
	readonly column?: string;
	/** The base/view table involved, when one applies. */
	readonly table?: string;
	/** Copy-pasteable remediation fragment (e.g. a `with tags (...)` suggestion). */
	readonly suggestion?: string;
}

/**
 * Error raised when view-mediated mutation propagation fails. Carries the
 * structured {@link MutationDiagnostic} on `.mutationDiagnostic` so callers can
 * inspect the machine-readable reason; the human message (with any suggestion
 * appended) is the `Error.message`.
 */
export class ViewMutationError extends QuereusError {
	readonly mutationDiagnostic: MutationDiagnostic;

	constructor(diagnostic: MutationDiagnostic, line?: number, column?: number) {
		const full = diagnostic.suggestion
			? `${diagnostic.message} ${diagnostic.suggestion}`
			: diagnostic.message;
		super(full, StatusCode.ERROR, undefined, line, column);
		this.name = 'ViewMutationError';
		this.mutationDiagnostic = diagnostic;
	}
}

/** Build and throw a {@link ViewMutationError}. */
export function raiseMutationDiagnostic(diagnostic: MutationDiagnostic, line?: number, column?: number): never {
	throw new ViewMutationError(diagnostic, line, column);
}
