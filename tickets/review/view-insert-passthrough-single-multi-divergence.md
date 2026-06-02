description: Review — single-source INSERT now admits a `passthrough` view column (identity-on-value transform of one base column — `b collate nocase as bc`, no-op `cast(b as <same type>) as bc`), storing the value verbatim, matching the multi-source contract. Inverse and opaque-computed columns stay non-insertable on both spines. The single↔multi INSERT insertability divergence is closed.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts
----

## What changed (the contract)

Both mutation spines now admit exactly `writable && inverse === undefined` for INSERT:
**identity / rename and passthrough store verbatim; inverse and opaque stay non-insertable.**
Previously single-source INSERT rejected a passthrough column (`no-inverse`) while
multi-source INSERT admitted it — that divergence is closed.

The single-source INSERT path was the only one not reading the `writableSites` map that
`analyzeView` already computes (UPDATE has consumed it since the
`single-source-passthrough-column-static-dynamic-divergence` ticket). The fix routes
INSERT through it; the identity-only AST `deriveViewColumns` model is **NOT** widened
(its `viewColumnsFromUpdateLineage ⇄ deriveViewColumns` parity is pinned by
`test/property.spec.ts` and still passes).

### Code change (`single-source.ts` `rewriteViewInsert`, ~line 679)

- Added a local `insertableBaseColumn(name)` reader: returns `site.baseColumn` iff
  `writableSites` has an entry whose `inverse === undefined`, else `undefined`.
- **Implicit target set** changed from `viewColumns.filter(vc => !vc.generated)` to also
  require `insertableBaseColumn(vc.name) !== undefined` — mirrors multi-source
  (`outColumns.filter(c => c.writable && !c.inverse)`). Display order + generated-column
  exclusion preserved.
- **Per-target base resolution** changed from `requireBaseColumn(findViewColumn(...))` to
  `insertableBaseColumn(name) ?? requireBaseColumn(findViewColumn(...))`. The fallback
  still yields the identity base column (a no-op for identity/rename) or raises
  `no-inverse` for an inverse/opaque column, and `findViewColumn` stays the
  unknown-view-column guard on the fallback path.

Comments/docs rewritten (they previously asserted the opposite): the `WritableSite` doc
block, the `writableSites` field comment, and the `analyzeView` writable-site block in
`single-source.ts`; the `identityBaseColumn` doc in `update-lineage.ts`; the § Scalar
Invertibility INSERT paragraph in `docs/view-updateability.md` (deferral sentence removed);
the passthrough-column comment in `property.spec.ts`.

## Use cases to validate (tests live in `93.4-view-mutation.sqllogic`)

- **Explicit passthrough INSERT — single-source** (was `-- error: non-invertible`, now
  succeeds): `pt_v2 = select id, b collate nocase as bc, cast(n as integer) as nc,
  b || '!' as bo from pt_t`; `insert into pt_v2 (id, bc) values (3, 'new')` stores
  `pt_t.b = 'new'` verbatim, `n` (omitted, nullable) → null, `bo` recomputes. (lines ~203–221)
- **Implicit passthrough INSERT, opaque column omitted**: `insert into pt_v2 values
  (4, 'imp', 7)` — the insertable set is `(id, bc, nc)` (the opaque `bo` is omitted, NOT
  an error). Proves the implicit-set alignment with multi-source. (lines ~215–221)
- **Single↔multi INSERT parity** (`pari_*`, fresh tables, lines ~266–300): the same
  `note collate nocase` passthrough is inserted verbatim through a single-source view
  (`pari_ss`) AND a two-table inner-join view (`pari_mj`, directly-supplied shared key).
- **Inverse INSERT still rejects on single-source** (unchanged): `iv_v = select id,
  b + 1 as bp, substr(s,1,1) as s1`; `insert into iv_v (id, bp) values (3, 5)` →
  `-- error: non-invertible`. (lines ~100–106)
- **Filtered passthrough** `pt_vf` UPDATE expectations updated for the 2 new base rows
  the inserts added (the base-table read now returns rows 3,4 too). (lines ~223–236)
- **property.spec.ts**: the `deriveViewColumns ⇄ updateLineage` parity test and the
  inverse/passthrough single-source PutGet tests all pass unchanged (AST model not widened).

## Behavior changes the reviewer should scrutinize

- **Implicit-insert value count is now against the INSERTABLE set, not the full view
  column count.** For a view exposing an opaque/inverse column, `insert into v values
  (...)` now expects one value per *insertable* column (opaque/inverse omitted). A user
  supplying a value for the omitted position gets a base-builder column/value-count
  mismatch. This is the deliberate, multi-source-matching contract (the ticket's
  "intended contract change"); the `pt_v2` implicit test pins it. Confirm the UX is
  acceptable and that no other implicit-insert test relied on the old "computed column
  exposed ⇒ implicit insert errors" behavior (a scan found none; only explicit-list
  computed-insert tests exist).
- **Identity columns now resolve their base column via `site.baseColumn` (plan-node
  lineage) instead of `requireBaseColumn`'s `vc.lineage.baseColumnName` (AST).** The
  parity harness only guarantees *lowercase* equality of the two, so the emitted base
  column name's *casing* could differ in principle. Functionally inert (SQL identifiers
  are case-insensitive; `filterConstants`/`isSupplied`/contradiction checks all lowercase),
  and the UPDATE SET path already uses `site.baseColumn` — but worth a glance.

## Known gaps / not covered (reviewer: treat tests as a floor)

- **No new test combining a passthrough column with a selection-predicate constant-FD
  default or `default_for` tag on INSERT.** The constant-FD / `default_for` append logic
  operates on resolved base-column names and is unaffected by the routing change (existing
  filter+default insert tests — `opentasks`, `GreenMen` — use identity columns; I reasoned
  through the interaction but did not add a passthrough+filter INSERT case). Low risk;
  a confirming test would harden it.
- **No explicit test that an implicit insert skips a *generated* passthrough/identity
  column.** The `!vc.generated` filter is preserved from before (a generated column has an
  identity writable site, so without the filter it would be wrongly admitted), but there
  is no targeted regression test for that exclusion on this path.
- **Multi-source INSERT was already correct** and is untouched; the parity test exercises
  it but no multi-source code changed.

## Validation run

- `yarn typecheck` (quereus): clean.
- `yarn workspace @quereus/quereus test`: 4411 passing, 9 pending (memory-backed vtab).
- `yarn workspace @quereus/quereus lint`: clean.
- `yarn test:store` (LevelDB store path) NOT run — out of scope for this AST-level rewrite;
  flag if the reviewer wants store-path confirmation of the new INSERT cases.
