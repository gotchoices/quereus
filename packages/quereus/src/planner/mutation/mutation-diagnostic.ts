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
	| 'no-default'                 // insert missing a NOT NULL column after the recovery chain
	| 'predicate-contradiction'    // insert violates the view's selection at plan time (Filter)
	| 'recursive-cte'              // recursive CTE as mutation target
	| 'tag-target-not-found'       // tag references unknown branch/table
	| 'tag-conflict'               // target/exclude excludes a side the statement must write
	| 'policy-strict-ambiguity'    // quereus.update.policy=strict rejects a residual fan-out ambiguity
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
	| 'delete-ambiguous'           // DELETE through a join with no provable FK-child and no delete_via tag
	| 'returning-through-view'     // RETURNING projected through a view — Phase 6
	| 'lens-read-only'             // logical table whose PK is not reconstructible at the lens boundary
	// --- decomposition (lens multi-source put) fan-out, advertisement-driven ---
	| 'unsupported-decomposition-insert'    // INSERT into a decomposition — rides the shared-surrogate envelope (view-mutation-shared-surrogate-insert)
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
