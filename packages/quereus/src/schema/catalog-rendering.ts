import type { SqlValue } from '../common/types.js';
import { expressionToString } from '../emit/ast-stringify.js';
import { sqlValueToLiteral } from '../util/sql-literal.js';
import type { SchemaCatalog, CatalogTable, CatalogView, CatalogIndex, CatalogAssertion } from './catalog.js';

/**
 * Canonical text rendering of a {@link SchemaCatalog}, for the `apply schema`
 * applied-state snapshot (see `docs/schema.md` § Applied-state snapshot).
 *
 * The rendering exists to answer exactly one question: *is this catalog, field
 * for field, the one that was in place at the end of the last successful,
 * no-op `apply schema`?* Two catalogs that render to the same string must be
 * indistinguishable to `computeSchemaDiff`. It is deliberately NOT a
 * hash — an exact string compare is both cheaper (measured 0.003–0.008 ms vs
 * 1.46 ms to FNV-1a hash 119 KB of rendered text) and carries no hash-collision
 * risk.
 *
 * NOTE: the *encoding* is not provably injective, though. Fields and items are
 * separated by literal spaces / tabs / newlines, and a leaf value can contain
 * any of them — a tag value or a DEFAULT holding a raw newline reaches the
 * output verbatim (via `sqlValueToLiteral` / `expressionToString`, and via the
 * `ddl` text that embeds the same literal). So a value crafted to imitate the
 * rendering of a *different* catalog item makes two distinct catalogs render
 * alike, and an out-of-band change between exactly those two catalogs would be
 * skipped. It takes deliberately hostile tag/DEFAULT text to build one, so it is
 * left open; the fix that retires the class is a uniquely-decodable encoding
 * (JSON-frame each part instead of joining on separators — measured ~+0.25 ms on
 * the 308.8 KB rendering of `bench/apply-schema-unchanged.mjs 30`, against a
 * 1.50 ms fast-pathed apply). See `tickets/backlog/debt-catalog-rendering-injective-encoding`.
 *
 * It is also NOT the schema *version* hash. `computeSchemaHash` strips tags
 * before hashing, because tags must not affect versioning; the differ, by
 * contrast, DOES diff tags and emits `SET TAGS` steps for them. So this
 * rendering is tags-inclusive and the two must never be conflated.
 *
 * Every arm destructures **every** field of its catalog interface and hands the
 * rest to {@link assertEveryFieldConsidered}, so a new field on any catalog
 * interface fails the build here until someone decides whether it belongs in
 * the comparison.
 */
export function renderCatalogForComparison(catalog: SchemaCatalog): string {
	const { schemaName, tables, views, indexes, assertions, ...rest } = catalog;
	assertEveryFieldConsidered(rest);
	return [
		// Lowercased: the snapshot is keyed by lowercased schema name, so
		// `apply schema MyApp` and `apply schema myapp` must render alike.
		`schema ${schemaName.toLowerCase()}`,
		...sortedRenderings(tables, renderTable),
		...sortedRenderings(views, renderView),
		...sortedRenderings(indexes, renderIndex),
		...sortedRenderings(assertions, renderAssertion),
	].join('\n');
}

/**
 * The rendering `apply schema` compares after unwinding a failed migration, to
 * verify the catalog is back where the apply found it (see
 * `runtime/emit/schema-declarative.ts` § `runBatchedMigrationLoop`).
 *
 * Identical to {@link renderCatalogForComparison} except that a table's and a
 * view's `ddl` text is left out. Those two texts record things the differ does
 * not treat as part of the schema, and an undo that restores the catalog exactly
 * as the differ sees it can still change them:
 *
 *  - a table's DDL lists constraints in *storage* order, and `ADD CONSTRAINT`
 *    appends — so `DROP CONSTRAINT a` + re-add on a table with constraints
 *    `[a, b]` comes back as `[b, a]` (the structured `namedConstraints` below are
 *    sorted, because the differ keys them by name);
 *  - a view's DDL is `ViewSchema.sql`, which `create view` stores verbatim and the
 *    rename propagation (`runtime/emit/alter-table.ts`) overwrites with the
 *    rewritten body alone, so a rename and its reverse leave the field spelled
 *    differently from the original statement.
 *
 * Everything an undo statement can touch — columns and their attributes, the
 * primary key, tags, named constraints, the maintained derivation, the object
 * set itself — is in the structured fields, so the check loses nothing an undo
 * arm could get wrong. Index and assertion `ddl` are rendered from structured
 * state and order-free, so they stay in.
 */
export function renderCatalogForRestoreCheck(catalog: SchemaCatalog): string {
	return renderCatalogForComparison({
		...catalog,
		tables: catalog.tables.map(t => ({ ...t, ddl: '' })),
		views: catalog.views.map(v => ({ ...v, ddl: '' })),
	});
}

/**
 * Compile error if a catalog interface grows a field this renderer does not
 * consider. The rest object of an exhaustive destructure is `{}`, which is
 * assignable to `Record<string, never>`; one left-over field of any other type
 * is not.
 */
function assertEveryFieldConsidered(_leftover: Record<string, never>): void { /* type-level only */ }

/**
 * Renders every item and sorts the RESULTS, so a drop+recreate that only changes
 * the live `Map` insertion order produces no spurious mismatch. Sorting the
 * rendered strings (rather than the items by name) also keeps two objects that
 * legitimately share a name — an index name is unique per *table*, not per
 * schema — in a stable order without needing a composite sort key.
 */
function sortedRenderings<T>(items: readonly T[], render: (item: T) => string): string[] {
	return items.map(render).sort();
}

function renderTable(t: CatalogTable): string {
	const { name, ddl, columns, primaryKey, referencedTables, tags, namedConstraints, unnamedConstraints, maintained, ...rest } = t;
	assertEveryFieldConsidered(rest);
	return [
		`table ${name}`,
		// `ddl` is deliberately redundant with the structured fields below: it costs
		// nothing extra (it is already computed by `collectSchemaCatalog`) and removes
		// any need to argue about what `generateTableDDL` does or does not render.
		`\tddl ${ddl}`,
		// Column ORDER is behavioural — never sorted.
		...columns.map(c => `\t${renderColumn(c)}`),
		`\tpk ${primaryKey.map(pk => `${pk.columnName} ${pk.desc ? 'desc' : 'asc'}`).join(', ')}`,
		// Sorted: only feeds the differ's drop ORDERING, which is inert on an empty diff.
		`\trefs ${[...referencedTables].sort().join(', ')}`,
		`\ttags ${renderTags(tags)}`,
		// Sorted: the differ keys named constraints by name, so their order carries no meaning.
		...sortedRenderings(namedConstraints, renderNamedConstraint).map(s => `\t${s}`),
		// Sorted: the differ matches unnamed constraints as a body multiset.
		...sortedRenderings(unnamedConstraints, renderUnnamedConstraint).map(s => `\t${s}`),
		`\tmaintained ${maintained ? renderMaintained(maintained) : '-'}`,
	].join('\n');
}

function renderColumn(c: CatalogTable['columns'][number]): string {
	const { name, type, notNull, primaryKey, defaultValue, collation, tags, ...rest } = c;
	assertEveryFieldConsidered(rest);
	return `column ${name} ${type} ${notNull ? 'not null' : 'null'} ${primaryKey ? 'pk' : '-'}`
		// `defaultValue` is an `AST.Expression`; rendered with the same
		// `expressionToString` the catalog itself uses for DEFAULT text. Measured at
		// 0.140 ms of a 0.871 ms whole-catalog render on the 112.7 KB / 54-table ×
		// 38-column declaration of `bench/apply-schema-unchanged.mjs` (median of 15),
		// against the 4.35 ms `computeSchemaDiff` the whole render replaces — so
		// keeping it costs nothing worth trading for leaning on `ddl` alone.
		+ ` default ${defaultValue ? expressionToString(defaultValue) : '-'}`
		+ ` collate ${collation} tags ${renderTags(tags)}`;
}

function renderNamedConstraint(c: CatalogTable['namedConstraints'][number]): string {
	// `bodyAst` omitted: it is the lift `definition` was rendered from (plus the
	// deferrability `definition` drops, which is not a differ channel), so the
	// canonical string already decides equality.
	const { name, tags, definition, bodyAst: _bodyAst, ...rest } = c;
	assertEveryFieldConsidered(rest);
	return `constraint ${name} ${definition} tags ${renderTags(tags)}`;
}

function renderUnnamedConstraint(c: CatalogTable['unnamedConstraints'][number]): string {
	// `name` omitted: an unnamed constraint's identity is its body, and the stored
	// auto-name only decides how a DROP is spelled — inert on an empty diff. `bodyAst`
	// omitted as for `renderNamedConstraint`. `tags` are not a differ channel for an
	// unnamed constraint but are kept, so the restore check still sees an undo that
	// re-adds one without them; on the fast path that only costs a full reconcile.
	const { kind, name: _name, tags, definition, bodyAst: _bodyAst, ...rest } = c;
	assertEveryFieldConsidered(rest);
	return `unnamed ${kind} ${definition} tags ${renderTags(tags)}`;
}

function renderMaintained(m: NonNullable<CatalogTable['maintained']>): string {
	// `select` (the live derivation body AST) is deliberately NOT rendered: the
	// differ compares `bodyHash` first and only walks the AST when that comparison
	// FAILS, to tolerate rename artifacts (schema-differ.ts § maintained-table
	// compare). This rendering only ever fires the fast path when every hash
	// matches, so the AST-tolerant path is unreachable and the hash fully
	// determines the outcome.
	// `columns` omitted: it is folded into `bodyHash` (see `CatalogTable.maintained`).
	const { bodyHash, backingModuleName, backingModuleArgs, select: _select, columns: _columns, ...rest } = m;
	assertEveryFieldConsidered(rest);
	return `body ${bodyHash} module ${backingModuleName ?? '-'} args ${renderTags(backingModuleArgs)}`;
}

function renderView(v: CatalogView): string {
	// `select` omitted for the same reason as `CatalogTable.maintained.select`:
	// the differ consults it only when `definition` already differs. `columns` is
	// folded into `definition`.
	const { name, ddl, definition, tags, select: _select, columns: _columns, ...rest } = v;
	assertEveryFieldConsidered(rest);
	return `view ${name}\n\tddl ${ddl}\n\tdef ${definition}\n\ttags ${renderTags(tags)}`;
}

function renderIndex(x: CatalogIndex): string {
	const { name, tableName, ddl, definition, tags, implicit, ...rest } = x;
	assertEveryFieldConsidered(rest);
	return `index ${name} on ${tableName}${implicit ? ' implicit' : ''}\n\tddl ${ddl}\n\tdef ${definition}\n\ttags ${renderTags(tags)}`;
}

function renderAssertion(a: CatalogAssertion): string {
	// `check` omitted for the same reason as `CatalogView.select`.
	const { name, ddl, definition, check: _check, ...rest } = a;
	assertEveryFieldConsidered(rest);
	return `assertion ${name}\n\tddl ${ddl}\n\tdef ${definition}`;
}

/**
 * Order-independent rendering of a tag set. Keys are sorted and an empty set
 * renders as an absent one, matching the differ's own tag comparison
 * (`tagsDrifted`, which stable-stringifies both sides).
 *
 * The rename-hint keys (`quereus.id` / `quereus.previous_name`) that the differ
 * excludes from drift comparison ARE rendered here. A hint-only change therefore
 * costs one extra full reconcile — the safe direction, and cheaper than keeping
 * a second copy of the differ's exclusion list in sync.
 */
function renderTags(tags: Readonly<Record<string, SqlValue>> | undefined): string {
	if (!tags) return '-';
	const keys = Object.keys(tags).sort();
	if (keys.length === 0) return '-';
	return `(${keys.map(k => `${JSON.stringify(k)}=${renderTagValue(tags[k])}`).join(', ')})`;
}

/**
 * A tag value as a SQL literal, prefixed with a one-character type tag.
 *
 * The prefix is what makes the encoding injective: `sqlValueToLiteral` renders a
 * JSON value as its quoted JSON text, which is byte-identical to what it renders
 * for a *string* holding that same text. Without the discriminator, a tag flipping
 * between `{"a":1}` and `'{"a":1}'` would render unchanged and be skipped.
 */
function renderTagValue(v: SqlValue): string {
	const kind =
		v === null ? 'n' :
		typeof v === 'string' ? 's' :
		typeof v === 'number' ? 'f' :
		typeof v === 'bigint' ? 'i' :
		typeof v === 'boolean' ? 'b' :
		v instanceof Uint8Array ? 'x' :
		'j';
	return kind + sqlValueToLiteral(v);
}
