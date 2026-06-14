description: Parameterized the multi-source identity-capture relation name (was the hard-coded `MS_UPDATE_KEYS_CTE = '__vmupd_keys'`) so two captures can coexist by name in one lowered statement. Pure, behavior-preserving plumbing — default name unchanged. The load-bearing prerequisite for `set-op-write-multisource-leg-compose`.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts
----

## Summary

Threaded an explicit `captureRelationName` (defaulting to `MS_UPDATE_KEYS_CTE`) through every
capture-producing and capture-reading function in `multi-source.ts`, and made
`MultiSourceKeyCapture` carry its own optional `relationName` so downstream injection /
RETURNING / base-op predicates read the name from one source of truth. Every call site that
omits the name lowers to a byte-identical plan; no nested capture is built yet (deferred to
`set-op-write-multisource-leg-compose`, now in `implement/`).

Functions parameterized (all default `= MS_UPDATE_KEYS_CTE`, new arg last so existing optional
args are undisturbed): `decomposeUpdate`, `decomposeDelete`, `buildNullExtendedInsert`,
`buildCapturedKeyPredicate`, `capturedValueSubquery`, `buildMultiSourceKeyCapture`.
`makeMultiSourceKeyRef` stamps the name onto BOTH the node's display name and every attribute's
`sourceRelation`. `buildMultiSourceUpdateReturning` and `withKeyCapture` read
`capture.relationName ?? MS_UPDATE_KEYS_CTE`. `MS_UPDATE_KEYS_CTE` stays exported as the default.

## Review findings

### Validation (all green at HEAD with the change)
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`) → exit 0.
- `yarn workspace @quereus/quereus tsc -p tsconfig.json --noEmit` (main source) → exit 0.
- `yarn workspace @quereus/quereus test` → **6309 passing, 9 pending, 0 failing** (matches the
  handoff). Covers the multi-source view-mutation suite, the decomposition suites, and the set-op
  write suites — i.e. every default-named path the parameterization touches.

### Correctness / consistency — checked, clean
- **Every call site of every modified function** verified. The default-name byte-identity bar
  holds: `decomposition.ts`'s five `capturedValueSubquery` callers use the 3-arg form (new param
  is last ⇒ default); the build flow threads ONE name into both `decomposeUpdate/Delete` and
  `buildMultiSourceKeyCapture` (both default to `MS_UPDATE_KEYS_CTE` today); `withKeyCapture`
  injects under `capture.relationName ?? MS_UPDATE_KEYS_CTE`; the RETURNING EXISTS re-query reads
  `capture.relationName`. All three resolve to `__vmupd_keys` for a given decomposition — no path
  silently re-derives the constant where it should read the threaded name.
- **Sibling captures reuse `MultiSourceKeyCapture` unchanged.** `relationName` is *optional*, so
  `set-op.ts` `buildSetOpCapture`, `decomposition.ts` `buildDecompositionKeyCapture`, and
  `single-source.ts` `buildCteSelfCapture` compile untouched and fall back to the default. The
  set-op base-op predicates (`buildMemberExists`) still reference `MS_UPDATE_KEYS_CTE` directly,
  and its capture sets no `relationName`, so `withKeyCapture` injects under the same default —
  consistent, byte-identical.
- **`makeMultiSourceKeyRef` default deviation** (the implementer's flagged choice: defaulting the
  arg to `capture.relationName ?? MS_UPDATE_KEYS_CTE` rather than the ticket's literal
  `MS_UPDATE_KEYS_CTE`). **Confirmed correct.** All three callers (`withKeyCapture`,
  `withCteCapture`, `buildMultiSourceUpdateReturning`) reduce to the identical value; the
  deviation is strictly safer — it makes a ref minted from a fresh-named capture self-consistent
  and cannot produce a name/`sourceRelation` mismatch. Agreed with the call; no change.
- **`withCteCapture` byte-identical.** The CTE-self capture has no `relationName`, so the
  no-3rd-arg `makeMultiSourceKeyRef` call defaults to `MS_UPDATE_KEYS_CTE` for the node name +
  `sourceRelation` (as before) while still injecting under the lowercased CTE name. Unchanged.
- **`sourceRelation` semantics.** Changed every key attribute's `sourceRelation` from the constant
  to the threaded `captureRelationName`; identical on the default path. Column resolution is by the
  `k` alias and the descriptor identity, not by `sourceRelation`, so the default-path no-op cannot
  regress (tests confirm).

### Type safety / DRY / modularity
- `relationName?: string` is the right modeling — optional keeps siblings clean; the name reads
  from one place (`capture.relationName`) downstream. No `any`, no duplication of the literal.

### Docs — checked, accurate
- `docs/view-updateability.md` describes `__vmupd_keys` as the shared capture relation and (line
  ~451) documents the very collision this parameterization is the prerequisite to fix
  (`set-op-write-multisource-leg-compose`). Because this ticket is default-named only — the
  collision still exists in behavior until the compose ticket introduces a fresh name — the docs
  remain correct as-is. The fresh-name story belongs to the compose ticket and is documented in it.

### Test coverage gap — acknowledged, correctly deferred (no new ticket)
- The fresh-name path (e.g. `__vmupd_keys$1` coexistence) has **zero** test coverage: no caller
  passes a non-default name yet. This is the expected shape of plumbing-only work and is NOT a
  finding to fix here — a meaningful fresh-name test requires the two-capture scenario the compose
  ticket builds. Confirmed `tickets/implement/set-op-write-multisource-leg-compose.md` owns that
  coverage and already encodes the load-bearing contract (thread the SAME name into
  `decomposeUpdate/Delete` AND `buildMultiSourceKeyCapture`, inject each capture under its own
  `relationName`). No coverage ticket filed.

### Pre-existing observation (out of scope, not introduced here)
- The CTE-self path's minted ref carries node name / `sourceRelation` = `MS_UPDATE_KEYS_CTE` while
  it is injected into `cteNodes` under the (different) CTE name. This mismatch predates this ticket
  (resolution is by map key + descriptor, so it is tolerated) and is untouched by the change. Noted
  for awareness; no action.

### Disposition
- **Minor findings:** none requiring an inline fix — the diff is clean, mechanical, default-preserving plumbing.
- **Major findings:** none — no new tickets filed.
