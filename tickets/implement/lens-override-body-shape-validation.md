description: Harden the lens override-body compiler against body shapes it silently mishandles — compound/set-operation override bodies, `values` bodies, unaliased computed projection columns, unvalidated `hiding(...)` names, and override FROM sources outside the declared `over Y` basis. All five are deploy-/parse-time validations; no runtime-path change.
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/parser/ast.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## Why

Surfaced in review of `lens-explicit-overrides-and-attribute-merge`. The override merger (`compileOverrideBody` in `lens-compiler.ts`) composes one effective read body as `covered ⊕ gap-fill ⊖ hidden` by replacing **only the top SELECT's projection**: `body = { ...select, columns: composed }` (lens-compiler.ts:715). That spread is correct for a simple single-`select` body but silently wrong for several body shapes the parser currently accepts. The happy path (simple select, rename, gap-fill, filter, single join) is well covered and correct; the five shapes below are not exercised by the shipped tests and are read-incorrect-or-silent rather than rejected.

## Reproduction (all five confirmed)

A throwaway spec (`db.exec` each override, then read `x.Car`) reproduced every defect during the fix stage:

| # | Override body | Current behavior | Should be |
|---|---|---|---|
| 1 | `select id, speed from y.CarCore union all select id, speed from y.CarOther` | **deploys**; effective body keeps `… union all select id, speed from y.CarOther` verbatim, reads rows from **both** legs (`{1,120},{2,90}`) | reject at parse time |
| 2 | `values (1, 2)` | already throws `A lens override body must be a SELECT; got 'values'.` | keep rejecting; add regression test |
| 3 | `select id, speed * 2 from y.CarCore` | **deploys**; `speed * 2` silently dropped, logical `speed` gap-fills from basis `speed` → reads `120`, not `240` | error naming the unaliased computed term |
| 4 | `select id, color from y.CarCore hiding (colour)` | **deploys**; typo ignored, view columns still `[id, color]` | error naming the unknown hiding name |
| 5 | `select id, speed from z.CarCore` while lens is `over y` (and `z.CarCore` exists) | **deploys**; binds to `z`, reads `{9,999}` from `z` | error (FROM source outside the declared basis) |

## Root causes & fix design

### 1. Compound / set-operation bodies (correctness)
`SelectStmt` carries `compound?` (and legacy `union?` / `unionAll?`) as **fields on the top node** (ast.ts:183–185), so `select A union all select B` parses as a single node with `type === 'select'`. The parser guard at **parser.ts:3044** is only `if (body.type !== 'select') throw …`, so it does not reject a compound body; the parser only ever populates `body.compound` (verified — `assertion-classifier.ts:70` also reads the legacy `sel.union`). `compileOverrideBody` then composes the **top leg only** (`collectOverrideSources(select.from)` never walks `select.compound`) and preserves the `compound` pointer through the `{ ...select }` spread (lens-compiler.ts:715) → effective body is `(composed top projection) <set-op> (verbatim other leg)`; positional misalignment is a silent mis-map or an opaque column-count error at query time, not deploy time.

**Fix:** reject at parse time in `declareLensStatement`, immediately after the existing `body.type !== 'select'` guard (parser.ts:3044–3046). Add a second guard:

```ts
if (body.compound || body.union) {
	throw this.error(this.previous(),
		`A lens override body must be a single SELECT; compound set-operations (union/intersect/except) are not supported in v1 lens overrides.`);
}
```

Check `body.compound` (the field the parser populates) **and** the legacy `body.union` defensively. Full multi-leg composition can defer to the decomposition work; rejection is the right v1 move.

### 2. `values (...)` bodies
Covered for free by the existing `body.type !== 'select'` guard (a `values` node has `type: 'values'`), and the message is already intelligible. No code change beyond a regression test (a `values` body is never a sound lens read body). Consider folding `values` into the same "must be a single SELECT" wording as defect 1 for a consistent message, but do not regress the existing behavior.

### 3. Unaliased computed projection column silently dropped
`deriveColumnOutputName` (lens-compiler.ts:754–757) returns `undefined` for a non-`column` expression without an alias. In `compileOverrideBody`'s coverage loop (lens-compiler.ts:664–672) that term contributes nothing to coverage, so the matching logical column is gap-filled from a same-named basis column (wrong) or errors as uncovered — never surfacing that the author wrote a projection term mapping to no logical column.

**Fix:** in the coverage loop, when `col.type !== 'all'` and `deriveColumnOutputName(col)` is `undefined`, throw a `lens:` error naming the offending expression (use `astToString(col.expr)`), e.g.:

```ts
lens: override for logical table '<L>.<T>' has a computed projection term '<expr>' with no output name; add an alias (… as <name>) so it maps to a logical column
```

Keep the voice consistent with `gapFillError`.

### 4. `hiding(...)` names not validated against logical columns
The `hidden` set is built from `override.hiding` at lens-compiler.ts:652 and only ever consumed via `hidden.has(key)`; a name that matches no logical column is silently a no-op.

**Fix:** right after building `hidden` (lens-compiler.ts:652), validate each hiding name against `logicalTable.columns` (case-insensitive). Error on the first unknown name, naming it and the logical table, in the `lens:` voice. (Iterate `override.hiding`, not the lowercased set, so the message preserves the author's spelling.)

### 5. Override FROM sources not checked against the declared basis
`collectOverrideSources` resolves `node.table.schema ?? basisSchemaName` (lens-compiler.ts:731), so an override referencing `Z.Foo` (a different existing schema) binds to `Z` without complaint even though the lens declared `over Y`. Note `collectOverrideSources` is shared by `deriveRelationBacking` and `validateOverrideAdvertisementConflict`, so do **not** add the error inside it — add a dedicated validation.

**Fix:** add a small `validateOverrideBasisSources(from, basisSchemaName, logicalSchemaName, logicalName)` that walks the override's `select.from` FROM tree (table + join nodes, mirroring `collectOverrideSources`'s walk) and errors when a `table` node carries an explicit `schema` that differs (case-insensitive) from `basisSchemaName`. Call it early in `compileOverrideBody`. Unqualified tables (default to basis) and tables qualified with the basis name are fine; cross-basis joins within the basis (the shipped `from y.Core c join y.Contact k` test) stay valid. Opaque sources (subquery/function) are not introspectable and are left to the existing gap-fill error path. Error for v1 (consistent with the other four), in the `lens:` voice, naming the offending `schema.table` and the declared basis.

## Notes
- All five are deploy-time / parse-time validations — no runtime-path change.
- Keep error messages in the existing `lens: …` voice used by `compileOverrideBody` / `gapFillError` for defects 3–5; defects 1–2 stay in the parser's prose voice (adjacent to the existing guard).
- Run `yarn workspace @quereus/quereus test` (or `node packages/quereus/test-runner.mjs --grep "lens overrides"`) and `yarn workspace @quereus/quereus lint` after the change.
- After the change, update docs/lens.md § Sparse Overrides to state the single-SELECT body restriction explicitly (no union/intersect/except/values), and that `hiding(...)` names and override FROM schemas are validated.

## TODO

- [ ] parser.ts `declareLensStatement` (~3044): add the compound-body rejection guard after the existing `body.type !== 'select'` check (defect 1); confirm the `values` message still fires (defect 2).
- [ ] lens-compiler.ts `compileOverrideBody` coverage loop (~664): error on an unaliased computed projection term, naming the expression (defect 3).
- [ ] lens-compiler.ts `compileOverrideBody` (~652): validate every `hiding` name against `logicalTable.columns`, error on unknown (defect 4).
- [ ] lens-compiler.ts: add `validateOverrideBasisSources` and call it in `compileOverrideBody`; error on a FROM table whose explicit schema ≠ basis (defect 5).
- [ ] test/lens-overrides.spec.ts: add one focused test per defect (compound rejected, values rejected, unaliased-computed errors naming the term, hiding-typo errors naming the column, FROM-outside-basis errors). Use the existing `expectThrows` helper with a regex matcher.
- [ ] docs/lens.md § Sparse Overrides: note the single-SELECT restriction and the hiding/basis-source validations.
- [ ] `yarn workspace @quereus/quereus test` + `lint` green.
