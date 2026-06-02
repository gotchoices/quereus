description: Align single-source INSERT *up* to the multi-source contract: a `passthrough` view column (identity-on-value transform of one base column — `b collate nocase as bc`, no-op `cast(b as <same logical type>) as bc`) is INSERTABLE, storing the value verbatim. Today single-source INSERT rejects it (`no-inverse`) while multi-source INSERT admits it; this makes the two spines agree. Inverse and opaque-computed columns stay non-insertable on both spines (unchanged).
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

## Decision: passthrough is INSERTABLE — align single-source up

A `passthrough` column is identity on the stored value (it carries no transform to
apply on write — `inverse` is *absent*), so — exactly as the UPDATE path now does —
its inserted value can be stored verbatim in its single base column. We align the
single-source INSERT spine **up** to the multi-source spine (which already admits
passthrough), mirroring the UPDATE fix from
`single-source-passthrough-column-static-dynamic-divergence`:

- **Insertable** (store verbatim): `identity` / rename (`b as bc`) and `passthrough`
  (`b collate nocase as bc`, no-op `cast`). Both are `base` writable sites with
  `inverse === undefined`.
- **NOT insertable** (unchanged on both spines): `inverse` columns (`b + 1 as bp` —
  the envelope/lowering writes verbatim, with no hook to apply the inverse, so an
  inserted value would land raw) and `opaque` computed columns (`b || '!'`, `substr(...)`
  — no base lineage). Explicit insert of either still raises `no-inverse`.

This makes the single-source and multi-source insertability contracts **identical**:
both admit exactly `writable && inverse === undefined` (identity + passthrough).

### Reproduced divergence (confirmed at runtime, this branch)

- Single-source `create view v as select id, b collate nocase as bc from t;`
  - `insert into v (id, bc) values (3, 'new');` → **REJECT**: "column 'bc' is a
    computed (non-invertible) expression and is read-only".
  - implicit `insert into v values (...)` → same reject.
- Multi-source `create view mj as select c.cid as cid, c.note collate nocase as note,
  p.pid as pid from par_c c join par_p p on p.pid = c.pref;`
  - `insert into mj (cid, note, pid) values (10, 'alpha', 1);` → **OK**, stores
    `par_c.note = 'alpha'` verbatim. (The passthrough `note` passes the
    `writable && !inverse` gate; only unrelated NOT NULL columns can still block.)

## How multi-source already does it (the target contract)

`multi-source.ts` `analyzeMultiSourceInsert` (lines ~286-369):
- implicit supplied set: `outColumns.filter(c => c.writable && !c.inverse)` — admits
  passthrough (a passthrough `OutColumn` is `writable && inverse === undefined`).
- per-supplied gate (line ~307): rejects only `!out.writable || out.inverse || …`.

So identity and passthrough are indistinguishable there (neither carries `inverse`) —
both admitted. Inverse columns are excluded from the implicit set and rejected when
explicit. This is the contract single-source must match.

## How single-source rejects today (what to change)

`single-source.ts` `rewriteViewInsert` (lines ~679-747):
- implicit target set: `analysis.viewColumns.filter(vc => !vc.generated)` — includes
  *every* non-generated view column, so an exposed computed/passthrough column is in
  the implicit set and is then rejected at resolution.
- per-column base resolution: `requireBaseColumn(findViewColumn(analysis, name, view))`.
  `requireBaseColumn` (lines ~641-650) throws `no-inverse` for any `computed` lineage,
  and `deriveViewColumns` / `classifyProjectionExpr` classify `collate` / `cast`
  passthrough as `computed` (the AST model is deliberately identity-only and is NOT to
  be widened — its parity is pinned by `test/property.spec.ts`).

The UPDATE path already solved the equivalent problem WITHOUT widening the AST model:
`analyzeView` builds `analysis.writableSites` (view-col → `{ baseColumn, inverse? }`)
by reading the planned body's `updateLineage` through the shared `resolveBaseSite`
(lines ~469-503), and `rewriteViewUpdate` (lines ~818-825) consults that map first,
falling back to `requireBaseColumn` only for the no-site case. INSERT must do the same
— `writableSites` is already computed in `analyzeView`; INSERT just isn't reading it.

A passthrough column has a `writableSites` entry with `inverse === undefined`; an
inverse column has an entry WITH `inverse`; an opaque/computed column has no entry.
So the insertable predicate is exactly: **a writable site exists AND `inverse` is
absent.**

## Implementation notes / gotchas

- The insertable gate must be `site !== undefined && site.inverse === undefined`.
  Do NOT treat a bare "has a site" as insertable — that would wrongly admit inverse
  columns (which have a site WITH `inverse`). For an inverse column the resolution
  must fall through to `requireBaseColumn` so it still raises `no-inverse` (its
  `deriveViewColumns` lineage is `computed`). This keeps inverse non-insertability
  intact on the single-source spine (parity with the existing iv_v test at
  `93.4-view-mutation.sqllogic` lines 100-103, which must stay `-- error: non-invertible`).
- Identity/rename columns have a site with no inverse, so routing them through
  `writableSites` yields the same base column `requireBaseColumn` would have — a no-op
  behavior change for them (keep it uniform; don't special-case).
- Changing the **implicit** target set to `writable && inverse === undefined` is a
  deliberate behavior change for a single-source view that *exposes* an opaque/inverse
  computed column: previously an implicit `insert into v values (...)` errored
  (`no-inverse` on the exposed computed column); now that column is omitted and falls
  to its base default / NOT NULL check — exactly what multi-source already does. Verify
  no existing logic test asserts the old "implicit insert errors because a computed
  column is exposed" behavior (a scan of `93.4-view-mutation.sqllogic` found none — the
  only computed/passthrough/inverse insert tests there are *explicit* column lists). If
  one surfaces elsewhere, treat it as an intended contract change and update it.
- `filterConstants` / `default_for` append logic in `rewriteViewInsert` operates on
  resolved base-column names and is unaffected — keep `baseColumns` positionally
  aligned to `targetNames` as today.
- The contradiction-check (`checkContradiction`) indexes into `baseColumns`; preserve
  that alignment.

## Comments / docs to update (do not skip — the prose currently asserts the opposite)

- `single-source.ts` interface/lineage comments that state INSERT stays passthrough-blind
  and `viewColumns` keeps passthrough `computed` for INSERT: the `WritableSite` doc
  block (~lines 96-110), the `writableSites` field comment (~line 120-121), and the
  `analyzeView` writable-site block comment (~lines 469-485, esp. the "INSERT is
  unaffected … stays non-insertable on the single-source spine" sentence). Rewrite to
  state INSERT now consults `writableSites` for identity + passthrough (inverse still
  excluded).
- `update-lineage.ts` `identityBaseColumn` doc (~lines 273-297) says "hence the
  single-source `viewColumns` model and INSERT routing" consume the identity-only
  reader — update the INSERT clause: INSERT now reads the richer `writableSites`
  (passthrough-inclusive) like UPDATE; the AST identity-only reader stays the
  `deriveViewColumns`-parity bridge only.
- `docs/view-updateability.md` § Scalar Invertibility, the paragraph at ~lines 597-604
  ("INSERT stays inverse/passthrough-blind on the single-source spine … that asymmetry
  is tracked separately in the backlog ticket `view-insert-passthrough-single-multi-divergence`
  … out of scope here"). Rewrite to state the **passthrough INSERT contract** explicitly:
  passthrough is insertable on BOTH spines (stored verbatim); inverse and opaque stay
  non-insertable on both; the single↔multi INSERT divergence is now closed. Remove the
  "tracked separately / out of scope" deferral sentence (this ticket closes it).

## TODO

- [ ] In `rewriteViewInsert` (`single-source.ts`): change the per-target base-column
      resolution to consult `analysis.writableSites` first — if a site exists with
      `inverse === undefined`, use `site.baseColumn`; otherwise fall back to
      `requireBaseColumn(findViewColumn(...))` (which still yields the identity base
      column or raises `no-inverse` for inverse/opaque). Keep `findViewColumn` as the
      unknown-view-column guard for the fallback path.
- [ ] In `rewriteViewInsert`: change the implicit target set from
      `viewColumns.filter(vc => !vc.generated)` to also require an insertable writable
      site (`writable && inverse === undefined`), matching multi-source
      (`outColumns.filter(c => c.writable && !c.inverse)`). Preserve view-column display
      order and the generated-column exclusion.
- [ ] Update the `single-source.ts` comments listed above (WritableSite block,
      `writableSites` field, `analyzeView` writable-site block) to reflect INSERT now
      routing through `writableSites` for identity + passthrough.
- [ ] Update the `update-lineage.ts` `identityBaseColumn` doc comment's INSERT clause.
- [ ] Update `docs/view-updateability.md` § Scalar Invertibility (~lines 597-604) to
      state the passthrough INSERT contract and remove the deferral reference to this
      ticket.
- [ ] Flip the existing single-source passthrough INSERT test in
      `93.4-view-mutation.sqllogic` (lines ~202-205: `insert into pt_v2 (id, bc) values
      (3, 'new');` currently `-- error: non-invertible`) to a successful insert that
      stores `bc`/`nc` verbatim; assert read-back through pt_t and pt_v2. Update the
      surrounding comment block (~lines 163-172, 202-205) which currently says
      "passthrough column is NOT insertable on the single-source spine".
- [ ] Add a single-source IMPLICIT insert case for a view exposing a passthrough column
      (e.g. implicit `insert into pt_v2 values (...)` supplying the passthrough column
      verbatim) and, if a view also exposes an opaque computed column, confirm the
      computed column is omitted (falls to base default) rather than erroring — proving
      the implicit-set alignment.
- [ ] Add an explicit single↔multi INSERT parity case near the existing UPDATE parity
      block (lines ~222-246, par_ss / par_mj): insert a passthrough column through both
      a single-source view and a two-table inner-join view and confirm both store the
      value verbatim. Confirm inverse-column INSERT still rejects on single-source
      (iv_v test lines ~100-103 stay `-- error: non-invertible`).
- [ ] Build + run logic tests: `yarn workspace @quereus/quereus test 2>&1 | tee
      /tmp/test.log; tail -n 80 /tmp/test.log`. Confirm `property.spec.ts`
      (deriveViewColumns ⇄ updateLineage parity) still passes — the AST model is NOT
      widened, so it must.
- [ ] Lint the touched package (single-quote globs on Windows).
