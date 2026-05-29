import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import type { ChangeScope } from '../planner/analysis/change-scope.js';
import { fnv1aHash, toBase64Url } from '../util/hash.js';

/**
 * Represents the schema definition of a database view.
 * Views are stored SELECT statements that act like virtual tables.
 */
export interface ViewSchema {
	/** The name of the view */
	name: string;
	/** The name of the schema this view belongs to (e.g., 'main') */
	schemaName: string;
	/** The original SQL text used to create the view */
	sql: string;
	/**
	 * The parsed body AST that defines the view's logic. Any relation-producing
	 * QueryExpr (SELECT / VALUES). DML bodies (INSERT/UPDATE/DELETE with
	 * RETURNING) are rejected at view-creation time because a view body
	 * re-evaluates on every reference — replaying a write per read is incoherent
	 * with view semantics.
	 */
	selectAst: AST.QueryExpr;
	/** Columns explicitly defined in CREATE VIEW (e.g., CREATE VIEW v(a,b) AS...) */
	columns?: ReadonlyArray<string>; // Optional list of explicitly named columns
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Refresh policy for a materialized view — when its backing table is brought
 * back in sync with its sources.
 *
 * - `manual` (default): the MV is only re-materialized by an explicit
 *   `refresh materialized view`. Bit-for-bit phase-1 behavior.
 * - `on-commit-incremental`: the MV is maintained incrementally at every
 *   COMMIT that touches a source table, via a `DeltaSubscription` registered
 *   with the {@link import('../core/database-materialized-views.js').MaterializedViewManager}.
 *   Only bodies whose sources all classify as `'row'`/`'group'` (not `'global'`)
 *   qualify — see `docs/materialized-views.md` § Incremental refresh.
 * - `row-time`: write-through maintenance — the backing table is kept consistent
 *   *synchronously* with each source row-write, within the same transaction and
 *   visible mid-statement (not deferred to COMMIT like `on-commit-incremental`).
 *   Gated to the covering-index shape (a single row-preserving source whose body
 *   projects every source PK column via passthrough columns), so each source row
 *   maps to exactly one backing row and maintenance is a pure projection of the
 *   changed row — no body re-execution, no scan. General bodies are rejected at
 *   create. See `docs/materialized-views.md` § Row-time refresh.
 *
 * A future `on-commit-full` policy is out of scope (filed to backlog).
 */
export type RefreshPolicy =
	| { kind: 'manual' }
	| { kind: 'on-commit-incremental' }
	| { kind: 'row-time' };

/** The default refresh policy: manual full-refresh (phase-1 behavior). */
export const DEFAULT_REFRESH_POLICY: RefreshPolicy = { kind: 'manual' };

/**
 * Schema definition of a materialized view — a "keyed derived relation". The
 * query body is stored once into a backing virtual table (a normal
 * `TableSchema` in the `tables` map); references resolve to that backing table
 * rather than re-expanding the body. Phase 1 is manual full-refresh; the body
 * AST is retained so a later incremental / write-through pass can build on it.
 *
 * Dual-registration: the backing table lives in `Schema.tables`, this record
 * lives in `Schema.materializedViews`. Name-disjointness is enforced across
 * tables, views, and materialized views.
 */
export interface MaterializedViewSchema {
	/** The materialized view's name (the name users reference). */
	name: string;
	/** The schema this MV belongs to (e.g. 'main'). */
	schemaName: string;
	/** Original DDL text (round-trippable via ast-stringify). */
	sql: string;
	/** The parsed body AST — any relation-producing QueryExpr (SELECT / VALUES / compound). */
	selectAst: AST.QueryExpr;
	/** Columns explicitly defined in CREATE MATERIALIZED VIEW (e.g. `mv(a, b)`). */
	columns?: ReadonlyArray<string>;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing). */
	tags?: Readonly<Record<string, SqlValue>>;

	/** Backing-table identity. Same schemaName; conventional derived name. */
	backingTableName: string;

	/** Inferred PK of the view output, derived from `keysOf` on the optimized body.
	 *  NOTE: `keysOf` returns column-index arrays WITHOUT direction; `desc` defaults
	 *  false. When `keysOf` yields no usable key, the all-columns key is used
	 *  (Quereus default). Such an MV is incremental-ineligible until Phase 2. */
	primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;

	/** `toBase64Url(fnv1aHash(...))` of the canonical body SQL (astToString of the
	 *  parsed body — not a plan-structure serialization, which embeds unstable node ids).
	 *  Consumed by the declarative-schema differ (sibling ticket) to detect
	 *  "body changed → rebuild". Populated here even though the differ wiring
	 *  lands next ticket. */
	bodyHash: string;

	/** Body ordering captured from the optimized body (for the materialized-index path).
	 *  v1 stores; the covering ticket consumes. */
	ordering?: ReadonlyArray<{ index: number; desc: boolean }>;

	/** Qualified (lowercased `schema.table`) names of the source tables the body
	 *  reads. Used by the schema-change subscription to mark the MV stale when a
	 *  source is modified or removed. */
	sourceTables: ReadonlyArray<string>;

	/** Staleness flag set by the schema-change subscription when a source table
	 *  is modified/removed in a way that may break the body. */
	stale?: boolean;

	/** Set when an incremental apply failed AND the always-correct full-rebuild
	 *  recovery also failed — the backing table cannot be re-materialized and its
	 *  contents have silently diverged from the sources. Reads error unconditionally
	 *  until a successful refresh / rebuild clears it (distinct from `stale`, which
	 *  tracks *structural* body breakage, not data drift). Runtime-only and not
	 *  persisted: it resets to falsy on reload (a persisted store that diverged in
	 *  a prior session loses the flag — same as `stale`). */
	diverged?: boolean;

	/** When and how the backing table is brought back in sync with its sources.
	 *  Absent on already-serialized MVs ⇒ treat as {@link DEFAULT_REFRESH_POLICY}
	 *  (`manual`). Set to `on-commit-incremental` for post-commit delta maintenance,
	 *  or `row-time` for synchronous write-through maintenance (covering-index shape only). */
	refreshPolicy?: RefreshPolicy;

	/**
	 * Cached source-union change-scope for an `on-commit-incremental` MV,
	 * computed once at registration (see `MaterializedViewManager.registerMaterializedView`).
	 * A `select` from this MV resolves to a reference on the (never-user-written)
	 * backing table; change-scope analysis substitutes this scope so a
	 * `Database.watch` fires on a *source* mutation rather than reporting the
	 * backing table. Absent for `manual` MVs (their cadence is `refresh`, so they
	 * keep reporting just the backing table) and for not-yet-registered MVs. v1 is
	 * the conservative union of a `full` watch per source — see
	 * `buildSourceUnionScope`. Not serialized; repopulated on re-registration.
	 */
	sourceScope?: ChangeScope;

	/**
	 * How this covering structure came to be. An ordinary user-declared MV is
	 * `'explicit'` (the default; absent on already-serialized MVs ⇒ treat as
	 * explicit). `'implicit-from-unique-constraint'` is reserved for the
	 * synchronously-maintained secondary BTree that a UNIQUE constraint
	 * auto-builds — described in this same vocabulary but held as a lightweight
	 * association on the memory-table manager, never registered here. See
	 * `docs/materialized-views.md` § Covering structures.
	 */
	origin?: 'explicit' | 'implicit-from-unique-constraint';

	/**
	 * Back-pointer to the UNIQUE constraint this structure realizes, recorded
	 * eagerly when the coverage prover (`planner/analysis/coverage-prover.ts`)
	 * recognizes that this MV covers the constraint. When this MV is `row-time`,
	 * its backing table answers the constraint's UNIQUE conflict resolution (see
	 * `docs/materialized-views.md` § Enforcement through a row-time covering MV).
	 * The authoritative link is the constraint's `coveringStructureName` forward
	 * pointer (see `docs/schema.md`); this is the convenience reverse link.
	 */
	covers?: { schemaName: string; tableName: string; constraintName?: string };
}

/** Conventional derived name for a materialized view's backing table. Reserved
 *  prefix; backing tables are hidden from user-facing catalog enumeration. */
export function backingTableNameFor(mvName: string): string {
	return `_mv_${mvName}`;
}

/**
 * Canonical body hash for a materialized view: `toBase64Url(fnv1aHash(bodySql))`
 * over the body's canonical SQL (`astToString` of the parsed body, supplied by
 * the caller — NOT a plan-structure serialization, which embeds unstable node
 * ids). Stable per body; changes when the body changes.
 *
 * Single source of truth shared by MV creation (which stamps
 * {@link MaterializedViewSchema.bodyHash}) and the declarative-schema differ
 * (which recomputes it from a declared MV's body to detect "body changed →
 * rebuild"). Both sides MUST hash the same canonical-SQL form, so they call
 * this one function.
 */
export function computeBodyHash(bodySql: string): string {
	return toBase64Url(fnv1aHash(bodySql));
}
