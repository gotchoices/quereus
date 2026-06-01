import type { MaybePromise, RowOp, SqlValue } from '../common/types.js';
import type { ConflictResolution } from '../common/constants.js';

/**
 * SQL Abstract Syntax Tree (AST) definitions
 * These interfaces define the structure of parsed SQL statements
 */

// Base for all AST nodes
export interface AstNode {
	type: 'literal' | 'identifier' | 'column' | 'binary' | 'unary' | 'function' | 'cast' | 'parameter' | 'subquery' | 'select'
		| 'insert' | 'update' | 'delete' | 'createTable' | 'createIndex' | 'createView' | 'createMaterializedView' | 'refreshMaterializedView' | 'createAssertion' | 'alterTable' | 'drop' | 'begin' | 'commit'
		| 'rollback' | 'table' | 'join' | 'savepoint' | 'release' | 'functionSource' | 'with' | 'commonTableExpr' | 'pragma'
		| 'collate' | 'primaryKey' | 'notNull' | 'null' | 'unique' | 'check' | 'default' | 'foreignKey' | 'generated' | 'windowFunction'
		| 'windowDefinition' | 'windowFrame' | 'currentRow' | 'unboundedPreceding' | 'unboundedFollowing' | 'preceding' | 'following'
		| 'subquerySource' | 'case' | 'in' | 'exists' | 'values' | 'between'
		| 'declareSchema' | 'declareLens' | 'diffSchema' | 'applySchema' | 'explainSchema'
		| 'declaredTable' | 'declaredIndex' | 'declaredView' | 'declaredMaterializedView' | 'declaredSeed' | 'declaredAssertion' | 'declareIgnored' | 'upsert'
		| 'analyze';
	loc?: {
		start: { line: number, column: number, offset: number };
		end: { line: number, column: number, offset: number };
	};
}

// Expression types
export type Expression = LiteralExpr | IdentifierExpr | BinaryExpr | UnaryExpr | FunctionExpr | CastExpr
	| ParameterExpr | SubqueryExpr | ColumnExpr | FunctionSource | CollateExpr | WindowFunctionExpr | CaseExpr
	| InExpr | ExistsExpr | BetweenExpr;

// Literal value expression (number, string, null, etc.)
export interface LiteralExpr extends AstNode {
	type: 'literal';
	value: MaybePromise<SqlValue>;
	lexeme?: string; // Optional: Original text representation, e.g., for numbers like '2.0'
}

// Identifier expression (table name or pragma name)
export interface IdentifierExpr extends AstNode {
	type: 'identifier';
	name: string;
	schema?: string; // Optional schema qualifier
}

// Column reference expression
export interface ColumnExpr extends AstNode {
	type: 'column';
	name: string;
	table?: string;  // Optional table qualifier
	schema?: string; // Optional schema qualifier
	alias?: string;  // Optional column alias
}

// Binary operation expression
export interface BinaryExpr extends AstNode {
	type: 'binary';
	operator: string; // +, -, *, /, AND, OR, =, <, etc.
	left: Expression;
	right: Expression;
}

// Unary operation expression
export interface UnaryExpr extends AstNode {
	type: 'unary';
	operator: string; // NOT, -, +, etc.
	expr: Expression;
}

// Function call expression
export interface FunctionExpr extends AstNode {
	type: 'function';
	name: string;
	args: Expression[];
	distinct?: boolean; // For DISTINCT in aggregate functions like COUNT(DISTINCT col)
}

// Window function expression
export interface WindowFunctionExpr extends AstNode {
	type: 'windowFunction';
	function: FunctionExpr;
	window?: WindowDefinition;
	alias?: string;
}

// Window definition (OVER clause)
export interface WindowDefinition extends AstNode {
	type: 'windowDefinition';
	partitionBy?: Expression[];
	orderBy?: OrderByClause[];
	frame?: WindowFrame;
}

// Window frame clause
export interface WindowFrame {
	type: WindowFrameUnits; // Changed from 'windowFrame' to WindowFrameUnits
	start: WindowFrameBound;
	end: WindowFrameBound | null; // Can be just START bound
	exclusion?: WindowFrameExclusion;
}

// Window frame bound
export type WindowFrameBound =
	| { type: 'currentRow' }
	| { type: 'unboundedPreceding' }
	| { type: 'unboundedFollowing' }
	| { type: 'preceding', value: Expression }
	| { type: 'following', value: Expression };

// Window frame units
export type WindowFrameUnits = 'rows' | 'range';

// Window frame exclusion
export type WindowFrameExclusion = 'no others' | 'current row' | 'group' | 'ties';

// CAST expression
export interface CastExpr extends AstNode {
	type: 'cast';
	expr: Expression;
	targetType: string;
}

// Parameter expression (? or :name or $name)
export interface ParameterExpr extends AstNode {
	type: 'parameter';
	index?: number;  // For positional parameters (?)
	name?: string;   // For named parameters (:name or $name)
}

// Subquery expression
export interface SubqueryExpr extends AstNode {
	type: 'subquery';
	query: QueryExpr;
}

// BETWEEN expression
export interface BetweenExpr extends AstNode {
	type: 'between';
	expr: Expression;      // Left side of BETWEEN
	lower: Expression;     // Lower bound
	upper: Expression;     // Upper bound
	not?: boolean;         // For NOT BETWEEN
}

// IN expression
export interface InExpr extends AstNode {
	type: 'in';
	expr: Expression;  // Left side of IN
	values?: Expression[];  // For IN (value1, value2, ...)
	subquery?: QueryExpr;  // For IN (SELECT/VALUES/INSERT/UPDATE/DELETE …)
}

// EXISTS expression
export interface ExistsExpr extends AstNode {
	type: 'exists';
	subquery: QueryExpr;  // EXISTS (SELECT/VALUES/INSERT/UPDATE/DELETE …)
}

// --- Statement Types ---

// --- Add FunctionSource type ---
export interface FunctionSource extends AstNode {
	type: 'functionSource';
	name: IdentifierExpr; // Function name (potentially schema.name)
	args: Expression[];    // Arguments passed to the function
	alias?: string;        // Optional alias for the generated table
	columns?: string[];    // Optional column list after alias: alias(col1, col2, ...)
}

// SELECT statement
export interface SelectStmt extends AstNode {
	type: 'select';
	withClause?: WithClause;
	columns: ResultColumn[];
	from?: FromClause[];
	where?: Expression;
	groupBy?: Expression[];
	having?: Expression;
	orderBy?: OrderByClause[];
	limit?: Expression;
	offset?: Expression;
	distinct?: boolean;
	all?: boolean;
	union?: SelectStmt;
	unionAll?: boolean;
	compound?: { op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'; select: QueryExpr };
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
}

/**
 * UPSERT clause for INSERT statements.
 * Specifies conflict handling with optional column-level updates.
 *
 * Syntax:
 *   ON CONFLICT [(column, ...)] DO NOTHING
 *   ON CONFLICT [(column, ...)] DO UPDATE SET col = expr, ... [WHERE condition]
 */
export interface UpsertClause extends AstNode {
	type: 'upsert';
	/** Conflict target columns. If undefined, matches any unique constraint. */
	conflictTarget?: string[];
	/** Action to take on conflict: 'nothing' skips the row, 'update' performs column updates */
	action: 'nothing' | 'update';
	/** For 'update' action: column assignments (col = expr) */
	assignments?: { column: string; value: Expression }[];
	/** For 'update' action: optional WHERE condition to control when update applies */
	where?: Expression;
}

// INSERT statement
export interface InsertStmt extends AstNode {
	type: 'insert';
	withClause?: WithClause;
	table: IdentifierExpr;
	columns?: string[];
	/**
	 * Source rows for the insert — a SELECT, a VALUES, or another DML with
	 * RETURNING. Replaces the legacy `values` / `select` pair: bare
	 * `INSERT … VALUES (…), (…)` parses as a `ValuesStmt` here.
	 */
	source: QueryExpr;
	/** Legacy conflict resolution (INSERT OR REPLACE, etc.) - mutually exclusive with upsertClauses */
	onConflict?: ConflictResolution;
	/** UPSERT clauses (ON CONFLICT DO ...) - mutually exclusive with onConflict */
	upsertClauses?: UpsertClause[];
	returning?: ResultColumn[];
	contextValues?: ContextAssignment[]; // Optional mutation context assignments
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
	tags?: Record<string, SqlValue>; // Optional WITH TAGS clause — statement-level reserved/override tags
}

// UPDATE statement
export interface UpdateStmt extends AstNode {
	type: 'update';
	withClause?: WithClause;
	table: IdentifierExpr;
	assignments: { column: string; value: Expression }[];
	where?: Expression;
	returning?: ResultColumn[];
	contextValues?: ContextAssignment[]; // Optional mutation context assignments
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
	tags?: Record<string, SqlValue>; // Optional WITH TAGS clause — statement-level reserved/override tags
}

// DELETE statement
export interface DeleteStmt extends AstNode {
	type: 'delete';
	withClause?: WithClause;
	table: IdentifierExpr;
	where?: Expression;
	returning?: ResultColumn[];
	contextValues?: ContextAssignment[]; // Optional mutation context assignments
	schemaPath?: string[]; // Optional schema search path from WITH SCHEMA clause
	tags?: Record<string, SqlValue>; // Optional WITH TAGS clause — statement-level reserved/override tags
}

// VALUES statement
export interface ValuesStmt extends AstNode {
	type: 'values';
	values: Expression[][]; // Array of value lists: VALUES (1, 'a'), (2, 'b'), ...
}

/**
 * Query expression — anything that produces a relation. The orthogonal shape
 * accepted everywhere a relation is allowed (top-level statement, FROM
 * subquery source, scalar / IN / EXISTS subquery, compound-set legs, CTE
 * body, view body).
 *
 * DML forms (INSERT/UPDATE/DELETE) qualify only when they carry a RETURNING
 * clause; the parser enforces this at non-top-level positions. DML in
 * scalar / IN / EXISTS / compound-leg / CTE-body / FROM-source positions
 * executes with full-drain + run-once semantics (see `docs/runtime.md`).
 * DML as a view body is rejected at view-creation time — a view body
 * re-evaluates on every reference and re-driving the write per read is
 * incoherent.
 */
export type QueryExpr =
	| SelectStmt
	| ValuesStmt
	| InsertStmt
	| UpdateStmt
	| DeleteStmt;

// CREATE TABLE statement
export interface CreateTableStmt extends AstNode {
	type: 'createTable';
	table: IdentifierExpr;
	ifNotExists: boolean;
	columns: ColumnDef[];
	constraints: TableConstraint[];
	isTemporary?: boolean;
	moduleName?: string;   // Optional module name from USING clause
	moduleArgs?: Record<string, SqlValue>; // Optional module arguments from USING clause
	contextDefinitions?: MutationContextVar[]; // Optional mutation context variables
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// CREATE INDEX statement
export interface CreateIndexStmt extends AstNode {
	type: 'createIndex';
	index: IdentifierExpr;
	table: IdentifierExpr;
	ifNotExists: boolean;
	columns: IndexedColumn[];
	where?: Expression;
	isUnique?: boolean;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// CREATE ASSERTION statement
export interface CreateAssertionStmt extends AstNode {
	type: 'createAssertion';
	name: string;
	check: Expression; // The CHECK (<violation-query>) expression
}

// CREATE VIEW statement
export interface CreateViewStmt extends AstNode {
	type: 'createView';
	view: IdentifierExpr;
	ifNotExists: boolean;
	columns?: string[];
	/** View body — any relation-producing form. Bare `VALUES (...)` is permitted. */
	select: QueryExpr;
	isTemporary?: boolean;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// CREATE MATERIALIZED VIEW statement
export interface CreateMaterializedViewStmt extends AstNode {
	type: 'createMaterializedView';
	view: IdentifierExpr;
	ifNotExists: boolean;
	columns?: string[];
	/** View body — any relation-producing form. Bare `VALUES (...)` is permitted. */
	select: QueryExpr;
	/** Optional backing-module name from a `USING mod(...)` clause. v1 only accepts `memory`. */
	moduleName?: string;
	/** Optional backing-module arguments (forward-compatible; ignored in v1). */
	moduleArgs?: Record<string, SqlValue>;
	isTemporary?: boolean;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// REFRESH MATERIALIZED VIEW statement
export interface RefreshMaterializedViewStmt extends AstNode {
	type: 'refreshMaterializedView';
	name: IdentifierExpr;
}

// ALTER TABLE statement
export interface AlterTableStmt extends AstNode {
	type: 'alterTable';
	table: IdentifierExpr;
	action: AlterTableAction;
}

// DROP statement
export interface DropStmt extends AstNode {
	type: 'drop';
	objectType: 'table' | 'view' | 'materializedView' | 'index' | 'trigger' | 'assertion';
	name: IdentifierExpr;
	ifExists: boolean;
}

// TRANSACTION statements
export interface BeginStmt extends AstNode {
	type: 'begin';
}

export interface CommitStmt extends AstNode {
	type: 'commit';
}

export interface RollbackStmt extends AstNode {
	type: 'rollback';
	savepoint?: string;
}

// --- Add Savepoint/Release ---
export interface SavepointStmt extends AstNode {
    type: 'savepoint';
    name: string;
}

export interface ReleaseStmt extends AstNode {
    type: 'release';
    savepoint?: string; // Optional savepoint name
}

// --- Supporting Types ---

export type ResultColumnExpr = {
	type: 'column',
	expr: Expression,
	alias?: string
}

// Result column in SELECT
export type ResultColumn =
	| { type: 'all', table?: string }
	| ResultColumnExpr;

// FROM clause item (table, join, function call, or subquery)
export type FromClause = TableSource | JoinClause | FunctionSource | SubquerySource;

// Table source in FROM clause
export interface TableSource extends AstNode {
	type: 'table';
	table: IdentifierExpr;
	alias?: string;
}

/**
 * Subquery source in FROM clause: `(SELECT/VALUES/INSERT/UPDATE/DELETE …) AS alias`.
 * The body is any `QueryExpr`. When the body is a DML statement it must carry
 * RETURNING (enforced at parse time outside top-level position). The planner
 * dispatches on `subquery.type` to choose the read vs mutating pipeline.
 */
export interface SubquerySource extends AstNode {
	type: 'subquerySource';
	subquery: QueryExpr;
	alias: string;
	columns?: string[]; // Optional column list: AS alias(col1, col2, ...)
}

// JOIN clause in FROM
export interface JoinClause extends AstNode {
	type: 'join';
	joinType: 'inner' | 'left' | 'right' | 'full' | 'cross';
	left: FromClause;
	right: FromClause;
	condition?: Expression; // For ON clause
	columns?: string[];     // For USING clause
	/** Right side is a LATERAL (correlated) subquery — the left's columns are visible inside. */
	isLateral?: boolean;
}

// ORDER BY clause
export interface OrderByClause {
	expr: Expression;
	direction: 'asc' | 'desc';
	nulls?: 'first' | 'last';
}

// Column definition in CREATE TABLE
export interface ColumnDef {
	name: string;
	dataType?: string;
	constraints: ColumnConstraint[];
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// Mutation context variable definition
export interface MutationContextVar {
	name: string;
	dataType?: string;
	notNull?: boolean;
}

// Mutation context assignment
export interface ContextAssignment {
	name: string;
	value: Expression;
}

// Column constraint (PRIMARY KEY, NOT NULL, etc.)
export interface ColumnConstraint extends AstNode {
	type: 'primaryKey' | 'notNull' | 'null' | 'unique' | 'check' | 'default' | 'foreignKey' | 'collate' | 'generated';
	name?: string;
	expr?: Expression;          // For CHECK or DEFAULT
	operations?: RowOp[];       // ADDED: For CHECK ON (...)
	collation?: string;         // For COLLATE
	direction?: 'asc' | 'desc'; // ADDED: For PRIMARY KEY ASC/DESC
	onConflict?: ConflictResolution;
	foreignKey?: ForeignKeyClause;
	generated?: {
		expr: Expression;
		stored: boolean;          // STORED or VIRTUAL
	};
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// Table constraint (PRIMARY KEY, UNIQUE, etc.)
export interface TableConstraint extends AstNode {
	type: 'primaryKey' | 'unique' | 'check' | 'foreignKey';
	name?: string;
	columns?: { name: string; direction?: 'asc' | 'desc' }[];
	expr?: Expression;         // For CHECK
	operations?: RowOp[];       // ADDED: For CHECK ON (...)
	onConflict?: ConflictResolution;
	foreignKey?: ForeignKeyClause;
	tags?: Record<string, SqlValue>; // Optional metadata tags from WITH TAGS clause
}

// Foreign key clause
export interface ForeignKeyClause {
	table: string;
	columns?: string[];
	onDelete?: ForeignKeyAction;
	onUpdate?: ForeignKeyAction;
	deferrable?: boolean;
	initiallyDeferred?: boolean;
}

// Foreign key action
export type ForeignKeyAction = 'setNull' | 'setDefault' | 'cascade' | 'restrict';

// Column in index definition
export interface IndexedColumn {
	name?: string;  // Column name
	expr?: Expression;  // Or expression
	collation?: string;
	direction?: 'asc' | 'desc';
}

// Alter table action
export type AlterTableAction =
	| { type: 'renameTable', newName: string }
	| { type: 'renameColumn', oldName: string, newName: string }
	| { type: 'addColumn', column: ColumnDef }
	| { type: 'dropColumn', name: string }
	| { type: 'addConstraint', constraint: TableConstraint }
	| { type: 'alterPrimaryKey', columns: Array<{ name: string; direction?: 'asc' | 'desc' }> }
	| {
		/**
		 * ALTER COLUMN <name> [SET NOT NULL | DROP NOT NULL | SET DATA TYPE <type> | SET DEFAULT <expr> | DROP DEFAULT].
		 * Each statement sets exactly one attribute — only one of the optional fields is populated.
		 */
		type: 'alterColumn',
		columnName: string,
		setNotNull?: boolean,          // true = SET NOT NULL, false = DROP NOT NULL
		setDataType?: string,
		setDefault?: Expression | null // null = DROP DEFAULT, Expression = SET DEFAULT
	};

// Add PragmaStmt interface
export interface PragmaStmt extends AstNode {
	type: 'pragma';
	name: string; // Name of the pragma
	value?: LiteralExpr | IdentifierExpr; // Value being assigned (optional for some pragmas)
}

export interface AnalyzeStmt extends AstNode {
	type: 'analyze';
	/** Optional table name. If omitted, all tables in the schema are analyzed. */
	tableName?: string;
	/** Optional schema qualifier (e.g., "main") */
	schemaName?: string;
}

export interface WithClause extends AstNode {
	type: 'with';
	recursive: boolean;
	ctes: CommonTableExpr[];
	options?: WithClauseOptions;
}

export interface WithClauseOptions {
	maxRecursion?: number;
}

export interface CommonTableExpr extends AstNode {
	type: 'commonTableExpr';
	name: string;
	columns?: string[];
	/** CTE body — any relation-producing form. DML bodies must carry RETURNING. */
	query: QueryExpr;
	materializationHint?: 'materialized' | 'not_materialized';
}

/**
 * Represents a COLLATE expression in SQL, which specifies the collation sequence
 * to use for a string operation
 */
export interface CollateExpr extends AstNode {
	type: 'collate';
	expr: Expression;
	collation: string;
}

export interface CaseExprWhenThenClause {
	when: Expression;
	then: Expression;
}

export interface CaseExpr extends AstNode {
	type: 'case'; // New type
	baseExpr?: Expression; // Optional: for CASE expr WHEN ...
	whenThenClauses: CaseExprWhenThenClause[];
	elseExpr?: Expression; // Optional: for ELSE ...
}

// --- Utility Type for Top-Level Statements ---
export type Statement =
	| SelectStmt
	| InsertStmt
	| UpdateStmt
	| DeleteStmt
	| ValuesStmt
	| CreateTableStmt
	| CreateIndexStmt
	| CreateViewStmt
	| CreateMaterializedViewStmt
	| RefreshMaterializedViewStmt
	| CreateAssertionStmt
	| DropStmt
	| AlterTableStmt
	| BeginStmt
	| CommitStmt
	| RollbackStmt
	| SavepointStmt
	| ReleaseStmt
	| PragmaStmt
	| AnalyzeStmt
	| DeclareSchemaStmt
	| DeclareLensStmt
	| DiffSchemaStmt
	| ApplySchemaStmt
	| ExplainSchemaStmt;

// === Declarative Schema AST ===

export interface DeclareSchemaStmt extends AstNode {
	type: 'declareSchema';
	schemaName?: string;
	version?: string;
	using?: { defaultVtabModule?: string; defaultVtabArgs?: string };
	items: readonly DeclareItem[];
	/**
	 * `declare logical schema X { ... }` — a design-only schema (`Schema.kind`
	 * becomes `'logical'` at apply). Logical tables declare columns + logical
	 * constraints only; module association / indexes / materialized views are
	 * rejected at apply. See `docs/lens.md` § Schema Kinds. Omitted/false for an
	 * ordinary physical schema.
	 */
	isLogical?: boolean;
}

export type DeclareItem = DeclaredTable | DeclaredIndex | DeclaredView | DeclaredMaterializedView | DeclaredSeed | DeclaredAssertion | DeclareIgnoredItem;

export interface DeclaredTable extends AstNode {
	type: 'declaredTable';
	tableStmt: CreateTableStmt;
}

export interface DeclaredIndex extends AstNode {
	type: 'declaredIndex';
	indexStmt: CreateIndexStmt;
}

export interface DeclaredView extends AstNode {
	type: 'declaredView';
	viewStmt: CreateViewStmt;
}

export interface DeclaredMaterializedView extends AstNode {
	type: 'declaredMaterializedView';
	viewStmt: CreateMaterializedViewStmt;
}

export interface DeclaredSeed extends AstNode {
	type: 'declaredSeed';
	tableName: string;
	columns?: readonly string[];
	seedData?: readonly SqlValue[][];
}

export interface DeclaredAssertion extends AstNode {
	type: 'declaredAssertion';
	assertionStmt: CreateAssertionStmt;
}

/** Placeholder for domain/collation/import items to keep parser forward-compatible */
export interface DeclareIgnoredItem extends AstNode {
	type: 'declareIgnored';
	kind: 'domain' | 'collation' | 'import';
	text: string; // original text snippet for hashing/canonicalization if needed
}

export interface DiffSchemaStmt extends AstNode {
	type: 'diffSchema';
	schemaName?: string;
}

export interface ApplySchemaStmt extends AstNode {
	type: 'applySchema';
	schemaName?: string;
	toVersion?: string;
	withSeed?: boolean;
	options?: {
		dryRun?: boolean;
		validateOnly?: boolean;
		allowDestructive?: boolean;
		renamePolicy?: 'allow' | 'require-hint' | 'deny';
	};
}

export interface ExplainSchemaStmt extends AstNode {
	type: 'explainSchema';
	schemaName?: string;
	version?: string;
}

/**
 * `declare lens for X over Y { view T as <select> [hiding (...)] ... }` — the
 * lens authoring surface (sibling of `declare schema`, NOT a variant of it).
 *
 * Binds a logical schema (`for X`) to a basis schema (`over Y`) and supplies
 * per-logical-table sparse overrides. The basis binding lives on the lens, not
 * the logical schema, which is what keeps the logical design embodiment-free
 * (one logical schema can target different bases across deployments). See
 * `docs/lens.md` § Sparse Overrides / Syntax.
 */
export interface DeclareLensStmt extends AstNode {
	type: 'declareLens';
	/** The logical schema this lens binds (`for X`). */
	logicalSchema: string;
	/** The basis schema the lens aligns over (`over Y`) — the explicit basis. */
	basisSchema: string;
	/** Per-logical-table sparse overrides. */
	overrides: readonly LensOverride[];
}

/**
 * One `view T as <select> [hiding (...)]` entry inside a {@link DeclareLensStmt}.
 * `select` is the authored override body; `hiding` lists logical columns to omit
 * from the effective body and the registered view's column list.
 */
export interface LensOverride {
	/** The logical table this override targets. */
	table: string;
	/** The authored override body (a relation-producing SELECT). */
	select: SelectStmt;
	/** Logical columns to hide (omit from effective body + view column list). */
	hiding?: readonly string[];
}
