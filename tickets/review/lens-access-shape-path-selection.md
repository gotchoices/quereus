description: Review the lens access-shape read-path consumer — the planner routes an exotic outer-query predicate over an inlined lens view through an advertised auxiliary structure (nd-tree / vector / full-text) as an auxiliary-seek ⋈ logical-key semi-join, instead of a residual filter over the full decomposition scan. Build + lint + full suite green (4285 passing); 13 new tests.
prereq:
files: packages/quereus/src/planner/nodes/lens-auxiliary-access-node.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/runtime/emit/lens-auxiliary-access.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/planner/building/lens-auxiliary-access.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/rules/access/lens-access-form-matcher.ts, packages/quereus/src/planner/rules/access/rule-lens-auxiliary-access.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/vtab/test-nd-tree-module.ts, packages/quereus/test/lens-access-form-matcher.spec.ts, packages/quereus/test/lens-access-routing.spec.ts, docs/lens.md, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/mapping-advertisement.ts
----

# Review: lens access-shape read-path consumer

The read-path sibling of `lens-module-mapping-advertisement` (which defined + stored `AccessShape` but built no consumer). When a query predicate over a lens logical table matches a form advertised on an `auxiliary-access` structure, the planner now routes the read through that structure rather than scanning the primary decomposition and filtering. Non-regressing by construction (the prior path was a correct residual-filter scan).

## What landed (the data flow)

```
  build time (select.ts, PlanningContext in hand)
    inlined lens view body V  ──►  LensAuxiliaryAccessNode( V )   [marker, only if ≥1 routable auxiliary]
       carries: RoutableAuxiliary[] = { auxScan (pre-built RetrieveNode over the aux member),
                                        joinPairs (logical-PK ↔ aux-key), accessColumns (logical↔aux), served }

  optimize time (Structural pass, before predicate-pushdown)
    Filter[ nd_contains(coord, :pt) ∧ rest ]            Filter[ rest ]?
    └─ marker( V )                            ──►        └─ V ⋈semi[V.pk = aux.key] Filter[ nd_contains(aux.coord, :pt) ]( AuxScan )
```

- **Marker** (`LensAuxiliaryAccessNode`) — unary pass-through modeled exactly on `AssertedKeysNode`: pass-through shape/attr-ids/physical, zero-cost emitter that emits its source (so when nothing routes, it vanishes). The auxiliary scans live on the marker's `routables` array (metadata), **not** in `getChildren()` — so an unrouted marker never drags the aux relation into the executed plan. This is also the test oracle: *the aux relation appears in the optimized plan ⟺ routing fired.*
- **Build helper** (`building/lens-auxiliary-access.ts`) — resolves routability per auxiliary (single-member `storage`, `logical-tuple` key aligned to logical PK, ≥1 advertised access column locatable on both V and the aux). Builds the aux scan via `buildTableReference`. Returns the marker only if ≥1 auxiliary is routable; else returns undefined (view untouched).
- **Form-matcher** (`rules/access/lens-access-form-matcher.ts`) — two channels: comparison forms (`equality`/`range`) via a `column op value` conjunct check; function-predicate forms (`prefix`/`contains`/`intersects`/`knn` + open strings) via an **extensible recognizer registry** (`registerAccessFormRecognizer`, `functionNameRecognizer`). Unknown form → no match (degrade).
- **Rewrite rule** (`rules/access/rule-lens-auxiliary-access.ts`) — registered on `Filter`, Structural `rewrite`, **before** predicate-pushdown. Finds the marker through Alias/AssertedKeys pass-throughs, rewrites the matched access column to the aux's backing basis column, pushes it onto the aux scan, builds the **semi-join** on the logical PK, consumes the matched conjunct, leaves the rest as a residual filter.

## How to exercise it

- Form-matcher units (no plan): `test/lens-access-form-matcher.spec.ts` (7).
- Routing e2e: `test/lens-access-routing.spec.ts` (6) — routing + aliased-view path + residual-conjunct + dual-decomposition discrimination + two degrade cases.
- Fixture: `test/vtab/test-nd-tree-module.ts` — `NdTreeModule` (MemoryTableModule subclass returning configured ads), `ndTreeAdvertisement()`, `registerNdTreeFixture(db)` (registers the `nd_contains` scalar fn + the `contains`→`nd_contains` recognizer).
- Run: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/lens-access-*.spec.ts"`.

Validation done: `yarn workspace @quereus/quereus run build` (tsc clean), `run lint` (clean), full `yarn workspace @quereus/quereus test` → **4285 passing, 0 failing, 9 pending** (was green before; +13 new tests). `test:store` not run — planner/read-path only, no store path touched.

## Soundness assumption the reviewer should weigh first

The semi-join `V ⋈semi[V.pk = aux.key] AuxScan[pred]` is row-equivalent to `Filter[pred](V)` **only if the auxiliary is a faithful, total index of the logical data**: every logical row has exactly one aux row on the logical key, and the aux's access column equals the logical column for that key. This is inherent to "an auxiliary access structure is an index," and is the D4 contract (the nd-tree fixture is total). **There is no runtime totality/consistency check** — an auxiliary that is missing rows or stale would silently drop rows the scan would keep. Worth deciding whether v1 should (a) document this as a module-honored contract (current stance), or (b) add a guard. The motivating structures (nd-tree, covering MV) are maintained write-through, so they are total by construction; a lazily-built or partial auxiliary would not be.

## Honest v1 boundaries (all by design per the plan's D-decisions; flag any you disagree with)

- **Comparison-form routing is wired but not activated.** The matcher surfaces `equality`/`range` matches (unit-tested), but `rule-lens-auxiliary-access` routes **function-predicate (exotic) matches only** and defers comparison forms to the primary body's own predicate-pushdown (D2 — the primary already answers them; routing would add a needless join). So a comparison-only auxiliary never routes in v1. Reviewer: confirm this is the intended scope, or decide whether comparison routing should be activated (and cost-gated against the primary).
- **One routed predicate per query.** The rule routes a single matching conjunct per firing (the marker is consumed, so it does not re-fire). A second exotic conjunct stays a residual filter over the semi-join. Multi-auxiliary / multi-predicate routing is not built.
- **Surrogate-only auxiliaries degrade to scan.** Join-back is on the **logical PK** (which V projects); an auxiliary keyed only by a non-logical surrogate has no alignment and is dropped at build time. The join-interior / surfaced-surrogate rewrite is the documented v2 boundary.
- **No cost tournament.** On a match the auxiliary path is selected unconditionally (it replaces residual-filter-over-full-scan, beneficial whenever it matches); >1 matching auxiliary resolves deterministically by advertisement `id`. There is **no manual cost stamping** — the rewritten subtree's cost is whatever the aux module's access-path selection + the semi-join heuristic produce. Reviewer: sanity-check that a routed plan can't pick a pathological downstream join algorithm; I did not audit join-physical-selection interaction beyond "the full suite stays green and semi-joins already flow through that machinery (subquery decorrelation produces them)."
- **Exact-form assumption.** An advertised form is treated as exact (the auxiliary fully answers the predicate; the conjunct is consumed). A lossy / refinement-required form that retains the predicate as a residual is a documented v2 extension — not built.
- **Marker/pushdown ordering — no barrier needed.** I did **not** make the marker a pushdown barrier. The rule fires first because it is registered ahead of predicate-pushdown in the Structural pass (rules run in registration order within a pass, and the pass is top-down with a fixpoint), and predicate-pushdown does not know the marker node type so it cannot slide a Filter below it. Even if pushdown reorders the Filter past an `Alias` above the marker, `findMarker` walks Alias/AssertedKeys, so the marker is still found. The aliased-view e2e test exercises this. Reviewer: this is the one ordering assumption worth a second look — if a future pushdown variant learns to cross the marker, a barrier becomes necessary.

## Other notes / smaller things to scrutinize

- **Aux read executes via scan + residual filter, not a custom `supports()`.** The fixture nd-tree module does not implement `supports()` for `nd_contains`; the routed aux read is an ordinary memory scan with `nd_contains` as a residual filter. This is sufficient (and the ticket explicitly blesses "a plain in-memory filter internally is fine — routing/selection is what's under test"), but it means the e2e tests prove **routing/selection**, not that a real exotic module's access surface is invoked end-to-end. A real nd-tree module would advertise the form, register a recognizer, and serve the pushed predicate through its own `getBestAccessPlan`/`supports` — that integration is unexercised here.
- **`lens.no-answering-structure` cross-link only.** Per D7, this consumer is what makes an advertised access shape *answer* a declared `quereus.lens.access.<col>` expectation, but `checkAnsweringStructures` (`schema/lens-prover.ts`) still only inspects basis index/ordering, not routable auxiliaries — so it can still warn even when an auxiliary would route. Teaching the advisory about routable auxiliaries is a reasonable backlog follow-up (not built; documented in `docs/lens.md`).
- **Recognizer registry is process-global** (module-level `Map`). The fixture guards re-registration with a module-level boolean. Duplicate recognizers would only produce duplicate matches that `chooseMatch` dedups — harmless, but the global-state shape is worth a glance for test isolation.
- **`select.ts` wiring** sits inside the existing `if (lensSlot)` block beside the `AssertedKeysNode` wiring (`planner/building/select.ts` ~line 443); the marker wraps the (possibly AssertedKeys-wrapped) view projection, inside the optional outer `AliasNode`.

## Suggested review focus

1. The totality/faithfulness soundness assumption above — is documenting-as-contract the right v1 call?
2. The semi-join's interaction with downstream join physical selection and cost (no manual cost stamp).
3. Whether comparison-form routing should remain deferred.
4. The marker/pushdown ordering reasoning (no barrier).
