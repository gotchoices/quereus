import type { SqlValue } from '../common/types.js';
import { expressionToString } from '../emit/ast-stringify.js';
import { sqlValueToLiteral } from '../util/sql-literal.js';
import type { SchemaCatalog, CatalogTable, CatalogView, CatalogIndex, CatalogAssertion } from './catalog.js';

/**
 * A JSON value built from the catalog. Positional: every tuple a renderer
 * returns has a fixed arity and a fixed field order, and an absent value is
 * `null` (never a sentinel string a real value could equal).
 *
 * Leaves are strings, booleans and `null` only. Numbers are left out of the type
 * on purpose, so a raw `SqlValue` cannot be put in a frame: `JSON.stringify` maps
 * `NaN`/`Infinity` to `null` and throws on a bigint. Tag values go through
 * {@link renderTagValue} instead.
 */
type Frame = string | boolean | null | readonly Frame[];

/**
 * Canonical text rendering of a {@link SchemaCatalog}, for the `apply schema`
 * applied-state snapshot (see `docs/schema-declarative.md` § Applied-state snapshot).
 *
 * The rendering exists to answer exactly one question: *is this catalog, field
 * for field, the one that was in place at the end of the last successful,
 * no-op `apply schema`?* Two catalogs that render to the same string must be
 * indistinguishable to `computeSchemaDiff`. It is deliberately NOT a
 * hash — an exact string compare is both cheaper (measured 0.003–0.008 ms vs
 * 1.46 ms to FNV-1a hash 119 KB of rendered text) and carries no hash-collision
 * risk.
 *
 * The encoding is injective by construction. The output is one JSON text: each
 * item is a fixed-arity positional tuple ({@link Frame}), and `JSON.stringify`
 * escapes quotes, backslashes and control characters inside every string leaf,
 * so no name, DDL text, DEFAULT or tag value can imitate the punctuation that
 * separates fields or items. A JSON text parses back to exactly one value, so
 * equal renderings mean equal trees, and equal trees mean equal field values.
 * The only things the tree drops are orderings the differ ignores (sections and
 * constraint lists are sorted), the absent-vs-empty tag distinction the differ
 * also ignores, and an index's absent-vs-`false` `implicit` flag.
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
	// [schemaName, tables[], views[], indexes[], assertions[]] — assembled from
	// already-encoded items so each item is stringified exactly once.
	return jsonArrayText([
		// Lowercased: the snapshot is keyed by lowercased schema name, so
		// `apply schema MyApp` and `apply schema myapp` must render alike.
		JSON.stringify(schemaName.toLowerCase()),
		encodedSection(tables, renderTable),
		encodedSection(views, renderView),
		encodedSection(indexes, renderIndex),
		encodedSection(assertions, renderAssertion),
	]);
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
 *  - a view's DDL is rendered from its stored body, which the rename propagation
 *    (`runtime/emit/alter-table.ts`) rewrites in place and can leave holding an
 *    engine-written schema qualifier or FROM alias, so a rename and its reverse
 *    can leave the field spelled differently from the original statement.
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
 * `[enc1,enc2,…]`: each item JSON-encoded once, and the ENCODINGS sorted, so a
 * drop+recreate that only changes the live `Map` insertion order produces no
 * spurious mismatch. Sorting the encodings (rather than the items by name) also
 * keeps two objects that legitimately share a name — an index name is unique per
 * *table*, not per schema — in a stable order without needing a composite sort key.
 */
function encodedSection<T>(items: readonly T[], render: (item: T) => Frame): string {
	return jsonArrayText(items.map(i => JSON.stringify(render(i))).sort());
}

/**
 * `[a,b,…]` from already-encoded JSON elements, built by ONE `join` so the result
 * is a flat string. `'[' + s + ']'` would leave a V8 rope (a concatenation node
 * over `s`) that the snapshot compare must copy flat first on every apply —
 * measured 0.057 ms vs 0.009 ms to compare a 234 KB rendering.
 */
function jsonArrayText(encoded: readonly string[]): string {
	const pieces = ['['];
	for (const e of encoded) pieces.push(e, ',');
	if (encoded.length > 0) pieces.pop();
	pieces.push(']');
	return pieces.join('');
}

/**
 * The frames themselves, ordered by their encoding — for lists nested inside an
 * item. The frames (not the encodings) are returned, because embedding an
 * encoded string in the enclosing item would escape it a second time.
 */
function sortedFrames<T>(items: readonly T[], render: (item: T) => Frame): Frame[] {
	return items
		.map(i => { const frame = render(i); return { frame, key: JSON.stringify(frame) }; })
		.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
		.map(e => e.frame);
}

// [name, ddl, module, columns[], pk[], refs[], tags, named[], unnamed[], maintained]
function renderTable(t: CatalogTable): Frame {
	// `contextVariables` omitted: the table's `ddl` already renders the `with context` clause.
	const { name, ddl, columns, primaryKey, referencedTables, contextVariables: _contextVariables, tags, module, namedConstraints, unnamedConstraints, maintained, ...rest } = t;
	assertEveryFieldConsidered(rest);
	return [
		name,
		// `ddl` is deliberately redundant with the structured fields below: it costs
		// nothing extra (it is already computed by `collectSchemaCatalog`) and removes
		// any need to argue about what `generateTableDDL` does or does not render.
		ddl,
		// Rendered on its own: the collected `ddl` elides a `using` clause that matches
		// the session default, so a table moved by direct DDL could leave it unchanged.
		module ? [module.name, renderTags(module.args)] : null,
		// Column ORDER is behavioural — never sorted.
		columns.map(renderColumn),
		primaryKey.map(pk => [pk.columnName, pk.desc]),
		// Sorted: only feeds the differ's drop ORDERING, which is inert on an empty diff.
		[...referencedTables].sort(),
		renderTags(tags),
		// Sorted: the differ keys named constraints by name, so their order carries no meaning.
		sortedFrames(namedConstraints, renderNamedConstraint),
		// Sorted: the differ matches unnamed constraints as a body multiset.
		sortedFrames(unnamedConstraints, renderUnnamedConstraint),
		maintained ? renderMaintained(maintained) : null,
	];
}

// [name, type, notNull, primaryKey, default, collation, tags]
function renderColumn(c: CatalogTable['columns'][number]): Frame {
	// `generatedExpr` omitted: the table's `ddl` already renders it, and no undo statement changes it.
	const { name, type, notNull, primaryKey, defaultValue, generatedExpr: _generatedExpr, collation, tags, ...rest } = c;
	assertEveryFieldConsidered(rest);
	return [
		name,
		type,
		notNull,
		primaryKey,
		// `defaultValue` is an `AST.Expression`; rendered with the same
		// `expressionToString` the catalog itself uses for DEFAULT text. Measured at
		// 0.140 ms of a 0.871 ms whole-catalog render on the 112.7 KB / 54-table ×
		// 38-column declaration of `bench/apply-schema-unchanged.mjs` (median of 15),
		// against the 4.35 ms `computeSchemaDiff` the whole render replaces — so
		// keeping it costs nothing worth trading for leaning on `ddl` alone.
		defaultValue ? expressionToString(defaultValue) : null,
		collation,
		renderTags(tags),
	];
}

// [name, definition, tags]
function renderNamedConstraint(c: CatalogTable['namedConstraints'][number]): Frame {
	// `bodyAst` omitted: it is the lift `definition` was rendered from (plus the
	// deferrability `definition` drops, which is not a differ channel), so the
	// canonical string already decides equality.
	const { name, tags, definition, bodyAst: _bodyAst, ...rest } = c;
	assertEveryFieldConsidered(rest);
	return [name, definition, renderTags(tags)];
}

// [kind, definition, tags]
function renderUnnamedConstraint(c: CatalogTable['unnamedConstraints'][number]): Frame {
	// `name` omitted: an unnamed constraint's identity is its body, and the stored
	// auto-name only decides how a DROP is spelled — inert on an empty diff. `bodyAst`
	// omitted as for `renderNamedConstraint`. `tags` are not a differ channel for an
	// unnamed constraint but are kept, so the restore check still sees an undo that
	// re-adds one without them; on the fast path that only costs a full reconcile.
	const { kind, name: _name, tags, definition, bodyAst: _bodyAst, ...rest } = c;
	assertEveryFieldConsidered(rest);
	return [kind, definition, renderTags(tags)];
}

// bodyHash (a bare string, not a tuple)
function renderMaintained(m: NonNullable<CatalogTable['maintained']>): Frame {
	// `select` (the live derivation body AST) is deliberately NOT rendered: the
	// differ compares `bodyHash` first and only walks the AST when that comparison
	// FAILS, to tolerate rename artifacts (schema-differ.ts § maintained-table
	// compare). This rendering only ever fires the fast path when every hash
	// matches, so the AST-tolerant path is unreachable and the hash fully
	// determines the outcome.
	// `columns` omitted: it is folded into `bodyHash` (see `CatalogTable.maintained`).
	const { bodyHash, select: _select, columns: _columns, ...rest } = m;
	assertEveryFieldConsidered(rest);
	return bodyHash;
}

// [name, ddl, definition, tags]
function renderView(v: CatalogView): Frame {
	// `select` omitted for the same reason as `CatalogTable.maintained.select`:
	// the differ consults it only when `definition` already differs. `columns` is
	// folded into `definition`.
	const { name, ddl, definition, tags, select: _select, columns: _columns, ...rest } = v;
	assertEveryFieldConsidered(rest);
	return [name, ddl, definition, renderTags(tags)];
}

// [name, tableName, implicit, ddl, definition, tags]
function renderIndex(x: CatalogIndex): Frame {
	const { name, tableName, ddl, definition, tags, implicit, ...rest } = x;
	assertEveryFieldConsidered(rest);
	// `implicit === true`: an absent flag and `false` mean the same thing.
	return [name, tableName, implicit === true, ddl, definition, renderTags(tags)];
}

// [name, ddl, definition]
function renderAssertion(a: CatalogAssertion): Frame {
	// `check` omitted for the same reason as `CatalogView.select`.
	const { name, ddl, definition, check: _check, ...rest } = a;
	assertEveryFieldConsidered(rest);
	return [name, ddl, definition];
}

/**
 * Order-independent rendering of a tag set: `[[key, value], …]` sorted by key.
 * An empty set renders as an absent one (`[]`), matching the differ's own tag
 * comparison (`tagsDrifted`, which stable-stringifies both sides).
 *
 * The rename-hint keys (`quereus.id` / `quereus.previous_name`) that the differ
 * excludes from drift comparison ARE rendered here. A hint-only change therefore
 * costs one extra full reconcile — the safe direction, and cheaper than keeping
 * a second copy of the differ's exclusion list in sync.
 */
function renderTags(tags: Readonly<Record<string, SqlValue>> | undefined): Frame {
	if (!tags) return [];
	return Object.keys(tags).sort().map(k => [k, renderTagValue(tags[k])]);
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
