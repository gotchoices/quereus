description: Close the single-source static↔dynamic divergence for the `passthrough` invertibility profile (a non-identity, identity-on-value transform of one base column — `b collate nocase as bc`, no-op `cast(b as <same-logical-type>) as bc`). The static `column_info`/`view_info` surfaces report such a column `is_updatable='YES'` / `base_column=b`, and the multi-source join path routes it writable, but the single-source dynamic UPDATE path rejects `update v set bc = …` with `no-inverse`. Unify the single-source SET-target routing onto the full writable-base set (identity + passthrough + inverse) so static, single-source-dynamic, and multi-source all agree — exactly as `single-source-inverse-column-static-dynamic-divergence` aligned them for the `inverse` profile.
prereq:
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Summary

The invertibility registry (`scalar-invertibility.ts`) recognises three update-path
profiles: `passthrough` (identity-on-value — bare column / rename, `collate(x,_)`,
no-op `cast`; traces to a `base` `UpdateSite` with **`inverse === undefined`**),
`inverse` (`x ± k`; a `base` site **with** an `inverse` closure), and `opaque`
(`computed`, read-only).

The single-source dynamic UPDATE path classifies a SET target two ways
(`single-source.ts` `rewriteViewUpdate`, lines ~770–787):

1. `analysis.inverseSites` (added by the inverse ticket) routes a target whose
   plan-lineage site has a **truthy `inverse`** — covers `inverse`, **not**
   `passthrough` (whose `inverse` is `undefined`).
2. otherwise `requireBaseColumn(findViewColumn(...))`, which reads the **AST-only**
   `deriveViewColumns` model (`classifyProjectionExpr`, bare-column-only). A
   `collate` / `cast` expression is not `type === 'column'`, so it is classified
   `computed` and rejected `no-inverse`.

A non-bare-column passthrough therefore falls between the two readers and is
rejected, while the static surface (`func/builtins/schema.ts` `baseSiteOf`, which
treats **any** `kind:'base'` site as writable) and the multi-source spine (whose
`OutColumn.writable = sideIndex !== undefined && !nullExtended`, inverse-agnostic)
both treat it as writable. The static catalog advertises a write the engine then
refuses, and the two mutation spines disagree on an identical projection.

## Confirmed reproduction (this run)

A temp `.sqllogic` under `node test-runner.mjs` confirmed the divergence exactly:

```sql
create table t (id integer primary key, b text null);
insert into t values (1, 'hi');
create view v as select id, b collate nocase as bc from t;
-- column_info('v') reports bc -> is_updatable='YES', base_column='b'  (assertion PASSED)
update v set bc = 'yo' where id = 1;
-- ViewMutationError: column 'bc' is a computed (non-invertible) expression and is read-only
--   raised at requireBaseColumn (single-source.ts:630), via rewriteViewUpdate (757)
```

The no-op-`cast` variant (`select id, cast(b as integer) as bc from t2` over an
`integer` base column) reproduces identically.

## Fix — unify single-source SET routing onto the writable-base set

Adopt the ticket's recommended unification: the single-source spine consumes
`resolveBaseSite` for **every** SET target (mirroring the multi-source spine and the
static surfaces), applying the site's `inverse` only when present. This collapses
the inverse-only `inverseSites` map into a single **`writableSites`** map carrying
`baseColumn` + optional `inverse` (+ the still-unused `domain`).

In `analyzeView` (`single-source.ts` ~478–494) the capture condition drops the
`&& site.inverse` gate:

```ts
// rename: interface InverseSite -> WritableSite; field inverseSites -> writableSites
const writableSites = new Map<string, WritableSite>();
viewColumns.forEach((vc, i) => {
  const site = resolveBaseSite(lineage?.get(attrs[i]?.id));
  if (site.writable && !site.nullExtended && site.baseColumn) {       // was: && site.inverse
    writableSites.set(vc.name.toLowerCase(), {
      baseColumn: site.baseColumn,
      ...(site.inverse ? { inverse: site.inverse } : {}),
      ...(site.domain ? { domain: site.domain } : {}),
    });
  }
});
```

In `rewriteViewUpdate` (~770–787) the SET routing consults `writableSites`,
applying `inverse` only when present:

```ts
const vc = findViewColumn(analysis, asg.column, view);   // unchanged: unknown/base-only -> unknown-view-column guard
guardTopLevelScope(asg.value, analysis, view);           // unchanged
const loweredValue = transformExpr(asg.value, substitute, descend);
const site = analysis.writableSites.get(asg.column.toLowerCase());
if (site) return { column: site.baseColumn, value: site.inverse ? site.inverse(loweredValue) : loweredValue };
return { column: requireBaseColumn(vc), value: loweredValue };   // only an opaque `computed` column reaches here -> no-inverse
```

Behavior-preservation notes for the implementer to confirm:

- **Identity / rename columns are now captured into `writableSites` too** (writable
  base, `inverse` undefined) and route through the `if (site)` branch with the
  value unchanged — byte-identical to the old `requireBaseColumn(vc)` result. The
  `requireBaseColumn(vc)` fallback now only ever fires for an `opaque` `computed`
  column (→ `no-inverse`), which is exactly its purpose. `findViewColumn` is kept
  as the SET-target **unknown-view-column** guard (a base-only / unknown name still
  rejects there before the lineage lookup).
- **`passthrough` (collate / no-op cast) is the new case made writable**: writable
  base, no inverse → `{ column: baseColumn, value: loweredValue }`, storing the
  assigned value verbatim (passthrough is identity on the stored value — no inverse
  to apply). This matches exactly what multi-source already does for the same
  projection on a join view.
- Leave the identity-only readers untouched — `deriveViewColumns`,
  `classifyProjectionExpr`, `viewColumnsFromUpdateLineage`, `identityBaseColumn`.
  Their `deriveViewColumns ⇄ viewColumnsFromUpdateLineage` parity is pinned by
  `property.spec.ts`; only the dynamic UPDATE write path reads the richer lineage.
  (`scalar-invertibility.ts` already classifies `collate` / no-op `cast` as
  `passthrough` and `traceInvertibleColumn` already threads them through to a base
  site with `inverse` undefined — no change needed there; it is listed in `files`
  only as the profile reference.)

## INSERT — spec decision (settled here): UPDATE-only, single-source INSERT unchanged

The ticket asked whether a passthrough column should be insertable. **Decision: this
ticket is UPDATE-only.** Single-source INSERT continues to reject a passthrough
column (`rewriteViewInsert` resolves base columns via
`requireBaseColumn(findViewColumn(...))` over the AST `deriveViewColumns` model,
which keeps passthrough `computed`). Rationale:

- The confirmed, in-scope correctness bug is UPDATE: the static `is_updatable`
  surface is an **UPDATE/writable-column** claim, and the single-source UPDATE path
  refuses it. There is no per-column static *insertability* surface advertising a
  passthrough column as insertable, so single-source INSERT rejecting it is not a
  catalog-lies-to-you divergence in the same class.
- Keeping `rewriteViewInsert` / `deriveViewColumns` untouched yields a minimal,
  parity-safe diff and matches how the inverse ticket scoped INSERT out.

Lock the decision with a test: a single-source INSERT of a passthrough column stays
rejected (see TODO).

**Observed (out of scope, candidate follow-up):** by code inspection the
multi-source INSERT path already *admits* passthrough columns — its implicit
supplied set is `outColumns.filter(c => c.writable && !c.inverse)` and its
per-supplied gate is `!out.writable || out.inverse || …`; a passthrough column is
`writable && !inverse`, so it passes both. That means single-source INSERT (rejects)
and multi-source INSERT (admits) already diverge for passthrough, independent of
this UPDATE fix. This is filed separately as backlog
`view-insert-passthrough-single-multi-divergence` — do **not** expand this ticket to
chase it; just confirm the single-source rejection test here.

## Docs

Update `docs/view-updateability.md` § Scalar Invertibility, the "Where inverse
profiles are consumed (today)." paragraph (lines ~547–566): state that the
single-source spine now consumes the **full writable-base set** (identity +
passthrough + inverse), not only inverse — a passthrough (`collate` / no-op `cast`)
column lowers `set bc = v` to `set b = v` (no inverse applied), aligning static
`is_updatable`, the single-source dynamic UPDATE, and the multi-source UPDATE. Keep
the existing notes that (a) only `opaque` / `null-extended` sites remain read-only
(`no-inverse`), (b) the identity-only AST readers are deliberately not widened, and
(c) INSERT stays inverse/passthrough-blind on the single-source spine (note the
multi-source-insert asymmetry now tracked in the backlog ticket).

## Validation

`yarn test` (memory vtab) and `yarn workspace @quereus/quereus run lint` must pass.
Pay special attention to the `property.spec.ts` round-trip parity block (must stay
green — the AST readers are untouched) and the existing inverse-profile cases in
`06.3.5` / `93.4` (must stay green — inverse routing is preserved, just reached
through the renamed `writableSites` map). On Windows, single-quote lint globs.

## TODO

### Core fix
- In `single-source.ts`: rename `interface InverseSite` → `WritableSite` and the
  `ViewAnalysis.inverseSites` field → `writableSites`; drop the `&& site.inverse`
  gate in the `analyzeView` capture loop so every `writable && !nullExtended` base
  site (identity, passthrough, inverse) is captured with optional `inverse`/`domain`.
- In `rewriteViewUpdate`: route the SET target through `writableSites` (apply
  `inverse` only when present), keeping `findViewColumn` as the unknown-column guard
  and `requireBaseColumn(vc)` as the opaque-`computed` → `no-inverse` fallback.
- Update the now-stale doc comments on the renamed interface/field and the
  `analyzeView` capture block to describe the full writable-base set (not "inverse
  profile" only).

### Tests
- `06.3.5-column-info.sqllogic`: add a single-source static↔dynamic-agreement block
  (after the `si_v` inverse block) for both a `collate nocase` column and a no-op
  `cast(... as <same type>)` column — assert `column_info` reports `is_updatable='YES'`
  / correct `base_column`, then a real `update` stores the value verbatim and the
  view reads it back; an opaque sibling (e.g. `b || '!'` / lossy cast) stays read-only.
- `93.4-view-mutation.sqllogic`: add a single-source passthrough write-through
  section (mirroring the `iv_v` inverse section) for both `collate` and no-op-`cast`
  columns; assert the UPDATE lands the raw value in the base column and reads back
  through the view. Add an assertion that a single-source INSERT of a passthrough
  column is still rejected (`-- error: read-only` / non-invertible), locking the
  spec decision.
- `property.spec.ts`: add a PutGet + lineage test for a passthrough column
  (mirroring the inverse "B1 analogue" test ~line 2545): the static plan-lineage
  resolves a writable `base` site with `inverse === undefined`; the identity-only
  `deriveViewColumns` still reports it `computed` (parity preserved); and
  `update v set bc = NV` stores the base value `NV` and reads back `bc = NV`.
- Add a single-source↔multi-source parity assertion (sqllogic in `93.4`, or a
  property test) that a `collate` column is writable on **both** spines: the same
  `c.note collate nocase as note` projection updates through a single-source view
  AND through a two-table inner-join view.

### Docs
- Update `docs/view-updateability.md` § Scalar Invertibility per the Docs section
  above.

### Validate
- Run `yarn test` and the quereus lint; confirm the property-spec parity block and
  the existing inverse cases stay green.
