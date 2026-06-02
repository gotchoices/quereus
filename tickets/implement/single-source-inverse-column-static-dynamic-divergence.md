description: Widen the single-source view-mutation spine to consume the threaded `inverse` so an inverse-profile column (`b + 1 as bp`) is writable on `update`, matching the static `column_info`/`view_info` `is_updatable = 'YES'` and the multi-source join path. `update v set bp = 9` must store `t.b = 8`; an `opaque` computed column stays `no-inverse`.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md

## Problem (settled)

The static updateability surfaces and the dynamic single-source write path disagree
about whether a single-source **inverse-profile** column is writable. Static
(`func/builtins/schema.ts` `baseSiteOf`) resolves any `base` site — including one
carrying an `inverse` — so `column_info('v')` reports `bp` (`b + 1`) as
`is_updatable = 'YES'`, `base_column = 'b'`. Dynamic (the single-source spine)
classifies projections at the AST level via the identity-only
`classifyProjectionExpr`, so `bp` is `computed` and `update v set bp = 9` is rejected
`no-inverse`. The multi-source join path was already taught to consume the threaded
`inverse` (`view-mutation-multisource-threaded-updatesite`); the single-source spine
was left out. **Resolution: widen the dynamic single-source path** to consume the
threaded `inverse`, mirroring multi-source.

### Reproduction (acceptance)

```sql
create table t (id integer primary key, b integer null);
create view v as select id, b + 1 as bp from t;
select column_name, is_updatable, base_column from column_info('v');  -- bp -> YES, base_column = b
update v set bp = 9 where id = 1;   -- must store t.b = 8 (currently rejected: no-inverse)
```

## Design

### Where the data already is

The plan-node backward walk is fully threaded for the single-source shape:
`TableReferenceNode.computePhysical` seeds `updateLineage` (`reference.ts:217`),
`ProjectNode.computePhysical` composes the inverse chain via
`deriveProjectUpdateLineage` → `traceInvertibleColumn` (`project-node.ts:262`,
`analysis/update-lineage.ts:154`), and `FilterNode` passes it through. So for
`select id, b + 1 as bp from t` the planned body's `root.physical.updateLineage`
maps `bp`'s output attribute to a `base` `UpdateSite` for `t.b` carrying
`inverse: w ↦ w - 1`. `resolveBaseSite` (`analysis/update-lineage.ts:330`) already
surfaces this as `{ baseColumn, inverse, domain, writable: true, nullExtended: false }`.

The single-source spine **plans the body** in `analyzeView` (`single-source.ts:341`,
`buildSelectStmt`) but then discards the plan and derives its column model purely
from the AST via `deriveViewColumns` (identity-only). It must instead read the
inverse off the planned `updateLineage` — exactly the surface multi-source consumes
through `analyzeBodyLineage` (`backward-body.ts:91`) and `decomposeUpdate`
(`multi-source.ts:736`: `const written = out.inverse ? out.inverse(baseValue) : baseValue;`).

### Approach: a separate full-lineage reader feeding an inverse-site map

Do **not** widen the identity-only readers in place. `deriveViewColumns` /
`classifyProjectionExpr` / `identityBaseColumn` / `viewColumnsFromUpdateLineage` stay
identity-only — their `deriveViewColumns ⇄ viewColumnsFromUpdateLineage` parity is
pinned by `test/property.spec.ts` (`viewColumnsFromUpdateLineage agrees with
deriveViewColumns on the writable set`, line ~2510) and must not move. Instead add a
**separate** reader on the dynamic single-source path that produces, per view column,
the writable `base`+`inverse` chain, and carry it on `ViewAnalysis` as a parallel map
keyed by view-column name (lowercased).

This keeps the blast radius minimal and isolates the change to the **UPDATE write
path** (the SET target), leaving read contexts and INSERT untouched:

- **Read contexts** (WHERE / RETURNING / a value RHS that references `bp`) already
  resolve `bp` → its forward base term `b + 1` through `analysis.columnMap`
  (`single-source.ts:429`, built from the `computed` lineage's `normalizeBaseRefs`
  expr). That is the correct read semantics and does not change.
- **Write context** (`set bp = expr`): the SET target's base column is `b`, and the
  assigned value becomes `inverse(loweredValue)` = `loweredValue - 1`.

New single-source-local shape (in `single-source.ts`):

```ts
interface InverseSite {
  readonly baseColumn: string;
  readonly inverse: (written: AST.Expression) => AST.Expression;
  readonly domain?: AST.Expression;   // none shipped yet (x ± k is unrestricted)
}
// added to ViewAnalysis:
readonly inverseSites: ReadonlyMap<string, InverseSite>;  // view-col (lc) -> inverse site
```

Build it in `analyzeView` from the already-planned `bodyPlan`:

```ts
const attrs = (bodyPlan as RelationalPlanNode).getAttributes();
const lineage = (bodyPlan as RelationalPlanNode).physical.updateLineage;
const inverseSites = new Map<string, InverseSite>();
viewColumns.forEach((vc, i) => {
  const site = resolveBaseSite(lineage?.get(attrs[i]?.id));
  if (site.writable && !site.nullExtended && site.inverse && site.baseColumn) {
    inverseSites.set(vc.name.toLowerCase(), { baseColumn: site.baseColumn, inverse: site.inverse, ...(site.domain ? { domain: site.domain } : {}) });
  }
});
```

Index alignment: `viewColumns[i]` ↔ `attrs[i]` holds because `deriveViewColumns` and
the planned projection expand `select *` identically (the same parity
`viewColumnsFromUpdateLineage` relies on). An inverse profile only ever arises from an
explicit projection (`*` columns are pure identity, `inverse === undefined`), so they
are never picked up here regardless. **Reuse `resolveBaseSite`** (already imported via
`backward-body.ts`; import it into `single-source.ts`) rather than re-deriving — DRY
with multi-source.

Consider factoring the per-column `resolveBaseSite` read so single-source and
`backward-body.ts`'s `analyzeBodyLineage` share it; if the refactor is more churn than
value, an inline read in `analyzeView` is acceptable — note the choice in the review
handoff.

### UPDATE assignment lowering (`rewriteViewUpdate`)

Intercept inverse columns before `requireBaseColumn` (which raises `no-inverse` for
`computed`). Mirror `multi-source.ts` `decomposeUpdate`:

```ts
const assignments = stmt.assignments.map(asg => {
  findViewColumn(analysis, asg.column, view);          // still enforces unknown-view-column scope
  guardTopLevelScope(asg.value, analysis, view);
  const loweredValue = transformExpr(asg.value, substitute, descend);
  const inv = analysis.inverseSites.get(asg.column.toLowerCase());
  if (inv) return { column: inv.baseColumn, value: inv.inverse(loweredValue) };
  return { column: requireBaseColumn(findViewColumn(analysis, asg.column, view)), value: loweredValue };
});
```

The inverse is applied **after** base-term substitution (it expects a value already in
base terms) — identical to multi-source. `set bp = 9` → `set b = 9 - 1`;
`set bp = a + 1` → `set b = (a + 1) - 1` (stores `b = a`).

### INSERT / DELETE — explicitly unchanged

- **INSERT**: `viewColumns` keeps marking `bp` `computed`, so `rewriteViewInsert`'s
  `requireBaseColumn` still raises `no-inverse` for an explicit `insert (bp)` and the
  implicit target set — exactly today's behavior, and consistent with multi-source,
  which also rejects inverse-column inserts (the raw-value envelope has no inverse
  hook; `multi-source.ts:300,306`). This is intentional: `is_updatable = 'YES'` is an
  UPDATE claim; inverse columns remain non-insertable on both spines. Note this in the
  handoff so the reviewer does not read it as a residual divergence.
- **DELETE**: no value lowering; an inverse column in a `where` resolves via
  `columnMap` to its forward term (read context). Unchanged.

### Domain deferral

No shipped invertibility profile produces a `domain` (`x ± k` is unrestricted over
integers), so `InverseSite.domain` is always absent today. Mirror multi-source's
documented deferral (`multi-source.ts:738`): thread the field but do not yet conjoin
it into the identifying predicate; leave the same one-line deferral note. Do **not**
invent domain machinery for a case nothing produces.

### Opaque stays read-only

An `opaque` projection (lossy cast, string fn, …) has no `inverse` on its `UpdateSite`,
so `resolveBaseSite(...).inverse` is `undefined`, no `inverseSites` entry is made, and
`requireBaseColumn` raises `no-inverse` as today. The widening is inverse-gated, not a
blanket allow.

## Tests (TDD)

Key new/extended coverage and expected outputs:

- **Reproduction pin (sqllogic)** — add to the view-mutation corpus (the
  `93.x-view-mutation*` family) or a focused new logic file: `create view v as
  select id, b + 1 as bp from t; update v set bp = 9 where id = 1;` then
  `select b from t where id = 1` → `8`. And an `opaque` sibling (e.g.
  `select id, substr(s,1,1) as s1`) where `update ... set s1 = ...` still errors
  `no-inverse`.
- **Single-source PutGet law (`test/property.spec.ts`, § View Round-Trip Laws, ~line
  1977)** — the `computed` shape `'id, a, b + 1 as bp'` (line 2003) is exactly the
  inverse column but is currently treated read-only by `viewModel` (which uses
  identity-only `deriveViewColumns`, line 2060). Extend the harness so an inverse
  column is recognized writable via the plan lineage (read `resolveBaseSite` over
  `planBody(body).physical.updateLineage`, like the existing
  `viewColumnsFromUpdateLineage` block) and pin PutGet/update: writing `bp = NV`
  stores `t.b = NV - 1` and reads back `bp = NV`. Mirror the multi-source inverse
  acceptance test (`PutGet + lineage: an inverse-profile column (cv + 1) is writable
  through the join`, ~line 2811). Keep the identity-only
  `deriveViewColumns ⇄ viewColumnsFromUpdateLineage` parity test (~line 2510) green
  and unchanged — proof the identity-only readers were not widened.
- **Golden `06.3.5-column-info` / `06.3.4-view-info`** — these already assert the
  static `YES` for an inverse column (static was always honest). Re-run; they should
  pass unchanged and now pin static↔dynamic agreement. Add a row only if no inverse
  column is currently covered there.

## Docs

- `docs/view-updateability.md` § Scalar Invertibility (lines ~530–543, "Where inverse
  profiles are consumed (today)"): drop the "**single-source** spine does not yet
  consume inverses…" caveat; state both spines consume the threaded `inverse`. Keep
  the note that the identity-only AST reader (`identityBaseColumn` /
  `viewColumnsFromUpdateLineage`) is the `deriveViewColumns`-parity surface and is
  deliberately not widened — the dynamic spine reads the richer plan-node lineage
  separately.
- `analysis/update-lineage.ts` `identityBaseColumn` doc-comment (lines ~282–294):
  drop "The single-source dynamic path does not yet consume inverses, so this reader's
  identity-only divergence is the honest single-source reading"; replace with: the
  single-source spine now reads the full `base`+`inverse` chain off the planned
  `updateLineage` (via `resolveBaseSite`) on its write path, while this reader stays
  identity-only for the `deriveViewColumns` parity bridge.

## TODO

- [ ] Add `InverseSite` + `inverseSites` to `ViewAnalysis`; populate in `analyzeView`
      from `bodyPlan.physical.updateLineage` via `resolveBaseSite` (import it into
      `single-source.ts`). Decide inline-vs-shared read; note in handoff.
- [ ] `rewriteViewUpdate`: route an inverse-column assignment to its base column with
      `inverse(loweredValue)`; non-inverse columns fall through to `requireBaseColumn`
      unchanged. Keep the `findViewColumn` / `guardTopLevelScope` guards.
- [ ] Confirm INSERT/DELETE/RETURNING paths are untouched (inverse columns stay
      `computed` in `viewColumns`).
- [ ] Add reproduction + opaque-stays-read-only sqllogic coverage.
- [ ] Extend the single-source PutGet law to write the inverse column and assert
      `t.b = NV - 1`; keep the identity-only parity test green.
- [ ] Update `docs/view-updateability.md` § Scalar Invertibility and the
      `identityBaseColumn` doc-comment.
- [ ] `yarn workspace @quereus/quereus run build`; `yarn workspace @quereus/quereus
      test` (stream with `2>&1 | tee /tmp/ss-inverse.log; tail -n 80 /tmp/ss-inverse.log`);
      `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
