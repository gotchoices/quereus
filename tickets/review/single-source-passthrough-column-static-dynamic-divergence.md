description: Review the fix that closes the single-source static↔dynamic divergence for the `passthrough` invertibility profile. The single-source UPDATE SET-target routing now consumes the FULL writable-base set (identity + passthrough + inverse) off the planned `updateLineage` via `resolveBaseSite`, so a passthrough column (`b collate nocase as bc`, no-op `cast(b as <same type>) as bc`) — already advertised `is_updatable='YES'` by the static surface and already writable on the multi-source spine — is now writable on the single-source dynamic UPDATE path too. UPDATE-only by spec decision; single-source INSERT of a passthrough column stays rejected.
prereq:
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What changed

The single-source spine (`mutation/single-source.ts`) previously classified an UPDATE
SET target two ways, leaving a non-bare-column **passthrough** projection (an
identity-on-value transform — `collate` / no-op `cast`) between the two readers:

1. `analysis.inverseSites` routed only targets whose plan-lineage site had a **truthy
   `inverse`** (the `inverse` profile — `x ± k`). A passthrough site has `inverse ===
   undefined`, so it missed this map.
2. the `requireBaseColumn(findViewColumn(...))` fallback read the **AST-only**
   `deriveViewColumns` model (bare-column-only via `classifyProjectionExpr`), which
   classifies a `collate` / `cast` expression `computed` → rejected `no-inverse`.

Meanwhile the static `column_info` / `view_info` surfaces (`baseSiteOf`, which treats
**any** `kind:'base'` site as writable) reported the column `is_updatable='YES' /
base_column=b`, and the multi-source spine (`OutColumn.writable = base-not-null-extended`,
inverse-agnostic) routed the same projection writable. So the catalog advertised a write
the single-source engine refused, and the two mutation spines disagreed on an identical
projection.

### The fix (minimal, parity-safe)

In `single-source.ts`:

- Renamed `interface InverseSite` → `WritableSite` (made `inverse` **optional**) and the
  `ViewAnalysis.inverseSites` field → `writableSites`.
- In `analyzeView`, **dropped the `&& site.inverse` gate** in the capture loop, so EVERY
  `writable && !nullExtended` base site (identity / passthrough / inverse) is captured
  with an optional `inverse` (and the still-unused `domain`).
- In `rewriteViewUpdate`, the SET target routes through `writableSites`, applying
  `inverse` only when present: `if (site) return { column: site.baseColumn, value:
  site.inverse ? site.inverse(loweredValue) : loweredValue }`. `findViewColumn` stays the
  unknown-view-column guard; `requireBaseColumn(vc)` is now only reached by an opaque
  `computed` column (→ `no-inverse`).
- Updated the doc comments on the renamed interface/field and the capture block.

No change to `update-lineage.ts`, `scalar-invertibility.ts`, or `multi-source.ts` — they
are listed in `files` only as references. `scalar-invertibility.ts` already classifies
`collate` / no-op `cast` as `passthrough` and traces them to a base site with `inverse`
undefined; `resolveBaseSite` already surfaces that as `{ writable:true, baseColumn,
inverse:undefined }`. The identity-only AST readers (`deriveViewColumns` /
`classifyProjectionExpr` / `viewColumnsFromUpdateLineage` / `identityBaseColumn`) are
deliberately untouched — their `deriveViewColumns ⇄ viewColumnsFromUpdateLineage` parity
is pinned by `property.spec.ts`.

### Spec decision locked: UPDATE-only

Single-source INSERT of a passthrough column stays **rejected** (`rewriteViewInsert`
resolves base columns via `requireBaseColumn(findViewColumn(...))` over the AST model,
which keeps passthrough `computed`). Rationale and the observed multi-source-INSERT
asymmetry are documented in `docs/view-updateability.md` and tracked in backlog
`view-insert-passthrough-single-multi-divergence` (confirmed to exist). This ticket only
confirms the single-source INSERT rejection.

## Behavior-preservation notes (verify these)

- **Identity / rename columns are now captured into `writableSites` too** (writable base,
  `inverse` undefined) and route through the `if (site)` branch with the value unchanged
  — byte-identical to the old `requireBaseColumn(vc)` result. The full suite (4411
  passing) exercises the existing identity/rename UPDATE-through-view tests, all green, so
  this re-route is confirmed behavior-preserving. Worth a reviewer's eye nonetheless: the
  claim is "every prior `requireBaseColumn`-routed identity column now goes through
  `writableSites` and lowers identically."
- **`findViewColumn` is still called for every SET target** (the unknown-view-column guard
  runs before the `writableSites` lookup). A base-only / unknown name still rejects there.
- The `WritableSite.domain` field remains **unused** (no shipped profile produces a
  domain; `x ± k` is unrestricted). Threaded for parity with multi-source, not conjoined
  into the identifying predicate — the documented deferral, unchanged by this ticket.

## Use cases / what the tests cover

**`test/property.spec.ts` § View Round-Trip Laws** — new test *"PutGet + lineage: a
passthrough column (no-op cast) is writable through the single-source view"* (mirrors the
inverse "B1 analogue"):
- static plan-lineage: `cast(b as integer) as bc` resolves a **writable** `base` site
  (t.b) with `inverse === undefined`, not null-extended;
- the identity-only `deriveViewColumns` still reports `bc` **computed** (parity preserved);
- PutGet property (50 runs): `update v set bc = NV` stores `t.b = NV` **verbatim** and the
  view reads back `bc = NV`.
- The pre-existing parity test *"viewColumnsFromUpdateLineage agrees with deriveViewColumns
  on the writable set"* stays green (AST readers untouched).

**`test/logic/06.3.5-column-info.sqllogic`** — new `pt_v` block: `column_info` reports a
`collate nocase` column AND a no-op `cast(n as integer)` column `is_updatable='YES'`
tracing to the right base column, while an opaque `b || '!'` sibling stays `'NO'`; a real
UPDATE then stores each passthrough value verbatim and the view reads it back; the opaque
sibling stays read-only on the write path.

**`test/logic/93.4-view-mutation.sqllogic`** — two new sections:
- `pt_v2` write-through: `collate` and no-op-`cast` passthrough columns UPDATE-land the raw
  value in the base column and read back through the view; opaque `bo` stays read-only;
  **single-source INSERT of a passthrough column is rejected** (`-- error: non-invertible`
  — locks the spec decision).
- `par_ss` / `par_mj` **single-source ↔ multi-source parity**: the identical
  `note collate nocase as note` projection updates through a single-source view over one
  table AND through a two-table inner-join view — the divergence this ticket closes.

## Known gaps / things for the reviewer to probe

- **Property test uses no-op `cast`, not `collate`, as the passthrough representative.**
  The base table `t` column `b` is `integer`; `cast(b as integer)` is the unambiguously
  type-safe no-op. The `collate nocase` passthrough is exercised on **TEXT** columns in the
  sqllogic tests (the natural collate case) and the static-lineage `collate` path is
  covered by the pre-existing *"invertibility registry"* test. So both passthrough
  flavors are covered, but split across files — a reviewer may want a `collate` PutGet
  property test for symmetry (low value; the sqllogic write-through already proves it).
- **Multi-source INSERT admitting passthrough is NOT tested here** — it is the explicit
  scope of the backlog ticket. This ticket only asserts the single-source INSERT
  *rejection*. If the reviewer wants the asymmetry pinned now, that belongs in the backlog
  ticket, not here.
- **`writableSites` now holds an entry for every writable column, including identity.**
  The map is larger than the old `inverseSites`. No measured perf concern (it is built
  once per `analyzeView`, O(columns)), but it is a behavioral widening worth a glance.
- The single↔multi parity assertion is a **concrete example** (sqllogic), not an
  exhaustive property. It proves the collate column writes on both spines for one shape.

## Validation performed (all green)

- `yarn typecheck` (quereus) — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Targeted: `06.3.5-column-info` + `93.4-view-mutation` sqllogic — pass.
- Targeted: `property.spec.ts` invertibility / parity / passthrough / plan-lineage — 7
  passing (incl. the new passthrough test and the untouched parity block).
- **`yarn test` (full quereus, memory vtab) — 4411 passing, 9 pending, 0 failures.**

`yarn test:store` (LevelDB store path) was **not** run — out of scope for a planner-side
mutation-routing change with no store-specific code touched; CI / a human can exercise it
if desired.
