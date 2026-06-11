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
	/**
	 * Per-column omitted-insert defaults from the `insert defaults (col = expr, …)`
	 * clause. Consumed by the insert write-through rewrite (step 5 of the
	 * insert-defaulting precedence chain — docs/view-updateability.md § View insert
	 * defaults) and by `view_info`'s insertability derivation.
	 */
	insertDefaults?: ReadonlyArray<AST.ViewInsertDefault>;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Describes a materialized view whose backing key is **collation-coarser** than
 * the source primary key it derives from — the parallel-migration-table shape
 * (`docs/migration.md` § Convergence hazards): the body has no provable unique
 * key, so the backing was keyed on the coarsened lineage key K' (see
 * `planner/analysis/coarsened-key.ts`), and colliding source rows
 * last-write-win until they are merged. Stamped alongside the create-time
 * key-coarsening warning; purely informational (recomputed at create / import /
 * refresh shape-rebuild from the body — never serialized into DDL).
 */
export interface CoarsenedKeyInfo {
	/** Backing/output column names forming the coarsened key, in key order. */
	readonly columns: readonly string[];
	/** The columns whose collation weakened, with the source → output collations. */
	readonly weakened: ReadonlyArray<{
		readonly column: string;
		readonly sourceCollation: string;
		readonly outputCollation: string;
	}>;
}

/**
 * Schema definition of a materialized view — a "keyed derived relation". The
 * query body is stored once into a backing virtual table (a normal
 * `TableSchema` in the `tables` map); references resolve to that backing table
 * rather than re-expanding the body.
 *
 * Every MV is **row-time maintained**: the backing table is kept consistent
 * *synchronously* with each source row-write, within the same transaction and
 * visible mid-statement (reads-own-writes; rolled back in lockstep with the
 * write). This is gated at create to the covering-index shape — a single
 * row-preserving source whose body is a passthrough projection covering every
 * source PK column — so each source row maps to exactly one backing row and
 * maintenance is a pure projection of the changed row (no body re-execution, no
 * scan). Bodies that are not row-time maintainable are rejected at create; the
 * body AST is retained for `refresh materialized view` (an explicit full
 * rebuild) and for the declarative-schema differ.
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
	/**
	 * Per-column omitted-insert defaults from the `insert defaults (col = expr, …)`
	 * clause — same semantics as {@link ViewSchema.insertDefaults}; MV write-through
	 * shares the single-source rewrite spine, so the field is read identically.
	 */
	insertDefaults?: ReadonlyArray<AST.ViewInsertDefault>;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing). */
	tags?: Readonly<Record<string, SqlValue>>;

	/** Backing-table identity. Same schemaName; conventional derived name. */
	backingTableName: string;

	/**
	 * Backing-host module the backing table lives in, from the create's
	 * `using <module>(...)` clause. Absent ⇒ `'memory'` (the default): an
	 * explicit `using memory()`/`mem()` with no args normalizes to absent at
	 * create ({@link normalizeBackingModule}), so the two spellings are one
	 * identical schema record and already-persisted catalogs are unperturbed.
	 */
	backingModuleName?: string;

	/** Backing-module args from the `using` clause; recorded only when non-empty. */
	backingModuleArgs?: Readonly<Record<string, SqlValue>>;

	/** Inferred PK of the view output, derived from `keysOf` on the optimized body.
	 *  NOTE: `keysOf` returns column-index arrays WITHOUT direction; `desc` defaults
	 *  false. When `keysOf` yields no usable key, a coarsened lineage key is tried
	 *  (`coarsenedKey` below); the all-columns fallback remains for bodies with
	 *  neither, and such an MV is rejected at registration (a bag). */
	primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;

	/**
	 * Present when the backing key is a collation-coarsened lineage key
	 * ({@link CoarsenedKeyInfo}) — colliding source rows last-write-win in this
	 * MV until merged. Informational (the key-coarsening warning's record-side
	 * complement); recomputed wherever the backing shape is re-derived, never
	 * serialized.
	 */
	coarsenedKey?: CoarsenedKeyInfo;

	/** `toBase64Url(fnv1aHash(...))` of the canonical DEFINITION string —
	 *  explicit column list + body + `insert defaults` clause, rendered by
	 *  `viewDefinitionToCanonicalString` (not a plan-structure serialization,
	 *  which embeds unstable node ids). Consumed by the declarative-schema
	 *  differ to detect "definition changed → rebuild"; a clause-only or
	 *  explicit-columns-only change therefore re-materializes, exactly as a
	 *  body change does (tags stay a separate channel — `SET TAGS`, no rebuild). */
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

	/**
	 * Cached source-union change-scope, computed once at registration (see
	 * `MaterializedViewManager.registerMaterializedView`). A `select` from this MV
	 * resolves to a reference on the (never-user-written) backing table; change-scope
	 * analysis substitutes this scope so a `Database.watch` fires on a *source*
	 * mutation rather than reporting the backing table (which is maintained off the
	 * user change log, synchronously at the DML boundary). Absent for not-yet-registered
	 * MVs. v1 is the conservative union of a `full` watch per source — see
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
 * Normalized backing-module identity for a materialized view's
 * `using <module>(...)` clause. `moduleName` is the name to RESOLVE (default
 * applied, `mem` aliased, lowercased); `storedModuleName`/`storedModuleArgs`
 * are what the schema RECORDS — absent for the memory default with no args,
 * so an explicit `using memory()` and an omitted clause produce one identical
 * schema record, identical generated DDL, and no differ churn between the two
 * spellings. Explicit `using memory(...)` with non-empty args is the one case
 * that still records (and round-trips) the clause.
 */
export interface NormalizedBackingModule {
	moduleName: string;
	storedModuleName?: string;
	storedModuleArgs?: Readonly<Record<string, SqlValue>>;
}

/** Normalizes a declared backing-module name: absent ⇒ `'memory'`; `mem` is an
 *  alias for `memory`; lowercased (module registration is case-insensitive). */
export function normalizeBackingModuleName(name: string | undefined): string {
	const lower = (name ?? 'memory').toLowerCase();
	return lower === 'mem' ? 'memory' : lower;
}

/** Applies the backing-module normalization decision — single source of truth
 *  shared by the create builder and the catalog-import path. */
export function normalizeBackingModule(
	moduleName: string | undefined,
	moduleArgs: Readonly<Record<string, SqlValue>> | undefined,
): NormalizedBackingModule {
	const name = normalizeBackingModuleName(moduleName);
	const args = moduleArgs && Object.keys(moduleArgs).length > 0 ? Object.freeze({ ...moduleArgs }) : undefined;
	if (name === 'memory' && !args) return { moduleName: name };
	return { moduleName: name, storedModuleName: name, storedModuleArgs: args };
}

/**
 * Stable (sorted-key) canonical render of a backing-module args record — the
 * comparison key for the args half of the backing-module identity. The
 * declarative differ compares this separately from `bodyHash` (the module is
 * deliberately NOT folded into the hash formula, which would spuriously
 * rebuild every already-persisted MV). Empty/absent renders ''.
 */
export function canonicalBackingModuleArgs(args: Readonly<Record<string, SqlValue>> | undefined): string {
	if (!args) return '';
	return Object.keys(args).sort().map(k => `${k}=${renderBackingArgValue(args[k])}`).join(',');
}

function renderBackingArgValue(v: SqlValue): string {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'string') return JSON.stringify(v);
	if (v instanceof Uint8Array) return `x'${Array.from(v, b => b.toString(16).padStart(2, '0')).join('')}'`;
	return String(v); // number | bigint | boolean — distinct from the quoted string render
}

/**
 * Canonical definition hash for a materialized view:
 * `toBase64Url(fnv1aHash(...))` over the canonical DEFINITION string supplied
 * by the caller — `viewDefinitionToCanonicalString(columns, selectAst,
 * insertDefaults)`, i.e. the explicit column list + the body's canonical SQL +
 * the `insert defaults` clause (NOT a plan-structure serialization, which
 * embeds unstable node ids). Stable per definition; changes when any
 * definitional part changes.
 *
 * Single source of truth shared by MV creation / the rename-propagation
 * rewrite (which stamp {@link MaterializedViewSchema.bodyHash}) and the
 * declarative-schema differ (which recomputes it from a declared MV to detect
 * "definition changed → rebuild"). All sides MUST hash the same canonical
 * form, so they call this one function over that one renderer.
 */
export function computeBodyHash(canonicalDefinition: string): string {
	return toBase64Url(fnv1aHash(canonicalDefinition));
}
