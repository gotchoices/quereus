description: Refactor `multi-source.ts` to parameterize the identity-capture relation name (today the hard-coded `MS_UPDATE_KEYS_CTE = '__vmupd_keys'`) so two captures can coexist by name in one lowered statement. Pure, behavior-preserving plumbing change (default name unchanged) — the load-bearing prerequisite for `set-op-write-multisource-leg-compose`, where an inner per-branch join capture must NOT collide with the outer set-op capture. No test should change behavior; existing multi-source coverage must pass byte-identical.
prereq: set-op-write-multisource-leg-reject
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts
difficulty: medium
----

## Why

`MS_UPDATE_KEYS_CTE` (`'__vmupd_keys'`) is a **single hard-coded relation name** that the
multi-source UPDATE/DELETE path uses in three coupled roles:

1. The CTE-ref node the readers bind to — `makeMultiSourceKeyRef` mints an
   `InternalRecursiveCTERefNode` with `sourceRelation: MS_UPDATE_KEYS_CTE` and the same CTE
   name, injected into `cteNodes` under that name (`withKeyCapture`,
   `buildMultiSourceKeyCapture`).
2. The `from __vmupd_keys k` table reference in every base-op identifying predicate
   (`buildCapturedKeyPredicate`, the both-sides/cross-source/RETURNING builders, the
   non-preserved IS-NULL filters).
3. The runtime `tableContexts` keying — via the `descriptor` (already a fresh `{}` per
   capture), independent of the *name*.

Today there is never more than one capture live per lowered statement, so the single name is
fine. `set-op-write-multisource-leg-compose` breaks that assumption: a set-op view whose branch
is a JOIN needs an **inner** per-branch base-PK capture lowered *inside* a statement that
already carries the **outer** set-op capture under `__vmupd_keys`. With both hard-coded to the
same name, the inner `k.k<side>_<j>` reference binds to the outer-injected relation (whose
columns are the view-output columns) and throws `k.k0_0 isn't a column`.

The descriptor is already per-capture-fresh; only the **name** is shared. Parameterize the
name so a caller can mint a fresh one (`__vmupd_keys$1`, …) per nested capture, and the inner
capture's readers and its injected ref agree on it while shadowing nothing.

This ticket does the **name-threading refactor only** — no nested capture is built yet, and the
default name keeps every existing path byte-identical.

## Design

Approach 1 from the parent backlog ticket (parameterize the relation name), chosen over
Approach 2 (scope by descriptor identity). Rationale: base-op predicates reference the capture
as a **literal AST table name** (`from __vmupd_keys k`) resolved by name through `cteNodes`;
there is no descriptor at the AST-resolution layer to key on. Parameterizing the name is the
localized change that keeps the AST-lowering model intact; the descriptor stays the runtime
key. Both end up distinct per capture (name for AST resolution, descriptor for `tableContexts`).

Thread an explicit `captureRelationName: string` parameter, **defaulting to**
`MS_UPDATE_KEYS_CTE`, through the capture-producing and capture-reading functions in
`multi-source.ts`:

- `makeMultiSourceKeyRef(scope, capture, captureRelationName = MS_UPDATE_KEYS_CTE)` — use it for
  BOTH the `InternalRecursiveCTERefNode`'s CTE name and `sourceRelation`.
- `buildMultiSourceKeyCapture(ctx, view, where, analysis, sides, sourceValues?, captureRelationName = MS_UPDATE_KEYS_CTE)`
  — the `cteNodes.set(<name>, keyRef)` and the internal `from <name> k` reads use the param.
  The returned `MultiSourceKeyCapture` should also **carry its own relation name** (add a
  `relationName: string` field) so downstream `withKeyCapture`-style injection and the base-op
  builders read it from the capture object rather than re-deriving the literal.
- `buildCapturedKeyPredicate(view, side, sideIndex, captureRelationName = MS_UPDATE_KEYS_CTE)` and
  every sibling that emits `from __vmupd_keys k` (the both-sides predicate ~L2120-2143, the
  cross-source read-back ~L2651-2663, the non-preserved IS-NULL filter ~L1788-1795, the update
  RETURNING re-query, the delete RETURNING projection). Thread the name from the `analysis` /
  capture so a single decomposition is internally consistent.
- `decomposeUpdate` / `decomposeDelete` — thread the name so the base-op predicates they emit
  reference the same relation the capture injects under. The cleanest carrier is the capture
  object (the predicates are built from the same analysis the capture is built from); decide
  whether to thread a bare string or read `capture.relationName`, and keep it DRY.

Then in `view-mutation-builder.ts`:

- `withKeyCapture(ctx, capture)` — inject under `capture.relationName` (falling back to
  `MS_UPDATE_KEYS_CTE` when absent), not the hard-coded constant, so a capture built with a
  fresh name injects under that name. `withCteCapture` (the CTE-self-read analog, keyed under
  the *CTE name*) is unaffected and stays as-is.
- `buildIdentityCapture` — pass no name (defaults to `MS_UPDATE_KEYS_CTE`), so the standalone
  multi-source path is byte-identical.

Keep `MS_UPDATE_KEYS_CTE` exported and used as the default everywhere — the standalone
multi-source UPDATE/DELETE/INSERT and decomposition paths must not change.

## Edge cases & interactions

- **Default-name byte-identity.** Every call site that does NOT pass a name must lower to the
  exact same plan as today. This is the whole correctness bar of this ticket — the multi-source
  suite (`93.4-view-mutation.sqllogic`, the inner/outer-join, self-join, composite-PK,
  cross-source-`set`, both-sides, RETURNING, lenient-delete cases) must pass unchanged.
- **Internal consistency within one decomposition.** A capture's injected ref name, its
  `keyRef.sourceRelation`, and every base-op predicate's `from <name>` must all agree. Threading
  the name from the single capture object (rather than re-passing a literal at each call) is the
  safest way to guarantee this — a mismatch silently resolves the reader to the wrong relation.
- **Decomposition path (`decomposition.ts`).** `buildDecompositionKeyCapture` and the
  decomposition update reader also reference `MS_UPDATE_KEYS_CTE` indirectly (they reuse
  `makeMultiSourceKeyRef`). They must keep the default name; confirm they compile and run
  unchanged (decomposition tests in `93.4` / `53-*`).
- **RETURNING re-query.** `buildMultiSourceUpdateReturning` / `buildMultiSourceDeleteReturning`
  read the capture by name; they must read the capture's own `relationName`, not the constant,
  so a future fresh-named capture's RETURNING (not exercised yet, but don't bake in the bug).
- **`InternalRecursiveCTERefNode` name uniqueness.** Two refs with different names in one
  `cteNodes` map must not clash; confirm the node uses the passed name for both its display CTE
  name and `sourceRelation` (a half-updated node that keeps the constant as `sourceRelation`
  would still collide).
- **No new diagnostics.** This ticket adds no reject paths; the join-leg reject gate stays in
  place (removed only by the compose ticket).

## TODO

- Add a `relationName` field to `MultiSourceKeyCapture`; set it in `buildMultiSourceKeyCapture`.
- Thread `captureRelationName = MS_UPDATE_KEYS_CTE` through `makeMultiSourceKeyRef`,
  `buildMultiSourceKeyCapture`, `buildCapturedKeyPredicate`, and every other `from __vmupd_keys`
  emitter / IS-NULL filter / cross-source read-back / RETURNING builder in `multi-source.ts`.
- Thread the name into `decomposeUpdate` / `decomposeDelete` (prefer reading
  `capture.relationName` over a second string param — keep DRY).
- Update `withKeyCapture` in `view-mutation-builder.ts` to inject under `capture.relationName`.
- Leave `buildIdentityCapture` / decomposition call sites on the default name.
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` — the
  multi-source + decomposition suites must pass with no diff in behavior.
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
