import type { SchemaCatalog, CatalogTable, CatalogView, CatalogIndex } from './catalog.js';
import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createTableToString, createViewToString, createMaterializedViewToString, createIndexToString, createAssertionToString, columnDefToString, quoteIdentifier, expressionToString, tagsBodyToString, tableConstraintsToString, constraintBodyToCanonicalString, createIndexBodyToCanonicalString, indexedColumnBareName, viewDefinitionToCanonicalString } from '../emit/ast-stringify.js';
import { computeBodyHash, normalizeBackingModuleName, canonicalBackingModuleArgs } from './view.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { validateReservedTags, type TagDiagnostic } from './reserved-tags.js';
import { raiseReservedTagDiagnostics } from './reserved-tags-policy.js';
import { renameColumnInAst, renameColumnInCheckExpression, renameTableInAst, collectFromTableNames } from './rename-rewriter.js';
import type { ResolveColumnInSource } from './rename-rewriter.js';
import { cloneExpr, cloneQueryExpr } from '../planner/mutation/scope-transform.js';
import { normalizeCollationName } from '../util/comparison.js';
import { inferType } from '../types/registry.js';
import { resolveDefaultCollation } from './table.js';

const log = createLogger('schema:differ');
const warnLog = log.extend('warn');

/** Reserved tag namespace prefix used for differ-recognized hints. */
const QUEREUS_TAG_PREFIX = 'quereus.';

export type RenamePolicy = 'allow' | 'require-hint' | 'deny';

export type RenameKind = 'table' | 'view' | 'index' | 'constraint';

export interface RenameOp {
	kind: RenameKind;
	oldName: string;
	newName: string;
}

export interface ColumnRenameOp {
	oldName: string;
	newName: string;
}

/**
 * Represents the difference between a declared schema and actual database state
 */
export interface SchemaDiff {
	tablesToCreate: string[];
	tablesToDrop: string[];
	tablesToAlter: TableAlterDiff[];
	viewsToCreate: string[];
	viewsToDrop: string[];
	/** Materialized views to (re)create — full `create materialized view …` DDL. */
	materializedViewsToCreate: string[];
	/** Materialized-view names to drop (a rebuild emits both a drop and a create). */
	materializedViewsToDrop: string[];
	indexesToCreate: string[];
	indexesToDrop: string[];
	assertionsToCreate: string[];
	assertionsToDrop: string[];
	/**
	 * In-place metadata-tag changes on name-matched views / materialized views /
	 * indexes (whole-set replacement; `tags: {}` clears). These take the new
	 * `ALTER … SET TAGS` primitive rather than a drop+recreate — crucially, a
	 * materialized-view tag change avoids a needless re-materialization. A MV whose
	 * *body* changed drops+recreates instead (the recreate carries the declared
	 * tags), so the two are mutually exclusive per object.
	 */
	viewTagsChanges: Array<{ name: string; tags: Record<string, SqlValue> }>;
	materializedViewTagsChanges: Array<{ name: string; tags: Record<string, SqlValue> }>;
	indexTagsChanges: Array<{ name: string; tags: Record<string, SqlValue> }>;
	/** Renames detected via `quereus.id` / `quereus.previous_name` hints. */
	renames: RenameOp[];
	/**
	 * Logical-schema lens attaches: declared logical tables not yet registered
	 * as a lens body. Only populated for a logical declared schema. Carries no
	 * migration DDL — the lens compiler attaches at apply time, not via DDL.
	 */
	lensToAttach: string[];
	/**
	 * Logical-schema lens detaches: registered lens bodies absent from the
	 * declaration. A logical removal detaches the lens and **never** drops basis
	 * storage (see `docs/lens.md` § Deployment) — so this is emitted *instead of*
	 * a basis-table drop.
	 */
	lensToDetach: string[];
}

export interface ColumnAttributeChange {
	columnName: string;
	/** Desired NOT NULL setting. Omitted = no change. */
	notNull?: boolean;
	/** Desired declared (logical) data type. Omitted = no change. */
	dataType?: string;
	/**
	 * Desired DEFAULT expression.
	 *   undefined = no change
	 *   null      = drop existing default
	 *   Expression = set to given expression
	 */
	defaultValue?: AST.Expression | null;
	/**
	 * Desired collation (canonical, e.g. `'NOCASE'`) when the declared column's
	 * COLLATE differs from actual. Omitted = no change. Absent and `'BINARY'` are
	 * treated as equal (no spurious diff). Emitted as `SET COLLATE <name>`.
	 */
	collation?: string;
	/**
	 * Desired metadata tag set (whole-set replacement) when the declared column
	 * tags differ from actual. Omitted = no change; `{}` = clear all tags. Rename
	 * hints (`quereus.id` / `quereus.previous_name`) are excluded from the drift
	 * comparison but kept verbatim in the emitted set.
	 */
	tags?: Record<string, SqlValue>;
}

export interface TableAlterDiff {
	tableName: string;
	columnsToAdd: string[];
	columnsToDrop: string[];
	columnsToAlter: ColumnAttributeChange[];
	/** Column renames discovered via `quereus.id` / `quereus.previous_name` on declared columns. */
	columnsToRename: ColumnRenameOp[];
	/** Constraint renames discovered via tag hints (user-named CHECK / UNIQUE / FK). */
	constraintsToRename?: ColumnRenameOp[];
	/**
	 * User-named constraints to remove via `DROP CONSTRAINT <name>`: those present
	 * in the actual catalog but absent from the declaration (and not consumed by a
	 * rename), PLUS the old side of a **body change** — a name-matched constraint
	 * whose canonical body drifted is realized as drop-old + add-new (it pairs with
	 * an entry in {@link constraintsToAdd}).
	 */
	constraintsToDrop?: string[];
	/**
	 * Declared user-named constraints to install via `ALTER TABLE … ADD
	 * <constraint-fragment>`: those absent from the actual catalog (and not a rename
	 * target), PLUS the new side of a **body change** (paired with a
	 * {@link constraintsToDrop} entry under the old name). Each entry is the full
	 * constraint DDL fragment (`constraint <name> check (...)` with any tags) the
	 * `ADD` primitive consumes. ADD applies a CHECK in place; a UNIQUE / FOREIGN
	 * KEY add routes through the module's `addConstraint`, re-validating existing
	 * rows (so a body-change recreate re-validates against the new rule).
	 */
	constraintsToAdd?: string[];
	primaryKeyChange?: {
		oldPkColumns: string[];
		newPkColumns: Array<{ name: string; direction?: 'asc' | 'desc' }>;
	};
	/**
	 * Desired table-level metadata tag set (whole-set replacement) when the declared
	 * table tags differ from actual. Omitted = no change; `{}` = clear all tags.
	 */
	tableTagsChange?: Record<string, SqlValue>;
	/**
	 * Per named table-level constraint whose declared tags drifted from actual.
	 * Whole-set replacement; `tags: {}` clears. Name-matched constraints only.
	 */
	constraintTagsChanges?: Array<{ constraintName: string; tags: Record<string, SqlValue> }>;
}

/**
 * Computes the difference between declared schema and actual catalog
 */
export function computeSchemaDiff(
	declaredSchema: AST.DeclareSchemaStmt,
	actualCatalog: SchemaCatalog,
	policy: RenamePolicy = 'allow',
	/**
	 * Session `default_collation` used to resolve an omitted COLLATE on the *declared*
	 * side, matching how the CREATE path resolves it for a fresh `apply`. Defaults to
	 * `'BINARY'` so direct callers (and the existing test suite, which runs under the
	 * BINARY session default) keep byte-for-byte identical diffs. The emitters thread
	 * the live `default_collation` session option.
	 */
	defaultCollation: string = 'BINARY',
): SchemaDiff {
	const diff: SchemaDiff = {
		tablesToCreate: [],
		tablesToDrop: [],
		tablesToAlter: [],
		viewsToCreate: [],
		viewsToDrop: [],
		materializedViewsToCreate: [],
		materializedViewsToDrop: [],
		indexesToCreate: [],
		indexesToDrop: [],
		assertionsToCreate: [],
		assertionsToDrop: [],
		viewTagsChanges: [],
		materializedViewTagsChanges: [],
		indexTagsChanges: [],
		renames: [],
		lensToAttach: [],
		lensToDetach: [],
	};

	// Logical schema: the per-table diff is attach/detach-lens, never
	// create/drop-table. A logical schema's actual catalog views ARE its lens
	// bodies (a logical schema has no user views), so compare declared logical
	// tables against the registered views. Basis storage is untouched.
	if (declaredSchema.isLogical) {
		return computeLogicalSchemaDiff(declaredSchema, actualCatalog, diff);
	}

	const targetSchemaName = actualCatalog.schemaName;

	// Extract schema-level default module settings
	const defaultVtabModule = declaredSchema.using?.defaultVtabModule;
	const defaultVtabArgs = declaredSchema.using?.defaultVtabArgs;

	// Build maps of declared items
	const declaredTables = new Map<string, AST.DeclaredTable>();
	const declaredViews = new Map<string, AST.DeclaredView>();
	const declaredMaterializedViews = new Map<string, AST.DeclaredMaterializedView>();
	const declaredIndexes = new Map<string, AST.DeclaredIndex>();
	const declaredAssertions = new Map<string, AST.DeclaredAssertion>();

	// Reserved-tag shape/site validation flows through the SAME typed registry
	// (`validateReservedTags`) as the lens-compile / mutation / advertisement
	// paths — there is no second differ-local allow-list. Severity is unified:
	// an unknown / mis-sited / malformed `quereus.*` key is a hard error here too
	// (Decision 2 of the ticket), so a physical-schema typo fails `apply`/`diff`
	// loudly instead of silently soft-warning. We accumulate every declared
	// object's diagnostics across the whole schema, then raise once — BEFORE the
	// throw-y rename resolution below, so a tag typo surfaces deterministically
	// rather than being masked by a rename conflict. Sites per Decision 3:
	// table → physical-table (also the basis-table/advertisement position),
	// column → physical-column, view / materialized view → view-ddl,
	// index → physical-index, table constraint (named or not) → physical-constraint.
	// Assertions carry no `tags` field (no site). The rename hints
	// (quereus.id / quereus.previous_name) are first-class specs valid at each of
	// these physical sites; an MV's hint validates (over-permissive: the differ
	// supports no MV rename and simply ignores it — harmless, see Decision 1).
	const tagDiagnostics: TagDiagnostic[] = [];
	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable':
				declaredTables.set(item.tableStmt.table.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.tableStmt.tags, 'physical-table'));
				for (const col of item.tableStmt.columns) {
					tagDiagnostics.push(...validateReservedTags(col.tags, 'physical-column'));
				}
				for (const c of item.tableStmt.constraints ?? []) {
					// Validate every table constraint's tags, named or not. A table-level
					// constraint consumes a trailing `WITH TAGS` unconditionally (the
					// parser only defers it to the column for *unnamed inline column*
					// constraints), so an unnamed table constraint CAN carry a reserved
					// tag — gating validation on `c.name` would leave a typo there as a
					// silent no-op, the exact escape the unified hard-error posture
					// exists to close. Rename detection still keys off named constraints
					// only; this is validation-only and harmless on unnamed ones.
					tagDiagnostics.push(...validateReservedTags(c.tags, 'physical-constraint'));
				}
				// Inline *named* column constraints carry their own trailing `WITH TAGS`
				// on `cc.tags` at the SAME physical-constraint site as a table-level
				// constraint (the parser lifts a trailing tag onto the constraint only
				// when it is named; an unnamed inline constraint defers its tags to the
				// column, so `cc.tags` is undefined there and validateReservedTags returns
				// [] — a harmless no-op, no `cc.name` guard needed). Validate regardless of
				// constraint *kind* (validation is independent of the lifecycle lift that
				// handles only check/unique/fk) so a typo'd or mis-sited reserved key on
				// e.g. `qty integer constraint chk check (qty>0) with tags (...)` fails
				// here too. Appended LAST (after the table-level constraint loop) so the
				// accumulated diagnostic order is identical to the direct CREATE path:
				// table → columns → table-constraints → column-constraints.
				for (const col of item.tableStmt.columns) {
					for (const cc of col.constraints ?? []) {
						tagDiagnostics.push(...validateReservedTags(cc.tags, 'physical-constraint'));
					}
				}
				break;
			case 'declaredView':
				declaredViews.set(item.viewStmt.view.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.viewStmt.tags, 'view-ddl'));
				break;
			case 'declaredMaterializedView':
				declaredMaterializedViews.set(item.viewStmt.view.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.viewStmt.tags, 'view-ddl'));
				break;
			case 'declaredIndex':
				declaredIndexes.set(item.indexStmt.index.name.toLowerCase(), item);
				tagDiagnostics.push(...validateReservedTags(item.indexStmt.tags, 'physical-index'));
				break;
			case 'declaredAssertion':
				declaredAssertions.set(item.assertionStmt.name.toLowerCase(), item);
				break;
		}
	}
	raiseReservedTagDiagnostics(tagDiagnostics, {
		log: (d) => warnLog('reserved tag advisory (%s) on %s: %s', d.reason, d.site, d.message),
	});

	// Build maps of actual items
	const actualTables = new Map(actualCatalog.tables.map(t => [t.name.toLowerCase(), t]));
	const actualViews = new Map(actualCatalog.views.map(v => [v.name.toLowerCase(), v]));
	const actualMaterializedViews = new Map(actualCatalog.materializedViews.map(mv => [mv.name.toLowerCase(), mv]));
	// Exclude *exposed implicit covering indexes* (`CatalogIndex.implicit` — the
	// secondary BTree backing a UNIQUE constraint tagged
	// `quereus.expose_implicit_index`). The catalog surfaces them for introspection
	// (`schema()` / `index_info()`), but their lifecycle belongs to the originating
	// UNIQUE constraint (the named-constraint diff path), NOT to `CREATE/DROP INDEX`.
	// Filtering here keeps them out of ALL three downstream index consumers in one
	// place — rename resolution, the create/body loop, and the orphan-drop loop — so a
	// converged schema with an exposed implicit index diffs empty (no phantom
	// `DROP INDEX IF EXISTS`). See `catalog.ts` `CatalogIndex.implicit`.
	const actualIndexes = new Map(
		actualCatalog.indexes.filter(i => !i.implicit).map(i => [i.name.toLowerCase(), i]),
	);

	// Resolve renames per-kind. Each call returns:
	//   - rename ops (oldName -> newName)
	//   - matched pairs (declaredKey -> actual): for the alter-diff loop later
	//   - consumedActuals: actuals that are now spoken-for by a rename and must
	//     not be dropped
	const tableRenames = resolveRenames<AST.DeclaredTable, CatalogTable>({
		kind: 'table',
		declared: declaredTables,
		actual: actualTables,
		getDeclaredName: d => d.tableStmt.table.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.tableStmt.tags,
		getActualTags: a => a.tags,
		policy,
	});
	diff.renames.push(...tableRenames.renames);

	const viewRenames = resolveRenames<AST.DeclaredView, CatalogView>({
		kind: 'view',
		declared: declaredViews,
		actual: actualViews,
		getDeclaredName: d => d.viewStmt.view.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.viewStmt.tags,
		getActualTags: a => a.tags,
		policy,
	});
	diff.renames.push(...viewRenames.renames);

	const indexRenames = resolveRenames<AST.DeclaredIndex, CatalogIndex>({
		kind: 'index',
		declared: declaredIndexes,
		actual: actualIndexes,
		getDeclaredName: d => d.indexStmt.index.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.indexStmt.tags,
		getActualTags: a => a.tags,
		policy,
	});
	diff.renames.push(...indexRenames.renames);

	// Pre-pass: resolve every name-matched declared table's column renames, keyed by
	// declared (new) table name (lowercased). This gives the per-table alter loop
	// cross-table visibility of a *parent* table's column renames, so the FK branch
	// of `reconciledDeclaredBody` can inverse-rename an FK's referenced PARENT column
	// (its `foreignKey.table` carries the parent's declared name at diff time — the
	// same lookup key). A self-referential FK falls out for free: the parent is the
	// current table, so `map.get(currentTable)` matches `diff.columnsToRename`. Pure
	// creates (no matched actual) contribute nothing. NOTE: this re-resolves the
	// current table's renames a second time (once here, once in its own
	// `computeTableAlterDiff`); see `resolveColumnRenames` for why that's accepted.
	const columnRenamesByTable = new Map<string, ColumnRenameOp[]>();
	for (const [name, declaredTable] of declaredTables) {
		const matchedActual = tableRenames.pairs.get(name);
		if (!matchedActual) continue;
		const renames = resolveColumnRenames(declaredTable, matchedActual, policy).renames;
		if (renames.length > 0) {
			columnRenamesByTable.set(name, renames.map(r => ({ oldName: r.oldName, newName: r.newName })));
		}
	}

	// Declared-side column-existence resolver for the scope-aware seeded column
	// rewrites in the reconcilers (the optional `ResolveColumnInSource` arg of
	// `renameColumnInCheckExpression`). The forward rename propagation passes a
	// live schemaManager lookup (see `rewriteTableForColumnRename` in
	// runtime/emit/alter-table.ts); the diff side has no live catalog for the
	// post-rename world, so it answers from the DECLARED column sets instead:
	// the inverse walk's match target (`oldCol`) is the rename's NEW column
	// name, and the question being answered is "in the declared world, does
	// this inner FROM source expose that name (so the unqualified ref binds
	// there, not to the owning seed)?". The walk's `realSources` carry OLD
	// table names when the inverse table-rename pass has pre-normalized
	// qualifiers (and DECLARED names when it hasn't — `columnReconciledViewStmt`),
	// hence the old→new table-name mapping before the declared lookup: an
	// already-declared name simply misses the rename find and passes through.
	// Cross-schema sources answer false (the catalog is single-schema) —
	// conservative where the forward path's live lookup could say yes; worst
	// case a benign drop+recreate.
	const targetSchemaLower = targetSchemaName.toLowerCase();
	const resolveDeclaredColumn: ResolveColumnInSource = (schema, table, column) => {
		if (schema !== targetSchemaLower) return false;
		const declaredName = tableRenames.renames.find(r => r.oldName.toLowerCase() === table)?.newName.toLowerCase() ?? table;
		const dt = declaredTables.get(declaredName);
		return dt?.tableStmt.columns.some(c => c.name.toLowerCase() === column) ?? false;
	};

	// Tables: creates / alters
	for (const [name, declaredTable] of declaredTables) {
		const tableStmt = declaredTable.tableStmt;
		const matchedActual = tableRenames.pairs.get(name);
		if (matchedActual) {
			// Either a rename match or a name-based match — compute alter diff against the matched actual.
			// Thread the table renames (all `kind: 'table'` from this resolver), the
			// schema name, and the cross-table column-rename map so the constraint body
			// comparison can reconcile a renamed local column / FK-parent-table /
			// FK-referenced-parent-column against the actual (pre-rename) catalog body.
			const alterDiff = computeTableAlterDiff(declaredTable, matchedActual, policy, tableRenames.renames, targetSchemaName, columnRenamesByTable, resolveDeclaredColumn, defaultCollation);
			// If this was a rename, set the alter target to the new name (post-rename)
			if (matchedActual.name.toLowerCase() !== name) {
				alterDiff.tableName = tableStmt.table.name;
			}
			if (
				alterDiff.columnsToAdd.length > 0
				|| alterDiff.columnsToDrop.length > 0
				|| alterDiff.columnsToAlter.length > 0
				|| alterDiff.columnsToRename.length > 0
				|| (alterDiff.constraintsToRename?.length ?? 0) > 0
				|| (alterDiff.constraintsToDrop?.length ?? 0) > 0
				|| (alterDiff.constraintsToAdd?.length ?? 0) > 0
				|| alterDiff.primaryKeyChange
				|| alterDiff.tableTagsChange !== undefined
				|| (alterDiff.constraintTagsChanges?.length ?? 0) > 0
			) {
				diff.tablesToAlter.push(alterDiff);
			}
		} else {
			const effectiveStmt = applyTableDefaults(tableStmt, targetSchemaName, defaultVtabModule, defaultVtabArgs);
			diff.tablesToCreate.push(createTableToString(effectiveStmt));
		}
	}

	// Tables: drops (skip those consumed by a rename)
	const dropSet = new Set<string>();
	for (const [name] of actualTables) {
		if (tableRenames.consumedActuals.has(name)) continue;
		if (!declaredTables.has(name)) dropSet.add(name);
	}
	diff.tablesToDrop = orderDropsByFKDependency(dropSet, actualTables);

	// Views: creates / drops / definition-change recreates / hinted-rename
	// recreates / in-place tag changes.
	// A matched view (name- OR rename-matched) whose canonical definition drifted
	// (explicit column list, body, or the `insert defaults` clause — see
	// `viewDefinitionToCanonicalString`) drops+recreates: a plain view is
	// data-less, so the recreate is free, and it carries the declared tags — so a
	// definition change SUPPRESSES any separate SET TAGS (the same mutual
	// exclusion the MV/index paths use). The declared definition is compared raw
	// first; on mismatch a rename-RECONCILED render (every in-diff table/column
	// rename inverse-applied NEW→OLD — see `reconciledDeclaredViewDefinition`)
	// re-compares, so a dependent view over a source renamed in this same diff
	// does not churn a spurious recreate. That reconciliation is
	// correctness-critical, not just churn: `generateMigrationDDL` emits view
	// creates BEFORE the table-alter block where RENAME COLUMN lives, and CREATE
	// VIEW plans its body at create time — an unreconciled recreate naming the
	// NEW column would fail at apply. A RENAME-matched view (hinted via
	// quereus.id / quereus.previous_name) resolves to drop(actual old name) +
	// create(declared new name) whether or not its definition changed — its
	// `kind: 'view'` rename op is metadata only (no ALTER VIEW … RENAME TO
	// primitive), so the convergence DDL must come from these buckets. A
	// definition-UNCHANGED hinted rename renders the recreate with the in-diff
	// COLUMN renames inverse-applied while keeping declared TABLE names (table
	// renames run before creates; column renames run after — see
	// `columnReconciledViewStmt`); the recreate carries the declared tags, so a
	// rename + tag drift converges through it and the in-place SET TAGS branch
	// below never double-emits (renames `continue` past it). A pure name match
	// whose definition is unchanged but tags drifted still takes the in-place
	// `ALTER VIEW … SET TAGS`.
	let viewRecreates = 0; // deliberate drop+create pairs, excluded from the require-hint counts
	for (const [name, declaredView] of declaredViews) {
		const matchedActual = viewRenames.pairs.get(name);
		if (!matchedActual) {
			diff.viewsToCreate.push(createViewToString(declaredView.viewStmt));
			continue;
		}
		const stmt = declaredView.viewStmt;
		let definitionDrifted = viewDefinitionToCanonicalString(stmt.columns, stmt.select, stmt.insertDefaults) !== matchedActual.definition;
		if (definitionDrifted && (tableRenames.renames.length > 0 || columnRenamesByTable.size > 0)) {
			definitionDrifted = reconciledDeclaredViewDefinition(stmt.columns, stmt.select, stmt.insertDefaults, tableRenames.renames, columnRenamesByTable, targetSchemaName, resolveDeclaredColumn) !== matchedActual.definition;
		}
		if (definitionDrifted) {
			diff.viewsToDrop.push(matchedActual.name);
			diff.viewsToCreate.push(createViewToString(stmt));
			viewRecreates++;
			continue;
		}
		if (matchedActual.name.toLowerCase() !== name) {
			// Hinted rename, definition unchanged → drop(old) + recreate(declared),
			// rendered with in-diff column renames inverse-applied (NEW→OLD).
			diff.viewsToDrop.push(matchedActual.name);
			diff.viewsToCreate.push(createViewToString(columnReconciledViewStmt(stmt, columnRenamesByTable, targetSchemaName, resolveDeclaredColumn)));
			viewRecreates++;
			continue;
		}
		if (tagsDrifted(stmt.tags, matchedActual.tags)) {
			diff.viewTagsChanges.push({ name: stmt.view.name, tags: desiredTagSet(stmt.tags) });
		}
	}
	for (const [name] of actualViews) {
		if (viewRenames.consumedActuals.has(name)) continue;
		if (!declaredViews.has(name)) diff.viewsToDrop.push(name);
	}

	// Materialized views: create / drop / rebuild. No rename support (names are
	// part of the contract, like assertions). A definition change is detected by
	// recomputing the declared MV's canonical definition hash (explicit column
	// list + body + `insert defaults` clause — the same
	// `viewDefinitionToCanonicalString` plain views compare, hashed because the
	// live side persists only the hash) and comparing it against the live MV's
	// `bodyHash`; a mismatch schedules a drop + recreate (the recreate
	// re-materializes the body in apply order — same drop+recreate path views
	// use, since MVs have no in-place ALTER primitive). On a raw mismatch the
	// rename-reconciled render re-compares first, so an in-diff source
	// table/column rename does not churn a spurious rebuild — the rename ops
	// themselves trigger the live MV rename propagation at apply, which rewrites
	// the body and re-stamps `bodyHash` to converge.
	//
	// Backing-module identity (`using <module>(...)`) is compared as a SEPARATE
	// field, not folded into the hash (changing the hash formula would spuriously
	// rebuild every already-persisted MV): both sides normalize (absent ⇒ memory,
	// `mem` aliased) and args compare under a stable-key-order render, so
	// `using memory()` vs absent never churns while a real module change takes
	// the same drop+recreate path a body drift does.
	for (const [name, declaredMv] of declaredMaterializedViews) {
		const actual = actualMaterializedViews.get(name);
		if (!actual) {
			diff.materializedViewsToCreate.push(createMaterializedViewToString(declaredMv.viewStmt));
		} else {
			const stmt = declaredMv.viewStmt;
			let bodyDrifted = computeBodyHash(viewDefinitionToCanonicalString(stmt.columns, stmt.select, stmt.insertDefaults)) !== actual.bodyHash;
			if (bodyDrifted && (tableRenames.renames.length > 0 || columnRenamesByTable.size > 0)) {
				bodyDrifted = computeBodyHash(reconciledDeclaredViewDefinition(stmt.columns, stmt.select, stmt.insertDefaults, tableRenames.renames, columnRenamesByTable, targetSchemaName, resolveDeclaredColumn)) !== actual.bodyHash;
			}
			const moduleDrifted =
				normalizeBackingModuleName(stmt.moduleName) !== normalizeBackingModuleName(actual.backingModuleName)
				|| canonicalBackingModuleArgs(stmt.moduleArgs) !== canonicalBackingModuleArgs(actual.backingModuleArgs);
			if (bodyDrifted || moduleDrifted) {
				// Definition changed → drop+recreate (the recreate re-materializes AND
				// carries the declared tags); never also emit a SET TAGS for this MV.
				diff.materializedViewsToDrop.push(name);
				diff.materializedViewsToCreate.push(createMaterializedViewToString(stmt));
			} else if (tagsDrifted(stmt.tags, actual.tags)) {
				// Definition unchanged but tags drifted → in-place SET TAGS, no rebuild.
				diff.materializedViewTagsChanges.push({ name: stmt.view.name, tags: desiredTagSet(stmt.tags) });
			}
		}
	}
	for (const [name] of actualMaterializedViews) {
		if (!declaredMaterializedViews.has(name)) diff.materializedViewsToDrop.push(name);
	}

	// Indexes: creates / drops / body-change recreates / hinted-rename recreates /
	// in-place tag changes.
	// A name-matched index whose canonical body drifted (UNIQUE-ness, column
	// set/order/direction, partial WHERE) drops+recreates — the same drop+recreate
	// shape MVs use, since an index has no in-place "redefine" primitive. The
	// recreate carries the declared tags, so a body change SUPPRESSES any separate
	// SET TAGS for that index (mutually exclusive per object, mirroring the MV
	// precedence above). A RENAME-matched index (hinted) resolves to drop(actual
	// old name) + create(declared new name) whether or not its body changed — the
	// `kind: 'index'` rename op is metadata only (no ALTER INDEX … RENAME TO
	// primitive), so the convergence DDL must come from these buckets; the
	// rebuild cost on a pure rename is the documented tradeoff. A body-UNCHANGED
	// hinted rename renders the recreate with the in-diff COLUMN renames
	// inverse-applied while keeping declared TABLE names (see
	// `columnReconciledIndexStmt`); the recreate carries the declared tags, so the
	// in-place SET TAGS branch below never double-emits (renames `continue` past
	// it). A pure name match whose body is unchanged but tags drifted still takes
	// the in-place `ALTER INDEX … SET TAGS`.
	let indexRecreates = 0; // deliberate drop+create pairs, excluded from the require-hint counts
	for (const [name, declaredIndex] of declaredIndexes) {
		const matchedActual = indexRenames.pairs.get(name);
		if (!matchedActual) {
			const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(effectiveStmt));
			continue;
		}
		// Body comparison (canonical: name / tags excluded; per-column collation
		// included via both-sides pre-resolution). Schema qualification does not affect
		// the body render, so compare the raw declared stmt. The declared side resolves
		// each column's effective collation against the matched declared table (so an
		// inherited/BINARY collation that is unchanged does not churn, while a real
		// collation change recreates), then inverse-applies the index table's in-diff
		// column renames so a same-named index over a column renamed in this same diff
		// matches the actual (pre-rename) body instead of churning a spurious
		// drop+recreate (the column rename rides the table-alter channel). The rename
		// lookup is keyed by the index's *declared* (post-rename) table name — exactly
		// how `columnRenamesByTable` is keyed — so a table renamed in the same diff still
		// resolves its column renames. ALL in-diff table renames are threaded too, so
		// both a table-qualified self-reference and a cross-table reference in the
		// partial WHERE predicate reconcile alongside the column renames (the own-table
		// rename's remaining special role — seeding the column rewrites — is resolved
		// inside declaredIndexCanonicalBody). The drop targets the actual
		// (pre-rename) name and the recreate carries the declared (post-rename) name, so
		// a genuine body change on a rename-matched index resolves to a correct
		// drop+recreate that supersedes the no-op rename op.
		const declaredTableForIndex = declaredTables.get(declaredIndex.indexStmt.table.name.toLowerCase());
		const indexColRenames = columnRenamesByTable.get(declaredIndex.indexStmt.table.name.toLowerCase()) ?? [];
		const declaredBody = declaredIndexCanonicalBody(declaredIndex.indexStmt, declaredTableForIndex, indexColRenames, tableRenames.renames, targetSchemaName, defaultCollation);
		if (declaredBody !== matchedActual.definition) {
			diff.indexesToDrop.push(matchedActual.name);
			const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(effectiveStmt));
			indexRecreates++;
			continue;
		}
		if (matchedActual.name.toLowerCase() !== name) {
			// Hinted rename, body unchanged → drop(old) + recreate(declared),
			// rendered with in-diff column renames inverse-applied (NEW→OLD).
			diff.indexesToDrop.push(matchedActual.name);
			const reconciledStmt = columnReconciledIndexStmt(declaredIndex.indexStmt, indexColRenames, columnRenamesByTable, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(applyIndexDefaults(reconciledStmt, targetSchemaName)));
			indexRecreates++;
			continue;
		}
		// Body unchanged → in-place tag change (pure name match only — renames `continue` above).
		if (tagsDrifted(declaredIndex.indexStmt.tags, matchedActual.tags)) {
			diff.indexTagsChanges.push({ name: declaredIndex.indexStmt.index.name, tags: desiredTagSet(declaredIndex.indexStmt.tags) });
		}
	}
	for (const [name] of actualIndexes) {
		if (indexRenames.consumedActuals.has(name)) continue;
		if (!declaredIndexes.has(name)) diff.indexesToDrop.push(name);
	}

	// Apply 'require-hint' policy: any unhinted name change is an error rather
	// than a silent drop+create. A body-change OR hinted-rename recreate counts as
	// both a create and a drop, which would falsely trip the unhinted-rename guard
	// — so exclude those from the view/index counts (the constraint path does the
	// same with its pure counts): both are deliberate drop+create pairs of a
	// matched object, not an ambiguous unhinted rename.
	if (policy === 'require-hint') {
		enforceRequireHint('table', diff.tablesToCreate.length, diff.tablesToDrop.length);
		enforceRequireHint('view', diff.viewsToCreate.length - viewRecreates, diff.viewsToDrop.length - viewRecreates);
		enforceRequireHint('index', diff.indexesToCreate.length - indexRecreates, diff.indexesToDrop.length - indexRecreates);
	}

	// Assertions (no rename support — names are explicitly part of the contract).
	const actualAssertions = new Map(actualCatalog.assertions.map(a => [a.name.toLowerCase(), a]));

	for (const [name, declaredAssertion] of declaredAssertions) {
		if (!actualAssertions.has(name)) {
			diff.assertionsToCreate.push(createAssertionToString(declaredAssertion.assertionStmt));
		}
	}

	for (const [name] of actualAssertions) {
		if (!declaredAssertions.has(name)) {
			diff.assertionsToDrop.push(name);
		}
	}

	return diff;
}

/**
 * Computes the diff for a **logical** declared schema. The per-table unit is
 * attach/detach-lens, not create/drop-table:
 *   - a declared logical table not currently registered → attach,
 *   - a registered lens body absent from the declaration → detach.
 *
 * Crucially, this never populates `tablesToDrop` — a logical removal detaches
 * the lens and leaves basis storage intact (see `docs/lens.md` § Deployment).
 * Physical buckets stay empty; `generateMigrationDDL` emits nothing for a
 * logical diff (attach/detach happens in the lens compiler at apply time).
 */
function computeLogicalSchemaDiff(
	declaredSchema: AST.DeclareSchemaStmt,
	actualCatalog: SchemaCatalog,
	diff: SchemaDiff,
): SchemaDiff {
	const declaredLogical = new Set<string>();
	for (const item of declaredSchema.items) {
		if (item.type === 'declaredTable') {
			declaredLogical.add(item.tableStmt.table.name.toLowerCase());
		}
	}
	// In a logical schema, registered views are exclusively lens bodies.
	const actualLens = new Set(actualCatalog.views.map(v => v.name.toLowerCase()));

	for (const name of declaredLogical) {
		if (!actualLens.has(name)) diff.lensToAttach.push(name);
	}
	for (const name of actualLens) {
		if (!declaredLogical.has(name)) diff.lensToDetach.push(name);
	}
	return diff;
}

/**
 * Generic resolver: pair declared and actual objects by name first, then by
 * `quereus.id` and `quereus.previous_name` tag hints to detect renames.
 *
 * Returns:
 *   - `renames`: ordered RenameOps to perform.
 *   - `pairs`:  map from lowercased *declared* name to the matched actual,
 *               for use by alter-diff (covers both name-matched and rename-matched).
 *   - `consumedActuals`: lowercase actual names that are spoken-for by a rename
 *                       (so the drop loop skips them).
 */
function resolveRenames<D, A>(args: {
	kind: RenameKind;
	declared: Map<string, D>;
	actual: Map<string, A>;
	getDeclaredName: (d: D) => string;
	getActualName: (a: A) => string;
	getDeclaredTags: (d: D) => Readonly<Record<string, SqlValue>> | undefined;
	getActualTags: (a: A) => Readonly<Record<string, SqlValue>> | undefined;
	policy: RenamePolicy;
}): {
	renames: RenameOp[];
	pairs: Map<string, A>;
	consumedActuals: Set<string>;
} {
	const { kind, declared, actual, getDeclaredName, getActualName, getDeclaredTags, getActualTags, policy } = args;

	const renames: RenameOp[] = [];
	const pairs = new Map<string, A>();
	const consumedActuals = new Set<string>();

	// Under 'deny' policy, skip rename detection entirely — only name matches.
	if (policy === 'deny') {
		for (const [dn] of declared) {
			const nameMatch = actual.get(dn);
			if (nameMatch) pairs.set(dn, nameMatch);
		}
		return { renames, pairs, consumedActuals };
	}

	// Build (id → actual) index for quick stable-id lookup.
	const actualById = new Map<string, A>();
	for (const [, a] of actual) {
		const id = readQuereusHint(getActualTags(a), 'id');
		if (id) {
			if (actualById.has(id)) {
				throw new QuereusError(
					`Duplicate quereus.id '${id}' on ${kind}s in actual catalog`,
					StatusCode.ERROR,
				);
			}
			actualById.set(id, a);
		}
	}

	// Iterate declared in insertion order. For each declared:
	//   - hintMatch: actual resolved by quereus.id (preferred) or previous_name
	//   - nameMatch: actual sharing the declared's name
	//   If both exist and refer to *different* actuals → conflict (always error,
	//   independent of policy beyond 'deny').
	for (const [dn, d] of declared) {
		const tags = getDeclaredTags(d);
		const declaredId = readQuereusHint(tags, 'id');
		const prevNamesRaw = readQuereusHint(tags, 'previous_name');

		let hintMatch: A | undefined;
		let hintMatchKey: string | undefined;
		if (declaredId) {
			const byId = actualById.get(declaredId);
			if (byId) {
				hintMatch = byId;
				hintMatchKey = getActualName(byId).toLowerCase();
			}
		}
		if (!hintMatch && prevNamesRaw) {
			const candidates = prevNamesRaw
				.split(',')
				.map(s => s.trim().toLowerCase())
				.filter(s => s.length > 0);
			for (const cand of candidates) {
				if (cand === dn) continue; // self-reference is never a rename source
				const byPrev = actual.get(cand);
				if (byPrev) {
					hintMatch = byPrev;
					hintMatchKey = cand;
					break;
				}
			}
		}

		const nameMatch = actual.get(dn);
		const hintIsSelf = hintMatch && hintMatchKey === dn;

		// Conflict: declared name AND hint each resolve to *distinct* existing actuals.
		if (nameMatch && hintMatch && !hintIsSelf) {
			throw new QuereusError(
				`Rename conflict for ${kind} '${getDeclaredName(d)}': declared name and quereus.previous_name/id resolve to different existing objects ('${dn}' vs '${hintMatchKey}')`,
				StatusCode.ERROR,
			);
		}

		if (nameMatch) {
			pairs.set(dn, nameMatch);
			continue;
		}
		if (hintMatch && !hintIsSelf) {
			if (consumedActuals.has(hintMatchKey!)) {
				throw new QuereusError(
					`Rename conflict for ${kind} '${getDeclaredName(d)}': old object '${hintMatchKey}' already consumed by another rename`,
					StatusCode.ERROR,
				);
			}
			renames.push({ kind, oldName: getActualName(hintMatch), newName: getDeclaredName(d) });
			pairs.set(dn, hintMatch);
			consumedActuals.add(hintMatchKey!);
		}
		// Else: create path (caller emits CREATE)
	}

	return { renames, pairs, consumedActuals };
}

/**
 * Read a `quereus.<key>` tag value as a string. Returns undefined if not present
 * or non-string.
 */
function readQuereusHint(
	tags: Readonly<Record<string, SqlValue>> | undefined,
	key: 'id' | 'previous_name',
): string | undefined {
	if (!tags) return undefined;
	const fullKey = QUEREUS_TAG_PREFIX + key;
	const v = tags[fullKey];
	if (typeof v !== 'string') return undefined;
	const trimmed = v.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function enforceRequireHint(kind: string, creates: number, drops: number): void {
	if (creates > 0 && drops > 0) {
		throw new QuereusError(
			`rename_policy = 'require-hint': ${kind} drops and creates both present (${drops} drop / ${creates} create); add 'quereus.previous_name' or 'quereus.id' to hint renames, or use 'allow' / 'deny'.`,
			StatusCode.ERROR,
		);
	}
}

/**
 * Applies schema-level defaults (schema name, default vtab module) to a table statement
 */
function applyTableDefaults(
	tableStmt: AST.CreateTableStmt,
	targetSchemaName: string,
	defaultVtabModule?: string,
	defaultVtabArgs?: string
): AST.CreateTableStmt {
	let result = tableStmt;

	// Apply schema name if not main and not already specified
	if (targetSchemaName && targetSchemaName !== 'main' && !tableStmt.table.schema) {
		result = {
			...result,
			table: {
				...result.table,
				schema: targetSchemaName
			}
		};
	}

	// Apply default vtab module if table doesn't have an explicit one
	if (!tableStmt.moduleName && defaultVtabModule) {
		let parsedArgs: Record<string, SqlValue> = {};
		if (defaultVtabArgs) {
			try {
				parsedArgs = JSON.parse(defaultVtabArgs) as Record<string, SqlValue>;
			} catch (e) {
				throw new QuereusError(
					`Invalid JSON in schema default vtab args for table '${tableStmt.table.name}': ${(e as Error).message}`,
					StatusCode.ERROR,
					e as Error
				);
			}
		}
		result = {
			...result,
			moduleName: defaultVtabModule,
			moduleArgs: parsedArgs
		};
	}

	return result;
}

/**
 * Applies schema name to an index statement and its table reference
 */
function applyIndexDefaults(
	indexStmt: AST.CreateIndexStmt,
	targetSchemaName: string
): AST.CreateIndexStmt {
	let result = indexStmt;

	// Apply schema name to the index if not main and not already specified
	if (targetSchemaName && targetSchemaName !== 'main') {
		// Apply schema to the index name
		if (!indexStmt.index.schema) {
			result = {
				...result,
				index: {
					...result.index,
					schema: targetSchemaName
				}
			};
		}
		// Apply schema to the table reference
		if (!indexStmt.table.schema) {
			result = {
				...result,
				table: {
					...result.table,
					schema: targetSchemaName
				}
			};
		}
	}

	return result;
}

/**
 * Reads an index column's EXPLICIT per-column collation as-written, covering both
 * indexed-column forms: the plain `col.collation` and the parser's collate-folded
 * form (`col COLLATE x`, whose collation lives on `col.expr.collation`). Returns
 * undefined when the column carries no explicit COLLATE — it then inherits the
 * table column's collation (see {@link declaredColumnCollation}).
 */
function explicitIndexColumnCollation(col: AST.IndexedColumn): string | undefined {
	if (col.collation) return col.collation;
	if (col.expr?.type === 'collate') return col.expr.collation;
	return undefined;
}

/**
 * Reads a declared table column's effective collation from its `collate` column
 * constraint, normalized (uppercase), defaulting to `'BINARY'`. Mirrors the
 * engine's resolution of a table column's collation ({@link extractDeclaredCollation}).
 * Returns `'BINARY'` when no declared table is supplied (an index on a non-declared
 * table — not a coherent name-match) or the column is not found in it.
 */
function declaredColumnCollation(declaredTable: AST.DeclaredTable | undefined, columnName: string, defaultCollation: string): string {
	if (!declaredTable) return 'BINARY';
	const lower = columnName.toLowerCase();
	const col = declaredTable.tableStmt.columns.find(c => c.name.toLowerCase() === lower);
	return col ? extractDeclaredCollation(col, defaultCollation) : 'BINARY';
}

/**
 * Renders the canonical body of a DECLARED index, pre-resolving each column's
 * effective collation the same way the engine does at create/import time
 * (`buildIndexSchema` / `importIndex`): explicit index COLLATE, else the declared
 * table column's collation, else BINARY — normalized. The resolved value is placed
 * on a normalized plain-form {@link AST.IndexedColumn} (`{ name, collation,
 * direction }`) so {@link createIndexBodyToCanonicalString} reads it off
 * `col.collation`, matching the actual side's lift (`indexToCanonicalDDL`). Because
 * both sides feed an identically-resolved collation, an unchanged inherited/BINARY
 * collation renders identically (no churn) while a genuine collation change diverges
 * (drop+recreate).
 *
 * A genuine expression-index column (no resolvable bare name) is passed through
 * untouched — there is no column collation to resolve and the renderer falls back to
 * `expressionToString`. `declaredTable` is the matched declared table (looked up by
 * the index's table reference); undefined falls back to explicit-or-BINARY.
 *
 * **Column-rename reconciliation.** `colRenames` are the in-diff column renames of
 * the index's table (keyed by the declared/new table name in `computeSchemaDiff`'s
 * pre-pass). The actual catalog body still renders the *pre-rename* column names at
 * diff time, while the declared side renders the *new* names — so a same-named index
 * over a column renamed in this same diff would otherwise churn a spurious
 * drop+recreate. To reconcile, each resolved bare name is inverse-mapped from its NEW
 * name back to its OLD name (case-insensitive) so a pure rename matches the actual
 * body (no churn) while a genuine body edit layered on the rename still differs
 * (recreate). The indexed-column list carries bare names (no qualifiers) and the body
 * excludes the `on <table>` reference, so a *table* rename alone never churns the
 * column list — but the partial WHERE predicate CAN embed table names: the index
 * table as a qualifier (`where t.active = 1`) or, in principle, another table
 * inside a subquery — so ALL in-diff table renames (`tableRenames`) are
 * reconciled there (see below). The cross-table case is currently unreachable
 * end-to-end (the memory backend rejects subqueries — and any cross-table ref —
 * in partial-index predicates at create time, so no actual catalog index can
 * carry one), but the all-renames scope is kept for symmetry with the forward
 * rewriter and future backends.
 *
 * **Ordering is load-bearing**: the effective collation is resolved from the *new*
 * (declared) column name FIRST — the declared table's `ColumnDef` is keyed by the new
 * name — and only THEN is the emitted name inverse-renamed to its old form. Reversing
 * this would look up the declared column's collation under the old name and miss it.
 *
 * The partial-index `where` predicate is reconciled the same way the constraint CHECK
 * path is: EVERY in-diff table rename is inverse-rewritten NEW→OLD first (via
 * {@link renameTableInAst} — the exact inverse of the forward rewriter the executed
 * rename migration runs over ALL tables, so the diff-side reconcile and the migration
 * cannot drift), THEN each renamed column is inverse-rewritten NEW→OLD via
 * {@link renameColumnInCheckExpression} seeded with the OLD table name (qualifiers
 * are pre-normalized to OLD by that point; unqualified refs resolve via the seed
 * either way). The index table's OWN rename retains one special role: it supplies
 * that seed. Sequential inverse application of multiple renames is order-independent
 * because `resolveRenames` makes chains/swaps unrepresentable — no inverse output
 * (oldName) can match another inverse input (newName). This keeps a partial index
 * over a renamed column AND/OR a qualified self-reference under a renamed table from
 * churning, while a genuine predicate edit layered on either rename still differs
 * (recreate). `schemaName` is the default schema for both rewriters. Known accepted
 * edge (symmetric with the forward path): the rewriters are scope-naive about a
 * subquery alias that happens to equal a renamed table's new name — worst case a
 * spurious (valid) recreate.
 */
function declaredIndexCanonicalBody(
	indexStmt: AST.CreateIndexStmt,
	declaredTable: AST.DeclaredTable | undefined,
	colRenames: ReadonlyArray<ColumnRenameOp>,
	tableRenames: ReadonlyArray<RenameOp>,
	schemaName: string,
	defaultCollation: string,
): string {
	const columns: AST.IndexedColumn[] = indexStmt.columns.map(col => {
		const bareName = indexedColumnBareName(col);
		if (!bareName) return col;
		// Collation resolves on the DECLARED (new) name — see the ordering note above.
		// An inherited (no explicit index COLLATE) column resolves the table column's
		// collation under the session default, matching the actual catalog index built
		// from a default-resolved table column — so a non-BINARY default doesn't churn.
		const effective = normalizeCollationName(
			explicitIndexColumnCollation(col) || declaredColumnCollation(declaredTable, bareName, defaultCollation) || 'BINARY',
		);
		// THEN inverse-rename the emitted name to its old (actual-catalog) form.
		const oldName = colRenames.find(r => r.newName.toLowerCase() === bareName.toLowerCase())?.oldName ?? bareName;
		return { name: oldName, collation: effective, direction: col.direction };
	});
	// Reconcile the partial-WHERE predicate: inverse-rewrite EVERY in-diff table
	// rename NEW→OLD first (self-qualifier or a cross-table reference in a
	// subquery alike — mirroring the forward rewriter's all-tables walk), then
	// each renamed column NEW→OLD, over a clone (the rewriters mutate in place;
	// indexStmt backs the recreate DDL). Skip the clone when nothing can match.
	// The column rewrites are seeded with the OLD table name because the
	// qualifier pass has already normalized qualified refs to it (with no own-
	// table rename, OLD == declared, so the seed is unchanged).
	let where = indexStmt.where;
	if (where && (colRenames.length > 0 || tableRenames.length > 0)) {
		const clone = cloneExpr(where);
		for (const r of tableRenames) {
			renameTableInAst(clone, r.newName, r.oldName, schemaName);
		}
		// The index's OWN table rename retains one special role: seeding the
		// column rewrites with that table's OLD name (matched by the declared/
		// NEW table name, exactly the lookup the call site used to do).
		const ownRename = tableRenames.find(
			r => r.newName.toLowerCase() === indexStmt.table.name.toLowerCase(),
		);
		const seedTableName = ownRename?.oldName ?? indexStmt.table.name;
		for (const r of colRenames) {
			renameColumnInCheckExpression(clone, seedTableName, r.newName, r.oldName, schemaName);
		}
		where = clone;
	}
	return createIndexBodyToCanonicalString({ ...indexStmt, columns, where });
}

/**
 * Renders the declared view definition's canonical string with the in-diff
 * renames inverse-applied — each renamed identifier rewritten from its declared
 * NEW name back to the ACTUAL (pre-rename) name the catalog still carries at
 * diff time. The view analogue of {@link reconciledDeclaredBody} (constraints)
 * and {@link declaredIndexCanonicalBody}: comparing this against the actual
 * definition distinguishes a *pure source rename* (matches after reconciliation
 * → no recreate; the rename ops alone converge the view at apply, via the live
 * rename propagation) from a *genuine definition edit* (still differs →
 * drop+recreate). Callers short-circuit the raw-equal compare and call this
 * only on mismatch with renames present.
 *
 * The explicit column list names the VIEW's own output columns — stable
 * identity untouched by source renames — so it passes through unchanged; the
 * body and `insert defaults` clause reconcile via
 * {@link inverseRenamedViewParts} with ALL in-diff table renames threaded.
 */
function reconciledDeclaredViewDefinition(
	columns: ReadonlyArray<string> | undefined,
	select: AST.QueryExpr,
	insertDefaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,
	tableRenames: ReadonlyArray<RenameOp>,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the seeded `insert defaults` expr rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): string {
	const parts = inverseRenamedViewParts(select, insertDefaults, tableRenames, columnRenamesByTable, schemaName, resolveDeclaredColumn);
	return viewDefinitionToCanonicalString(columns, parts.select, parts.insertDefaults);
}

/**
 * Core inverse-rename pass shared by {@link reconciledDeclaredViewDefinition}
 * (which threads ALL in-diff table renames) and {@link columnReconciledViewStmt}
 * (which passes none — its render must keep declared table names): clones the
 * declared select and `insert defaults` clause (the rewriters mutate in place;
 * the declared stmt backs the declared-schema store / recreate DDL) and
 * rewrites the in-diff renames NEW→OLD.
 *
 * Reconciled parts:
 *   - body:    inverse table renames over the select clone for ALL threaded
 *              renames FIRST — so both a direct FROM reference and a
 *              cross-table reference in a subquery normalize to OLD names —
 *              THEN each renamed table's column renames NEW→OLD, seeded with
 *              that table's OLD name (qualifiers are pre-normalized to OLD by
 *              the table pass; with no own-table rename — in particular with
 *              no table pass at all — the seed is the DECLARED name the
 *              qualifiers still carry). Sequential inverse application is
 *              order-independent: `resolveRenames` makes chains/swaps
 *              unrepresentable, so no inverse output (oldName) can match
 *              another inverse input (newName).
 *   - clause:  each `insert defaults` entry's `column` names a base-table
 *              column of the view's FROM table — inverse-renamed via that
 *              table's column renames ({@link collectFromTableNames} scopes the
 *              lookup to FROM tables so an unrelated table's rename cannot
 *              false-rewrite); its `expr` gets the same inverse rewriters as
 *              the body, with column renames applied via the CHECK-expression
 *              entry point (the expr has no FROM of its own — the base table
 *              seeds the scope, exactly like the constraint/index predicates),
 *              threaded with the declared-side scope resolver so an inner
 *              subquery ref binding to a like-named column on its own FROM is
 *              not falsely captured by the seed (the forward
 *              `renameColumnInInsertDefaults` takes the same hook).
 */
function inverseRenamedViewParts(
	select: AST.QueryExpr,
	insertDefaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,
	tableRenames: ReadonlyArray<RenameOp>,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the seeded `insert defaults` expr rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): { select: AST.QueryExpr; insertDefaults: ReadonlyArray<AST.ViewInsertDefault> | undefined } {
	// FROM tables under their DECLARED (new) names — collected before the inverse
	// table pass below rewrites the clone's references to OLD names.
	const fromTables = collectFromTableNames(select, schemaName);

	const selectClone = cloneQueryExpr(select);
	for (const r of tableRenames) {
		renameTableInAst(selectClone, r.newName, r.oldName, schemaName);
	}
	for (const [declaredTableName, colRenames] of columnRenamesByTable) {
		const ownRename = tableRenames.find(r => r.newName.toLowerCase() === declaredTableName);
		const seedTableName = ownRename?.oldName ?? declaredTableName;
		for (const r of colRenames) {
			renameColumnInAst(selectClone, seedTableName, r.newName, r.oldName, schemaName);
		}
	}

	let reconciledDefaults = insertDefaults;
	if (insertDefaults && insertDefaults.length > 0) {
		reconciledDefaults = insertDefaults.map(d => {
			let column = d.column;
			for (const ft of fromTables) {
				const r = columnRenamesByTable.get(ft)?.find(cr => cr.newName.toLowerCase() === column.toLowerCase());
				if (r) {
					column = r.oldName;
					break;
				}
			}
			const exprClone = cloneExpr(d.expr);
			for (const r of tableRenames) {
				renameTableInAst(exprClone, r.newName, r.oldName, schemaName);
			}
			for (const ft of fromTables) {
				const colRenames = columnRenamesByTable.get(ft);
				if (!colRenames) continue;
				const ownRename = tableRenames.find(r => r.newName.toLowerCase() === ft);
				const seedTableName = ownRename?.oldName ?? ft;
				for (const r of colRenames) {
					renameColumnInCheckExpression(exprClone, seedTableName, r.newName, r.oldName, schemaName, resolveDeclaredColumn);
				}
			}
			return { column, expr: exprClone };
		});
	}

	return { select: selectClone, insertDefaults: reconciledDefaults };
}

/**
 * Declared {@link AST.CreateViewStmt} with the in-diff COLUMN renames
 * inverse-applied (NEW→OLD); table references untouched. Renders the recreate
 * DDL of a hinted-RENAME-matched view whose definition is otherwise unchanged:
 * in migration order the create runs AFTER `ALTER TABLE … RENAME TO` (declared
 * table names are already live) but BEFORE `ALTER TABLE … RENAME COLUMN` (a
 * body naming the NEW column would fail to plan at create time). After the
 * create, the live column-rename propagation rewrites the fresh body, so the
 * post-apply state and a re-diff converge. Unlike
 * {@link reconciledDeclaredViewDefinition} there is NO inverse table pass (it
 * would name a table that no longer exists at create time) — the shared
 * {@link inverseRenamedViewParts} core runs with no table renames, seeding the
 * column rewrites with each table's DECLARED name, which the body's qualifiers
 * still carry. Identity when the diff carries no column renames.
 */
function columnReconciledViewStmt(
	stmt: AST.CreateViewStmt,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
	/** Declared-side column-existence resolver for the seeded `insert defaults` expr rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): AST.CreateViewStmt {
	if (columnRenamesByTable.size === 0) return stmt;
	const parts = inverseRenamedViewParts(stmt.select, stmt.insertDefaults, [], columnRenamesByTable, schemaName, resolveDeclaredColumn);
	return { ...stmt, select: parts.select, insertDefaults: parts.insertDefaults };
}

/**
 * Declared {@link AST.CreateIndexStmt} with the in-diff COLUMN renames
 * inverse-applied (NEW→OLD); table references untouched. The index analogue of
 * {@link columnReconciledViewStmt}, rendering the recreate DDL of a
 * hinted-RENAME-matched index whose body is otherwise unchanged. Indexed-column
 * bare names map NEW→OLD via the index table's own renames (both indexed-column
 * forms — plain and the parser's collate-folded `col COLLATE x`). The partial
 * WHERE predicate reuses the walk shape of {@link declaredIndexCanonicalBody}
 * minus its inverse table pass: the own table's renames via the
 * CHECK-expression entry point seeded with the DECLARED table name (qualifiers
 * still carry it — no table pass pre-normalized them), other tables' renames
 * via the plain scope-aware walk (a cross-table predicate reference is
 * unreachable today — the memory backend rejects it at create time — kept for
 * symmetry with the canonical-body reconciler). After the create, the live
 * column-rename propagation rewrites the indexed columns and predicate, so a
 * re-diff converges. Identity when the diff carries no column renames.
 */
function columnReconciledIndexStmt(
	stmt: AST.CreateIndexStmt,
	/** The index's own table's in-diff column renames. */
	colRenames: ReadonlyArray<ColumnRenameOp>,
	/** Declared (new) table name (lowercased) → that table's column renames. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	schemaName: string,
): AST.CreateIndexStmt {
	if (columnRenamesByTable.size === 0) return stmt;

	const columns: AST.IndexedColumn[] = stmt.columns.map(col => {
		const bareName = indexedColumnBareName(col);
		if (!bareName) return col;
		const rename = colRenames.find(r => r.newName.toLowerCase() === bareName.toLowerCase());
		if (!rename) return col;
		if (col.name) return { ...col, name: rename.oldName };
		// Collate-folded form: the bare name lives on col.expr.expr.name.
		const collate = col.expr as AST.CollateExpr;
		const inner = collate.expr as AST.ColumnExpr;
		return { ...col, expr: { ...collate, expr: { ...inner, name: rename.oldName } } };
	});

	let where = stmt.where;
	if (where) {
		const clone = cloneExpr(where);
		for (const r of colRenames) {
			renameColumnInCheckExpression(clone, stmt.table.name, r.newName, r.oldName, schemaName);
		}
		const ownTableLower = stmt.table.name.toLowerCase();
		for (const [declaredTableName, renames] of columnRenamesByTable) {
			if (declaredTableName === ownTableLower) continue;
			for (const r of renames) {
				renameColumnInAst(clone, declaredTableName, r.newName, r.oldName, schemaName);
			}
		}
		where = clone;
	}

	return { ...stmt, columns, where };
}

/**
 * A declared user-named table constraint, normalized for lifecycle detection.
 * `ddl` is the full constraint fragment (`constraint <name> check (...)` with
 * tags) consumed by `ALTER TABLE … ADD <fragment>`. `definition` is the canonical
 * body fragment (name + tags excluded) compared against the actual catalog's
 * `definition` to detect a name-unchanged-but-body-changed constraint.
 */
interface DeclaredNamedConstraint {
	name: string;
	tags?: Readonly<Record<string, SqlValue>>;
	ddl: string;
	definition: string;
	/**
	 * The lifted table-level constraint AST `definition` was rendered from. Kept so
	 * the body comparison can build a rename-reconciled body (see
	 * {@link reconciledDeclaredBody}) by inverse-rewriting a renamed identifier back
	 * to its actual (pre-rename) name. MUST NOT be mutated — it backs `ddl` /
	 * `definition`; reconciliation clones before rewriting.
	 */
	bodyAst: AST.TableConstraint;
}

/**
 * Converts a column-level constraint carrying a name into the equivalent
 * table-level {@link AST.TableConstraint}, so it can be stringified into an
 * `ADD CONSTRAINT` fragment and diffed by name alongside table-level constraints.
 * Returns undefined for constraint kinds that are not lifecycle-managed named
 * constraints (NOT NULL / NULL / DEFAULT / COLLATE / GENERATED / PRIMARY KEY).
 */
function columnConstraintToTableConstraint(columnName: string, cc: AST.ColumnConstraint): AST.TableConstraint | undefined {
	switch (cc.type) {
		case 'check':
			if (!cc.expr) return undefined;
			return { type: 'check', name: cc.name, expr: cc.expr, operations: cc.operations, onConflict: cc.onConflict, tags: cc.tags };
		case 'unique':
			return { type: 'unique', name: cc.name, columns: [{ name: columnName }], onConflict: cc.onConflict, tags: cc.tags };
		case 'foreignKey':
			if (!cc.foreignKey) return undefined;
			return { type: 'foreignKey', name: cc.name, columns: [{ name: columnName }], foreignKey: cc.foreignKey, tags: cc.tags };
		default:
			return undefined;
	}
}

/**
 * Gathers declared *user-named* CHECK / UNIQUE / FOREIGN KEY constraints from a
 * declared table — both table-level and column-level (carrying an explicit name)
 * — keyed by lowercased name. PRIMARY KEY is excluded (handled by
 * `primaryKeyChange`); engine-synthesized `_`-prefixed names are excluded to stay
 * symmetric with the catalog's `namedConstraints`. On a name collision the first
 * wins (a duplicate user constraint name is a separate validation concern).
 */
function collectDeclaredNamedConstraints(declaredTable: AST.DeclaredTable): Map<string, DeclaredNamedConstraint> {
	const out = new Map<string, DeclaredNamedConstraint>();
	const add = (name: string | undefined, tags: Readonly<Record<string, SqlValue>> | undefined, tc: AST.TableConstraint): void => {
		if (!name) return;
		const lower = name.toLowerCase();
		if (lower.startsWith('_')) return;
		if (out.has(lower)) return;
		out.set(lower, { name, tags, ddl: tableConstraintsToString([tc]), definition: constraintBodyToCanonicalString(tc), bodyAst: tc });
	};
	for (const c of declaredTable.tableStmt.constraints ?? []) {
		if (c.type === 'primaryKey') continue;
		add(c.name, c.tags, c);
	}
	for (const col of declaredTable.tableStmt.columns) {
		for (const cc of col.constraints ?? []) {
			if (!cc.name) continue;
			const tc = columnConstraintToTableConstraint(col.name, cc);
			if (tc) add(cc.name, cc.tags, tc);
		}
	}
	return out;
}

/**
 * Inverse-applies the in-diff column renames to a constraint's column list: maps
 * each `{ name }` entry from its NEW name back to its OLD name (case-insensitive).
 * Used to reconcile a UNIQUE column set / an FK's local (child) column set against
 * the actual catalog body, which still renders the pre-rename names at diff time.
 * Mutates the supplied (already-cloned) array in place.
 */
function inverseRenameConstraintColumns(
	columns: Array<{ name: string; direction?: 'asc' | 'desc' }> | undefined,
	colRenames: ReadonlyArray<ColumnRenameOp>,
): void {
	if (!columns) return;
	for (const col of columns) {
		const lower = col.name.toLowerCase();
		const r = colRenames.find(cr => cr.newName.toLowerCase() === lower);
		if (r) col.name = r.oldName;
	}
}

/**
 * String-list variant of {@link inverseRenameConstraintColumns}: inverse-applies
 * column renames to a bare `string[]` (an FK's referenced PARENT column list,
 * which is `string[]` rather than `{ name }[]`), mapping each entry from its NEW
 * name back to its OLD name (case-insensitive). Used to reconcile an FK whose
 * *parent* table renamed a referenced column — the parent's column renames are
 * threaded in from `computeSchemaDiff`'s pre-pass. Mutates the supplied
 * (already-cloned) array in place; an undefined / elided list is a no-op (so a
 * `references parent` with no column list never synthesizes one).
 */
function inverseRenameStringColumns(
	columns: string[] | undefined,
	colRenames: ReadonlyArray<ColumnRenameOp>,
): void {
	if (!columns) return;
	for (let i = 0; i < columns.length; i++) {
		const lower = columns[i].toLowerCase();
		const r = colRenames.find(cr => cr.newName.toLowerCase() === lower);
		if (r) columns[i] = r.oldName;
	}
}

/**
 * Renders the declared constraint's canonical body with the in-diff renames
 * inverse-applied — i.e. each renamed identifier rewritten from its NEW name
 * back to the ACTUAL (pre-rename) name the catalog still carries at diff time.
 * Comparing this against `actual.definition` lets the body-change detector
 * distinguish a *pure rename* (bodies match after reconciliation → no churn) from
 * a *genuine body edit* (still differ → drop+recreate). A body edit layered on a
 * rename survives the reconciliation, so the existing rename-vs-body precedence is
 * preserved.
 *
 * Reconciles only what each kind needs (surgical clone, never the whole tree):
 *   - CHECK:  inverse table renames on ALL in-diff renamed tables FIRST —
 *             mirroring the forward path (`rewriteTableForTableRename` walks
 *             every table's CHECKs), so both a qualified self-reference and a
 *             cross-table reference inside a subquery reconcile — then inverse
 *             column renames, in two passes mirroring the forward
 *             `rewriteTableForColumnRename` branch split: the OWNING table's
 *             renames via the seeded CHECK rewriter (OLD-table seed — correct
 *             unconditionally, since qualifiers are pre-normalized to OLD by
 *             the qualifier pass — plus the declared-side scope resolver, so
 *             an unqualified inner-subquery ref binding to a like-named column
 *             on its own FROM source is not falsely captured by the seed),
 *             then OTHER tables' renames via the plain scope-aware walk (no
 *             seed, no resolver — exactly the forward non-owning branch).
 *             Within each pass, sequential inverse application is
 *             order-independent: `resolveRenames` makes rename chains/swaps
 *             unrepresentable, so no inverse output (oldName) can match
 *             another inverse input (newName). BETWEEN the passes order
 *             matters — owning first (see the cross-table loop's comment).
 *   - UNIQUE: inverse column renames on the column list.
 *   - FK:     inverse column renames on the LOCAL (child) column list, inverse
 *             column renames on the referenced PARENT column list (via the parent
 *             table's column renames, keyed by the declared parent name in
 *             `columnRenamesByTable`), AND inverse table renames on the referenced
 *             parent `foreignKey.table`. A parent-table rename and a parent-column
 *             rename in the same diff reconcile together: look up the parent's
 *             column renames by the *new* parent name first, then rewrite the
 *             table name back to its old form.
 */
function reconciledDeclaredBody(
	d: DeclaredNamedConstraint,
	colRenames: ReadonlyArray<ColumnRenameOp>,
	tableRenames: ReadonlyArray<RenameOp>,
	tableName: string,
	schemaName: string,
	/** Declared (new) table name (lowercased) → that table's column renames; for the FK parent-column reconcile. */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	/** Declared-side column-existence resolver for the seeded CHECK rewrites (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
): string {
	const tc = d.bodyAst;
	switch (tc.type) {
		case 'check': {
			if (!tc.expr) return d.definition;
			// cloneExpr: the rewriters mutate in place; bodyAst backs ddl/definition.
			const clone: AST.TableConstraint = { ...tc, expr: cloneExpr(tc.expr) };
			// Qualifiers first: any qualified reference in the declared CHECK carries
			// a NEW table name (a self-reference after the owning table's rename, or a
			// cross-table reference inside a subquery after THAT table's rename);
			// inverse-rewrite every in-diff rename to its OLD name so the body matches
			// the actual catalog and the OLD-seeded column rewrites below see the
			// owning table's OLD qualifier. Sequential in-place application is safe:
			// `resolveRenames` makes chains and swaps unrepresentable (every newName is
			// absent from the actual catalog while every oldName is present), so no
			// rename's inverse output can match another's inverse input — order is
			// immaterial and equivalent to simultaneous substitution.
			for (const r of tableRenames) {
				renameTableInAst(clone.expr!, r.newName, r.oldName, schemaName);
			}
			for (const r of colRenames) {
				// Inverse: rewrite the declared NEW column name back to its OLD name.
				// The declared-side resolver keeps the seeded walk scope-aware — an
				// unqualified ref inside a subquery whose own FROM source exposes the
				// NEW name (in the declared world) binds there, not to the owning
				// seed, so it is NOT inverse-rewritten — mirroring the forward seeded
				// call in `rewriteTableForColumnRename` (owning-table branch).
				renameColumnInCheckExpression(clone.expr!, tableName, r.newName, r.oldName, schemaName, resolveDeclaredColumn);
			}
			// Cross-table column renames: a subquery in this CHECK may reference
			// ANOTHER table whose column was renamed in this same diff; the forward
			// propagation rewrites those refs via the plain scope-aware walk (no seed
			// frame, no resolver — `rewriteTableForColumnRename`'s non-owning branch),
			// so the inverse uses the same walker: an unqualified ref only rewrites
			// when the renamed table sits in an enclosing FROM frame, which is exactly
			// right for subquery references. The map key is the DECLARED (new) table
			// name; the qualifier pass above already rewrote the clone's references to
			// OLD names, so map the walk's table seed back. The owning table's entry
			// is skipped — its renames are `colRenames`, handled by the seeded loop
			// above (`tableName` is the ACTUAL/old owning name, so the comparison
			// holds even when the owning table was itself renamed). ORDER MATTERS:
			// owning-seeded inverse FIRST. With the reverse order, a compound diff
			// (owning `qty→cap` + referenced `lim.cap→capacity`) has this loop turn
			// the inner `capacity` back into `cap`, which the owning inverse then
			// falsely captures; owning-first leaves the inner ref spelled `capacity`
			// (no match) until this loop fixes it.
			for (const [declaredTableName, renames] of columnRenamesByTable) {
				const ownRename = tableRenames.find(r => r.newName.toLowerCase() === declaredTableName);
				const seedTableName = ownRename?.oldName ?? declaredTableName;
				if (seedTableName.toLowerCase() === tableName.toLowerCase()) continue;
				for (const r of renames) {
					renameColumnInAst(clone.expr!, seedTableName, r.newName, r.oldName, schemaName);
				}
			}
			return constraintBodyToCanonicalString(clone);
		}
		case 'unique': {
			const clone: AST.TableConstraint = { ...tc, columns: tc.columns?.map(c => ({ ...c })) };
			inverseRenameConstraintColumns(clone.columns, colRenames);
			return constraintBodyToCanonicalString(clone);
		}
		case 'foreignKey': {
			const clone: AST.TableConstraint = {
				...tc,
				columns: tc.columns?.map(c => ({ ...c })),
				foreignKey: tc.foreignKey
					? { ...tc.foreignKey, columns: tc.foreignKey.columns ? [...tc.foreignKey.columns] : undefined }
					: tc.foreignKey,
			};
			// Local (child) columns live on THIS table → inverse column rename.
			inverseRenameConstraintColumns(clone.columns, colRenames);
			if (clone.foreignKey) {
				// Referenced PARENT columns → inverse column rename via the parent
				// table's renames, looked up by the DECLARED (new) parent name —
				// BEFORE the table inverse-rename below rewrites that name to its old
				// form. Absent from the map (e.g. a freshly created parent) ⇒ no-op.
				const parentLower = clone.foreignKey.table.toLowerCase();
				const parentColRenames = columnRenamesByTable.get(parentLower);
				if (parentColRenames) inverseRenameStringColumns(clone.foreignKey.columns, parentColRenames);
				// Parent table reference → inverse table rename (newTable → oldTable).
				const tr = tableRenames.find(r => r.newName.toLowerCase() === parentLower);
				if (tr) clone.foreignKey = { ...clone.foreignKey, table: tr.oldName };
			}
			return constraintBodyToCanonicalString(clone);
		}
		default:
			return d.definition;
	}
}

/**
 * Resolves a declared table's column renames against its matched actual catalog
 * table — the map-building + {@link resolveRenames} step shared by both the
 * `computeSchemaDiff` pre-pass (which keeps only `.renames`, keyed by declared
 * table name, so the FK branch of {@link reconciledDeclaredBody} can inverse-
 * rename a parent's referenced column cross-table) and {@link computeTableAlterDiff}
 * (which uses the full `{ renames, pairs, consumedActuals }` for add/drop/alter).
 * The current table's renames are therefore resolved twice per diff — once in the
 * pre-pass and once in its own alter-diff. Accepted: `resolveRenames` over a
 * table's columns is O(columns) with no I/O, and threading the full result through
 * the loop for a micro-optimization would widen the blast radius.
 */
function resolveColumnRenames(
	declaredTable: AST.DeclaredTable,
	actualTable: CatalogTable,
	policy: RenamePolicy,
): { renames: RenameOp[]; pairs: Map<string, CatalogTable['columns'][number]>; consumedActuals: Set<string> } {
	const declaredColumns = new Map<string, AST.ColumnDef>();
	for (const col of declaredTable.tableStmt.columns) {
		declaredColumns.set(col.name.toLowerCase(), col);
	}
	const actualColumns = new Map<string, CatalogTable['columns'][number]>();
	for (const col of actualTable.columns) {
		actualColumns.set(col.name.toLowerCase(), col);
	}
	return resolveRenames<AST.ColumnDef, CatalogTable['columns'][number]>({
		kind: 'constraint', // unused for ColumnRenameOp; kind only flows into RenameOp not surfaced here
		declared: declaredColumns,
		actual: actualColumns,
		getDeclaredName: d => d.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.tags,
		getActualTags: a => a.tags,
		policy,
	});
}

function computeTableAlterDiff(
	declaredTable: AST.DeclaredTable,
	actualTable: CatalogTable,
	policy: RenamePolicy,
	/** Table renames detected in this same diff (used to reconcile FK parent-table refs). */
	tableRenames: ReadonlyArray<RenameOp>,
	/** Schema name — the default schema for the CHECK column-rename rewriter. */
	schemaName: string,
	/**
	 * Declared (new) table name (lowercased) → that table's column renames, for the
	 * cross-table FK referenced-parent-column reconcile in {@link reconciledDeclaredBody}.
	 */
	columnRenamesByTable: ReadonlyMap<string, ColumnRenameOp[]>,
	/** Declared-side column-existence resolver for the scope-aware CHECK reconcile (see `computeSchemaDiff`). */
	resolveDeclaredColumn: ResolveColumnInSource,
	/** Session `default_collation` for resolving an omitted COLLATE on the declared side. */
	defaultCollation: string,
): TableAlterDiff {
	const diff: TableAlterDiff = {
		// Default to actual's name; caller may override to declared name when this is a rename target.
		tableName: actualTable.name,
		columnsToAdd: [],
		columnsToDrop: [],
		columnsToAlter: [],
		columnsToRename: [],
	};

	// Detect column renames first so subsequent add/drop/alter operate on the
	// post-rename column set.
	const colRenames = resolveColumnRenames(declaredTable, actualTable, policy);
	for (const r of colRenames.renames) {
		diff.columnsToRename.push({ oldName: r.oldName, newName: r.newName });
	}

	// Find columns to add (store full column definition for DDL generation).
	// Emit an EXPLICIT resolved COLLATE when the declared column omits one and the
	// session `default_collation` resolves to a non-BINARY collation for its type
	// (see {@link withResolvedAddColumnCollation}) — keeps the migration both
	// self-contained (lands the same collation under any executing session default)
	// and idempotent (matches the catalog column the engine's ADD COLUMN now creates).
	for (const col of declaredTable.tableStmt.columns) {
		if (!colRenames.pairs.has(col.name.toLowerCase())) {
			diff.columnsToAdd.push(columnDefToString(withResolvedAddColumnCollation(col, defaultCollation)));
		}
	}

	// Find columns to drop (skip those consumed by a rename)
	const declaredColumnNames = new Set(declaredTable.tableStmt.columns.map(c => c.name.toLowerCase()));
	for (const col of actualTable.columns) {
		const ln = col.name.toLowerCase();
		if (colRenames.consumedActuals.has(ln)) continue;
		if (!declaredColumnNames.has(ln)) {
			diff.columnsToDrop.push(col.name);
		}
	}

	// Detect attribute changes for surviving columns (matched declared/actual pair)
	for (const col of declaredTable.tableStmt.columns) {
		const matched = colRenames.pairs.get(col.name.toLowerCase());
		if (!matched) continue;
		const change = computeColumnAttributeChange(col, matched, defaultCollation);
		if (change) {
			diff.columnsToAlter.push(change);
		}
	}

	// Apply require-hint to columns within this table
	if (policy === 'require-hint') {
		enforceRequireHint(`column (${actualTable.name})`, diff.columnsToAdd.length, diff.columnsToDrop.length);
	}

	// Constraint lifecycle (CHECK / UNIQUE / FOREIGN KEY) by name: rename / drop /
	// add. We gather declared *user-named* constraints from BOTH the table-level
	// `constraints` list AND column-level constraints carrying an explicit name
	// (e.g. `qty int constraint chk_qty check (qty > 0)`) — the actual catalog's
	// `namedConstraints` already merges both. PRIMARY KEY constraints are excluded
	// (PK changes flow through `primaryKeyChange`); auto-prefixed (`_`) names are
	// excluded to stay symmetric with the catalog (see catalog.ts) so an unnamed
	// declared constraint never churns add/drop against its synthesized actual name.
	const declaredNamedConstraints = collectDeclaredNamedConstraints(declaredTable);
	const actualNamedConstraints = new Map<string, CatalogTable['namedConstraints'][number]>();
	for (const c of actualTable.namedConstraints ?? []) {
		actualNamedConstraints.set(c.name.toLowerCase(), c);
	}
	const constraintRenames = resolveRenames<DeclaredNamedConstraint, CatalogTable['namedConstraints'][number]>({
		kind: 'constraint',
		declared: declaredNamedConstraints,
		actual: actualNamedConstraints,
		getDeclaredName: d => d.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.tags,
		getActualTags: a => a.tags,
		policy,
	});
	// Adds / drops / body-change recreates. A declared constraint is matched (by
	// name or by rename hint) to at most one actual via `constraintRenames.pairs`:
	//   - no match           → create (ADD declared fragment)
	//   - match, same body    → no-op here (rename, if any, handled below; tags below)
	//   - match, body changed → drop the old + add the declared (drop+recreate); a
	//                           constraint body change has no in-place "redefine"
	//                           primitive, and re-creation re-validates existing rows
	//                           against the new rule.
	// Precedence: when a constraint was rename-matched AND its body changed, prefer
	// the drop+recreate (under the declared name/def) and SUPPRESS the RENAME — one
	// coherent op, and the new body must re-validate regardless.
	const constraintsToAdd: string[] = [];
	const constraintsToDrop: string[] = [];
	const renamesSuppressedByBodyChange = new Set<string>(); // declared lower-names
	const bodyChangedNames = new Set<string>();              // declared lower-names recreated
	// Counts that feed the `require-hint` guard: only a PURE create + PURE drop
	// (the unhinted-rename shape) trips it. A same-constraint body-change drop+add
	// is a deliberate recreate, not an ambiguous rename, so it is excluded here.
	let pureCreateCount = 0;
	let pureDropCount = 0;

	for (const [lower, d] of declaredNamedConstraints) {
		const matchedActual = constraintRenames.pairs.get(lower);
		if (!matchedActual) {
			constraintsToAdd.push(d.ddl); // create (name- or rename-unmatched)
			pureCreateCount++;
			continue;
		}
		// Body comparison. The actual side (`matchedActual.definition`) renders the
		// PRE-rename identifier names (a column/parent-table rename has not landed at
		// diff time); the declared side uses the NEW names. So a string mismatch that
		// is purely a renamed identifier — already emitted as a rename in this same
		// diff — must NOT churn a drop+recreate. Short-circuit the common no-rename
		// case (raw strings equal) first; only then reconcile the declared body back
		// to the old names and re-compare. A genuine body edit still differs after
		// reconciliation, so the drop+recreate (and its rename-suppression) is kept.
		if (
			d.definition !== matchedActual.definition &&
			reconciledDeclaredBody(d, diff.columnsToRename, tableRenames, actualTable.name, schemaName, columnRenamesByTable, resolveDeclaredColumn) !== matchedActual.definition
		) {
			constraintsToDrop.push(matchedActual.name); // drop old
			constraintsToAdd.push(d.ddl);               // add new (declared name + tags)
			bodyChangedNames.add(lower);
			if (matchedActual.name.toLowerCase() !== lower) renamesSuppressedByBodyChange.add(lower);
		}
	}

	// Renames, minus any subsumed by a same-constraint body change.
	const effectiveConstraintRenames = constraintRenames.renames.filter(
		r => !renamesSuppressedByBodyChange.has(r.newName.toLowerCase()),
	);
	if (effectiveConstraintRenames.length > 0) {
		diff.constraintsToRename = effectiveConstraintRenames.map(r => ({ oldName: r.oldName, newName: r.newName }));
	}

	// Drops: actual constraint neither declared nor consumed by a rename → DROP.
	// (A rename-consumed actual whose body also changed was already dropped above;
	// it stays in `consumedActuals`, so it is skipped here — no double drop.)
	for (const [lower, a] of actualNamedConstraints) {
		if (constraintRenames.consumedActuals.has(lower)) continue;
		if (!declaredNamedConstraints.has(lower)) {
			constraintsToDrop.push(a.name);
			pureDropCount++;
		}
	}

	if (constraintsToAdd.length > 0) diff.constraintsToAdd = constraintsToAdd;
	if (constraintsToDrop.length > 0) diff.constraintsToDrop = constraintsToDrop;

	// Apply require-hint to constraints within this table (a PURE add + a PURE drop
	// with no rename hint is the ambiguous case the policy guards — body-change
	// recreates are excluded from the counts).
	if (policy === 'require-hint') {
		enforceRequireHint(`constraint (${actualTable.name})`, pureCreateCount, pureDropCount);
	}

	// Detect named-constraint tag drift (name-matched constraints only — a
	// renamed constraint is not addressable by ALTER CONSTRAINT, see the runtime
	// emitter). Whole-set replacement; rename hints excluded from the compare. A
	// constraint that is being body-change-recreated is skipped: its recreate
	// fragment already carries the declared tags, so a separate SET TAGS would be
	// redundant (and would target a constraint that no longer exists at that point).
	const constraintTagsChanges: Array<{ constraintName: string; tags: Record<string, SqlValue> }> = [];
	for (const [name, declaredConstraint] of declaredNamedConstraints) {
		if (bodyChangedNames.has(name)) continue;
		const actualConstraint = actualNamedConstraints.get(name);
		if (!actualConstraint) continue; // a rename/create — not a same-name tag change
		if (tagsDrifted(declaredConstraint.tags, actualConstraint.tags)) {
			constraintTagsChanges.push({
				constraintName: declaredConstraint.name,
				tags: desiredTagSet(declaredConstraint.tags),
			});
		}
	}
	if (constraintTagsChanges.length > 0) {
		diff.constraintTagsChanges = constraintTagsChanges;
	}

	// Detect table-level tag drift (whole-set replacement; rename hints excluded).
	if (tagsDrifted(declaredTable.tableStmt.tags, actualTable.tags)) {
		diff.tableTagsChange = desiredTagSet(declaredTable.tableStmt.tags);
	}

	// Detect PK changes
	const declaredPk = extractDeclaredPK(declaredTable);
	const actualPk = actualTable.primaryKey;

	// Inverse-rename declared PK column names (new → old) so a pure PK-column rename
	// — already emitted as RENAME COLUMN — does not also churn an ALTER PRIMARY KEY.
	// Mirrors the constraint-body reconciliation (reconciledDeclaredBody). A PK
	// references only THIS table's own columns, so `diff.columnsToRename` suffices —
	// no cross-table `columnRenamesByTable` / table renames (unlike the FK body case).
	// Clone first: inverseRenameConstraintColumns mutates in place, and declaredPk
	// backs the NEW names carried in `newPkColumns`.
	const reconciledDeclaredPk = declaredPk.map(c => ({ ...c }));
	inverseRenameConstraintColumns(reconciledDeclaredPk, diff.columnsToRename);

	if (!pkSequencesEqual(reconciledDeclaredPk, actualPk)) {
		diff.primaryKeyChange = {
			oldPkColumns: actualPk.map(pk => pk.columnName),
			newPkColumns: declaredPk, // keep NEW (declared) names for the genuine-change DDL
		};
	}

	return diff;
}

/**
 * Extract a declared column's effective nullability from its AST constraints.
 * Returns undefined when no explicit NULL/NOT NULL is present (session default applies).
 */
function extractDeclaredNotNull(col: AST.ColumnDef): boolean | undefined {
	if (!col.constraints) return undefined;
	// PK always implies NOT NULL.
	if (col.constraints.some(c => c.type === 'primaryKey')) return true;
	for (const c of col.constraints) {
		if (c.type === 'notNull') return true;
		if (c.type === 'null') return false;
	}
	return undefined;
}

function extractDeclaredDefault(col: AST.ColumnDef): AST.Expression | null {
	if (!col.constraints) return null;
	const d = col.constraints.find(c => c.type === 'default');
	return d?.expr ?? null;
}

/**
 * Extract a declared column's effective collation from its COLLATE constraint,
 * canonicalized (uppercase). When no COLLATE is declared, resolves the
 * `defaultCollation` exactly as the engine's CREATE path does
 * ({@link resolveDefaultCollation}) — so absent COLLATE and an explicit
 * `COLLATE <default>` compare equal against the actual catalog collation, and an
 * `apply schema` under a non-BINARY default stays idempotent (the live catalog
 * column already carries the resolved default; resolving the declared side to the
 * same value avoids a spurious `SET COLLATE`). `defaultCollation` is threaded from
 * the live session — the cross-session rehydrate concern stays fixed-BINARY on the
 * `importTable` path, not here.
 */
function extractDeclaredCollation(col: AST.ColumnDef, defaultCollation: string): string {
	const c = col.constraints?.find(c => c.type === 'collate');
	if (c) return c.collation ? normalizeCollationName(c.collation) : 'BINARY';
	return resolveDefaultCollation(inferType(col.dataType), defaultCollation);
}

/**
 * Returns `col` unchanged when it already declares an explicit COLLATE, or when the
 * session `default_collation` resolves to BINARY for its type; otherwise returns a
 * shallow clone with an explicit `{ type: 'collate', collation: <resolved> }`
 * constraint appended. Used by the ADD COLUMN emission so generated DDL carries an
 * explicit non-BINARY collation rather than relying on the executing session's
 * default — this is what makes `apply schema` idempotent and `diff schema` output
 * portable across sessions with different defaults. Never mutates the declared AST
 * (clones the `constraints` array).
 */
function withResolvedAddColumnCollation(col: AST.ColumnDef, defaultCollation: string): AST.ColumnDef {
	if (col.constraints?.some(c => c.type === 'collate')) return col;
	const resolved = resolveDefaultCollation(inferType(col.dataType), defaultCollation);
	if (resolved === 'BINARY') return col;
	return { ...col, constraints: [...(col.constraints ?? []), { type: 'collate', collation: resolved }] };
}

/**
 * Structural equality for DEFAULT expressions. Compares AST shape by
 * JSON serialization with a stable key order — adequate for literals
 * and common expression shapes typically used as DEFAULT values.
 */
function defaultExpressionsEqual(a: AST.Expression | null, b: AST.Expression | null): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).filter(k => k !== 'loc').sort();
	return `{${keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',')}}`;
}

/**
 * Rename-hint keys excluded from tag-drift comparison: they drive rename
 * detection ({@link resolveRenames}), not data state, so a tag set carrying only
 * a hint must not churn out a `SET TAGS` after the rename completes. All other
 * reserved tags (`quereus.lens.*`, `quereus.expose_implicit_index`, …) are real
 * schema state and ARE compared.
 */
const RENAME_HINT_KEYS = new Set([QUEREUS_TAG_PREFIX + 'id', QUEREUS_TAG_PREFIX + 'previous_name']);

/** A tag record with the rename-hint keys stripped, for drift comparison. */
function tagsForDriftCompare(tags: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> {
	const out: Record<string, SqlValue> = {};
	if (tags) {
		for (const [k, v] of Object.entries(tags)) {
			if (!RENAME_HINT_KEYS.has(k.toLowerCase())) out[k] = v;
		}
	}
	return out;
}

/**
 * True when the declared and actual tag sets differ (order-independent, rename
 * hints ignored). On drift the differ emits a `SET TAGS` carrying the full
 * declared set (hints included — they are stored verbatim).
 */
function tagsDrifted(
	declared: Readonly<Record<string, SqlValue>> | undefined,
	actual: Readonly<Record<string, SqlValue>> | undefined,
): boolean {
	return stableStringify(tagsForDriftCompare(declared)) !== stableStringify(tagsForDriftCompare(actual));
}

/** The whole-set replacement value to emit for a drifted tag site (declared, or `{}`). */
function desiredTagSet(declared: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> {
	return declared ? { ...declared } : {};
}

function computeColumnAttributeChange(
	declared: AST.ColumnDef,
	actual: CatalogTable['columns'][number],
	defaultCollation: string,
): ColumnAttributeChange | undefined {
	const change: ColumnAttributeChange = { columnName: declared.name };
	let any = false;

	// Nullability — only compare when explicitly declared; session default handles unspecified.
	const declaredNotNull = extractDeclaredNotNull(declared);
	if (declaredNotNull !== undefined && declaredNotNull !== actual.notNull) {
		change.notNull = declaredNotNull;
		any = true;
	}

	// Data type — declared type is a string; compare case-insensitively.
	if (declared.dataType && declared.dataType.toLowerCase() !== actual.type.toLowerCase()) {
		change.dataType = declared.dataType;
		any = true;
	}

	// Default expression — declared absent + actual present → drop (null).
	const declaredDefault = extractDeclaredDefault(declared);
	const hasDeclaredDefaultConstraint = !!declared.constraints?.some(c => c.type === 'default');
	const actualDefault = actual.defaultValue ?? null;
	if (hasDeclaredDefaultConstraint) {
		if (!defaultExpressionsEqual(declaredDefault, actualDefault)) {
			change.defaultValue = declaredDefault;
			any = true;
		}
	} else if (actualDefault !== null) {
		change.defaultValue = null;
		any = true;
	}

	// Collation — declared COLLATE (default BINARY) vs actual, case-insensitive.
	// Absent and BINARY are equal, so a column that never mentions COLLATE never
	// churns a diff against an actual BINARY column.
	const declaredCollation = extractDeclaredCollation(declared, defaultCollation);
	if (declaredCollation !== (actual.collation || 'BINARY').toUpperCase()) {
		change.collation = declaredCollation;
		any = true;
	}

	// Tag drift — whole-set replacement (rename hints excluded from the compare).
	if (tagsDrifted(declared.tags, actual.tags)) {
		change.tags = desiredTagSet(declared.tags);
		any = true;
	}

	return any ? change : undefined;
}

function extractDeclaredPK(declaredTable: AST.DeclaredTable): Array<{ name: string; direction?: 'asc' | 'desc' }> {
	const stmt = declaredTable.tableStmt;

	// Check for table-level PRIMARY KEY constraint
	if (stmt.constraints) {
		for (const constraint of stmt.constraints) {
			if (constraint.type === 'primaryKey' && constraint.columns) {
				return constraint.columns.map(c => ({
					name: c.name,
					direction: c.direction,
				}));
			}
		}
	}

	// Check for column-level PRIMARY KEY
	const pkCols: Array<{ name: string; direction?: 'asc' | 'desc' }> = [];
	for (const col of stmt.columns) {
		if (col.constraints?.some(c => c.type === 'primaryKey')) {
			const pkConstraint = col.constraints.find(c => c.type === 'primaryKey');
			pkCols.push({
				name: col.name,
				direction: pkConstraint?.type === 'primaryKey' ? pkConstraint.direction : undefined,
			});
		}
	}

	if (pkCols.length > 0) return pkCols;

	// No explicit PK — Quereus defaults to all columns
	return stmt.columns.map(c => ({ name: c.name }));
}

function pkSequencesEqual(
	declared: Array<{ name: string; direction?: 'asc' | 'desc' }>,
	actual: Array<{ columnName: string; desc: boolean }>,
): boolean {
	if (declared.length !== actual.length) return false;
	for (let i = 0; i < declared.length; i++) {
		if (declared[i].name.toLowerCase() !== actual[i].columnName.toLowerCase()) return false;
		const declaredDesc = declared[i].direction === 'desc';
		if (declaredDesc !== actual[i].desc) return false;
	}
	return true;
}

/**
 * Serializes a schema diff to JSON string
 */
export function serializeSchemaDiff(diff: SchemaDiff): string {
	return JSON.stringify(diff, null, 2);
}

/**
 * Topologically sort the to-be-dropped table set so that, for every edge
 * "child references parent" within the set, child appears before parent.
 * Falls back to the input order on a cycle (shouldn't happen for simple FKs,
 * but self/cyclic FKs would otherwise hang the migration).
 */
function orderDropsByFKDependency(
	dropSet: Set<string>,
	actualTables: Map<string, CatalogTable>,
): string[] {
	const result: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	function visit(name: string): void {
		if (visited.has(name)) return;
		if (visiting.has(name)) return; // cycle; bail out gracefully
		visiting.add(name);
		const table = actualTables.get(name);
		if (table) {
			for (const refName of table.referencedTables) {
				if (dropSet.has(refName) && refName !== name) visit(refName);
			}
		}
		visiting.delete(name);
		visited.add(name);
		result.push(name);
	}

	// DFS post-order along child→parent edges puts parents first; reverse to
	// drop children before parents.
	for (const name of dropSet) visit(name);
	return result.reverse();
}

/**
 * Generates migration DDL statements from a schema diff
 */
export function generateMigrationDDL(diff: SchemaDiff, schemaName?: string): string[] {
	const statements: string[] = [];
	const schemaPrefix = (schemaName && schemaName !== 'main') ? `${quoteIdentifier(schemaName)}.` : '';

	// Renames first — they free old names for subsequent creates and re-target
	// dependents (handled inside ALTER TABLE ... RENAME by the rename rewriter).
	// Only tables have a rename primitive. The other RenameOp kinds are metadata
	// here: a hinted view/index rename's convergence DDL is emitted by
	// computeSchemaDiff itself as drop(old) + recreate(declared) through the
	// standard viewsToDrop/viewsToCreate / indexesToDrop/indexesToCreate buckets
	// (whether or not the definition also changed), and a constraint rename rides
	// the table-alter channel (RENAME CONSTRAINT below).
	for (const r of diff.renames) {
		if (r.kind === 'table') {
			statements.push(`ALTER TABLE ${schemaPrefix}${quoteIdentifier(r.oldName)} RENAME TO ${quoteIdentifier(r.newName)}`);
		}
		// Non-table rename ops emit no DDL here — see the note above.
	}

	// Drop assertions first (they may reference tables)
	for (const name of diff.assertionsToDrop) {
		statements.push(`DROP ASSERTION IF EXISTS ${schemaPrefix}${quoteIdentifier(name)}`);
	}

	// Drop materialized views before their source tables. MV storage is
	// independent (its own backing table), but dropping early keeps a body-change
	// rebuild's drop ahead of any source-table alter/drop in the same migration.
	for (const mvName of diff.materializedViewsToDrop) {
		statements.push(`DROP MATERIALIZED VIEW IF EXISTS ${schemaPrefix}${quoteIdentifier(mvName)}`);
	}

	// Drop items (reverse order)
	for (const tableName of diff.tablesToDrop) {
		statements.push(`DROP TABLE IF EXISTS ${schemaPrefix}${quoteIdentifier(tableName)}`);
	}

	for (const viewName of diff.viewsToDrop) {
		statements.push(`DROP VIEW IF EXISTS ${schemaPrefix}${quoteIdentifier(viewName)}`);
	}

	for (const indexName of diff.indexesToDrop) {
		statements.push(`DROP INDEX IF EXISTS ${schemaPrefix}${quoteIdentifier(indexName)}`);
	}

	// Create new items. Materialized views come after tables and views (their
	// body reads those) and re-materialize as part of the create.
	statements.push(...diff.tablesToCreate);
	statements.push(...diff.viewsToCreate);
	statements.push(...diff.materializedViewsToCreate);
	statements.push(...diff.indexesToCreate);
	statements.push(...diff.assertionsToCreate);

	// Alter existing tables.
	// Phase order within one table:
	//   RENAME COLUMN (so subsequent phases see post-rename column names)
	//   → ADD COLUMN
	//   → ALTER COLUMN (type, then default, then nullability — so SET NOT NULL
	//     can rely on an already-populated DEFAULT for backfill)
	//   → RENAME CONSTRAINT, then DROP CONSTRAINT (free / remove a name before any
	//     re-add; a UNIQUE drop precedes the PK change so it can't strand a PK dep)
	//   → ALTER PRIMARY KEY
	//   → ADD CONSTRAINT (after the PK change and the column adds it may reference)
	//   → DROP COLUMN (last, so NOT NULL relaxation never blocks subsequent drops)
	for (const alter of diff.tablesToAlter) {
		const quotedTable = `${schemaPrefix}${quoteIdentifier(alter.tableName)}`;
		for (const r of alter.columnsToRename) {
			statements.push(`ALTER TABLE ${quotedTable} RENAME COLUMN ${quoteIdentifier(r.oldName)} TO ${quoteIdentifier(r.newName)}`);
		}
		for (const colDef of alter.columnsToAdd) {
			statements.push(`ALTER TABLE ${quotedTable} ADD COLUMN ${colDef}`);
		}
		for (const colAlter of alter.columnsToAlter) {
			const quotedCol = quoteIdentifier(colAlter.columnName);
			if (colAlter.dataType !== undefined) {
				statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET DATA TYPE ${colAlter.dataType}`);
			}
			// SET COLLATE right after SET DATA TYPE (both are comparison-domain
			// changes), before DEFAULT / NOT NULL.
			if (colAlter.collation !== undefined) {
				statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET COLLATE ${colAlter.collation}`);
			}
			if (colAlter.defaultValue !== undefined) {
				if (colAlter.defaultValue === null) {
					statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} DROP DEFAULT`);
				} else {
					statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET DEFAULT ${expressionToString(colAlter.defaultValue)}`);
				}
			}
			if (colAlter.notNull !== undefined) {
				statements.push(colAlter.notNull
					? `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET NOT NULL`
					: `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} DROP NOT NULL`);
			}
		}
		// Constraint lifecycle: RENAME (free a name) then DROP (remove a stale /
		// conflicting constraint), both BEFORE re-adds and before the PK change so a
		// dropped UNIQUE can't strand a PK dependency.
		for (const r of alter.constraintsToRename ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} RENAME CONSTRAINT ${quoteIdentifier(r.oldName)} TO ${quoteIdentifier(r.newName)}`);
		}
		for (const name of alter.constraintsToDrop ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} DROP CONSTRAINT ${quoteIdentifier(name)}`);
		}
		if (alter.primaryKeyChange) {
			const pkCols = alter.primaryKeyChange.newPkColumns
				.map(c => {
					let s = quoteIdentifier(c.name);
					if (c.direction === 'desc') s += ' desc';
					return s;
				})
				.join(', ');
			statements.push(`ALTER TABLE ${quotedTable} ALTER PRIMARY KEY (${pkCols})`);
		}
		// ADD CONSTRAINT after the PK change (a new UNIQUE / FK may align with the new
		// key) and after the column adds it may reference. CHECK adds apply in-place;
		// UNIQUE / FK adds depend on module ADD CONSTRAINT support (see constraintsToAdd).
		for (const frag of alter.constraintsToAdd ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} ADD ${frag}`);
		}
		for (const colName of alter.columnsToDrop) {
			statements.push(`ALTER TABLE ${quotedTable} DROP COLUMN ${quoteIdentifier(colName)}`);
		}
		// Tags phase — last, so a SET TAGS lands on the post-structural column /
		// constraint set (a tag set emitted alongside a RENAME COLUMN targets the
		// post-rename name). Whole-set replacement; an empty set clears.
		if (alter.tableTagsChange !== undefined) {
			statements.push(`ALTER TABLE ${quotedTable} SET TAGS ${tagsBodyToString(alter.tableTagsChange)}`);
		}
		for (const colAlter of alter.columnsToAlter) {
			if (colAlter.tags === undefined) continue;
			statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteIdentifier(colAlter.columnName)} SET TAGS ${tagsBodyToString(colAlter.tags)}`);
		}
		for (const ctc of alter.constraintTagsChanges ?? []) {
			statements.push(`ALTER TABLE ${quotedTable} ALTER CONSTRAINT ${quoteIdentifier(ctc.constraintName)} SET TAGS ${tagsBodyToString(ctc.tags)}`);
		}
	}

	// In-place tag changes on views / materialized views / indexes. These are leaf
	// metadata writes (no dependency ordering vs the table-alter block), and an MV
	// tag change here is mutually exclusive with a body-rebuild drop+recreate. The
	// `?? []` keeps generateMigrationDDL robust against hand-built diffs (some tests
	// construct partial SchemaDiff literals), mirroring `constraintTagsChanges`.
	for (const vtc of diff.viewTagsChanges ?? []) {
		statements.push(`ALTER VIEW ${schemaPrefix}${quoteIdentifier(vtc.name)} SET TAGS ${tagsBodyToString(vtc.tags)}`);
	}
	for (const mvtc of diff.materializedViewTagsChanges ?? []) {
		statements.push(`ALTER MATERIALIZED VIEW ${schemaPrefix}${quoteIdentifier(mvtc.name)} SET TAGS ${tagsBodyToString(mvtc.tags)}`);
	}
	for (const itc of diff.indexTagsChanges ?? []) {
		statements.push(`ALTER INDEX ${schemaPrefix}${quoteIdentifier(itc.name)} SET TAGS ${tagsBodyToString(itc.tags)}`);
	}

	return statements;
}


