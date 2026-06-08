description: Review the implemented single-identity (anchor-key) per-row capture that admits an arbitrary value (cross-member read, embedded subquery, or mixed anchor+self) in a decomposition optional **columnar** UPDATE. The capture reuses the multi-source `__vmupd_keys` substrate; the matched UPDATE reads the captured value back by the member key, a filtered materialize INSERT by the anchor key. EAV stays rejected (the prereq-chained follow-up `view-write-decomposition-update-captured-eav`).
prereq:
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md
----

## What shipped

An **arbitrary** value assigned to an optional **columnar** decomposition member — a cross-member
read (`set c = b + 1`), an embedded subquery (`set c = (select max(a) from main.T_core)`), or a
value mixing anchor + self leaves (`set c = c + a`) — is now **admitted** via a single-identity
(anchor-key) per-row capture, instead of rejecting `unsupported-decomposition-update`. EAV members
keep rejecting (the prereq-chained follow-up). Build / typecheck / lint / full test suite (5277
passing, 0 failing) all green.

### The mechanism

A decomposition's identity is a **single column** (the anchor key), every member keyed 1:1 to it by
the stitch key. So the capture needs one identity column `k0_0` (the anchor key) plus one `srcN` per
arbitrary value, built as plan nodes over the **already-planned get body**
(`Project_{k0_0, srcN…}(Filter_{anchorPred}(anchor ⋈ members))`) and materialized once before any
base op fires, into the **shared multi-source `__vmupd_keys` substrate**. Because the body
null-extends an absent optional member, the captured value already encodes per-row presence
(`c = b + 1` captures `b + 1` for an absent row; `c = c + a` captures `null + a` = null). Then:

- the **matched UPDATE** (`memberUpdateOp`, unfiltered over present rows) reads each value back
  correlated by the **member key** — `set c = (select srcN from __vmupd_keys k where k.k0_0 = <memberKey>)`;
- the **materialize INSERT** (over the anchor, absent rows) reads each value back by the **anchor
  key**, gated on a **runtime** non-null OR-chain (`… and (<srcN-by-anchorKey> is not null or …)`),
  with `on conflict (<memberKey>) do nothing` ceding matched rows to the UPDATE (emitted first).

The two ops cannot collapse into an upsert (the filter must suppress the absent branch without
suppressing the matched write). Capturing pre-mutation is what makes a **both-sides** write correct
(`set c = b + 1, b = b + 100` reads `c` from the pre-mutation `b`). A mixed anchor+self group rides
this path too — it **subsumes the retired `hasAnchor && hasSelf` reject**.

### Where the code lives (by phase)

- **Phase 1 — substrate**
  - `multi-source.ts`: exported `capturedValueSubquery` (was file-private).
  - `backward-body.ts`: added `findBodySource(root)` (the generalized `findJoinNode` — outermost
    `JoinNode` for a join body, bare anchor table for an anchor-only body) and threaded
    `bodySource` / `bodyScope` (`ctx.outputScopes.get(bodySource)`) through `BodyBackwardLineage`.
  - `decomposition.ts`: extended `DecompShape` with `bodySource` / `bodyScope`.
- **Phase 2 — classifier + emit (columnar)**
  - `decomposition.ts`: added `CapturedDecompValue` + the `captured` `ValueKind`; threaded a
    `capturedValues` carrier + `registerCapturedExpr` closure + `canCapture` flag through
    `decomposeUpdate` → `routeAssignment` → `lowerMaterializedValue` (which now returns `captured`
    for an arbitrary value when the owner is columnar **and** a carrier is present; EAV / carrier-
    absent still raise). `emitOptionalMemberUpdate` routes a `captured`-bearing **or** mixed
    anchor+self group through the new `emitCapturedMemberUpdate` + `buildCapturedMaterializeInsert`;
    the `hasAnchor && hasSelf` reject is gone (replaced by the captured path; a defensive reject
    remains for the carrier-absent legacy path).
- **Phase 3 — routing**
  - `view-mutation-builder.ts`: a decomposition UPDATE now plans the body once via
    `analyzeDecomposition` and routes to `decomposeDecompositionUpdate(…, capturedValues)` (bypassing
    `propagate`, mirroring the multi-source branch). When `capturedValues` is non-empty,
    `buildDecompositionKeyCapture` folds into the existing `keyCapture` / `injectKeyRef` /
    `withKeyCapture` / `identityCapture` machinery. DELETE / INSERT routing unchanged.

## Deviations from the ticket (intentional — please sanity-check)

1. **`buildDecompositionKeyCapture` lives in `decomposition.ts`, not `view-mutation-builder.ts`.**
   The ticket said the builder; I placed it in the mutation module because that is the *true*
   architectural dual of `buildMultiSourceKeyCapture` (which lives in `multi-source.ts`, not the
   builder) and it keeps `anchorPredicate` / `singleKeyColumn` private. It is imported into the
   builder and called from `buildViewMutation` exactly as the ticket's routing section describes.
2. **Registration is emit-time only.** The ticket had `lowerMaterializedValue` register the captured
   cell (cell carries `srcAlias`) and emit register the anchor/self siblings. I unified to a single
   registration site: `lowerMaterializedValue` only *classifies* `captured`, and
   `emitCapturedMemberUpdate` registers **every** cell's lowered value (including anchor/self/constant
   siblings — uniform, harmless, since the capture over the body null-extends absent members). One
   site, no `srcAlias` on the cell. Functionally identical; please confirm you agree it's cleaner.
3. **`findJoinNode` left in place.** I added `findBodySource` (the generalized version the EAV
   follow-up will reuse) but did **not** refactor multi-source's `analyzeJoinView` to consume it —
   minimal risk to the multi-source hot path. Minor duplication between the two finders; a possible
   future cleanup is to have `analyzeJoinView` read `lineage.bodySource` and delete `findJoinNode`.

## Test coverage (treat as a floor)

`lens-put-fanout.spec.ts` (deterministic):
- **Flipped to success** (T fixture): cross-member `set c = b + 1` (present 101 / absent materialize
  201); subquery `set c = (select max(a) …)` (present 20 / absent materialize 20).
- **New (T fixture)**: mixed self+anchor `set c = c + a` (present 1010 / absent → captured null → no
  materialize); both-sides `set c = b + 1, b = b + 100` (c reads pre-mutation b = 101, b = 200,
  PutGet through `x.T`); the predicate gate still fires on a non-anchor WHERE with a captured value
  (`set c = b + 1 where b = 100` → `non-anchor decomposition member`, atomic).
- **New (M fixture, nullable c1/c2)**: mixed anchor+self two-cell `set c1 = a + 1, c2 = c2 + 1`
  (present + absent-materialize, c2 self captures null); captured-null on a **matched** row writes
  the (nullable) column null and reads it back null.
- **New `P` fixture** (anchor + mandatory `b` + two-column optional `c1,c2`): multiple arbitrary
  cells `set c1 = b + 1, c2 = a + b` (each its own `srcN`, present + absent-materialize NON-null);
  multi-cell both-sides write; multi-cell all-null-image → no materialize.
- **EAV still rejects** (`set p = p + 1` → `/capture substrate|subquery/i`) — unchanged.

`property.spec.ts` (fuzzed): added an `update-c-cross` arm (`set c = b + 1`) to the columnar PutGet
oracle (present matched + absent materialize, b mandatory so always non-null); updated the
columnar-reject test (the columnar arbitrary `set c = b` reject became a **predicate** reject
`set c = b + 1 where b = 100`); added an arbitrary-EAV reject (`set p = p + 1`).

## Known gaps / boundaries for the reviewer

- **Invisible logical row (missing mandatory member) — the main boundary.** The capture is built
  over the **body** (inner-joins mandatory members, so an anchor row missing a mandatory member is
  dropped — it is invisible through the view), but the matched UPDATE's identity filters off the
  **anchor** subquery (`id in (select anchorKey from anchor where pred)`), which *includes* the
  invisible row. So a captured read-back for an invisible row **misses** (returns null). For a
  *nullable* optional column this writes null (PutGet holds — the row stays invisible, no widen); for
  a **NOT NULL** optional column it raises a base NOT NULL constraint error (atomic). This diverges
  from the constant/anchor paths, which write the literal value to the invisible row's component.
  Invisible rows are malformed base states (mandatory members should always be present), so this is
  not a logical-correctness regression, but it is **untested and unguarded** — I deliberately did NOT
  add a test that locks in the constraint-error behavior. Decide whether a plan-time guard (e.g.
  keying the matched UPDATE off `__vmupd_keys` membership instead of the anchor subquery, so invisible
  rows are excluded) or a documented limitation is warranted. The existing
  `PutGet (columnar, missing member)` property test does not fuzz the captured arm (it seeds T_b for
  every T_core, so no invisible rows reach the captured path).
- **Captured-null on a matched NOT-NULL column.** On the standard T fixture, `T_c.c` is NOT NULL, so
  the captured-null-matched case is only exercised on the nullable `M_opt.c1`. A captured value that
  evaluates null on a present row whose base column is NOT NULL raises a base constraint error (same
  as any UPDATE setting a NOT NULL column to null) — correct, but worth a second look.
- **Volatile classification nuance.** `set c = b + random()` is `arbitrary` → captured once per row
  (the ticket's "one value per row shared by both branches" benefit). But `set c = random()` itself
  classifies `constant` (no column ref, no subquery) and stays on the inline constant path (matched
  and materialize evaluate `random()` independently). Not tested (random is hard to assert); the self
  path's volatile handling is unchanged.
- **`bodyScope` undefined guard** in `buildDecompositionKeyCapture` is defensive only — never hit for
  a columnar body (always a join with a registered scope). It is the seam the EAV/anchor-only
  follow-up will exercise.
- **Dedup key** for `registerCapturedExpr` is per `(member, basisColumn)` (each assigned once by
  `noteTarget`), so each captured cell gets its own `srcN` — no accidental cross-cell sharing.

## Suggested review focus

1. The invisible-row boundary above — the one place where the captured path's behavior genuinely
   diverges and is unguarded/untested. Is a guard wanted, or is "documented limitation" acceptable?
2. The capture/body vs base-op identity alignment generally (capture over `anchor ⋈ members`,
   base ops keyed by the anchor subquery) — confirm the 1:1 stitch-key invariant makes the read-back
   single-valued for every *well-formed* row (it relies on `validatePrimaryAdvertisement`'s
   deploy-time stitch-key uniqueness).
3. The two intentional ticket deviations (capture builder placement; emit-time-only registration).
