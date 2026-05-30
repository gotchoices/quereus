description: Harden the lens override-body compiler against body shapes it silently mishandles — compound/set-operation (`union`/`intersect`/`except`) and `values` override bodies, unaliased computed projection columns, unvalidated `hiding(...)` names, and override FROM sources outside the declared `over Y` basis. Today these are read-incorrect-or-silent rather than rejected.
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/parser/ast.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## Why

Surfaced in review of `lens-explicit-overrides-and-attribute-merge`. The override merger (`compileOverrideBody` in `lens-compiler.ts`) composes one effective read body as `covered ⊕ gap-fill ⊖ hidden` by replacing **only the top SELECT's projection**: `body = { ...select, columns: composed }`. That spread is correct for a simple single-`select` body but silently wrong for several body shapes that the parser currently accepts. None of these are exercised by the shipped tests; the happy path (simple select, rename, gap-fill, filter, single join) is well covered and correct.

## Defects to close

### 1. Compound / set-operation bodies are carried through inconsistently (correctness)
`SelectStmt` carries `union?`, `unionAll?`, and `compound?` as **fields on the top node** (see `ast.ts` ~lines 183–185), so `select A union all select B` parses as a single node with `type === 'select'`. The override parser's guard is only `if (body.type !== 'select') throw …`, so it does **not** reject compound bodies. `compileOverrideBody` then:
- collects FROM sources from the **top leg only** (`collectOverrideSources(select.from)` never walks `select.union` / `select.compound`),
- builds coverage from the top leg's projection only,
- and preserves the `union` / `compound` pointer via the `{ ...select }` spread.

Result: the effective body is `(composed top projection) UNION (verbatim other leg)`. If the other leg's projection does not line up positionally with the composed top projection, reads are silently mis-mapped or fail with an opaque column-count error at query time, not at deploy time.

**Fix:** reject a compound/set-operation override body at parse time (or at compile time) with a clear "v1 lens override bodies must be a single SELECT (no union/intersect/except)" message, OR compose every leg. Rejection is the right v1 move; full multi-leg composition can defer to the decomposition work.

### 2. `values (...)` override bodies
`parseQueryExpr` can return a `values` node; the guard `body.type !== 'select'` *does* reject this, but confirm the error message is intelligible and add a regression test (a `values` body is never a sound lens read body).

### 3. Unaliased computed projection column silently dropped
`deriveColumnOutputName` returns `undefined` for a non-`column` expression without an alias (e.g. `select id, speed * 2 from CarCore`). That column contributes nothing to coverage, so the matching logical column is gap-filled (possibly from a same-named basis column — wrong) or errors as uncovered — never surfacing that the author wrote a projection term that maps to no logical column. **Fix:** error when an override projection term produces no output name (require an alias on computed columns), naming the offending expression.

### 4. `hiding(...)` names not validated against logical columns
A typo'd `hiding (colour)` is silently ignored — the name never matches a logical column, so nothing is hidden and no error is raised. **Fix:** validate every `hiding` name against the logical table's columns; error on an unknown name.

### 5. Override FROM sources not checked against the declared `over Y` basis
`collectOverrideSources` resolves `node.table.schema ?? basisSchemaName`, so an override that references `Z.Foo` (a different, existing schema) binds to `Z` without complaint, even though the lens declared `over Y`. At minimum warn; consider erroring for v1 so the basis binding is meaningful.

## Notes
- All five are deploy-time / compile-time validations — no runtime-path change. Add a focused test per case to `test/lens-overrides.spec.ts`.
- Keep the error messages in the existing `lens: …` voice used by `compileOverrideBody` / `gapFillError`.
- After the change, re-read docs/lens.md § Sparse Overrides and note the single-SELECT body restriction explicitly.
