---
description: The text description of the database that the schema tool compares to skip unneeded migration work is now JSON, so a user-typed name, label or default value can no longer imitate the separators and make two different databases look identical.
architecture: docs/schema-declarative.md#applied-state-snapshot-the-unchanged-schema-fast-path
files: packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts, docs/schema-declarative.md, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/bench/apply-schema-unchanged.mjs
---

## What landed

`renderCatalogForComparison` (`packages/quereus/src/schema/catalog-rendering.ts`) used to join fields with spaces and items with newlines without escaping, so free text in a catalog (a quoted identifier, `ddl`, a view `definition`, a `DEFAULT`, a tag value) could spell out another item, two different catalogs could render to the same string, and `apply schema` would skip `computeSchemaDiff` when it should not. It now emits one JSON text:

- Every renderer returns a `Frame` (`string | boolean | null | readonly Frame[]`): a fixed-arity positional tuple, absent values `null`. `number` is excluded from `Frame` so a raw `SqlValue` cannot be embedded (NaN/Infinity/bigint break `JSON.stringify`); tag values still go through `renderTagValue`.
- Top level `[schemaName, tables[], views[], indexes[], assertions[]]`; each item is stringified once and the encodings sorted (`encodedSection`); nested constraint lists use `sortedFrames`. Tuple layouts are documented above each renderer.
- `jsonArrayText` builds `[a,b,…]` with one `join` so the result is a flat string rather than a V8 rope that the snapshot's `===` must flatten on every apply (measured 0.057 vs 0.009 ms compare).
- `implicit` renders as `implicit === true`, matching the differ's `!i.implicit`.
- `renderCatalogForRestoreCheck` unchanged (blanks table/view `ddl` and delegates).

Measured cost (`bench/apply-schema-unchanged.mjs`): render 0.60 → ~0.77 ms at the 112.7 KB declaration, rendering 310 KB → 275 KB; the fast path still takes 52–72% off a full comparison across the three sizes. Figures are in `docs/schema-declarative.md` § Applied-state snapshot.

Tests: added `rendering encoding › free text that imitates item separators cannot make two catalogs render alike` (the reproduction — one view whose `definition` spells out a second view in the old format; the implementer confirmed it collided against the old build); updated `renders the implicit marker` to parse the JSON.

## Review findings

Read the diff of `ticket(implement): debt-catalog-rendering-injective-encoding` first, then the handoff.

- **Correctness / injectivity** — checked. Every string leaf goes through `JSON.stringify` (which escapes quotes, backslashes, control characters and lone surrogates), tuples are fixed-arity, and sorted sections are still a parse-unique JSON array, so the multiset of items is recoverable. Checked every catalog field type against `Frame` (`pk.desc`, `notNull`, `primaryKey` are plain `boolean`; `type`/`collation` plain `string`; only `implicit` is optional and it is normalized). `module` absent vs present is unchanged in meaning from the old `'-'` sentinel. Sort order of `encodedSection` (default `.sort()`) and `sortedFrames` (code-unit comparator) agree. Nothing found.
- **Equivalences the rendering keeps** — confirmed the differ ignores each one the doc comment lists: tag absent-vs-empty (`tagsDrifted`), index `implicit` absent-vs-false (`schema-differ.ts` filters `!i.implicit`). Fixed inline: `docs/schema-declarative.md` listed only orderings and tags in its "agree field for field" sentence; added the `implicit` flag so it matches the code comment.
- **Stale comment** — fixed inline: the `AppliedSchemaSnapshot` `NOTE:` in `declared-schema-manager.ts` said FNV-1a hashing (1.46 ms) was "three times the string compare it would replace"; the measured compare is ~0.017 ms, so it now states that figure and compares the hash to the whole render instead.
- **Older measurement in `renderColumn` comment** (0.140 ms of a 0.871 ms render) — left as is: it is a dated measurement whose conclusion (rendering `DEFAULT` costs little next to `computeSchemaDiff`) still holds at the re-measured 0.77 ms render. Same for the 0.003–0.008 ms compare figure in the `renderCatalogForComparison` doc comment.
- **Debug log readability** — the post-unwind mismatch log in `unwindJournal` (`runtime/emit/schema-declarative.ts`) now prints two single-line JSON texts, harder to compare by eye. Debug-only and not a correctness concern; no action, noted here only.
- **Tests** — the added test is the reproduction of the defect at the lowest layer (pure renderer, no mocks); kept. The rewritten implicit-marker test couples to the index tuple layout (position 3, fields 1 and 2), but it is the pre-existing guard that the exposed implicit index reaches the rendering at all; kept. No new tests: the JSON framing retires the class by construction, so a generalized property test would only restate `JSON.stringify`.
- **Performance / resources** — `sortedFrames` stringifies each nested constraint once for sorting and again inside its table; negligible at measured sizes and covered by the bench figures. No resource-cleanup concerns (pure function).
- **Declared side** (`renderDeclaredSchemaCanonical`) — out of scope per the plan (generator-emitted SQL, tokenizer-delimited); not re-checked here.
- **Docs** — read `docs/schema-declarative.md` § Applied-state snapshot, the `catalog-rendering.ts` and `declared-schema-manager.ts` comments, and the bench header; grep found no other references to the old format or the old backlog ticket.
- **Validation** — `yarn workspace @quereus/quereus run lint` clean; the apply-schema specs plus `schema/differ-undo-plan` and `schema-batch-hook` 194 passing. My edits are comment/doc only; the implementer's full `yarn build` + `yarn test` run (quereus 11192 passing, 0 failing) stands.
- **Major findings / tickets filed** — none.
