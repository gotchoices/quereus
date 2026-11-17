---
description: The schema tool skips migration work when two text descriptions of the database match exactly, but text a user typed into the schema (a name, a label, a default value) can imitate the punctuation that separates items, so two different databases can produce the same description. Switch the description to a JSON encoding where that cannot happen.
architecture: docs/schema-declarative.md#applied-state-snapshot-the-unchanged-schema-fast-path
files: packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts, docs/schema-declarative.md, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/bench/apply-schema-unchanged.mjs
difficulty: medium
---

## Background

`apply schema` skips `computeSchemaDiff` when the live catalog renders to the exact string it rendered to at the last verified-no-op apply (`renderCatalogForComparison` in `packages/quereus/src/schema/catalog-rendering.ts`, compared in `runtime/emit/schema-declarative.ts` near the `unchanged` computation). The same renderer, with table/view `ddl` blanked, backs the post-unwind restore check (`renderCatalogForRestoreCheck`).

Today the rendering joins fields with spaces, lines with `\n\t`, and items with `\n`, and nothing escapes those characters inside values. Free-text values reach the output raw: object names (a quoted identifier may contain a newline), `ddl`, `definition`, column `DEFAULT` text, constraint `definition`, tag values. So the encoding is not injective.

**Verified collision** (ran it, scratch spec, since deleted). Take a catalog `B` from a database with `create table t (id integer primary key)`, `create view v1 as select id from t`, `create view v2 as select id from t`. Build `A = { ...B, views: [{ ...v1, definition: `${v1.definition}\n\ttags -\nview ${v2.name}\n\tddl ${v2.ddl}\n\tdef ${v2.definition}` }] }` — one view instead of two. `renderCatalogForComparison(A) === renderCatalogForComparison(B)` today.

Reaching this through SQL needs a crafted name, tag or literal plus an out-of-band change landing on exactly the imitated shape, so it is contrived; it is fixed because the renderer's contract is "equal output ⇔ indistinguishable to the differ", and that should hold by construction.

## Design

Render every catalog item to a **JSON-serializable tree of positional tuples**, and serialize with `JSON.stringify`. JSON escapes quotes, backslashes and control characters inside strings, and a JSON text parses to exactly one value, so two renderings are equal only if the trees are equal. The tree's shape is fixed per position (fixed-arity tuples, sections in fixed order), so equal trees mean equal field values.

```ts
/** A JSON value built from the catalog. Positional — every tuple has a fixed arity and field order. */
type Frame = string | number | boolean | null | readonly Frame[];
```

### Top level — encode each item once, sort the encodings

The output is itself valid JSON, assembled from already-encoded item strings so each item is stringified exactly once:

```ts
export function renderCatalogForComparison(catalog: SchemaCatalog): string {
	const { schemaName, tables, views, indexes, assertions, ...rest } = catalog;
	assertEveryFieldConsidered(rest);
	return '[' + [
		JSON.stringify(schemaName.toLowerCase()),
		encodedSection(tables, renderTable),
		encodedSection(views, renderView),
		encodedSection(indexes, renderIndex),
		encodedSection(assertions, renderAssertion),
	].join(',') + ']';
}

/** `[enc1,enc2,…]` with each item JSON-encoded once and the encodings sorted (Map-order independence). */
function encodedSection<T>(items: readonly T[], render: (item: T) => Frame): string {
	return '[' + items.map(i => JSON.stringify(render(i))).sort().join(',') + ']';
}
```

This replaces `sortedRenderings` at the top level. Sorting the encoded strings keeps today's rationale (stable order for same-named indexes on different tables, no composite sort key). Do **not** build the whole tree and stringify once at the end: sorting needs each item's encoding anyway, so that would stringify every item twice.

### Inside an item — return frames, sort nested lists by encoding

Nested sorted lists (named and unnamed constraints) are small; sort the frames by their `JSON.stringify` and embed the frames (not the strings — embedding a JSON string inside JSON double-escapes it):

```ts
function sortedFrames<T>(items: readonly T[], render: (item: T) => Frame): Frame[] {
	return items
		.map(i => { const frame = render(i); return { frame, key: JSON.stringify(frame) }; })
		.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
		.map(e => e.frame);
}
```

### Tuple layouts

Each renderer keeps its exhaustive destructure + `assertEveryFieldConsidered(rest)` and its existing omission comments. Document the tuple layout in a one-line comment above each renderer. Absent values become `null` (no more `'-'` sentinel, which a real value could equal):

- table: `[name, ddl, module, columns[], pk[], refs[], tags, named[], unnamed[], maintained]`
  - module: `module ? [module.name, renderTags(module.args)] : null`
  - columns: in declared order (behavioural — never sorted), each `[name, type, notNull, primaryKey, defaultValue ? expressionToString(defaultValue) : null, collation, tags]`
  - pk: `[[columnName, desc], …]` in key order
  - refs: `[...referencedTables].sort()`
  - named: `sortedFrames(namedConstraints, c => [name, definition, tags])`
  - unnamed: `sortedFrames(unnamedConstraints, c => [kind, definition, tags])`
  - maintained: `maintained ? maintained.bodyHash : null`
- view: `[name, ddl, definition, tags]`
- index: `[name, tableName, implicit, ddl, definition, tags]`
- assertion: `[name, ddl, definition]`
- tags (`renderTags`): `[[key, renderTagValue(v)], …]` sorted by key; absent and empty both `[]` (unchanged semantics — the differ treats them alike).

Keep `renderTagValue` as is (one-character kind prefix + `sqlValueToLiteral`): inside a JSON string it is still unambiguous, and its comment about the JSON-vs-string discriminator still applies.

`renderCatalogForRestoreCheck` needs no change (it blanks `ddl` and delegates).

### Out of scope, checked

- **Declared side** (`renderDeclaredSchemaCanonical`, `schema/schema-hasher.ts`): newline-joined generated DDL statements plus an optional `logical` / `using {json}` prefix line. Every statement is generator-emitted well-formed SQL, so a newline or statement-lookalike inside it can only sit inside a quoted literal or identifier, and the SQL tokenizer decides those boundaries. Not the same class; leave it.
- No persisted copy of the rendering exists (snapshots are in-memory; `feat-apply-schema-persisted-catalog-fingerprint` in backlog would persist one, and is not landed), so the format change needs no migration.

## Cost

Baseline (from the original ticket, `node bench/apply-schema-unchanged.mjs 30`, 54 tables / 14 views, 112.7 KB declaration): rendering 308.8 KB, fast-pathed no-op apply 1.50 ms vs 5.49 ms full comparison; standalone `JSON.stringify` of that much string data ≈ +0.25 ms. The design above stringifies each top-level item once (constraint frames twice, but they are tiny), so expect roughly +0.25 ms. The acceptance bar from `docs/schema-declarative.md` still applies: the fast path must take at least half off a full comparison at every schema size the bench reports. Re-run the bench (`yarn build` first — it imports `dist/`) and record the new numbers rather than trusting this estimate.

## Edge cases & interactions

- **Quoted identifiers containing `\n`, `"`, `\`** in table/column/view/index/constraint names — JSON-escaped; covered by the property, verified by inspection plus the new test.
- **Absent vs present-with-sentinel-text** (`module` absent vs module named `-`; DEFAULT absent vs a DEFAULT whose text is `-`) — now `null` vs a string; by inspection.
- **Absent tags vs empty tags** — both `[]`, intentionally equal (differ treats them alike); by inspection.
- **Two indexes with the same name on different tables** — still ordered by full encoding; existing `apply-schema-index-order.spec.ts` covers order-independence.
- **Map insertion order changes after drop+recreate** — top-level sections and constraint lists sorted by encoding; existing tests in `apply-schema-alter-order.spec.ts` / `apply-schema-index-order.spec.ts` / `apply-schema-unchanged-fast-path.spec.ts` compare before/after renderings and must stay green.
- **Restore check** (`renderCatalogForRestoreCheck`) — same encoding with blanked `ddl`; `apply-schema-restore.spec.ts`, `apply-schema-yields.spec.ts`, `schema/differ-undo-plan.spec.ts`, `schema-batch-hook.spec.ts` must stay green.
- **Compile-time field coverage** — every renderer keeps its exhaustive destructure and `assertEveryFieldConsidered`; enforced by the type checker.
- **Non-string leaves** (`notNull`, `primaryKey`, `desc`, `implicit` booleans) — emitted as JSON booleans, not stringified; by inspection.
- **Numbers in `SqlValue` tags** never reach `JSON.stringify` raw — they go through `renderTagValue` as strings, so `NaN`/`Infinity`/bigint cannot hit JSON's lossy or throwing paths. Keep it that way (do not put raw `SqlValue`s into a frame).

## Tests

- **New — the reproduction**, in `test/apply-schema-unchanged-fast-path.spec.ts` (near the renderer-shape tests): build catalog `B` (one table, views `v1`, `v2`) and catalog `A` exactly as in *Background*, and assert `renderCatalogForComparison(A) !== renderCatalogForComparison(B)`. This fails on today's code (verified) and passes for any injective encoding, so it pins the property without pinning the format. One test; no separate end-to-end `plantSnapshot` variant — the "equal renderings ⇒ diff skipped" consequence is already pinned by the existing white-box tests.
- **Update** `renders the implicit marker` (currently a regex `/^index .* on vehicles implicit$/m` against the old text): `JSON.parse` the rendering, take the index section (position 3), and assert some tuple has `tableName === 'vehicles'` and `implicit === true`.

## Docs / notes to update

- Replace the injectivity `NOTE:` in the `renderCatalogForComparison` doc comment (it points at the old backlog path) with a short statement of why the encoding is injective (JSON framing, positional fixed-arity tuples, `null` for absent).
- `docs/schema-declarative.md`: the comparison table row (catalog side) and the paragraph ending "…See the `NOTE:` on `renderCatalogForComparison` and `tickets/backlog/debt-catalog-rendering-injective-encoding`." — drop the "not uniquely decodable" caveat, say the rendering is JSON-framed, and refresh the measured render / size numbers from the bench.
- `packages/quereus/src/schema/declared-schema-manager.ts` `AppliedSchemaSnapshot` NOTE quotes "309 KB" for the catalog rendering — refresh from the bench.
- `bench/apply-schema-unchanged.mjs` header comments, if they quote the render cost.

## TODO

- Introduce `Frame`, `encodedSection`, `sortedFrames`; rewrite `renderCatalogForComparison`, `renderTable`, `renderColumn`, `renderNamedConstraint`, `renderUnnamedConstraint`, `renderMaintained`, `renderView`, `renderIndex`, `renderAssertion`, `renderTags` to the tuple layouts above; delete `sortedRenderings`.
- Add the collision test; update the implicit-marker test.
- `yarn build`, then `node bench/apply-schema-unchanged.mjs` (default and `30`) from `packages/quereus`; confirm the ≥ half-off bar; record numbers.
- Update the doc comment, `docs/schema-declarative.md`, the `declared-schema-manager.ts` NOTE, and bench comments with the new numbers.
- `yarn workspace @quereus/quereus run lint` and `yarn test`.
