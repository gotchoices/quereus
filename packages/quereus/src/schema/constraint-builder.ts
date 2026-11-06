/**
 * Shared AST → constraint-schema builders plus the engine-level FK existing-row
 * validator. These are the single source of truth for turning a table-level
 * `ALTER TABLE … ADD <constraint>` (an `AST.TableConstraint`) into the
 * corresponding {@link UniqueConstraintSchema} / {@link ForeignKeyConstraintSchema},
 * reproducing the canonical mapping that {@link SchemaManager}'s
 * `extractUniqueConstraints` / `extractForeignKeys` table-level arms encode for
 * CREATE TABLE. Both the built-in modules (memory + store, via the
 * `@quereus/quereus` barrel) and the SchemaManager delegate here so the two
 * paths can never drift.
 *
 * Column resolution is always against the CHILD table's `columnIndexMap`
 * (`ALTER TABLE ADD CONSTRAINT` is always the table-level form). Parent-column
 * resolution for a FK stays deferred (the parent may not exist yet) exactly as
 * in the CREATE TABLE path.
 */

import type { Database } from '../core/database.js';
import type { TableSchema, UniqueConstraintSchema, ForeignKeyConstraintSchema, RowConstraintSchema } from './table.js';
import { resolveReferencedColumns, resolveReferencedColumnsForEnforcement, opsToMask, collectDeclaredConstraintNames, disambiguateAutoConstraintName, requireVtabModule } from './table.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import type * as AST from '../parser/ast.js';
import { quoteIdentifier, expressionToString } from '../emit/ast-stringify.js';
import { createLogger } from '../common/logger.js';
import { resolveForeignKeyColumnCollation } from '../planner/analysis/comparison-collation.js';
import { containsOldRowImageRef, isRowInvariantCheck } from '../planner/analysis/check-extraction.js';
import { cloneExpr } from '../planner/mutation/scope-transform.js';
import { requalifyOwnRowRefsInSchemaExpression, type OwnRowContextVariables } from './rename-rewriter.js';
import { rowSourceOverrideKey, type RowSourceOverrides } from '../planner/planning-context.js';
import { distinctRestorableRows, judgeRestorableStates, type RestorableRows, type RestorableRowStates } from '../vtab/rollback-states.js';

const log = createLogger('schema:constraint-builder');

/**
 * Builds a {@link UniqueConstraintSchema} from a table-level UNIQUE
 * `AST.TableConstraint`, resolving each declared column name to its index in the
 * child table. Mirrors `SchemaManager.extractUniqueConstraints` (table-level arm).
 */
export function buildUniqueConstraintSchema(
	con: AST.TableConstraint,
	columnIndexMap: ReadonlyMap<string, number>,
): UniqueConstraintSchema {
	if (con.type !== 'unique' || !con.columns || con.columns.length === 0) {
		throw new QuereusError('UNIQUE constraint requires at least one column', StatusCode.ERROR);
	}
	const colIndices = con.columns.map(col => {
		const idx = columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(`UNIQUE constraint column '${col.name}' not found`, StatusCode.ERROR);
		}
		return idx;
	});
	return {
		name: con.name,
		columns: Object.freeze(colIndices),
		defaultConflict: con.onConflict,
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/**
 * Builds a {@link ForeignKeyConstraintSchema} from a table-level FOREIGN KEY
 * `AST.TableConstraint`, resolving child column names to indices and deferring
 * parent-column resolution (the parent table may not exist yet). Mirrors
 * `SchemaManager.extractForeignKeys` (table-level arm), including the
 * child/parent column-count mismatch error.
 *
 * `takenNames` is the mint disambiguation set: an unnamed FK's
 * `_fk_<table>_<cols>` mint is disambiguated against — and registered into — it
 * (see `disambiguateAutoConstraintName`), so it can never repeat a name already
 * in use. CREATE TABLE seeds it with the statement's user-written names; every
 * ALTER path seeds it from the table's existing constraint names
 * (`collectTableConstraintNames`). Omitting it is supported only for a caller
 * that genuinely has no table to disambiguate against — an omitted set means an
 * unnamed FK re-added over an existing `_fk_<table>_<cols>` mints that name a
 * SECOND time, and one `DROP CONSTRAINT` then removes both.
 */
export function buildForeignKeyConstraintSchema(
	con: AST.TableConstraint,
	columnIndexMap: ReadonlyMap<string, number>,
	childTableName: string,
	childSchemaName: string,
	takenNames?: Set<string>,
): ForeignKeyConstraintSchema {
	if (con.type !== 'foreignKey' || !con.foreignKey || !con.columns) {
		throw new QuereusError('FOREIGN KEY constraint requires child columns and a REFERENCES clause', StatusCode.ERROR);
	}
	const fk = con.foreignKey;
	const childColIndices = con.columns.map(col => {
		const idx = columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(`FK column '${col.name}' not found in table '${childTableName}'`, StatusCode.ERROR);
		}
		return idx;
	});

	const mintedName = `_fk_${childTableName}_${con.columns.map(c => c.name).join('_')}`;
	const fkName = con.name
		?? (takenNames !== undefined ? disambiguateAutoConstraintName(mintedName, takenNames) : mintedName);

	if (fk.columns && fk.columns.length !== childColIndices.length) {
		throw new QuereusError(
			`FK constraint '${fkName}' on table '${childTableName}': child column count (${childColIndices.length}) does not match parent column count (${fk.columns.length})`,
			StatusCode.ERROR,
		);
	}

	return {
		name: fkName,
		columns: Object.freeze(childColIndices),
		referencedTable: fk.table,
		referencedSchema: fk.schema ?? childSchemaName,
		referencedColumnNames: fk.columns, // deferred resolution via resolveReferencedColumns
		onDelete: fk.onDelete ?? 'restrict',
		onUpdate: fk.onUpdate ?? 'restrict',
		deferred: fk.initiallyDeferred ?? false,
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/**
 * Builds a {@link RowConstraintSchema} from a table-level CHECK
 * `AST.TableConstraint` (the `ALTER TABLE … ADD CONSTRAINT … CHECK` form). The
 * single source of truth for that mapping, called by the built-in modules
 * (memory + store) so a CHECK added via ALTER lands in the *module-cached*
 * schema, in lock-step with the catalog — the same place inline-CREATE CHECKs
 * live and where `DROP/RENAME CONSTRAINT` later resolve the constraint class. An
 * unnamed CHECK is auto-named `check_<n>` — see {@link mintCheckConstraintName}
 * for how `n` is chosen. Determinism is intentionally NOT validated here — a
 * CHECK may reference `new.*`/`old.*`, which is checked at INSERT/UPDATE plan time.
 */
export function buildCheckConstraintSchema(
	con: AST.TableConstraint,
	existingCount: number,
	takenNames: ReadonlySet<string>,
): RowConstraintSchema {
	if (con.type !== 'check' || !con.expr) {
		throw new QuereusError('CHECK constraint requires an expression', StatusCode.ERROR);
	}
	return {
		name: con.name || mintCheckConstraintName(existingCount, takenNames),
		expr: con.expr,
		operations: opsToMask(con.operations),
		tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
	};
}

/**
 * The auto-name for an unnamed table-level CHECK: `check_<n>`, where `n` starts at
 * `existingCount` (the number of CHECKs already on the table — the engine's
 * historical spelling) and is bumped upward until the name is free on that table.
 *
 * `takenNames` is the table's existing constraint names, case-folded, spanning
 * CHECK / UNIQUE / FOREIGN KEY as one namespace (`collectTableConstraintNames`) —
 * the same namespace `namedConstraintExists` and `disambiguateAutoConstraintName`
 * use. Without the probe, `DROP CONSTRAINT check_0` followed by another unnamed
 * add re-mints a LIVE name (the count shrank), leaving two constraints one name
 * addresses and one `DROP` removes both of.
 *
 * NOT `disambiguateAutoConstraintName`: that appends a `_<N>` collision suffix,
 * which on this base would read `check_1_2`. Bumping the index instead keeps the
 * documented `check_<n>` shape. Seeding at `existingCount` rather than scanning
 * from 0 is what keeps every non-colliding name byte-identical to the historical
 * mint — a table whose two CHECKs are USER-named has `existingCount` 2, so the
 * next unnamed add stays `check_2` instead of shifting to a now-free `check_0`.
 */
function mintCheckConstraintName(existingCount: number, takenNames: ReadonlySet<string>): string {
	// `check_<n>` is already lower-case, and `takenNames` is case-folded, so no
	// further folding is needed on either side of the membership test.
	let n = existingCount;
	while (takenNames.has(`check_${n}`)) n++;
	return `check_${n}`;
}

/* ──────────────── ALTER TABLE ADD COLUMN inline constraints ────────────────
 * A constraint written inline on an added column (`add column c int unique`,
 * `… check (c > 0)`, `… references p(pid)`) has no table-level AST of its own, so
 * these three extractors synthesize the equivalent table-level
 * {@link AST.TableConstraint} over the new column. The emitter hands each to
 * `module.alterTable({ type: 'addConstraint', constraint })` — the very path
 * `ALTER TABLE … ADD CONSTRAINT` uses — so the MODULE ends up owning the
 * constraint, exactly as it owns one declared in CREATE TABLE.
 *
 * That ownership is what makes the constraint durable. Every later structural
 * ALTER (DROP COLUMN, RENAME COLUMN, …) asks the module for the new table schema
 * and installs the module's answer in the catalog verbatim; a constraint merged
 * only into the engine's catalog copy is silently dropped by the next one.
 */

/**
 * Extracts the column-level CHECK constraints declared on a single `ALTER TABLE
 * ADD COLUMN` ColumnDef into the equivalent table-level constraints.
 *
 * An unnamed CHECK is named `_check_<column>` HERE rather than left to
 * {@link buildCheckConstraintSchema} (which would auto-name it `check_<n>`,
 * the table-level `ADD CONSTRAINT` convention): the inline-CREATE-TABLE spelling
 * of the same declaration is named `_check_<column>`, and the two paths must agree.
 *
 * `takenNames` holds the table's existing constraint names. This column's
 * user-written inline names join it before any mint runs, and each mint is
 * registered as it is chosen, so two unnamed CHECKs on one new column (legal; see
 * `assertInlineConstraintNamesFree`) mint `_check_<col>` / `_check_<col>_2` exactly
 * as the CREATE TABLE spelling does, instead of two constraints one name addresses.
 *
 * The undo of `ADD COLUMN` calls this too (`UndoRenderer.dropAddedColumn`): it has
 * to name the stored CHECKs at plan time, before the forward step has run.
 */
export function extractColumnLevelCheckConstraints(columnDef: AST.ColumnDef, takenNames: Set<string>): Array<AST.TableConstraint & { name: string }> {
	for (const declared of collectDeclaredConstraintNames([columnDef], undefined)) takenNames.add(declared);
	const result: Array<AST.TableConstraint & { name: string }> = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'check' || !con.expr) continue;
		result.push({
			type: 'check',
			name: con.name ?? disambiguateAutoConstraintName(`_check_${columnDef.name}`, takenNames),
			expr: con.expr,
			operations: con.operations,
			tags: con.tags,
		});
	}
	return result;
}

/**
 * Extracts the column-level FOREIGN KEY constraints declared on a single `ALTER
 * TABLE ADD COLUMN` ColumnDef into the equivalent table-level constraints over
 * the new column.
 *
 * The name is left unset for an unnamed FK so {@link buildForeignKeyConstraintSchema}
 * applies its `_fk_<table>_<column>` convention — the same name the inline-CREATE-TABLE
 * spelling produces.
 *
 * The single-child-column count match against the parent column list is enforced
 * here, ahead of the builder's identical check, so a malformed declaration is
 * rejected *before* the column is materialized rather than after.
 */
export function extractColumnLevelForeignKeys(columnDef: AST.ColumnDef): AST.TableConstraint[] {
	const result: AST.TableConstraint[] = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'foreignKey' || !con.foreignKey) continue;
		const fk = con.foreignKey;
		if (fk.columns && fk.columns.length !== 1) {
			throw new QuereusError(
				`FOREIGN KEY${con.name ? ` '${con.name}'` : ''} on ADD COLUMN '${columnDef.name}': `
					+ `child column count (1) does not match parent column count (${fk.columns.length})`,
				StatusCode.ERROR,
			);
		}
		result.push({
			type: 'foreignKey',
			name: con.name,
			columns: [{ name: columnDef.name }],
			foreignKey: fk,
			tags: con.tags,
		});
	}
	return result;
}

/**
 * Extracts the column-level UNIQUE constraints declared on a single `ALTER TABLE
 * ADD COLUMN` ColumnDef into the equivalent table-level constraints over the new
 * column.
 *
 * The synthetic constraint preserves a named inline UNIQUE's name (so it
 * round-trips), `ON CONFLICT`, and tags. `buildUniqueConstraintSchema` reads only
 * those fields plus `columns[].name`, so no `operations` / `direction` is emitted.
 * Each inline `unique` ColumnConstraint becomes its own single-column table
 * constraint over `columnDef.name` (multiple are rare but handled like CHECK / FK).
 */
export function extractColumnLevelUniqueConstraints(columnDef: AST.ColumnDef): AST.TableConstraint[] {
	const result: AST.TableConstraint[] = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'unique') continue;
		result.push({
			type: 'unique',
			name: con.name,
			columns: [{ name: columnDef.name }],
			onConflict: con.onConflict,
			tags: con.tags,
		});
	}
	return result;
}

/** Qualify a relation reference, eliding the `main.` prefix (the default schema). */
function qualifyRelation(schemaName: string, tableName: string): string {
	const prefix = schemaName.toLowerCase() !== 'main' ? `${quoteIdentifier(schemaName)}.` : '';
	return `${prefix}${quoteIdentifier(tableName)}`;
}

/* ──────────────── maintained-table derived-row attribution ────────────────
 * A maintained table's rows are written by its derivation, so a declared
 * CHECK / FK violation surfaces on a statement that targeted a DIFFERENT table
 * (a source write, or the create/attach statement). These two helpers produce
 * the table-attributed diagnostic both validation mechanisms share — the bulk
 * SQL-scan validators (create-fill / attach reconcile) and the per-row
 * maintenance evaluator (`core/derived-row-validator.ts`). The leading
 * `CHECK constraint failed:` / `FOREIGN KEY constraint failed:` prefixes are
 * load-bearing: existing assertions and downstream consumers key off them
 * (see `runtime/row-constraints.ts`). */

/** Attributed CHECK diagnostic for a row the derivation wrote into a maintained table. */
export function maintainedTableCheckViolationError(
	schemaName: string,
	tableName: string,
	constraintName: string,
	exprHint?: string,
): QuereusError {
	const hint = exprHint && exprHint.length <= 60 ? ` (${exprHint})` : '';
	return new QuereusError(
		`CHECK constraint failed: ${constraintName}${hint} — row derived into maintained table `
			+ `'${schemaName}.${tableName}' violates its declared constraint`,
		StatusCode.CONSTRAINT,
	);
}

/** Attributed child-side FK diagnostic for a row the derivation wrote into a maintained table. */
export function maintainedTableFkViolationError(
	schemaName: string,
	tableName: string,
	constraintName: string,
	parentSchemaName: string,
	parentTableName: string,
): QuereusError {
	return new QuereusError(
		`FOREIGN KEY constraint failed: ${constraintName} — row derived into maintained table `
			+ `'${schemaName}.${tableName}' references a missing '${parentSchemaName}.${parentTableName}'`,
		StatusCode.CONSTRAINT,
	);
}

/** Renders one constrained-column value for a key-collision diagnostic. */
export function formatKeyValue(v: SqlValue): string {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'string') return `'${v}'`;
	if (v instanceof Uint8Array) return `x'…'`;
	return String(v);
}

/**
 * Attributed secondary-UNIQUE diagnostic for rows the derivation wrote into a
 * maintained table. Unlike CHECK / FK (per-row properties), a UNIQUE collision
 * is a property of a PAIR of rows at distinct primary keys, so the diagnostic
 * names the colliding key values. Thrown by the backing hosts' post-batch
 * maintenance enforcement (memory `enforceSecondaryUniqueOnMaintenance`, store
 * `enforceSecondaryUniqueForMaintenance`) — see `vtab/backing-host.ts`
 * § Constraint validation.
 */
export function maintainedTableUniqueViolationError(
	schemaName: string,
	tableName: string,
	constraintName: string,
	columnNames: readonly string[],
	keyValues: readonly SqlValue[],
): QuereusError {
	return new QuereusError(
		`UNIQUE constraint failed: ${constraintName} (${columnNames.join(', ')}) — row derived into maintained table `
			+ `'${schemaName}.${tableName}' collides on its declared UNIQUE constraint (key: ${keyValues.map(formatKeyValue).join(', ')})`,
		StatusCode.CONSTRAINT,
	);
}

/**
 * The alias the existing-row CHECK scan gives the scanned table, and the qualifier
 * every own-row reference in the CHECK is rewritten to
 * ({@link requalifyOwnRowRefsInSchemaExpression}). Spelled so that no FROM source a
 * user could write inside a CHECK subquery rebinds it.
 *
 * NOTE: `new.<missing>` is refused with this alias in the message
 * (`__quereus_stored_row__.x isn't a column`); if users start hitting that, report it under `new.`.
 */
const STORED_ROW_ALIAS = '__quereus_stored_row__';

/** Top-level AND-conjuncts of `expr`, the same split the optimizer's `walkConjunction` makes. */
function topLevelConjuncts(expr: AST.Expression): AST.Expression[] {
	const out: AST.Expression[] = [];
	const stack: AST.Expression[] = [expr];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur.type === 'binary' && (cur as AST.BinaryExpr).operator === 'AND') {
			const b = cur as AST.BinaryExpr;
			// Right first so `out` keeps source order.
			stack.push(b.right, b.left);
			continue;
		}
		out.push(cur);
	}
	return out;
}

/**
 * The part of a CHECK that every STORED row of `tableSchema` must satisfy, rendered
 * so it plans over `from <table> as STORED_ROW_ALIAS` — or `undefined` when nothing
 * in the CHECK can be judged from a row sitting still.
 *
 * This is the validation-side twin of the optimizer's row-invariant lift
 * (`planner/analysis/check-extraction.ts`): the optimizer trusts a declared CHECK as a
 * fact about every stored row and folds contradicting predicates away
 * (`ruleFilterContradiction`), so whatever it lifts MUST have been validated by the
 * scan this feeds, or rows silently vanish from query results. Validating more than
 * rows owe makes legal statements start failing. Hence the same per-top-level-AND-conjunct
 * split, and the optimizer's own screens:
 *
 *   - a conjunct referencing `old.<col>` is a transition constraint over the PREVIOUS
 *     row image (`check (old.a is null or a >= old.a)`); it says nothing about a row
 *     sitting still and the optimizer refuses to lift it — dropped, via the very
 *     predicate the optimizer uses ({@link containsOldRowImageRef}). Its `old.`-free
 *     siblings are kept: under SQL ternary logic `C1 AND C2` is FALSE whenever `C2`
 *     is, so each such conjunct holds over stored rows on its own.
 *   - `new.<col>` IS the stored row (the optimizer lifts it), so it is requalified to
 *     the scan alias rather than left for the planner to reject as `new.<col> isn't a
 *     column`; a self-qualified `<table>.<col>` gets the same treatment.
 *
 * One difference is deliberate: a conjunct reading a mutation-context variable is kept
 * here though the optimizer lifts nothing from it, since it constrains a per-statement
 * value. It is judged as a statement with no envelope would judge it, which is how a
 * read of a NOT NULL variable gets rejected. See {@link scanContextVariables}.
 *
 * Returns fresh AST (the stored constraint is never mutated).
 */
export function storedRowPredicate(
	check: RowConstraintSchema,
	tableSchema: TableSchema,
	contextVariables?: OwnRowContextVariables,
): AST.Expression | undefined {
	const kept: AST.Expression[] = [];
	for (const conjunct of topLevelConjuncts(check.expr)) {
		if (containsOldRowImageRef(conjunct)) continue;
		const clone = cloneExpr(conjunct);
		requalifyOwnRowRefsInSchemaExpression(clone, tableSchema.name, tableSchema.schemaName, STORED_ROW_ALIAS, contextVariables);
		kept.push(clone);
	}
	if (kept.length === 0) return undefined;
	return kept.reduce((acc, next): AST.Expression => {
		const conjunction: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc, right: next };
		return conjunction;
	});
}

/**
 * How the existing-row scan reads a table's declared mutation-context variables, or
 * `undefined` when it declares none, which leaves the scan's SQL as it is for every
 * other table. Maintained tables cannot declare context, so that path never gets here.
 *
 * The scan runs as a statement that supplied no `with context` envelope (see
 * `Statement._noEnvelopeContextTable`). A bare name must then mean the variable
 * even when a column shares it, as it does on a write, but a FROM source would win over
 * the root scope the variables live in. So a shared column is exposed under an internal
 * name ({@link storedRowSourceSql}), and the bare name falls through to the variable.
 */
function scanContextVariables(tableSchema: TableSchema): OwnRowContextVariables | undefined {
	const declared = tableSchema.mutationContext;
	if (!declared || declared.length === 0) return undefined;
	const names = new Set(declared.map(contextVar => contextVar.name.toLowerCase()));
	const takenNames = new Set(tableSchema.columns.map(column => column.name.toLowerCase()));
	const shadowedColumns = new Map<string, string>();
	for (const column of tableSchema.columns) {
		const nameLower = column.name.toLowerCase();
		if (names.has(nameLower)) shadowedColumns.set(nameLower, mintShadowedColumnName(nameLower, takenNames));
	}
	return { names, shadowedColumns };
}

/**
 * A name no column of the scan's source already has. Two source columns under one name
 * would let `new.<name>` read the wrong one, and a row that passes on the wrong column
 * then vanishes from queries through the fact the optimizer lifts from that spelling.
 */
function mintShadowedColumnName(nameLower: string, takenNames: Set<string>): string {
	let internalName = `__quereus_shadowed_${nameLower}`;
	while (takenNames.has(internalName)) internalName += '_';
	takenNames.add(internalName);
	return internalName;
}

/** The scan's FROM source: the table itself, or a derived source when a column is shadowed ({@link scanContextVariables}). */
function storedRowSourceSql(tableSchema: TableSchema, contextVariables: OwnRowContextVariables | undefined): string {
	const tableRef = qualifyRelation(tableSchema.schemaName, tableSchema.name);
	const alias = quoteIdentifier(STORED_ROW_ALIAS);
	const shadowed = contextVariables?.shadowedColumns;
	if (!shadowed || shadowed.size === 0) return `${tableRef} as ${alias}`;
	const columns = tableSchema.columns.map(column => {
		const internalName = shadowed.get(column.name.toLowerCase());
		const name = quoteIdentifier(column.name);
		return internalName ? `${name} as ${quoteIdentifier(internalName)}` : name;
	});
	return `(select ${columns.join(', ')} from ${tableRef}) as ${alias}`;
}

/**
 * Validates a table's EXISTING (effective, pending-over-committed) rows against
 * each CHECK in `checks`, throwing on the first violating row. One shared scan
 * for every path that installs a CHECK over rows that already exist —
 * `ALTER TABLE … ADD CONSTRAINT … CHECK` and its engine-side fallback
 * (`runtime/emit/add-constraint.ts`), `ALTER TABLE … ADD COLUMN … CHECK`
 * (`validateBackfillAgainstChecks` in `runtime/emit/alter-table.ts`) and the
 * maintained-table derivation (`runtime/emit/materialized-view-helpers.ts`) — so
 * the `new.` / `old.` / operation-mask rules below are decided once. One
 * `select 1 from <t> as <alias> where not (<stored-row predicate>) limit 1` scan per
 * CHECK, so the NULL-pass rule falls out of SQL semantics (`not NULL` is NULL — the
 * row is not a violation). A subquery-bearing CHECK is just SQL here; the scan
 * reads final pending state through the ordinary read path, so rows the issuing
 * transaction has staged but not committed count as present.
 *
 * On a table that declares mutation context, the scan reads the variables as a
 * statement with no envelope does ({@link scanContextVariables}): a NULL-declared one is
 * NULL, and a read of a NOT NULL one raises at plan time, so it is rejected whether or
 * not the table has rows. A CHECK this scan never judges cannot raise that error.
 *
 * The operation-mask policy is the CALLER's, not this scan's: which stored rows
 * owe a partial-mask CHECK (`check on insert (…)`, `check on update (…)`) anything
 * depends on how the rows got there. The ALTER paths hand rows stored under any
 * path and so validate only row invariants
 * ({@link validateRowInvariantChecksOverExistingRows}); the maintained-table
 * derivation validates every derived image against any insert-or-update CHECK
 * (its op-mask collapse, `docs/mv-constraints.md`) and filters accordingly before
 * calling here. The one screen intrinsic to the scan is the `old.` one: a stored
 * row has no previous image whoever asks, so a CHECK whose every conjunct is a
 * transition constraint is skipped (see {@link storedRowPredicate}).
 *
 * CAUTION — declared-constraint folding: the optimizer trusts a DECLARED CHECK
 * as a proven domain invariant, so if the LIVE catalog entry for `tableSchema`
 * already declares the CHECK being validated, `ruleFilterContradiction` folds the
 * `where not (<expr>)` scan to EmptyRelation and the validation vacuously
 * passes — it trusts the very thing it is testing. Callers must scan while the
 * live record does NOT declare the constraints under validation: the ALTER
 * paths run this before the catalog swap, the maintained-table path swaps in a
 * constraint-stripped record first. The one caller that scans a declared CHECK is
 * `apply schema`'s re-validation over a recreated object, whose CHECKs read a subquery the
 * optimizer never lifts (see `rejectCheckViolatedByExistingRows`).
 */
export async function validateChecksOverExistingRows(
	db: Database,
	tableSchema: TableSchema,
	checks: ReadonlyArray<RowConstraintSchema>,
	onViolation?: (check: RowConstraintSchema, exprSql: string) => QuereusError,
): Promise<void> {
	await scanChecksOverRows(db, tableSchema, checks, onViolation);
}

/**
 * The scan behind {@link validateChecksOverExistingRows}, over the table's effective rows — or,
 * with `rows`, over those rows in the table's place: the same SQL, planned with the table read
 * from `rows` (`Statement._rowSourceOverrides`), so types, collations, NULL handling and the
 * `new.` / context-variable rules are the effective pass's by construction. A subquery in the
 * CHECK that reads the same table reads `rows` too.
 */
async function scanChecksOverRows(
	db: Database,
	tableSchema: TableSchema,
	checks: ReadonlyArray<RowConstraintSchema>,
	onViolation?: (check: RowConstraintSchema, exprSql: string) => QuereusError,
	rows?: RestorableRows,
): Promise<void> {
	const contextVariables = scanContextVariables(tableSchema);
	const source = storedRowSourceSql(tableSchema, contextVariables);
	for (const check of checks) {
		const predicate = storedRowPredicate(check, tableSchema, contextVariables);
		if (!predicate) continue;
		const exprSql = expressionToString(check.expr);
		const sql = `select 1 from ${source} where not (${expressionToString(predicate)}) limit 1`;
		log('CHECK existing-row validation for %s.%s: %s', tableSchema.schemaName, tableSchema.name, sql);
		const stmt = db.prepare(sql);
		// The CHECK is SCHEMA-AUTHORED, so a bare relation name inside it means the OWNING
		// table's schema — not the session path this freshly-prepared scan would otherwise
		// inherit. Owning schema only, matching `schemaAuthoredContext`
		// (planner/building/schema-authored-context.ts), which decides the same thing for
		// every CHECK the DML builders compile.
		stmt._schemaPathOverride = [tableSchema.schemaName];
		if (contextVariables) stmt._noEnvelopeContextTable = tableSchema;
		if (rows) stmt._rowSourceOverrides = new Map([[rowSourceOverrideKey(tableSchema.schemaName, tableSchema.name), rows]]);
		try {
			for await (const _row of stmt._iterateRowsRaw()) {
				throw onViolation?.(check, exprSql) ?? new QuereusError(
					`CHECK constraint failed: ${check.name ?? exprSql} — existing rows in '${tableSchema.name}' violate the constraint`,
					StatusCode.CONSTRAINT,
				);
			}
		} finally {
			await stmt.finalize();
		}
	}
}

/**
 * {@link validateChecksOverExistingRows} restricted to the CHECKs that are row
 * invariants by the optimizer's own gate ({@link isRowInvariantCheck}), and run over
 * every state a rollback could return the table to as well — the ALTER-path entry
 * point (`ADD CONSTRAINT … CHECK`, `ADD COLUMN … CHECK`).
 *
 * Row invariants only: the rows an ALTER meets were stored under every write path, and
 * a partial-mask CHECK lets a row be legally stored in violation of it (inserted under
 * an update-only one, updated under an insert-only one), so those rows owe it nothing —
 * and the optimizer lifts nothing from it, so accepting leaves no wrong-result risk
 * open. Gating on the same predicate the lift uses is what keeps everything lifted
 * validated; change one, change the other. The optimizer lifts less than this
 * validates: nothing from a conjunct reading a mutation-context variable.
 *
 * Every restorable state: DDL survives a rollback on the bundled backends while the
 * rows it was judged against do not, and the lifted CHECK is a fact about every stored
 * row, so a violator a rollback restores would vanish from every query that asks for
 * it. A violation the transaction can see keeps its `CONSTRAINT` (that pass runs
 * first); one confined to a state the module reports
 * (`VirtualTableModule.restorableRowStates`) refuses as `BUSY` (`judgeRestorableStates`),
 * with `ddl` naming the statement. A module without the hook, or with no open work on
 * the table, pays no second scan.
 *
 * NOTE: a CHECK whose subquery reads ANOTHER table judges each state of this table against that
 * table's current rows, not against the rows it would hold after the same rollback. Such a CHECK
 * is never lifted (`planner/analysis/check-extraction.ts`), so nothing vanishes from queries, and
 * a later write to that other table is not re-judged against this CHECK either. If pairing by
 * rollback point is ever wanted, override both tables, pairing their `savepoints` entries by depth.
 */
export async function validateRowInvariantChecksOverExistingRows(
	db: Database,
	tableSchema: TableSchema,
	checks: ReadonlyArray<RowConstraintSchema>,
	ddl: string,
	onViolation?: (check: RowConstraintSchema, exprSql: string) => QuereusError,
): Promise<void> {
	const invariants = checks.filter(isRowInvariantCheck);
	if (invariants.length === 0) return;
	await scanChecksOverRows(db, tableSchema, invariants, onViolation);
	const states = await requireVtabModule(tableSchema).restorableRowStates?.(db, tableSchema.schemaName, tableSchema.name, ddl);
	if (!states) return;
	await judgeRestorableStates(
		distinctRestorableRows(states),
		rows => scanChecksOverRows(db, tableSchema, invariants, onViolation, rows),
		ddl,
		tableSchema.name,
	);
}

/**
 * Validates every existing CHILD row against a FOREIGN KEY, throwing
 * `StatusCode.CONSTRAINT` if any row references a non-existent parent — over the
 * rows the issuing transaction can see only. The maintained-table derivation's entry
 * point: the rows it judges are a derived image it just built, not rows a rollback
 * restores (its CHECK scan, `validateChecksOverExistingRows`, judges no rollback state
 * either). An ALTER adding a foreign key calls
 * {@link validateAddedForeignKeyOverExistingRows} instead.
 *
 * Engine-level and backend-agnostic: it reads committed/base data through
 * `db.prepare` + scan (which does not take any module schema-change latch, so it
 * is safe to call while a module holds its own schema-change lock). No-op when
 * `pragma foreign_keys` is off.
 *
 * MATCH SIMPLE semantics: a child row with ANY NULL FK column is allowed
 * regardless of the parent, so only fully-non-NULL orphans abort. When the
 * parent table is absent, no fully-non-NULL child row can be satisfied, so any
 * such row is an orphan (mirrors the child-side builder's null-guards-only
 * fallback in `planner/building/foreign-key-builder.ts`).
 *
 * `onViolation` overrides the default diagnostic — the maintained-table
 * derivation validator threads its table-attributed message through here.
 * Note the declared-constraint folding caveat on
 * {@link validateChecksOverExistingRows}: if the live child record already
 * declares this FK (it does NOT on the ADD COLUMN / ADD CONSTRAINT paths, but
 * DOES on the maintained-table path), the caller must scan against a
 * constraint-stripped record or `ruleAntiJoinFkEmpty` folds the anti-join away.
 */
export async function validateForeignKeyOverExistingRows(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
	onViolation?: () => QuereusError,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;
	const { sql } = foreignKeyOrphanScan(db, childSchema, fk);
	await scanForOrphans(db, childSchema, fk, sql, onViolation);
}

/**
 * {@link validateForeignKeyOverExistingRows} for a foreign key an ALTER is adding
 * (`add constraint … foreign key`, and `add column … references`, which reaches the
 * same module arm), run over every state a rollback could return the two tables to as
 * well. Called by the module's `addConstraint` arm, which skips it while restoring a
 * dropped constraint during an unwind (`SchemaChangeInfo` `restoring`).
 *
 * DDL survives a rollback on the bundled backends while the rows it was judged against
 * do not, so a child row a rollback restores, or a parent row it removes, would leave an
 * orphan under the surviving constraint. A rollback moves both tables to the same point,
 * so each state of the child is judged against the parent as it would stand at that same
 * point ({@link foreignKeyRollbackPoints}) — never against the parent's current rows,
 * which would both miss an orphan (a parent the transaction inserted rescues a committed
 * child row) and refuse a consistent rollback (a parent deleted with its child rows).
 *
 * An orphan the transaction can see keeps `CONSTRAINT` (that scan runs first); one
 * confined to a rollback point refuses as `BUSY` (`judgeRestorableStates`), with `ddl`
 * naming the statement (`describeAddForeignKey`). When neither table has open work no
 * second scan runs.
 */
export async function validateAddedForeignKeyOverExistingRows(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
	ddl: string,
): Promise<void> {
	if (!db.options.getBooleanOption('foreign_keys')) return;
	const { sql, parentTable } = foreignKeyOrphanScan(db, childSchema, fk);
	await scanForOrphans(db, childSchema, fk, sql);
	await judgeRestorableStates(
		await foreignKeyRollbackPoints(db, childSchema, parentTable, ddl),
		overrides => scanForOrphans(db, childSchema, fk, sql, undefined, overrides),
		ddl,
		childSchema.name,
	);
}

/**
 * The `select 1 … limit 1` that finds a fully-non-NULL child row of `fk` with no parent, and
 * the parent table it reads (undefined when absent: every such row is then an orphan).
 */
function foreignKeyOrphanScan(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
): { readonly sql: string; readonly parentTable: TableSchema | undefined } {
	const childRef = qualifyRelation(childSchema.schemaName, childSchema.name);
	const childAlias = '_c';
	// MATCH SIMPLE: only rows where every FK column is non-NULL can violate.
	const notNullChain = fk.columns
		.map(idx => `${childAlias}.${quoteIdentifier(childSchema.columns[idx].name)} is not null`)
		.join(' and ');

	const parentSchemaName = fk.referencedSchema ?? childSchema.schemaName;
	const parentTable = db.schemaManager.findTable(fk.referencedTable, parentSchemaName);
	if (!parentTable) {
		return { sql: `select 1 from ${childRef} as ${childAlias} where ${notNullChain} limit 1`, parentTable };
	}

	// Shared with the plan-time / runtime enforcement sites so one malformed FK
	// reports one message wherever it is met.
	const parentColIndices = resolveReferencedColumnsForEnforcement(fk, parentTable, childSchema);
	const parentRef = qualifyRelation(parentTable.schemaName, parentTable.name);
	const parentAlias = '_p';
	// Aliases keep the correlation unambiguous even for a self-referencing FK
	// (child table === parent table).
	const matchChain = fk.columns
		.map((childIdx, i) =>
			`${parentAlias}.${quoteIdentifier(parentTable.columns[parentColIndices[i]].name)} = ${childAlias}.${quoteIdentifier(childSchema.columns[childIdx].name)}`)
		.join(' and ');
	// `not exists` correlated subquery: a fully-non-NULL child row with no matching
	// parent is an orphan. (The decorrelator may turn this into an anti-join; that is
	// fine — the ADD COLUMN path deliberately validates against a live schema that does
	// NOT yet declare the new FK, so `ruleAntiJoinFkEmpty` has no FK to fold against.)
	const sql = `select 1 from ${childRef} as ${childAlias} `
		+ `where ${notNullChain} `
		+ `and not exists (select 1 from ${parentRef} as ${parentAlias} where ${matchChain}) limit 1`;
	return { sql, parentTable };
}

/**
 * Runs `sql` ({@link foreignKeyOrphanScan}) and throws on the first orphan it finds — with
 * `overrides`, reading those tables from the given rows instead of their modules
 * (`Statement._rowSourceOverrides`), so a rollback point is judged by the very SQL the
 * effective pass ran.
 */
async function scanForOrphans(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
	sql: string,
	onViolation?: () => QuereusError,
	overrides?: RowSourceOverrides,
): Promise<void> {
	log('FK existing-row validation for %s.%s: %s', childSchema.schemaName, childSchema.name, sql);
	const stmt = db.prepare(sql);
	if (overrides) stmt._rowSourceOverrides = overrides;
	try {
		for await (const _row of stmt._iterateRowsRaw()) {
			if (onViolation) throw onViolation();
			const colNames = fk.columns.map(idx => childSchema.columns[idx].name).join(', ');
			throw new QuereusError(
				`FOREIGN KEY constraint failed: ${childSchema.name} (${colNames}) has rows referencing a missing '${fk.referencedTable}'`,
				StatusCode.CONSTRAINT,
			);
		}
	} finally {
		await stmt.finalize();
	}
}

/**
 * The row-source overrides for each rollback point — the whole-transaction rollback, then each
 * open savepoint by depth — at which a foreign key's child or parent would hold rows other than
 * its current ones, each pairing the child's rows at that point with the parent's rows at the
 * same point. A table that reports no states (no open work, or a module without the hook) keeps
 * its current rows at every point and gets no override. A self-referencing FK has one table and
 * one override, which both reads of the scan take; an absent parent needs none. Points that pair
 * the same two streams are judged once; there are none when neither table has open work.
 *
 * NOTE: a parent whose module has no `restorableRowStates` hook is read as unchanged by every
 * rollback, so a parent row its transaction inserted can rescue a committed orphan here and then
 * roll back. Every bundled module has the hook; if a third-party module without one is ever a
 * parent of a child whose DDL survives rollback, refuse `BUSY` for such a parent inside an
 * explicit transaction, since nothing else reveals its open work.
 */
async function foreignKeyRollbackPoints(
	db: Database,
	childSchema: TableSchema,
	parentTable: TableSchema | undefined,
	ddl: string,
): Promise<RowSourceOverrides[]> {
	const childKey = rowSourceOverrideKey(childSchema.schemaName, childSchema.name);
	const parentKey = parentTable && rowSourceOverrideKey(parentTable.schemaName, parentTable.name);
	const child = await restorableStatesOf(db, childSchema, ddl);
	const parent = parentTable && parentKey !== childKey ? await restorableStatesOf(db, parentTable, ddl) : undefined;
	if (!child && !parent) return [];

	const depth = Math.max(child?.savepoints.length ?? 0, parent?.savepoints.length ?? 0);
	const pairs: [RestorableRows | undefined, RestorableRows | undefined][] = [[child?.transaction, parent?.transaction]];
	for (let d = 0; d < depth; d++) pairs.push([rowsAtSavepoint(child, d), rowsAtSavepoint(parent, d)]);

	const distinct = pairs.filter(([c, p], i) => pairs.findIndex(([c2, p2]) => c2 === c && p2 === p) === i);
	return distinct.map(([childRows, parentRows]) => {
		const overrides = new Map<string, RestorableRows>();
		if (childRows) overrides.set(childKey, childRows);
		if (parentRows && parentKey) overrides.set(parentKey, parentRows);
		return overrides;
	});
}

/**
 * What `rollback to` the savepoint at `depth` restores `states`' table to. An entry the module
 * did not report restores the committed rows (`VirtualTable.savepointRowSources` reads a
 * missing trailing entry the same way).
 */
function rowsAtSavepoint(states: RestorableRowStates | undefined, depth: number): RestorableRows | undefined {
	return states && (states.savepoints[depth] ?? states.transaction);
}

/**
 * `table`'s restorable states, from the module the catalog routes it through — the wrapper (the
 * isolation layer) rather than the module beneath it, since the wrapper stages the transaction's
 * rows. The FK arm runs inside a module's `alterTable` holding that module's own copy of the
 * child schema, hence the catalog lookup; the hook is read-only, so calling it from there is safe.
 */
async function restorableStatesOf(db: Database, table: TableSchema, ddl: string): Promise<RestorableRowStates | undefined> {
	const catalogTable = db.schemaManager.findTable(table.name, table.schemaName) ?? table;
	return requireVtabModule(catalogTable).restorableRowStates?.(db, table.schemaName, table.name, ddl);
}

/**
 * Rejects a FOREIGN KEY whose child column and parent key column declare
 * conflicting explicit/declared collations — the same conflict the synthesized
 * `parent.ref = child.fk` enforcement comparison raises at plan time, surfaced
 * here at declaration time (CREATE TABLE / ALTER ADD CONSTRAINT / ADD COLUMN /
 * declarative apply). Pure schema check (no row scan).
 *
 * Stays in lockstep with enforcement by construction: it resolves the pair
 * through {@link resolveForeignKeyColumnCollation} — the one rule the child-side
 * check, the parent-side checks and the runtime parent-side probes / actions
 * share (`collationExplicit` → provenance `'declared'`, else `'default'`, then the
 * comparison lattice). So it fires on exactly the conflicts the first DML
 * against the child would, only sooner — never a re-derived textuality- or
 * name-based rule.
 *
 * Resolution rules (consequences of staying in lockstep, intended):
 *  - matching declared collations (nocase/nocase) resolve, no conflict;
 *  - one-sided declaration (declared nocase vs defaulted BINARY) resolves to
 *    NOCASE — a defaulted BINARY is the engine floor, it contributes nothing;
 *  - a *declared* `COLLATE BINARY` (rank 2) vs a declared NOCASE conflicts;
 *  - a divergent explicit COLLATE on non-text columns still conflicts — we
 *    mirror enforcement exactly rather than gating on textuality.
 *
 * The parent is resolved against the live catalog; a not-yet-created
 * (forward-declared) parent is skipped — its column types are unknown, so the
 * conflict cannot be seen yet and remains caught at first DML (the one
 * unavoidable residual). A self-referencing FK resolves against `childSchema`
 * directly so it validates at CREATE, before the table is registered.
 *
 * Unconditional — NOT gated on `pragma foreign_keys`. A conflicting-collation
 * declaration is a malformed declaration (same class as the child/parent
 * column-count mismatch the builders reject unconditionally), not an
 * enforcement concern, so a contradictory schema is rejected whether or not
 * enforcement is currently enabled.
 */
export function validateForeignKeyCollations(
	db: Database,
	childSchema: TableSchema,
	fk: ForeignKeyConstraintSchema,
): void {
	// Resolve the parent. A self-referencing FK names `childSchema` itself; resolve
	// it directly so the check fires at CREATE (the table is not yet registered).
	const parentSchemaName = fk.referencedSchema ?? childSchema.schemaName;
	const selfRef = fk.referencedTable.toLowerCase() === childSchema.name.toLowerCase()
		&& parentSchemaName.toLowerCase() === childSchema.schemaName.toLowerCase();
	const parent = selfRef
		? childSchema
		: db.schemaManager.findTable(fk.referencedTable, parentSchemaName);
	// Forward-declared parent: column types unknown — conflict stays caught at first DML.
	if (!parent) return;

	let parentColIndices: number[];
	try {
		parentColIndices = resolveReferencedColumns(fk, parent);
	} catch {
		// A missing referenced column is reported by the enforcement path; don't double-report.
		return;
	}
	// A child/parent column-count mismatch is already raised by the builders.
	if (parentColIndices.length !== fk.columns.length) return;

	for (let i = 0; i < fk.columns.length; i++) {
		const childCol = childSchema.columns[fk.columns[i]];
		const parentCol = parent.columns[parentColIndices[i]];
		const res = resolveForeignKeyColumnCollation(childCol, parentCol);
		if (res.kind === 'conflict') {
			throw new QuereusError(
				`FOREIGN KEY '${fk.name ?? `_fk_${childSchema.name}`}' on '${childSchema.name}': `
				+ `child column '${childSchema.name}.${childCol.name}' (collation ${childCol.collation}) `
				+ `and parent column '${parent.name}.${parentCol.name}' (collation ${parentCol.collation}) `
				+ `declare conflicting collations; declare a matching COLLATE on both sides.`,
				StatusCode.ERROR,
			);
		}
	}
}
