---
description: The text description of the database that the schema tool compares to skip unneeded migration work is now JSON, so a user-typed name, label or default value can no longer imitate the separators and make two different databases look identical. Review the new encoding, its test, and the re-measured cost.
architecture: docs/schema-declarative.md#applied-state-snapshot-the-unchanged-schema-fast-path
files: packages/quereus/src/schema/catalog-rendering.ts, packages/quereus/test/apply-schema-unchanged-fast-path.spec.ts, docs/schema-declarative.md, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/bench/apply-schema-unchanged.mjs
---

## What changed

`renderCatalogForComparison` (`packages/quereus/src/schema/catalog-rendering.ts`) used to join fields with spaces and items with newlines, with no escaping, so free text (a quoted identifier, `ddl`, a view `definition`, a `DEFAULT`, a tag value) could spell out another item and two different catalogs could render to the same string. `apply schema` would then skip `computeSchemaDiff` when it should not. The renderer now emits one JSON text:

- Every renderer returns a `Frame` (`string | boolean | null | readonly Frame[]`) — a fixed-arity positional tuple; absent values are `null` (the old `'-'` sentinel is gone). `number` is deliberately left out of `Frame`, so a raw `SqlValue` can't be put in a frame by mistake (NaN/Infinity/bigint would break `JSON.stringify`); tag values still go through `renderTagValue` as strings.
- Tuple layouts are documented in a one-line comment above each renderer: table `[name, ddl, module, columns[], pk[], refs[], tags, named[], unnamed[], maintained]`, column `[name, type, notNull, primaryKey, default, collation, tags]`, view `[name, ddl, definition, tags]`, index `[name, tableName, implicit, ddl, definition, tags]`, assertion `[name, ddl, definition]`, tags `[[key, kind+literal], …]` sorted by key (absent and empty both `[]`, as before).
- Top level: `[schemaName, tables[], views[], indexes[], assertions[]]`. Each item is `JSON.stringify`-ed once (`encodedSection`), the encodings are sorted (replaces `sortedRenderings`, same order-independence rationale). Nested constraint lists use `sortedFrames` (sort by encoding, embed the frame).
- **Deviation from the plan:** the plan wrote the wrapper as `'[' + parts.join(',') + ']'`. Measured: that leaves a V8 rope, and the snapshot's `===` has to copy it flat first — string compare went from 0.018 ms to 0.060 ms at 275 KB. Added `jsonArrayText`, which builds `[a,b,…]` with one `join` so the result is flat; compare is back to 0.016 ms. Comment at the helper carries the measurement (0.057 vs 0.009 ms on a 234 KB rendering).
- `implicit` renders as `implicit === true`, so an absent flag and `false` stay equal, as before. The doc comment lists that among what the tree intentionally drops.
- `renderCatalogForRestoreCheck` unchanged (blanks table/view `ddl` and delegates).

## Tests

- **Added** `rendering encoding › free text that imitates item separators cannot make two catalogs render alike` (`test/apply-schema-unchanged-fast-path.spec.ts`): the reproduction from the ticket. It builds one table and two views, then a second catalog with one view whose `definition` spells out the second view in the old format, and asserts the renderings differ. Before the change I confirmed this pair collided by running the same construction against the old `dist/` build (`collide: true`). After the change it does not (`collide: false`).
- **Updated** `renders the implicit marker`: it now `JSON.parse`s the rendering, takes section 3 (indexes), and asserts some tuple has `tableName === 'vehicles'` and `implicit === true`. The old regex matched the old text format.
- Existing order-independence and restore-check specs (`apply-schema-alter-order`, `apply-schema-index-order`, `apply-schema-restore`, `apply-schema-yields`, `schema/differ-undo-plan`, `schema-batch-hook`) all stay green unchanged (194 passing when run together).

## Validation run

- `yarn workspace @quereus/quereus run lint`: clean (eslint plus the test-file tsc pass).
- `yarn build` then `yarn test`: all workspaces green (quereus: 11192 passing, 23 pending, 0 failing).
- Bench: `node bench/apply-schema-unchanged.mjs [0|14|30]`, twice each. I also took a same-session baseline on the old build first.

| declaration | before (old encoding) | after |
|---|---|---|
| 20.4 KB | render 0.17 ms, 65.1 KB, 56% off | render 0.19–0.21 ms, 55.4 KB, 52–61% off over three runs |
| 62.9 KB | (not re-run before) | render 0.51 ms, 156.7 KB, 63–65% off |
| 112.7 KB | render 0.60 ms, 309.8 KB, fast 1.57 vs full 5.92 ms (74% off) | render 0.73–0.77 ms, 274.8 KB, fast ~1.7 vs full ~5.9 ms (71–72% off) |

The fast path takes at least half off a full comparison at every size. The 20.4 KB size is closest to that 50% bar and noisy (the unrelated `computeSchemaHash` swung 1.42–2.44 ms between runs on this machine). The rendering got about 11% smaller, because field labels like `table` and `ddl` are gone.

## Docs touched

- `catalog-rendering.ts` doc comment: the old injectivity `NOTE:` (pointing at the backlog ticket) was replaced with the reason the encoding is injective.
- `docs/schema-declarative.md` § Applied-state snapshot: added "encoded as one JSON text" to the table row, refreshed the three-size table and the per-piece numbers, replaced the "not uniquely decodable" caveat with a paragraph on the JSON framing (including the flat-string note and the cost against the old encoding), and updated the memory figure (275 KB + 109 KB).
- `declared-schema-manager.ts` `AppliedSchemaSnapshot` NOTE: 309 KB changed to 275 KB, and roughly 4× changed to roughly 3.5×.
- `bench/apply-schema-unchanged.mjs` header: two pointers said `docs/schema.md`, but the section lives in `docs/schema-declarative.md`. Fixed both. The header quotes no render cost.

## Known gaps / things for the reviewer to weigh

- The `ddl` and `DEFAULT` comment in `renderColumn` still quotes an older measurement ("0.140 ms of a 0.871 ms whole-catalog render … 4.35 ms computeSchemaDiff"). I left it as is because I did not re-measure `expressionToString` on its own; the whole render now measures ~0.75 ms at that size.
- The `AppliedSchemaSnapshot` NOTE says FNV-1a over 119 KB (1.46 ms) is "three times the string compare it would replace". That ratio doesn't match the measured compare (~0.016 ms). This wording was already there before this ticket and I didn't touch it; it may be worth a correction.
- The post-unwind mismatch debug log (`unwindJournal` in `runtime/emit/schema-declarative.ts`) prints both renderings. They are now one JSON line each instead of multi-line text, so they are harder to eyeball in a log. This is a debug log only, so I didn't change it.
- The declared side (`renderDeclaredSchemaCanonical`) is out of scope, per the plan: it is generator-emitted SQL, and the tokenizer sets its boundaries. I did not re-check that.
