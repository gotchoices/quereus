import type * as AST from '../parser/ast.js';

/**
 * Module mapping advertisement protocol — the typed surface a virtual-table
 * module exposes to tell the lens default mapper how a set of *its* basis
 * relations jointly back one logical table (columnar split / EAV / column-family
 * / nd-tree). See `docs/lens.md` § "The Default Mapper".
 *
 * The advertisement is load-bearing in both directions of the lens:
 * - **`get`** — the join fan-out shape + which basis relation backs each logical
 *   column (drives the n-way read body).
 * - **`put`** — the same fan-out + the shared key, so an insert reaches every
 *   member and a surrogate is evaluated once and threaded.
 *
 * This module defines the descriptor only. Resolution / validation / slot
 * storage lives in `schema/lens-compiler.ts`; the n-way join synthesis + put
 * fan-out that *consume* a resolved advertisement land in the follow-up ticket
 * `lens-multi-source-decomposition`.
 *
 * The two facets ({@link StorageShape}, {@link AccessShape}) are **separate and
 * need not be symmetric** (accommodation #1): *storage shape* drives `put`,
 * *access shape* drives `get` planning. An nd-tree's storage shape is a
 * surrogate-keyed insert path identical to the column stores beside it, while
 * its access shape is spatial predicates over a coordinate tuple.
 */

/** How a set of a module's basis relations decomposes one logical table. */
export interface MappingAdvertisement {
	/**
	 * Stable symbolic id, unique within the basis schema. This is the existence
	 * anchor's `relationId` — the target an injected IND (`IndTarget.kind:'relation'`,
	 * reserved by `optimizer-inclusion-dependency-foundation`) points at. Minted by
	 * the module (dedicated) or by the tag builder (generic) from the anchor
	 * relation. The contract `id === storage.anchorRelationId` is validated by the
	 * resolver, so the INDs `lens-multi-source-decomposition` injects and the join
	 * it builds agree on which relation is the existence anchor.
	 */
	readonly id: string;
	/**
	 * Logical table this decomposition backs, matched case-insensitively by the
	 * resolver against the logical declaration.
	 */
	readonly logicalTable: string;
	/**
	 * `primary-storage` drives write fan-out (at most one per logical table —
	 * accommodation #5); `auxiliary-access` is a read-path-only structure (nd-tree,
	 * covering MV, vector index).
	 */
	readonly role: 'primary-storage' | 'auxiliary-access';
	/** Drives put (and the get join). Required on `primary-storage`. */
	readonly storage?: StorageShape;
	/**
	 * Drives read-path selection. Defined + stored here; its planner consumer is the
	 * deferred `lens-access-shape-path-selection` (backlog).
	 */
	readonly access?: AccessShape;
}

/** The write/storage facet: drives `put` fan-out and the `get` join skeleton. */
export interface StorageShape {
	/**
	 * The existence anchor (accommodation #4): preserved side for outer joins of
	 * value-only members, the delete source for "the logical row ceases to exist",
	 * and the relation a covering MV joins back through. Named explicitly — never
	 * reverse-engineered from outer-join structure. Must be one of {@link members}.
	 */
	readonly anchorRelationId: string;
	/** Every basis relation in the decomposition, including the anchor. */
	readonly members: readonly DecompositionMember[];
	readonly sharedKey: SharedKey;
}

/** A reference to a concrete basis relation (schema + table). */
export interface BasisRelationRef {
	readonly schema: string;
	readonly table: string;
}

/** One basis relation participating in a decomposition. */
export interface DecompositionMember {
	/** Member's symbolic id (the anchor's equals {@link StorageShape.anchorRelationId}). */
	readonly relationId: string;
	readonly relation: BasisRelationRef;
	/**
	 * `mandatory` ⇒ inner-joined onto the anchor (every logical row has it);
	 * `optional` ⇒ outer-joined (a logical row may lack it).
	 */
	readonly presence: 'mandatory' | 'optional';
	/**
	 * logical-column-name -> the basis expression on THIS relation backing it. A
	 * member may back many columns (column-family), one (columnar), or none beyond
	 * identity (pure existence anchor). EAV members use {@link attributePivot}
	 * instead.
	 */
	readonly columns: readonly LogicalColumnMapping[];
	/**
	 * EAV / triple-store member: logical columns are rows keyed by an attribute
	 * literal, not basis columns. Defined for completeness; the resolver validates
	 * its shape, the synthesis ticket builds the pivot.
	 */
	readonly attributePivot?: AttributePivot;
}

/** Binds one logical column to a basis expression on a member relation. */
export interface LogicalColumnMapping {
	readonly logicalColumn: string;
	readonly basisExpr: AST.Expression;
}

/**
 * The key that stitches the decomposition's members together (the equi-join in
 * `get`, the threaded identity in `put`).
 */
export interface SharedKey {
	/**
	 * Accommodation #3 — first-class, surfaces to the compiler so it knows whether
	 * to drive surrogate generation:
	 * - `surrogate`: a substrate-managed key distinct from any logical column.
	 *   Engages the per-row default evaluator before fan-out
	 *   (evaluate-once-and-thread, `docs/view-updateability.md` § Mutation Context).
	 *   Requires {@link generator}.
	 * - `logical-tuple`: the shared key IS the logical PK, arriving mapped from the
	 *   logical layer. Generation collapses entirely; {@link generator} must be
	 *   absent.
	 */
	readonly kind: 'surrogate' | 'logical-tuple';
	/**
	 * Per-member key columns the equi-join uses (a surrogate may be spelled
	 * differently across relations). Keyed by member `relationId`.
	 */
	readonly keyColumnsByRelation: ReadonlyMap<string, readonly string[]>;
	readonly generator?: SharedKeyGenerator;
}

/** How a surrogate shared key is minted at insert. */
export interface SharedKeyGenerator {
	readonly strategy: 'integer-auto' | 'uuid7' | 'callback';
	/**
	 * `per-row` mints a distinct value per produced logical row; `per-statement`
	 * binds once for the statement (`docs/view-updateability.md` § Mutation Context
	 * cadences).
	 */
	readonly cadence: 'per-row' | 'per-statement';
	/** `callback`: the basis-level default expression/function evaluated at insert. */
	readonly expr?: AST.Expression;
}

/**
 * Extensible (accommodation #2) — string-typed with built-in constants, NOT a
 * closed enum, so vector-similarity / full-text / time-series forms land without
 * re-litigating the type. Built-ins enumerated; `string & {}` keeps it open.
 */
export type AccessForm = 'equality' | 'range' | 'prefix' | 'contains' | 'intersects' | 'knn' | (string & {});

/** The read/access facet: which predicate forms the decomposition serves. */
export interface AccessShape {
	/**
	 * Which predicate forms this decomposition serves efficiently over which
	 * columns (or coordinate tuple). The nd-tree case is
	 * `{ columns: ['x','y','z'], forms: ['range','contains','knn'] }`.
	 */
	readonly served: readonly { readonly columns: readonly string[]; readonly forms: readonly AccessForm[] }[];
}

/** EAV / triple-store pivot: three basis columns carrying identity, name, value. */
export interface AttributePivot {
	/** basis column = logical row identity. */
	readonly entityColumn: string;
	/** basis column = logical column name. */
	readonly attributeColumn: string;
	/** basis column = the value. */
	readonly valueColumn: string;
}
