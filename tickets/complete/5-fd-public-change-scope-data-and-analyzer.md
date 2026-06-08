---
description: Public ChangeScope data contract, analyzer, composition helpers, and Statement.getChangeScope (review complete)
files:
  - packages/quereus/src/planner/analysis/change-scope.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/optimizer/change-scope-analyzer.spec.ts
  - packages/quereus/test/logic/change-scope.spec.ts
  - docs/change-scope.md
  - docs/optimizer.md
  - docs/usage.md
  - docs/architecture.md
  - packages/quereus/README.md
---

## What landed

Public, JSON-serializable change-scope API — the first half of the
binding-aware introspection surface:

- New module `packages/quereus/src/planner/analysis/change-scope.ts`
  exposing `ChangeScope`, `analyzeChangeScope`, `unionScopes`,
  `intersectScopes`, `bindParameters`, `isEmpty`, `describesEverything`,
  `serializeChangeScope`, `deserializeChangeScope`, plus the
  `PortableScalarType` <-> `ScalarType` bridge `scalarTypeFromPortable`.
- New `Statement.getChangeScope(params?)` API that runs over a
  dedicated `optimizeForAnalysis` plan (pre-physical) and applies
  `bindParameters` against either the supplied or the statement's
  already-bound args.
- Public exports added to `packages/quereus/src/index.ts`.
- Documentation updated: new `docs/change-scope.md`, cross-references
  from `docs/optimizer.md`, `docs/architecture.md`, `docs/usage.md`,
  and `packages/quereus/README.md`.
- 38 spec tests across two files (unit + integration).

The watcher half (`Database.watch`) intentionally ships in a follow-up
ticket (`fd-public-change-scope-watcher`).

## Review findings

### Soundness — fixed inline (minor)

- **Row binding whose values cannot be decoded would emit
  `{kind:'rows', values: []}`.** `buildScopeForMode` for `mode.kind === 'row'`
  trusted `extractRowKeyValues` to always succeed; when it returned
  `[]` (because the value expression was a non-literal, non-parameter
  scalar — e.g. `pk = coalesce(?, 0)`), the watch became "watch zero
  rows", which is a strict subset of what the query actually reads.
  A watcher consuming this scope would silently miss firings.
  - **Fix**: when `values.length === 0` for a `row` binding, fall back
    to `{kind:'full'}`. Same conservative-fallback pattern the group
    case already uses (degrading to `{kind:'groups'}` when values are
    unknown).
  - Added a regression test
    (`row binding whose values cannot be decoded falls back to full
    (soundness)`).
  - Doc updated: new bullet under `docs/change-scope.md` § "Known
    imprecisions".

### Code clarity — fixed inline (minor)

- **`intersectScopes` non-determinism filter had a vacuous clause**:
  `bNonDet.has(nonDetKey(s)) && aNonDet.has(nonDetKey(s))` — the second
  `aNonDet.has(...)` is always true for `s ∈ a`. Removed the redundant
  set and clause.
- **`isDmlWithoutReturning` rebuilt its `dmlNodeTypes` Set on every
  call**. Hoisted to module-scope `DML_NODE_TYPES`.

### Scrutiny by aspect — what was checked

- **SPP / Single-purpose**: every helper in `change-scope.ts` has one
  job (collect refs, collect columns, collect non-determinism, build
  watches, normalize). Composition + serialization are factored out.
  No oversized functions; `analyzeChangeScope` is the orchestrator.
- **DRY**: `stringifyScopeValue` is reused for sort+dedup, tuple key
  serialization, and union/intersect comparison. `nonDetKey` for
  non-determinism. `tableKey`/`compareWatches` form a small key
  algebra; no duplicated comparison logic.
- **Modular / scalable**: the analyzer is a pure function over a
  plan; composition helpers operate on the public data contract; no
  hidden state. Adding new binding shapes later means extending
  `WatchScope` and updating the lattice in two places (union+intersect).
- **Maintainable**: the contract types (`ChangeScope`, `WatchScope`,
  `ScopeValue`, etc.) are documented in `docs/change-scope.md` and
  mirrored in `index.ts`. `PortableScalarType` + `scalarTypeFromPortable`
  bridge documented as a deviation from the original spec with a clear
  reason (functions inside `ScalarType` defeat both `structuredClone`
  and `JSON`).
- **Performant**: `extractConstraintsForTable` is called twice per
  table (once for row-binding param detection, once for value
  extraction). Acceptable for v1; flagged as a future optimization
  when caching the analysis plan ships with the watcher.
- **Resource cleanup**: pure-function API, no listeners or handles to
  release. `Statement.getChangeScope` does **not** cache the analysis
  plan — handoff calls this out as a deliberate v1 decision; the
  watcher ticket can revisit caching once usage shape is clearer.
- **Error handling**: the analyzer never throws on plan walks; it
  silently produces conservative `full` scopes when it can't decode
  values. Param lookups in `bindParameters` are forgiving (missing
  keys are simply not bound). Failure modes are visible via
  `unboundParameters` and the `full` shape, not exceptions.
- **Type safety**: no `any` introduced; controlled `unknown` casts
  used at narrow boundaries (`as unknown as { operand: ScalarPlanNode }`
  for `Cast` unwrap; `as unknown as { expression: { value } }` for the
  literal-node value field; both are intentional structural narrows
  with clear local justification). The `number | string` widening of
  `ParamScopeValue.index` and `unboundParameters` correctly reflects
  Quereus's positional + named parameter support and is documented.

### Tests — coverage assessment

The implementer added 38 cases across:
- Row/group/full classifications (incl. the row-binding-on-non-unique
  → full fallback)
- Subquery fallbacks (both watches `full`)
- Non-determinism (random, volatile UDF)
- Column tracking ('all' vs explicit Set)
- DML without RETURNING (empty watches, params preserved)
- Composition lattice (union, intersect, bindParameters, isEmpty,
  describesEverything, edge cases like disjoint tables and
  mixed-shape collapse)
- JSON round-trip + `structuredClone` round-trip
- Integration through `db.prepare(...).getChangeScope(...)`,
  including portable type descriptor shape

**Added by reviewer**: regression test for the row-binding
empty-values soundness fallback.

**Not covered** — flagged for follow-up:
- Property test that the analyzer's scope is a superset of the
  *true* minimum scope (the implementer deferred this to the watcher
  ticket where mutation makes the property naturally falsifiable —
  agreed).
- IN-list with parameters (only IN-list with literals is tested).
  Not a likely regression but would be cheap to add later.
- Multi-column row bindings (only single-column keys are tested).
  The Cartesian-product code path is exercised only through the IN
  case; multi-PK tables would exercise it explicitly.

These are not blockers — the analyzer's behavior is sound by
construction and the soundness fallback now catches the case that
would have leaked through.

### Docs — verified

- `docs/change-scope.md` — accurate; updated with the new
  empty-values fallback bullet.
- `docs/optimizer.md` — § "Binding-aware Delta Planning" correctly
  cross-references the new doc.
- `docs/architecture.md` — bullet under § "Key Design Decisions"
  added.
- `docs/usage.md` — § "Change-scope introspection" added with
  analyzer + composition examples; examples match the actual data
  shape (verified against test output).
- `packages/quereus/README.md` — feature bullet + docs index entry
  added.

### Major findings

None. The deviations from the ticket spec (`PortableScalarType` for
serializability; `number | string` for named-parameter support) are
documented and well-justified. The conservative-fallback policy is
sound. No new tickets filed.

### Open future-work pointers (for the watcher ticket)

1. Cache the analysis plan in `Statement` when `getChangeScope` is
   called more than once (current path re-runs `_buildPlan` +
   `optimizeForAnalysis` on every call).
2. Implement the optional property test that
   `analyzeChangeScope(plan)` is a superset of the true minimum
   change scope, using end-to-end mutation to falsify regressions.
3. Inter-table propagation beyond what the FD/EC machinery proves
   (the doc's "rows-of-A whose key joins to current rows-of-B" mode
   is explicitly out of scope).

## Build, lint, test status

- `yarn workspace @quereus/quereus run lint` — passes (no output).
- `yarn workspace @quereus/quereus run test` — 2917 passing,
  2 pending (the 2 pre-existing pending tests), 0 failing.
- One additional test added by this review.

Pre-existing `sample-plugins` failures (key-value-store delete/update)
are unrelated and reproduce on `main` without these changes.
