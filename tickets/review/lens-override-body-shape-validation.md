description: Review of five deploy-/parse-time validations hardening the lens override-body compiler against body shapes it silently mishandled — compound/set-operation bodies, `values` bodies, unaliased computed projection terms, unvalidated `hiding(...)` names, and override FROM sources outside the declared `over Y` basis. All five reject rather than mis-map; no runtime-path change.
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## What landed

Five new validations, all of which fire **before any catalog mutation** (atomic deploy preserved). Two are parser-stage, three are compile-stage inside `compileOverrideBody`.

### Defect 1 — compound / set-operation bodies (parser.ts ~3047)
`declareLensStatement` already rejected non-`select` bodies (`body.type !== 'select'`). A compound (`union`/`union all`/`intersect`/`except`) parses as a single `select` node carrying a `compound` pointer (the parser populates `body.compound`, not the legacy `union`/`unionAll` fields — verified at parser.ts:638-685), so the prior guard missed it and the merger composed only the **top leg**, keeping the other leg verbatim. New guard, immediately after the existing one:

```ts
if (body.compound || body.union) {
    throw this.error(this.previous(), `A lens override body must be a single SELECT; compound set-operations (union/intersect/except) are not supported in v1 lens overrides.`);
}
```
`body.union` is checked defensively (the current parser never populates it, but `assertion-classifier.ts` reads it for other statements).

### Defect 2 — `values (...)` bodies (no code change)
Already rejected by the pre-existing `body.type !== 'select'` guard with `A lens override body must be a SELECT; got 'values'.`. Only a regression test was added. Message left as-is (intelligible; not folded into defect-1 wording to avoid regressing the existing message).

### Defect 3 — unaliased computed projection term (lens-compiler.ts coverage loop, ~675)
`deriveColumnOutputName` returns `undefined` for a non-`column` expr with no alias; that term contributed nothing to coverage, so the same-named logical column was silently gap-filled from the basis (e.g. `speed * 2` dropped, logical `speed` reads basis `speed`). Now throws, naming the term via `astToString(col.expr)`:
```
lens: override for logical table '<L>.<T>' has a computed projection term '<expr>' with no output name; add an alias (... as <name>) so it maps to a logical column
```

### Defect 4 — `hiding(...)` names not validated (lens-compiler.ts, ~657)
A hiding name matching no logical column was a silent no-op (typo hides nothing). Now validated case-insensitively against `logicalTable.columns`, iterating `override.hiding` (original case) so the message preserves the author's spelling:
```
lens: override for logical table '<L>.<T>' hides unknown column '<name>'; it matches no column of the logical table
```

### Defect 5 — override FROM source outside declared basis (lens-compiler.ts, new `validateOverrideBasisSources`, called first in `compileOverrideBody`)
`collectOverrideSources` resolves `node.table.schema ?? basisSchemaName`, so `from Z.Foo` while the lens is `over Y` bound to `Z` silently. New dedicated walker (mirrors `collectOverrideSources`'s table+join descent; deliberately **not** added inside `collectOverrideSources`, which is shared by `deriveRelationBacking` and `validateOverrideAdvertisementConflict` where cross-basis is allowed) errors when a `table` node carries an explicit schema ≠ basis (case-insensitive):
```
lens: override for logical table '<L>.<T>' references basis relation '<schema>.<table>' outside the declared basis '<basis>' ...
```
Unqualified tables (default to basis) and basis-qualified tables pass; the shipped `from y.Core c join y.Contact k` cross-table-within-basis join stays valid.

## How to validate

- Targeted: `node packages/quereus/test-runner.mjs --grep "lens overrides"` → **19 passing** (14 prior + 5 new under `describe('lens overrides: body-shape validation')`).
- Full: `yarn workspace @quereus/quereus test` → **3954 passing, 9 pending** (pending are pre-existing). `yarn workspace @quereus/quereus lint` → clean.

Each new test exercises exactly one defect with `expectThrows(fn, regex)`:
- compound `union all` body → throws at `declare lens` parse time.
- `values (1, 2)` body → throws at parse time.
- `select id, speed * 2 from y.CarCore` (no alias) → throws at `apply schema x`.
- `hiding (colour)` typo → throws at `apply schema x`.
- `from z.CarCore` with lens `over y` (z exists) → throws at `apply schema x`.

## Reviewer focus / known gaps (treat tests as a floor)

- **Opaque-source blind spot (defect 5).** `validateOverrideBasisSources` only walks top-level `table`/`join` nodes; a subquery/function source (`from (select * from z.Foo)`) is treated as opaque and **not** descended into, so a cross-basis table hidden inside a subquery is not caught here — left to the existing gap-fill error path, consistent with the ticket's stated design. Confirm this is the intended boundary; a reviewer may want a test pinning the subquery-source behavior (currently untested either way).
- **Defect 3 breadth.** The guard throws on *any* unaliased non-`column` projection term (cast, function call, concat, arithmetic). This is intentional per the ticket but is a behavior change for any previously-accepted override that leaned on a computed term being silently dropped — worth a sanity check that no shipped fixture relied on that (full suite is green, so none in-tree).
- **Error-ordering.** Within `compileOverrideBody` the order is: basis-source check (5) → hiding check (4) → coverage-loop computed-term check (3) → gap-fill. Each test triggers one defect only; a body tripping several would surface defect 5 first. Not spec'd in the ticket — flag if a specific precedence is desired.
- **Message wording** for defects 3–5 is in the `lens:` voice; defects 1–2 in the parser's prose voice (per ticket). The regex matchers are deliberately loose (`/single SELECT|compound|union/i` etc.) so they survive light wording changes — tighten if exact strings should be pinned.
- No runtime/read-path change — all five are deploy/parse-time. docs/lens.md § Sparse Overrides updated with a new "v1 override body-shape restrictions" subsection and a hiding-validation note.
