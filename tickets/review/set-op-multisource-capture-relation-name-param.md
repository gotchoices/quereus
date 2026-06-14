description: Review the name-threading refactor that parameterizes the multi-source identity-capture relation name (was the hard-coded `MS_UPDATE_KEYS_CTE = '__vmupd_keys'`) so two captures can coexist by name in one lowered statement. Pure, behavior-preserving plumbing — default name unchanged; the load-bearing prerequisite for `set-op-write-multisource-leg-compose`.
prereq:
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts
difficulty: medium
----

## What landed

Threaded an explicit `captureRelationName` (defaulting to `MS_UPDATE_KEYS_CTE`) through every
capture-producing and capture-reading function in `multi-source.ts`, and made the capture
object **carry its own relation name** so downstream injection / RETURNING / base-op predicates
read the name from one source of truth instead of re-deriving the literal. Every call site that
omits the name lowers to a byte-identical plan; no nested capture is built yet (that is the
follow-up `set-op-write-multisource-leg-compose`).

### `multi-source.ts`

- **`MultiSourceKeyCapture`** — added optional `relationName?: string`. Optional (not required)
  so the sibling captures that reuse this type — `set-op.ts` `buildSetOpCapture`,
  `decomposition.ts` `buildDecompositionKeyCapture`, `single-source.ts` `buildCteSelfCapture` —
  compile unchanged and fall back to the default.
- **`buildMultiSourceKeyCapture(…, captureRelationName = MS_UPDATE_KEYS_CTE)`** — stamps
  `relationName: captureRelationName` onto the returned capture.
- **`makeMultiSourceKeyRef(scope, capture, captureRelationName = capture.relationName ??
  MS_UPDATE_KEYS_CTE)`** — uses the name for BOTH the `InternalRecursiveCTERefNode`'s display
  CTE name and every attribute's `sourceRelation` (no half-updated node that keeps the constant
  as `sourceRelation`). **Design choice to scrutinize:** the ticket spec wrote the default as
  `= MS_UPDATE_KEYS_CTE`; I defaulted it to `capture.relationName ?? MS_UPDATE_KEYS_CTE`
  instead, so a ref minted from a fresh-named capture is self-consistent even if a caller omits
  the arg. This is strictly safer (it cannot produce a name/ref mismatch) and the two reduce to
  the identical value on every current call site, but it is a deliberate deviation from the
  literal signature — confirm you agree it is the right call.
- **`buildCapturedKeyPredicate(…, captureRelationName = MS_UPDATE_KEYS_CTE)`** — the per-side
  `exists (select 1 from <name> k …)` identifying predicate.
- **`capturedValueSubquery(…, captureRelationName = MS_UPDATE_KEYS_CTE)`** — the cross-source /
  matched-non-preserved read-back `(select <src> from <name> k …)`. New param is **last**, after
  the existing optional `dedupAggregate` / `correlationAlias`, so `decomposition.ts`'s five
  callers keep the default.
- **`buildNullExtendedInsert(…, captureRelationName = MS_UPDATE_KEYS_CTE)`** — the
  outer-join null-extended materialization `insert … select … from <name> k …`.
- **`buildMultiSourceUpdateReturning`** — signature unchanged; now derives
  `capture.relationName ?? MS_UPDATE_KEYS_CTE` once and uses it for the `from`, the
  `cteNodes.set(…)`, and the `makeMultiSourceKeyRef` call (so a future fresh-named capture's
  RETURNING re-query does not bake in the constant). `buildMultiSourceDeleteReturning` needs no
  change (it never reads the capture relation — it filters the raw join by the id predicate).
- **`decomposeUpdate(…, captureRelationName = MS_UPDATE_KEYS_CTE)`** and
  **`decomposeDelete(…, captureRelationName = MS_UPDATE_KEYS_CTE)`** — thread the bare string
  into the predicate / read-back / null-extended-insert calls they emit. (Threaded as a string,
  not via the capture object, because in the build flow the capture is materialized *after*
  decompose runs — the base-op predicates and the capture share the name as a common input, not
  a shared object.)

### `view-mutation-builder.ts`

- **`withKeyCapture`** — injects under `capture.relationName ?? MS_UPDATE_KEYS_CTE` (was the
  hard-coded constant) and pins the minted ref's own name to that same value, so map key and ref
  agree. `withCteCapture` (keyed under the CTE name, capture has no `relationName`) is untouched
  and stays byte-identical. `buildIdentityCapture` passes no name ⇒ default ⇒ standalone
  multi-source path unchanged.

`MS_UPDATE_KEYS_CTE` stays exported and is the default everywhere.

## Correctness bar & validation

The whole bar is **default-name byte-identity**: every path that omits a name must lower to the
same plan as before.

- `yarn test` (full quereus suite, memory vtab) → **6309 passing, 9 pending, 0 failing**.
  Covers the multi-source suite (`93.4-view-mutation.sqllogic` — inner/outer/self/composite-PK
  joins, cross-source `set`, both-sides, RETURNING, lenient delete, existence flags), the
  decomposition suites, and the set-op write suites (`93.6-…`).
- `yarn workspace @quereus/quereus tsc -p tsconfig.json --noEmit` → clean.
- `yarn workspace @quereus/quereus lint` (eslint + test-file typecheck) → clean.

## Reviewer focus / known gaps

- **The fresh-name path is UNPROVEN.** No caller passes a non-default name yet, so
  `__vmupd_keys$1`-style coexistence has **zero test coverage**. The parameterization is
  exercised only at its default. This is expected (the ticket is plumbing-only and explicitly
  defers the nested capture to `set-op-write-multisource-leg-compose`), but it means the actual
  collision-avoidance this enables is validated only by inspection until the compose ticket
  lands. Worth a careful read of the four edits below to confirm no path silently re-derives the
  constant where it should read the threaded name.
- **Internal consistency within one decomposition.** Verify that a capture's injected ref name
  (`withKeyCapture`), its `keyRef.sourceRelation` / display name (`makeMultiSourceKeyRef`), and
  every base-op predicate's `from <name>` (`buildCapturedKeyPredicate`, `capturedValueSubquery`,
  `buildNullExtendedInsert`, the `buildMultiSourceUpdateReturning` EXISTS) all resolve to the
  same string for a given decomposition — a mismatch would silently resolve a reader to the
  wrong relation. They do today because (a) the build flow threads one `captureRelationName` into
  both decompose and `buildMultiSourceKeyCapture`, and (b) the RETURNING / injection paths read
  `capture.relationName`.
- **`makeMultiSourceKeyRef` default deviation** (see above) — the one place I chose a different
  default than the ticket's literal text.
- **`sourceRelation` semantics.** I changed every key attribute's `sourceRelation` from the
  constant to `captureRelationName`. For the default path this is the same string. For the
  CTE-self path (`withCteCapture`, capture has no `relationName`) it remains
  `MS_UPDATE_KEYS_CTE` even though the ref is injected under the CTE name — unchanged from
  before. Confirm nothing resolves columns *by* `sourceRelation` in a way the default-path no-op
  could regress (tests say no; the resolution is by the `k` alias, not `sourceRelation`).

## Suggested spot-checks

- `update`/`delete` through an inner-join view, a left-join view (preserved + non-preserved
  column writes, existence flips), a self-join view, and a composite-PK side — confirm the
  emitted base-op predicates still read `from __vmupd_keys k`.
- A both-sides UPDATE … RETURNING and a multi-side DELETE … RETURNING — the RETURNING re-query
  now reads `capture.relationName`; confirm the post/pre image is unchanged.
- A cross-source `set a.x = b.y` (rides `capturedValueSubquery`) and an outer-join
  non-preserved-column update (rides `buildNullExtendedInsert`) — both default-named.
