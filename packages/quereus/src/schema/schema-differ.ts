import type { SchemaCatalog, CatalogTable, CatalogView, CatalogIndex } from './catalog.js';
import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createTableToString, createViewToString, createMaterializedViewToString, createIndexToString, createAssertionToString, columnDefToString, quoteIdentifier, expressionToString, astToString, tagsBodyToString, tableConstraintsToString } from '../emit/ast-stringify.js';
import { computeBodyHash } from './view.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { validateReservedTags, type TagDiagnostic } from './reserved-tags.js';
import { raiseReservedTagDiagnostics } from './reserved-tags-policy.js';

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
	 * User-named constraints present in the actual catalog but absent from the
	 * declaration (and not consumed by a rename) → `DROP CONSTRAINT <name>`.
	 */
	constraintsToDrop?: string[];
	/**
	 * Declared user-named constraints absent from the actual catalog (and not a
	 * rename target) → `ADD <constraint-fragment>`. Each entry is the constraint
	 * DDL fragment (`constraint <name> check (...)` etc.) the `ALTER TABLE … ADD`
	 * primitive consumes. NOTE: the engine's `ADD CONSTRAINT` only implements CHECK
	 * in-place today; an emitted UNIQUE / FOREIGN KEY add will fail at apply with
	 * UNSUPPORTED (a pre-existing `ADD CONSTRAINT` limitation, not introduced here).
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
	const actualIndexes = new Map(actualCatalog.indexes.map(i => [i.name.toLowerCase(), i]));

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

	// Tables: creates / alters
	for (const [name, declaredTable] of declaredTables) {
		const tableStmt = declaredTable.tableStmt;
		const matchedActual = tableRenames.pairs.get(name);
		if (matchedActual) {
			// Either a rename match or a name-based match — compute alter diff against the matched actual.
			const alterDiff = computeTableAlterDiff(declaredTable, matchedActual, policy);
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

	// Views: creates / drops / in-place tag changes. A pure name match (no rename)
	// whose tags drifted takes the in-place `ALTER VIEW … SET TAGS` primitive; a
	// rename-matched view has no in-place primitive, so its tags ride the
	// drop+recreate the standard buckets already drive.
	for (const [name, declaredView] of declaredViews) {
		const matchedActual = viewRenames.pairs.get(name);
		if (!matchedActual) {
			diff.viewsToCreate.push(createViewToString(declaredView.viewStmt));
		} else if (matchedActual.name.toLowerCase() === name && tagsDrifted(declaredView.viewStmt.tags, matchedActual.tags)) {
			diff.viewTagsChanges.push({ name: declaredView.viewStmt.view.name, tags: desiredTagSet(declaredView.viewStmt.tags) });
		}
	}
	for (const [name] of actualViews) {
		if (viewRenames.consumedActuals.has(name)) continue;
		if (!declaredViews.has(name)) diff.viewsToDrop.push(name);
	}

	// Materialized views: create / drop / rebuild. No rename support (names are
	// part of the contract, like assertions). A body change is detected by
	// recomputing the declared MV's canonical body hash and comparing it against
	// the live MV's `bodyHash`; a mismatch schedules a drop + recreate (the
	// recreate re-materializes the body in apply order — same drop+recreate path
	// views use, since MVs have no in-place ALTER primitive).
	for (const [name, declaredMv] of declaredMaterializedViews) {
		const actual = actualMaterializedViews.get(name);
		if (!actual) {
			diff.materializedViewsToCreate.push(createMaterializedViewToString(declaredMv.viewStmt));
		} else {
			const declaredBodyHash = computeBodyHash(astToString(declaredMv.viewStmt.select));
			if (declaredBodyHash !== actual.bodyHash) {
				// Body changed → drop+recreate (the recreate re-materializes AND carries
				// the declared tags); never also emit a SET TAGS for this MV.
				diff.materializedViewsToDrop.push(name);
				diff.materializedViewsToCreate.push(createMaterializedViewToString(declaredMv.viewStmt));
			} else if (tagsDrifted(declaredMv.viewStmt.tags, actual.tags)) {
				// Body unchanged but tags drifted → in-place SET TAGS, no rebuild.
				diff.materializedViewTagsChanges.push({ name: declaredMv.viewStmt.view.name, tags: desiredTagSet(declaredMv.viewStmt.tags) });
			}
		}
	}
	for (const [name] of actualMaterializedViews) {
		if (!declaredMaterializedViews.has(name)) diff.materializedViewsToDrop.push(name);
	}

	// Indexes: creates / drops / in-place tag changes (pure name match only, as
	// with views — a renamed index drops+recreates and carries its tags then).
	for (const [name, declaredIndex] of declaredIndexes) {
		const matchedActual = indexRenames.pairs.get(name);
		if (!matchedActual) {
			const effectiveStmt = applyIndexDefaults(declaredIndex.indexStmt, targetSchemaName);
			diff.indexesToCreate.push(createIndexToString(effectiveStmt));
		} else if (matchedActual.name.toLowerCase() === name && tagsDrifted(declaredIndex.indexStmt.tags, matchedActual.tags)) {
			diff.indexTagsChanges.push({ name: declaredIndex.indexStmt.index.name, tags: desiredTagSet(declaredIndex.indexStmt.tags) });
		}
	}
	for (const [name] of actualIndexes) {
		if (indexRenames.consumedActuals.has(name)) continue;
		if (!declaredIndexes.has(name)) diff.indexesToDrop.push(name);
	}

	// Apply 'require-hint' policy: any unhinted name change is an error rather
	// than a silent drop+create.
	if (policy === 'require-hint') {
		enforceRequireHint('table', diff.tablesToCreate.length, diff.tablesToDrop.length);
		enforceRequireHint('view', diff.viewsToCreate.length, diff.viewsToDrop.length);
		enforceRequireHint('index', diff.indexesToCreate.length, diff.indexesToDrop.length);
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
 * A declared user-named table constraint, normalized for lifecycle detection.
 * `ddl` is the constraint fragment (`constraint <name> check (...)` etc.) consumed
 * by `ALTER TABLE … ADD <fragment>`.
 */
interface DeclaredNamedConstraint {
	name: string;
	tags?: Readonly<Record<string, SqlValue>>;
	ddl: string;
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
		out.set(lower, { name, tags, ddl: tableConstraintsToString([tc]) });
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

function computeTableAlterDiff(
	declaredTable: AST.DeclaredTable,
	actualTable: CatalogTable,
	policy: RenamePolicy,
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
	const declaredColumns = new Map<string, AST.ColumnDef>();
	for (const col of declaredTable.tableStmt.columns) {
		declaredColumns.set(col.name.toLowerCase(), col);
	}
	const actualColumns = new Map<string, CatalogTable['columns'][number]>();
	for (const col of actualTable.columns) {
		actualColumns.set(col.name.toLowerCase(), col);
	}

	const colRenames = resolveRenames<AST.ColumnDef, CatalogTable['columns'][number]>({
		kind: 'constraint', // unused for ColumnRenameOp; kind only flows into RenameOp not surfaced here
		declared: declaredColumns,
		actual: actualColumns,
		getDeclaredName: d => d.name,
		getActualName: a => a.name,
		getDeclaredTags: d => d.tags,
		getActualTags: a => a.tags,
		policy,
	});
	for (const r of colRenames.renames) {
		diff.columnsToRename.push({ oldName: r.oldName, newName: r.newName });
	}

	// Find columns to add (store full column definition for DDL generation)
	for (const col of declaredTable.tableStmt.columns) {
		if (!colRenames.pairs.has(col.name.toLowerCase())) {
			diff.columnsToAdd.push(columnDefToString(col));
		}
	}

	// Find columns to drop (skip those consumed by a rename)
	for (const col of actualTable.columns) {
		const ln = col.name.toLowerCase();
		if (colRenames.consumedActuals.has(ln)) continue;
		if (!declaredColumns.has(ln)) {
			diff.columnsToDrop.push(col.name);
		}
	}

	// Detect attribute changes for surviving columns (matched declared/actual pair)
	for (const col of declaredTable.tableStmt.columns) {
		const matched = colRenames.pairs.get(col.name.toLowerCase());
		if (!matched) continue;
		const change = computeColumnAttributeChange(col, matched);
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
	if (constraintRenames.renames.length > 0) {
		diff.constraintsToRename = constraintRenames.renames.map(r => ({ oldName: r.oldName, newName: r.newName }));
	}

	// Adds: declared constraint not matched (by name or rename) to any actual →
	// emit its DDL fragment as an `ALTER TABLE … ADD`.
	const constraintsToAdd: string[] = [];
	for (const [lower, d] of declaredNamedConstraints) {
		if (constraintRenames.pairs.has(lower)) continue; // exists (name- or rename-matched)
		constraintsToAdd.push(d.ddl);
	}
	if (constraintsToAdd.length > 0) diff.constraintsToAdd = constraintsToAdd;

	// Drops: actual constraint neither declared nor consumed by a rename → DROP.
	const constraintsToDrop: string[] = [];
	for (const [lower, a] of actualNamedConstraints) {
		if (constraintRenames.consumedActuals.has(lower)) continue;
		if (!declaredNamedConstraints.has(lower)) constraintsToDrop.push(a.name);
	}
	if (constraintsToDrop.length > 0) diff.constraintsToDrop = constraintsToDrop;

	// Apply require-hint to constraints within this table (an add + a drop with no
	// rename hint is the ambiguous case the policy guards).
	if (policy === 'require-hint') {
		enforceRequireHint(`constraint (${actualTable.name})`, constraintsToAdd.length, constraintsToDrop.length);
	}

	// Detect named-constraint tag drift (name-matched constraints only — a
	// renamed constraint is not addressable by ALTER CONSTRAINT, see the runtime
	// emitter). Whole-set replacement; rename hints excluded from the compare.
	const constraintTagsChanges: Array<{ constraintName: string; tags: Record<string, SqlValue> }> = [];
	for (const [name, declaredConstraint] of declaredNamedConstraints) {
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

	if (!pkSequencesEqual(declaredPk, actualPk)) {
		diff.primaryKeyChange = {
			oldPkColumns: actualPk.map(pk => pk.columnName),
			newPkColumns: declaredPk,
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
 * a hint must not churn out a `SET TAGS` after the rename completes. Behavioral
 * reserved tags (`quereus.update.*`, `quereus.lens.*`,
 * `quereus.expose_implicit_index`, …) are real schema state and ARE compared.
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
	// Tables get a primitive ALTER TABLE RENAME; views/indexes/named constraints
	// have no engine primitive yet — fall back to drop+recreate is left to the
	// caller (we surface only the rename op here for tables and the alter-diff
	// pipeline already drops+recreates non-table objects via diff.viewsToDrop /
	// indexesToDrop when no rename hint is present).
	for (const r of diff.renames) {
		if (r.kind === 'table') {
			statements.push(`ALTER TABLE ${schemaPrefix}${quoteIdentifier(r.oldName)} RENAME TO ${quoteIdentifier(r.newName)}`);
		}
		// View / index / constraint renames have no primitive — caller emits
		// drop+recreate via the standard buckets.
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


