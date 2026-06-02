description: Planner read-path consumer for the access-shape facet of a mapping advertisement. During path selection, when a query predicate over a lens logical table matches an advertised `AccessShape.served` form on an auxiliary-access structure (nd-tree spatial, vector knn, full-text), route the read through that structure (auxiliary seek ⋈ primary decomposition on the logical key) instead of scanning the primary decomposition and applying the predicate as a residual filter. Consumes `LensSlot.auxiliaryAccess` (stored by `lens-module-mapping-advertisement`).
prereq:
files: packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/nodes/asserted-keys-node.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/runtime/emit/asserted-keys.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/vtab/test-query-module.ts, packages/quereus/test/lens-advertisement.spec.ts, docs/lens.md
effort: xhigh
----

## Context — what already exists vs. what this builds

`lens-module-mapping-advertisement` (complete) **defines and stores** the access-shape facet but builds no consumer:

- `AccessShape` (`src/vtab/mapping-advertisement.ts:159`) = `{ served: { columns, forms }[] }`, where `AccessForm` is an **open union** `'equality' | 'range' | 'prefix' | 'contains' | 'intersects' | 'knn' | (string & {})`.
- Resolved auxiliary advertisements are stored on `LensSlot.auxiliaryAccess` (`src/schema/lens.ts:143`), a `ReadonlyArray<MappingAdvertisement>` with `role: 'auxiliary-access'`.
- The storage-shape consumer (write fan-out) landed (`lens-multi-source-{get-synthesis,put-fanout,put-insert-fanout,ind-injection}`, all complete). This ticket is the **read-path** sibling.

### The architectural reality that shapes the whole design

A lens logical table is **not** a plan-time first-class table — it compiles to an ordinary registered `ViewSchema` whose body is the n-way decomposition join over basis relations (`compileDecompositionBody`). At plan time the view is **inlined**: a `select … from Spatial where st_contains(coord, point)` becomes a `Filter` over the inlined join, and access-path selection runs per basis-relation `RetrieveNode` — **none of which know the nd-tree exists**. The auxiliary structure is a *separate* basis relation absent from the compiled body. So today the spatial predicate is a residual filter over a full decomposition scan (correct, just slow → this optimization is **non-regressing by construction**).

The single seam where the lens slot is reachable with the inlined body in hand is `planner/building/select.ts:443-449` — the exact spot `AssertedKeysNode` is already wired around an inlined lens view. That is the model this ticket follows: **a pass-through marker wired at build time, consumed by an optimizer rule** (the build site cannot see the outer query's `WHERE` predicate; only the optimizer sees the whole `Filter`-over-marker tree).

## Design decisions (settled in plan; do not re-litigate)

### D1 — Parallel advertised-form channel, NOT new `ConstraintOp` members
`equality`/`range` map cleanly onto `ConstraintOp` (`=`/`IN`, `>`/`>=`/`<`/`<=`), but `contains`/`intersects`/`knn` are **function-call predicates** (`st_contains(coord, point)`), not column-op-value comparisons — `ConstraintOp` cannot express them and `extractConstraintsForTable` will never surface them. Growing `ConstraintOp` would force every existing `getBestAccessPlan` module to understand an open vocabulary. **Reject.** Instead, a self-contained **form-matcher** consults two sub-channels:
- **comparison forms** (`equality`, `range`) — matched against `PredicateConstraint`s extracted from the filter (reuse `extractConstraintsForTable` / the constraint-extractor) on the advertised access columns.
- **function-predicate forms** (`prefix`, `contains`, `intersects`, `knn`, and any open `string & {}`) — matched by an **extensible recognizer registry** keyed by form name: a recognizer inspects the `Filter` predicate AST for a function call of the matching shape over the advertised access column(s). An advertised form with **no registered recognizer is silently ignored** (degrade, see D5).

### D2 — Scope: route EXOTIC forms; comparison forms already ride pushdown
An `equality`/`range` predicate on a column the decomposition body *projects* is already pushed into the inlined join's anchor by existing predicate-pushdown + `rule-select-access-path` (the "equi-lookup on the surrogate → column-store equality" case in the source ticket already works with **no** lens rewrite). The consumer's load-bearing job is the case ordinary pushdown **cannot** serve: an exotic form (`contains`/`knn`/…) that only an *auxiliary* structure answers. v1 therefore **only rewrites when a matched form is served exclusively by an auxiliary advertisement** (not already answerable by the primary body's natural pushdown). Comparison forms advertised by an auxiliary are admissible too but are lower priority — implement the function-predicate path first; wire comparison-form routing through the same machinery.

### D3 — The rewrite shape (auxiliary seek ⋈ logical key)
Given the marker wrapping the inlined view body `V` (output = logical columns) and a `Filter[P]` above it where `P` matches form `f` on auxiliary advertisement `A` serving column `c`:

```
   Filter[ st_contains(coordAttr, point) ]            Join[  V  ⋈[Vpk = aux.keyCols]  AuxSeek ]
   └─ LensAuxAccess-marker( V )            ──►         where AuxSeek = scan(A.member.relation)
                                                                      with P' = st_contains(A.coordCol, point) pushed,
                                                                      projecting A's key columns
```

- `P` is **consumed** (removed from the residual filter): v1 treats an advertised form as **exact** — the auxiliary fully answers the predicate. (A future "refinement-required / lossy form" flag that retains `P` as a residual is a documented v2 extension; do not build it now.)
- The matched access column `c` in `P` is rewritten from the logical column to `A`'s backing basis column (from `A.storage.members[].columns` / coordinate mapping) so `A`'s own vtab module sees the predicate over its own column. `A`'s module then serves it efficiently through the **existing** `supports()` / `getBestAccessPlan` surface (the synthetic fixture's `supports()` recognizes the function predicate). This ticket does **not** add a new module execution path — it only *selects/routes*.

### D4 — Join-back is on the projected logical primary key (v1 restriction)
The hard problem: the decomposition's shared **surrogate** is consumed *inside* the inlined join and is **not** in the view's projected output, so an auxiliary cannot be joined back on it without reaching into the (possibly already-transformed) join interior. **v1 decision:** the auxiliary joins back on the **logical primary key**, which the view body *does* project. The marker carries the logical-PK output-attribute ids; the auxiliary advertisement supplies, via its own `storage` shape, the basis key columns that align to that logical PK. An auxiliary keyed only by a non-logical surrogate with no logical-PK alignment **degrades to scan** (D5) — documented as the v2 boundary (join-interior rewrite / surfaced surrogate). The motivating nd-tree fixture keys its backing by the logical coordinate-id PK (`SharedKey.kind: 'logical-tuple'`), so it routes in v1. Note this implies an auxiliary advertisement intended for routing **must** carry a `storage` shape (single member relation + logical-tuple key alignment); an auxiliary with `access` but no usable key alignment is ignored.

### D5 — Graceful degrade (the extensibility contract)
At every step where the consumer cannot proceed, it **emits no rewrite and leaves the scan** (never errors): unknown form with no recognizer; recognizer present but predicate doesn't match its shape; auxiliary with no logical-PK-aligned `storage`; form served but column not projected. This is what lets vector-similarity / full-text modules land later with **zero** engine change — they advertise a new form + register a recognizer, and until a recognizer exists the query simply scans.

### D6 — Cost integration
A matched exotic auxiliary path replaces *residual-filter-over-full-decomposition-scan*, so it is beneficial whenever it matches; v1 selects it on match (first/most-specific match wins) and stamps the rewritten subtree a cost reflecting an index seek (sublinear in the auxiliary's rows) so the existing cost framework keeps it over the scan alternative. Do **not** build a full multi-auxiliary cost tournament; if >1 auxiliary matches the same predicate, pick deterministically (advertisement `id` order) and log the others as un-chosen. Comparison-form auxiliaries cost against the primary's own pushdown form (prefer the primary when it already answers — D2).

### D7 — The `lens.no-answering-structure` advisory closes the loop
`checkAnsweringStructures` (`schema/lens-prover.ts:1018`) warns when a declared `quereus.lens.access.<col>` expectation has no basis structure serving it. An advertised auxiliary access shape that *this consumer can route to* is exactly what answers that expectation. Out of scope to *silence* the advisory here (the advisory's v1 only inspects basis index/ordering, not advertisements), but add a doc cross-link noting the consumer is the structure that makes an advertised shape answer the declared pattern. A backlog item to teach `checkAnsweringStructures` about routable auxiliaries is acceptable to file if discovered necessary — do not build it in this ticket.

## Synthetic test fixtures (the test bed)

A real exotic module is **not** needed — `AccessForm` is open, so a fixture advertises exotic forms with no engine change. Follow the existing synthetic-vtab pattern (`test/vtab/test-query-module.ts`, `test-ordinal-seek-module.ts`, `test-monotonic-decline-module.ts`).

- **`test/vtab/test-nd-tree-module.ts`** — a module over a trivial in-memory backing whose `getMappingAdvertisements` returns a `MappingAdvertisement` with `role: 'auxiliary-access'`, `access: { served: [{ columns: ['coord'], forms: ['contains','knn','intersects'] }] }`, and a `storage` shape (single member relation, `SharedKey.kind: 'logical-tuple'` aligned to the logical coordinate-id PK, `columns` mapping logical `coord` → the backing's coordinate column). Its `supports()` recognizes the fixture spatial function predicate so the routed read executes (a plain in-memory filter internally is fine — routing/selection is what's under test). Register a fixture scalar function (e.g. `nd_contains(coord, point)`) the recognizer keys off; no real spatial math required.
- An **`equality`-serving column-store fixture** for the primary decomposition (or reuse the memory module + `quereus.lens.decomp.*` tags) so the dual-decomposition routing case exists: an equi-lookup on the logical key chooses the primary's equality pushdown; a `nd_contains(...)` predicate chooses the nd-tree.

### Key tests / expected outputs (TDD targets)
- **Form-matcher unit tests** (no plan): `equality`/`range` over an advertised column match against extracted constraints; `nd_contains(coord, ?)` matches the `contains` recognizer on `coord`; an advertised form with no recognizer (`'vector-cosine'`) returns no match (degrade); a `nd_contains` over a *non*-advertised column returns no match.
- **Routing e2e (`lens-advertisement.spec.ts` or a new sqllogic)**: `select … from Spatial where nd_contains(coord, :pt)` produces a plan whose access reaches the **nd-tree backing relation** (assert via `explain` plan shape / object name), and the residual `nd_contains` filter is consumed; results equal the scan-and-filter baseline (correctness: route and scan must agree row-for-row).
- **Dual-decomposition discrimination**: an equi-lookup on the logical PK does **not** route to the nd-tree (still served by the primary pushdown); only the spatial predicate routes to the nd-tree.
- **Graceful degrade**: a logical table whose auxiliary advertises only an unrecognized form, and a `contains` query over an auxiliary with surrogate-only (no logical-PK) `storage`, both fall back to the scan plan unchanged (assert no exception + identical results to baseline).
- **No-regression sweep**: the full suite stays green — a plain view / non-lens table never gets a marker (the `getLensSlot` lookup at `select.ts:443` already only matches a logical schema's slot), so ordinary queries are untouched.

## TODO

### Phase 1 — marker node + form-matcher infrastructure
- Add `PlanNodeType.LensAuxiliaryAccess` (`planner/nodes/plan-node-type.ts`).
- Add `LensAuxiliaryAccessNode` (`planner/nodes/lens-auxiliary-access-node.ts`) — a unary pass-through modeled **exactly** on `AssertedKeysNode` (shape/attr-id/physical pass-through, zero-cost emitter). It carries: the resolved `auxiliaryAccess` advertisements, the logical-PK **output-attribute ids** (for the join-back, D4), and the logical-column → output-attribute map (to locate the advertised access columns in the predicate). Add its emitter mirroring `runtime/emit/asserted-keys.ts` (emit source directly), and register it in the emitter dispatch.
- Wire it at `planner/building/select.ts:443-449`, alongside the existing `AssertedKeysNode` wiring: only when `lensSlot.auxiliaryAccess?.length` and ≥1 advertisement has a logical-PK-aligned `storage` (else skip — keeps non-lens and non-routable-lens views untouched). Compute the logical-PK attribute ids from the inlined body's output attributes against `lensSlot.logicalTable.primaryKeyDefinition`.
- Build the **form-matcher** (`planner/analysis/lens-access-form-matcher.ts` or under `rules/access/`): `matchAccessForms(predicate, marker) → MatchedAuxiliaryPath[]`, with `{ advertisement, servedEntry, form, accessColumn, predicateFragment }`. Comparison forms via the constraint-extractor; function-predicate forms via an **extensible recognizer registry** (`registerAccessFormRecognizer(form, fn)` + built-in `prefix`/`contains`/`intersects`/`knn` recognizers; unknown → no match). Unit-test the matcher in isolation.

### Phase 2 — the rewrite rule + cost + registration
- `planner/rules/access/rule-lens-auxiliary-access.ts`: register on `PlanNodeType.Filter`, phase `'rewrite'`, **ordered before generic filter-pushdown** so the predicate is still directly above the marker (skip pass-through `Alias`/`AssertedKeys` nodes when locating the marker). Guard: child subtree contains a `LensAuxiliaryAccessNode`; the filter predicate matches ≥1 auxiliary form (D1/D2 — exotic, auxiliary-only first). On match: build `AuxSeek` (a `buildTableReference`-style scan over the auxiliary member relation with the column-rewritten predicate pushed; reuse the existing scan/retrieve construction so `A`'s module access surface runs), `Join` it to the marker's source on the logical-PK ↔ aux-key equality (D3/D4), consume the matched predicate from the residual, stamp the seek cost (D6). No match / not routable → return `null` (degrade, D5).
- Register the rule in `planner/optimizer.ts:registerRulesToPasses()` near the access-path block (see the `rule-select-access-path` registration ~`optimizer.ts:185`). Confirm ordering vs. filter-pushdown; if the marker can be bypassed by pushdown, make the marker a pushdown barrier for the matched predicate or ensure this rule fires first.

### Phase 3 — fixtures, e2e tests, docs
- Add `test/vtab/test-nd-tree-module.ts` + the column-store/equality fixture + the `nd_contains` fixture function (see Test fixtures above).
- Add the e2e + degrade + discrimination + correctness tests (see Key tests).
- Update `docs/lens.md` § "The module mapping advertisement (protocol)": flip the access-shape consumer from *deferred* to *shipped*, document the v1 routing shape, the logical-PK join-back restriction (D4) + surrogate-only v2 boundary, the recognizer-registry extensibility contract (D5), and the `lens.no-answering-structure` cross-link (D7). Keep it DRY — extend the existing § rather than adding a new one.

### Validation
- `yarn workspace @quereus/quereus run build` (tsc clean), `… run lint`, then the full `yarn workspace @quereus/quereus test` — stream with `Tee-Object`; expect the existing count + the new tests, no regressions. (`yarn test:store` not required — this is planner/read-path only.)
- Handoff to review must be honest about the v1 boundaries: comparison-form auxiliary routing depth, surrogate-only join-back degrade, single-auxiliary cost selection (no tournament), exact-form assumption (no lossy/refinement residual), and whether the marker/pushdown ordering needed a barrier.
