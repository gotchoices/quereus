description: Single-identity (anchor-key) per-row capture admitting an arbitrary value (cross-member read, embedded subquery, or mixed anchor+self) in a decomposition optional **columnar** UPDATE. The capture reuses the multi-source `__vmupd_keys` substrate; the matched UPDATE reads the captured value back by the member key, a filtered materialize INSERT by the anchor key. EAV stays rejected (prereq-chained follow-up `view-write-decomposition-update-captured-eav`). Reviewed and completed.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md
----

## What shipped

An **arbitrary** value assigned to an optional **columnar** decomposition member — a cross-member
read (`set c = b + 1`), an embedded subquery (`set c = (select max(a) from main.T_core)`), or a
value mixing anchor + self leaves (`set c = c + a`) — is now **admitted** via a single-identity
(anchor-key) per-row capture, instead of rejecting `unsupported-decomposition-update`. EAV members
keep rejecting (prereq-chained follow-up).

### The mechanism (as implemented and verified)

A decomposition's identity is a **single column** (the anchor key), every member keyed 1:1 to it by
the stitch key. The capture is one identity column `k0_0` (the anchor key) plus one `srcN` per
arbitrary value, built as plan nodes over the **already-planned get body**
(`Project_{k0_0, srcN…}(Filter_{anchorPred}(anchor ⋈ members))`) and materialized once before any
base op fires, into the **shared multi-source `__vmupd_keys` substrate**. Because the body
null-extends an absent optional member, the captured value already encodes per-row presence. Then:

- the **matched UPDATE** (`memberUpdateOp`, over present rows) reads each value back correlated by
  the **member key** — `set c = (select srcN from __vmupd_keys k where k.k0_0 = <memberKey>)`;
- the **materialize INSERT** (over the anchor, absent rows) reads each value back by the **anchor
  key**, gated on a **runtime** non-null OR-chain, with `on conflict (<memberKey>) do nothing`
  ceding matched rows to the UPDATE (emitted first).

Capturing pre-mutation is what makes a **both-sides** write correct (`set c = b + 1, b = b + 100`
reads `c` from the pre-mutation `b`). A mixed anchor+self group rides this path too — subsuming the
retired `hasAnchor && hasSelf` reject.

### Code locations

- `multi-source.ts`: exported `capturedValueSubquery`.
- `backward-body.ts`: `findBodySource(root)` + threaded `bodySource` / `bodyScope` through
  `BodyBackwardLineage`.
- `decomposition.ts`: `DecompShape.bodySource`/`bodyScope`; `CapturedDecompValue` + the `captured`
  `ValueKind`; `registerCapturedExpr` carrier; `emitCapturedMemberUpdate` +
  `buildCapturedMaterializeInsert` + `buildDecompositionKeyCapture`.
- `view-mutation-builder.ts`: a decomposition UPDATE plans the body once via `analyzeDecomposition`
  and routes to `decomposeDecompositionUpdate(…, capturedValues)`, bypassing `propagate`; a
  non-empty carrier folds `buildDecompositionKeyCapture` into the existing
  `keyCapture`/`injectKeyRef`/`withKeyCapture`/`identityCapture` machinery.

## Review findings

Reviewed adversarially from SPP / DRY / modularity / type-safety / error-handling / resource-cleanup
/ performance angles. Read the full implement diff with fresh eyes before the handoff summary, then
re-derived the correctness argument from the code (capture vs base-op identity alignment, the
`__vmupd_keys` wiring, the legacy-path routing) rather than trusting the summary.

**Correctness (checked, no issues):**
- The capture builder is a faithful dual of `buildMultiSourceKeyCapture` — `descriptor: {}` matches
  (the multi-source builder returns the same), `preserveInputColumns=false` matches, key-column types
  taken from `getType()`. The `__vmupd_keys` substrate / `injectKeyRef` / `identityCapture` wiring is
  shared verbatim with the multi-source path.
- `capturedValueSubquery(srcN, 0, [memberKey | anchorKey])` correlates `k.k0_0` to the op's own
  stitch-key column; single-valued for every well-formed row by the 1:1 stitch invariant
  (`validatePrimaryAdvertisement` deploy-time uniqueness). The matched UPDATE targets only present
  member rows; the materialize handles absent rows; `do nothing` + UPDATE-first ceding is correct.
- Routing: the builder routes **all** decomposition updates through `decomposeDecompositionUpdate`
  (= `decomposeUpdate`) with a carrier, bypassing `propagate`; the legacy `propagateDecomposition`
  update case is now defensive/dead (still reachable only off the non-build path, where it correctly
  rejects an arbitrary value). No double-emit. The body is planned once (`analyzeDecomposition` →
  `analyzeBodyLineage`). Constant/anchor/self updates build no capture and classify identically
  (`canCapture=true` does not change their pre-`captured` classification).
- RETURNING on a decomposition update is rejected upstream (`rejectReturning`), so
  `buildMultiSourceReturning`'s `if (!analysis) return {}` guard correctly no-ops despite a present
  `keyCapture`.
- The three intentional deviations are all correct: (1) `buildDecompositionKeyCapture` belongs in
  `decomposition.ts` (true dual of `buildMultiSourceKeyCapture`, which lives in `multi-source.ts`);
  (2) emit-time-only registration is cleaner and functionally identical; (3) leaving `findJoinNode`
  un-refactored is acceptable (minor duplication, avoids touching the multi-source hot path — a noted
  future cleanup for the EAV follow-up).

**Documentation (one minor gap — fixed inline):**
- The handoff correctly flagged the **invisible-row boundary** (a malformed anchor row whose
  *mandatory* member is missing: dropped by the body's inner join → absent from the capture, but
  included by the base ops' anchor subquery → captured read-back misses, writing null / raising a
  base NOT NULL error on the optional column, diverging from the constant/anchor/self paths). This
  was correctly described in the handoff but **not reflected in the docs**. Fixed: added a
  *Current Limitations* entry to `docs/lens.md` documenting the boundary (confined to malformed base
  states, never silent corruption — writes null on a nullable column, fails atomically on NOT NULL).
  Disposition: **documented limitation**, not a runtime guard — the divergence is safe and confined
  to malformed input; a guard (keying the matched UPDATE off `__vmupd_keys` membership) is noted as a
  possible future tightening but not warranted now.

**Test coverage (one regression anchor added — minor):**
- The implementer's tests are thorough (cross-member, subquery, mixed self+anchor, both-sides,
  multi-cell each-own-`srcN`, captured-null on matched nullable, predicate gate still fires, EAV still
  rejects; plus a fuzzed `update-c-cross` property arm). Verified they exercise happy path, the
  absent-materialize transition, the null-image no-materialize, and the reject paths.
- The invisible-row boundary was untested. Added one focused regression test on the T fixture
  (`captured read-back over an INVISIBLE logical row fails safely and atomically`) locking in the
  **safe** contract: the captured read-back misses, the matched UPDATE proposes null, and (T_c.c being
  NOT NULL) the write raises a base constraint error caught **atomically** (the component is
  untouched) — never silent corruption. The nullable null-write branch is not reproducible on either
  existing fixture (it needs a fixture with both a mandatory non-anchor member *and* a nullable
  optional column — T has the former with a NOT NULL optional, M has nullable optionals but no
  mandatory non-anchor member); documented in the test comment.

**Validation:** `yarn build`, `yarn lint` (single-quoted globs), and the full quereus suite all green
— **5278 passing, 0 failing, 9 pending** (5277 prior + the new invisible-row test).

**No major findings; no new tickets filed.** The EAV arbitrary-value follow-up is already scoped as
the prereq-chained `view-write-decomposition-update-captured-eav`.
