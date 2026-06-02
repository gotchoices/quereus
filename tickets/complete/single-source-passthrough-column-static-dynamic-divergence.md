description: Close the single-source static↔dynamic divergence for the `passthrough` invertibility profile. The single-source UPDATE SET-target routing now consumes the FULL writable-base set (identity + passthrough + inverse) off the planned `updateLineage` via `resolveBaseSite`, so a passthrough column (`b collate nocase as bc`, no-op `cast(b as <same type>) as bc`) — already `is_updatable='YES'` on the static surface and already writable on the multi-source spine — is writable on the single-source dynamic UPDATE path too. UPDATE-only by spec decision; single-source INSERT of a passthrough column stays rejected.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What shipped

The single-source spine (`mutation/single-source.ts`) previously classified an UPDATE SET
target two ways, leaving a non-bare-column **passthrough** projection (identity-on-value —
`collate` / no-op `cast`) read-only on the dynamic path while the static catalog and the
multi-source spine both reported it writable. The fix unifies the read:

- `interface InverseSite` → `WritableSite` (`inverse` made optional); `ViewAnalysis.inverseSites`
  → `writableSites`.
- In `analyzeView`, the capture loop dropped the `&& site.inverse` gate, so EVERY
  `writable && !nullExtended` base site (identity / passthrough / inverse) is captured, with an
  optional `inverse` closure.
- In `rewriteViewUpdate`, the SET target routes through `writableSites`, applying `inverse` only
  when present (`site.inverse ? site.inverse(loweredValue) : loweredValue`). `findViewColumn`
  remains the unknown-column guard; only an opaque `computed` column now reaches
  `requireBaseColumn` (→ `no-inverse`).
- Doc comments on the renamed interface/field and the capture block updated;
  `docs/view-updateability.md` § Scalar Invertibility rewritten to describe the full
  writable-base set and the single↔multi INSERT asymmetry.

No change to `update-lineage.ts`, `scalar-invertibility.ts`, or `multi-source.ts` — they already
classify `collate` / no-op `cast` as `passthrough` (`inverse` undefined) and surface it via
`resolveBaseSite`. The identity-only AST readers (`deriveViewColumns` / `classifyProjectionExpr`
/ `viewColumnsFromUpdateLineage` / `identityBaseColumn`) are deliberately untouched — their
parity is pinned by `property.spec.ts`. Single-source INSERT of a passthrough column stays
rejected (it routes via the AST model, which keeps passthrough `computed`).

## Review findings

### Checked

- **Correctness — the load-bearing widening.** Dropping the `&& site.inverse` gate means
  identity / rename columns now route through the positional `writableSites` map
  (`viewColumns[i] ↔ attrs[i]`) instead of the AST-only `requireBaseColumn(vc)`. This makes the
  `deriveViewColumns`-order ⇄ plan-attribute-order correspondence load-bearing for the *common*
  case, not just the rare `inverse` case. **Verified safe:** (a) the parity property test
  *"viewColumnsFromUpdateLineage agrees with deriveViewColumns on the writable set"* asserts
  name + kind + **base-column** correspondence positionally across `star / explicit / rename /
  computed / dropkey / alias` shapes — exactly the alignment the capture relies on; (b) the
  `AliasView` sqllogic test (`select x.id as aid, x.label as alabel … update set alabel='Z'`)
  exercises an end-to-end single-source *rename* UPDATE where a positional off-by-one would write
  the wrong base column — it writes `label` correctly.
- **Spine parity.** Multi-source `OutColumn.writable = sideIndex !== undefined && !bc.nullExtended`
  (inverse-agnostic) matches the new single-source predicate `site.writable && !site.nullExtended
  && site.baseColumn`; both apply `inverse` only when present. Confirmed identical routing for a
  passthrough write.
- **Static ↔ dynamic.** `func/builtins/schema.ts` `baseSiteOf` unwraps `null-extended` and treats
  *any* `base` site (identity / passthrough / inverse) as writable → now agrees with the dynamic
  single-source UPDATE path. The divergence the ticket targets is closed.
- **INSERT rejection.** Single-source INSERT routes via `requireBaseColumn(findViewColumn(...))`
  over `deriveViewColumns`, which keeps passthrough `computed` → rejected (`non-invertible`).
  Confirmed by the new `pt_v2` INSERT case. The multi-source-INSERT-admits-passthrough asymmetry
  is documented and tracked in backlog ticket `view-insert-passthrough-single-multi-divergence`
  (confirmed present).
- **Graceful degradation.** When `updateLineage` is absent, `writableSites` is empty and identity
  columns still resolve via the AST `requireBaseColumn` fallback; only passthrough would then fail
  — acceptable, as lineage is always present for a single-source projection body.
- **Type safety / error handling / cleanup.** No `any`; optional `inverse` / `domain` properly
  guarded; pure planner transformation with no resource lifecycle. The `no-inverse` /
  `unknown-view-column` diagnostics are preserved on their respective paths.
- **Docs.** `docs/view-updateability.md` § Scalar Invertibility and the interface/field/loop doc
  comments read accurately against the shipped code.

### Found & fixed inline (minor)

- **Coverage gap: filtered-view × passthrough interaction.** The body-WHERE conjoin combined with
  passthrough SET-target routing was untested — `AliasView` covers it only for the *rename*
  profile. Added a `pt_vf` block to `test/logic/93.4-view-mutation.sqllogic`
  (`select … b collate nocase as bc … where n > 10`) asserting that (a) a visible row's passthrough
  write lands in the base column and (b) a row outside the filter matches no base row. Validated
  green (the file's logic test passes; full suite re-confirmed below).

### Found & noted (not actioned — out of scope / inert)

- **Latent: `WritableSite.domain` threaded but never conjoined** into the identifying WHERE on
  *either* spine. No shipped invertibility profile produces a `domain` (`x ± k` is unrestricted),
  so this is inert today; it must be wired before any domain-restricted profile ships. Documented
  deferral, unchanged here.
- **Pre-existing (not introduced): duplicate output-column-name ambiguity.** `writableSites` /
  `columnMap` are keyed by lowercased view-column name (last-wins). A view projecting two columns
  with the same output name would have `writableSites.get` return the last site while
  `findViewColumn` returns the first. This ambiguity predates the ticket (it already applied to
  `columnMap` and the former `inverseSites`) and is unrelated to the passthrough fix.
- **Multi-source INSERT/passthrough asymmetry** — tracked in the backlog ticket above.

### Major findings

None. No new fix/plan/backlog tickets filed (the one pre-existing asymmetry already has its
backlog ticket).

### Validation

- `yarn typecheck` (quereus) — clean.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn test` (full quereus, memory vtab) — **4411 passing, 9 pending, 0 failing.**
- Targeted `93.4-view-mutation.sqllogic` (incl. the new `pt_vf` block) — green.
- `yarn test:store` (LevelDB path) not run — out of scope for a planner-side mutation-routing
  change with no store-specific code touched; CI / a human can exercise it if desired.
