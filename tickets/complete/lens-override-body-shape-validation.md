description: Five deploy-/parse-time validations hardening the lens override-body compiler against body shapes it silently mishandled — compound/set-operation bodies, `values` bodies, unaliased computed projection terms, unvalidated `hiding(...)` names, and override FROM sources outside the declared `over Y` basis. All five reject rather than mis-map; no runtime-path change.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## What landed

Five validations firing **before any catalog mutation** (atomic deploy preserved):

1. **Compound / set-operation bodies** (parser.ts:3050) — a `union`/`intersect`/`except` body parses as a single `select` carrying `body.compound`; the prior `body.type !== 'select'` guard missed it and the merger composed only the top leg. New guard rejects `body.compound || body.union` at parse time.
2. **`values (...)` bodies** — already rejected by the pre-existing `body.type !== 'select'` guard; regression test added.
3. **Unaliased computed projection term** (lens-compiler.ts coverage loop) — a non-`column` term with no alias contributed nothing to coverage and let the same-named logical column be silently gap-filled from the basis. Now throws, naming the term via `astToString`.
4. **`hiding(...)` names not validated** (lens-compiler.ts) — a hiding name matching no logical column was a silent no-op; now validated case-insensitively against `logicalTable.columns`.
5. **Override FROM source outside the declared basis** (`validateOverrideBasisSources`) — a `table`/join-leg qualified with a different existing schema (`from Z.Foo` while `over Y`) silently re-anchored the body. New dedicated FROM walker rejects it.

## Review findings

**Diff reviewed first, then handoff.** Scrutinized parser guard placement, the compile-stage ordering, DRY vs the sibling walkers (`collectOverrideSources`, `validateOverrideAdvertisementConflict`), type safety of `body.compound || body.union` (both fields exist on `SelectStmt` — ast.ts:183-185), and the error-message voice. Probed edge cases beyond the implementer's five tests.

### Checked — correctness
- **Parser compound detection** verified against `selectStatement` (parser.ts:638): compound legs populate `body.compound`, not legacy `body.union`/`unionAll`; the new guard matches the real AST shape. `values` bodies surface as `body.type === 'values'` and hit the existing guard. ✔
- **Advertisement-member regression risk (investigated, dismissed).** `validateOverrideBasisSources` runs unconditionally and *before* the more permissive `validateOverrideAdvertisementConflict`. I checked whether a multi-source advertisement could legitimately have members outside the basis schema (which the new check would now wrongly reject). Advertisement members are assembled with `relation: { schema: basisSchema.name, ... }` (mapping-advertisement-tags.ts:233) — members are always basis-qualified, so a member-referencing override passes the basis check. No regression. ✔
- **Join arm of defect 5** — probed `from y.CarCore c join z.Extra e ...`: the recursive walk rejects the cross-basis leg correctly. Added a regression test (was untested).
- **Defect-3 no-false-positive** — probed `select id, speed * 2 as fast from y.CarCore`: aliased computed term is accepted and `speed` still gap-fills (`source: 'default'`). Added a regression test pinning this boundary (was untested).

### Found — soundness gap (filed, not a regression)
- **Subquery-source re-anchor bypass.** `validateOverrideBasisSources` walks only top-level `table`/`join` nodes. A cross-basis table buried in a subquery source — `from (select * from z.CarCore)` — that covers every logical column explicitly deploys **without error** (confirmed by probe: NO THROW), silently reading `z` while the lens is `over y`. The handoff/code-comment claim that this is "left to the existing gap-fill error path" is **incorrect for the fully-covered case** (no uncovered column → no gap-fill → no error). Pre-existing hole, explicitly scoped out of v1, but it defeats the guarantee of the top-level check. Disposition: **major →** filed `tickets/backlog/lens-override-subquery-cross-basis.md` (closing it needs a recursive subquery-FROM walk that threads CTE/alias scope). Corrected the overstated `validateOverrideBasisSources` docstring and the docs/lens.md restriction note to state the gap accurately and reference the ticket (minor, fixed in this pass).

### Checked — other dimensions
- **DRY** — three near-identical FROM walks (`collectOverrideSources`, `validateOverrideBasisSources`, `validateOverrideAdvertisementConflict`). The implementer's rationale for not sharing (the other two permit cross-basis) is sound; folding them would require a mode flag and entangle distinct concerns. Left as-is.
- **Error ordering** within `compileOverrideBody`: basis-source (5) → hiding (4) → computed-term (3) → gap-fill. Each test trips exactly one; no spec'd precedence. Acceptable — flagged in handoff, no action.
- **Type safety / lint** — `body.compound || body.union` and `astToString` import all compile; lint clean.
- **Docs** — read every touched file. docs/lens.md § "v1 override body-shape restrictions" reflects the new reality; amended for the subquery gap and to clarify the FROM check covers join legs.
- **Resource cleanup / error handling** — all five throw `QuereusError`/parser error before catalog mutation; atomic-deploy property preserved. No new resources. Nothing to clean up.

### Disposition summary
- Minor (fixed in this pass): two regression tests added (join cross-basis rejection; aliased-computed-term acceptance); corrected misleading docstring + docs note re: the subquery gap.
- Major (filed): `lens-override-subquery-cross-basis` (backlog).

## Validation
- `node packages/quereus/test-runner.mjs --grep "lens overrides"` → **21 passing** (19 prior + 2 added).
- Full: `node packages/quereus/test-runner.mjs` → **3956 passing, 9 pending** (pending pre-existing). `yarn workspace @quereus/quereus lint` → clean (exit 0).
