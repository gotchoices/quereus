import type * as AST from '../parser/ast.js';
import type {
	TableSchema,
	RowConstraintSchema,
	UniqueConstraintSchema,
	ForeignKeyConstraintSchema,
	PrimaryKeyColumnDefinition,
} from './table.js';
import type { MappingAdvertisement } from '../vtab/mapping-advertisement.js';

/**
 * Lens layer — per-logical-table mapping slots.
 *
 * A logical schema (`Schema.kind === 'logical'`) declares tables as pure design
 * (columns + logical constraints, no module / index / storage). At
 * `apply schema X` the lens compiler ({@link ./lens-compiler.ts}) aligns each
 * logical table against a basis schema and produces an inlined effective view
 * body — the query processor then sees an ordinary view (registered via
 * `Schema.addView`), so reads ride the standard view-resolution path and writes
 * ride view-updateability with zero new runtime.
 *
 * The {@link LensSlot} is the home for the logical-table spec (columns / types /
 * constraints) that a `ViewSchema` cannot carry. The override / prover tickets
 * consume the slot; this ticket only populates and stores it.
 *
 * See `docs/lens.md` for the full design.
 */

/** A resolved reference to the basis schema a lens slot aligns against. */
export interface SchemaRef {
	/** Schema name of the basis schema (lowercased, as stored in the manager). */
	schemaName: string;
}

/**
 * A logical constraint carried verbatim from the logical declaration onto the
 * compiled view body. The prover ticket routes these to enforcement; this
 * ticket only stores them. Reuses the existing constraint-schema shapes rather
 * than re-modelling (see `docs/lens.md` § Constraint Attachment).
 */
export type LogicalConstraint =
	| { kind: 'primaryKey'; columns: ReadonlyArray<PrimaryKeyColumnDefinition> }
	| { kind: 'check'; constraint: RowConstraintSchema }
	| { kind: 'unique'; constraint: UniqueConstraintSchema }
	| { kind: 'foreignKey'; constraint: ForeignKeyConstraintSchema };

/**
 * Where one logical column's effective-body mapping came from, in logical
 * declaration order. Consumed by the `quereus_effective_lens` TVF.
 *
 * - `override` — the column is covered by the `declare lens` override body.
 * - `default`  — gap-filled by the default name-based mapper.
 * - `hidden`   — listed in `hiding (...)`; absent from the effective body and
 *   the registered view's column list.
 */
export interface LensColumnProvenance {
	logicalColumn: string;
	source: 'override' | 'default' | 'hidden';
	/**
	 * When a resolved primary-storage advertisement backs this logical column, the
	 * member `relationId` that backs it (the existence anchor for an EAV pivot).
	 * `undefined` ⇒ name-match / override-only provenance (no advertisement). Set by
	 * the lens compiler's `resolveAdvertisement`; surfaced by `quereus_effective_lens`.
	 */
	advertisedBy?: string;
}

/**
 * The per-logical-table mapping slot. Populated at lens-compile time
 * (the `apply schema X` step for a logical schema).
 */
export interface LensSlot {
	/**
	 * The logical spec: columns + constraints, built from the declared
	 * `CreateTableStmt`. `vtabModule` is undefined and `isLogical` is true —
	 * a logical table is a design, not a module-backed relation.
	 */
	logicalTable: TableSchema;
	/** The basis schema this slot aligns against. */
	defaultBasis: SchemaRef;
	/**
	 * The authored override body from `declare lens for X over Y { view T as ... }`,
	 * when one covers this logical table. `undefined` for a purely default-mapped
	 * table. The effective {@link compiledBody} is composed from this override
	 * (covered columns) ⊕ default-mapper gap-fill (uncovered columns) ⊖ {@link hiding}.
	 */
	override?: AST.SelectStmt;
	/**
	 * Logical columns hidden via `hiding (...)` (lowercased). Omitted from the
	 * effective body and the registered view's column list. Empty/absent when the
	 * override declares no `hiding` clause.
	 */
	hiding?: ReadonlySet<string>;
	/** The effective body — default mapper, or override ⊕ gap-fill ⊖ hidden. */
	compiledBody: AST.SelectStmt;
	/**
	 * Per-logical-column provenance, in declaration order (covers hidden columns
	 * too). Surfaced by the `quereus_effective_lens` introspection TVF.
	 */
	columnProvenance: ReadonlyArray<LensColumnProvenance>;
	/**
	 * The logical spec's constraints, verbatim. Routed to enforcement by the
	 * prover ticket (`lens-prover-and-constraint-attachment`); stored as-is here.
	 */
	attachedConstraints: ReadonlyArray<LogicalConstraint>;
	/**
	 * The resolved primary-storage advertisement, when a module advertised a
	 * decomposition for this logical table (see {@link MappingAdvertisement}).
	 * Resolved + validated by the lens compiler's `resolveAdvertisement` and stored
	 * here; consumed by `lens-multi-source-decomposition` to synthesize the n-way
	 * `get` join + `put` fan-out. `undefined` ⇒ name-match / single-source (the v1
	 * path). NOTE: this ticket **stores** the advertisement; the v1 body producer
	 * (name-match / override) is unchanged — synthesis lands in the follow-up.
	 */
	advertisement?: MappingAdvertisement;
	/**
	 * Auxiliary access-path advertisements for this logical table (nd-tree, vector,
	 * covering structures). Stored here; the planner path-selection consumer is
	 * deferred (backlog `lens-access-shape-path-selection`).
	 */
	auxiliaryAccess?: ReadonlyArray<MappingAdvertisement>;
}

/**
 * How one basis relation backs a logical table under a deployed lens: every
 * `(basisColumn → logicalColumn)` pair it supplies, including shared join-key
 * columns threaded across the decomposition's members (so a split member that
 * carries the key — but does not project it — is still backfillable). Captured in
 * the per-deploy {@link LensTableSnapshot} (see `docs/lens.md` § The deployed
 * basis representation).
 */
export interface LensRelationBacking {
	/**
	 * Stable relation id — the advertisement member `relationId` when an
	 * advertisement backs this relation, else `schema.table` (lowercased). Used to
	 * group columns into basis relations and to detect surrogate members.
	 */
	relationId: string;
	/** The concrete basis relation (original case). */
	basisRelation: { schema: string; table: string };
	/**
	 * `basisColumn` (original case) → `logicalColumn` (original case, as the prior
	 * get-body spells it — what the backfill selects from the prior-get subquery).
	 */
	columns: ReadonlyArray<{ basisColumn: string; logicalColumn: string }>;
}

/**
 * The per-logical-table record inside a {@link LensDeploymentSnapshot}: enough
 * to re-read the prior `get` over the prior basis and to diff the basis
 * decomposition against the next deploy.
 */
export interface LensTableSnapshot {
	/** Logical table name (original declaration case). */
	logicalTable: string;
	/**
	 * The compiled `get` body deployed for this table — `prior_lens.get(prior_basis)`.
	 * Stored as the AST (the snapshot is in-memory, alongside the declared-schema
	 * ASTs); `astToString(getBody)` recovers the SQL the backfill wraps as a
	 * subquery. Held by reference to the slot's `compiledBody`, which is never
	 * mutated after deploy.
	 */
	getBody: AST.SelectStmt;
	/** Non-hidden logical columns, declaration order (original case). */
	logicalColumns: readonly string[];
	/** basis-relation key (`schema.table`, lowercased) → how it backs the table. */
	relationBacking: ReadonlyMap<string, LensRelationBacking>;
	/**
	 * When a surrogate-keyed decomposition advertisement backs this table, the
	 * basis-relation keys (`schema.table`, lowercased) of its surrogate members.
	 * Used to defer an unsound multi-member surrogate split (threading one
	 * surrogate across members is `lens-multi-source-put-fanout`'s concern).
	 * Absent for a logical-tuple key / name-match.
	 */
	surrogateMemberKeys?: ReadonlySet<string>;
}

/**
 * The persisted, hash-coded record of one logical schema's lens deployment over
 * its basis — the "deployed basis representation" `docs/lens.md` § Deployment
 * requires. Captured by `deployLogicalSchema` on each successful `apply schema X`
 * and rotated (previous ← current) so the prior deploy survives one re-apply,
 * letting the backfill differ diff `previous → current`.
 */
export interface LensDeploymentSnapshot {
	/** Basis schema name this deploy aligned against. */
	basisSchemaName: string;
	/**
	 * `computeSchemaHash` of the basis declared schema at deploy time. The
	 * migration-safety record: a later deploy / introspection can confirm the
	 * basis still matches the one last deployed against, and a mismatch is a
	 * diagnosable "basis drifted out-of-band" condition.
	 */
	basisHash: string;
	/** Lowercased logical table name → its snapshot. */
	tables: ReadonlyMap<string, LensTableSnapshot>;
}

/**
 * Collects the logical spec's constraints into the verbatim
 * {@link LogicalConstraint} list stored on the lens slot. The primary key is
 * always included (even the empty / singleton key — see `docs/lens.md`
 * § The Default Mapper); the prover decides how to realize each.
 */
export function buildLogicalConstraints(logicalTable: TableSchema): LogicalConstraint[] {
	const result: LogicalConstraint[] = [];
	result.push({ kind: 'primaryKey', columns: logicalTable.primaryKeyDefinition });
	for (const c of logicalTable.checkConstraints) {
		result.push({ kind: 'check', constraint: c });
	}
	for (const c of logicalTable.uniqueConstraints ?? []) {
		result.push({ kind: 'unique', constraint: c });
	}
	for (const c of logicalTable.foreignKeys ?? []) {
		result.push({ kind: 'foreignKey', constraint: c });
	}
	return result;
}
