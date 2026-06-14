description: A second create-time gate (same shape as the shipped replicable-function gate, same host capability `requiresReplicableDerivations`) that rejects a non-replicable custom collation governing a derivation body (comparison / ORDER BY / GROUP BY / DISTINCT / backing key) on a demanding backing host. Inert by default; exercised via the ReplBackingModule test host. Built-in collations auto-qualify; custom collations opt in with `replicable: true`.
files:
  - packages/quereus/src/core/database.ts                         # collations Map entry += replicable?; registerCollation options-object 3rd arg; registerDefaultCollations stamps builtins; _isCollationReplicable
  - packages/quereus/src/core/database-materialized-views.ts      # findNonReplicableCollation (body scalar-walk + backing-key second source) + nonReplicableCollationDerivationError; wired into the requiresReplicableDerivations block after the function check
  - packages/quereus/src/vtab/backing-host.ts                     # requiresReplicableDerivations doc: now governs collations too (reused, no new flag)
  - packages/quereus/test/materialized-view-replicable.spec.ts    # `replicable-collation gate` describe (11 cases) + collation reject helper
  - docs/migration.md                                             # § Determinism requirements + Current gaps: collations now covered
  - docs/materialized-views.md                                    # § Maintenance strategy: the collation gate paragraph
----

# Replicable collation class — COMPLETE

## What shipped

A **second create-time gate of the same shape** as the replicable-**function** gate, under the **same**
host capability (`BackingHost.requiresReplicableDerivations`), **inert by default**. When the resolved
backing host declares the capability, `buildMaintenancePlan` rejects — after the function check, over the
same analyzed plan — any **non-replicable custom collation** that governs derived bytes. No new host flag.

- `database.ts`: per-database collation registry entry gained optional `replicable?`; `registerCollation`'s
  3rd param widened to `((s)=>string) | { normalizer?, replicable? }` (legacy function path unchanged);
  `registerDefaultCollations` stamps `replicable: true` on `BINARY`/`NOCASE`/`RTRIM`; new
  `_isCollationReplicable(name)`.
- `database-materialized-views.ts`: `findNonReplicableCollation` — **source 1** body walk reading each
  scalar node's `getType().collationName`, **source 2** backing key (PK collations + secondary-UNIQUE
  per-column enforcement collations via `uniqueEnforcementCollations`). Dedicated `StatusCode.UNSUPPORTED`
  `nonReplicableCollationDerivationError`. Orthogonal to `pragma nondeterministic_schema`.
- `backing-host.ts`: capability doc widened to cover collations (reused flag, no new surface).
- Docs (`migration.md`, `materialized-views.md`) updated to reflect collations now covered.

## Review findings

**Reviewed:** the full implement diff (commit `7a704577`) read first with fresh eyes, then the handoff.
Scrutinized for soundness, DRY, type-safety, error handling, backward compatibility, doc accuracy, and
test coverage (happy / edge / second-source / orthogonality / inert-host / accept paths).

### Correctness / soundness — PASS
- **Body-walk reach (the load-bearing soundness claim).** The handoff flagged DISTINCT-key and
  subquery-leg collations as "covered structurally but not pinned" (gap #4). I verified both are genuinely
  caught by adding two cases (`m_dist`, `m_subq`) — both reject. The `getChildren()` recursion truly
  reaches relational subtrees, not just top-level projection/WHERE. **Minor — fixed inline** (the two
  cases are now committed as regression pins).
- **Precision boundary verified.** The "custom collations can only enter via a body `COLLATE` expr (source
  1) or `create unique index (col collate X)` (source 2)" argument rests on `TEXT.supportedCollations =
  ['BINARY','NOCASE','RTRIM']` (confirmed in `types/builtin-types.ts:113`) — so a custom collation cannot
  be declared on a built-in TEXT column. Both entry points are covered; the second-source test exercises
  the index-via-`set maintained` path where the body walk genuinely sees nothing. No hole.
- **`registerCollation` widening is backward-compatible.** All in-tree call sites pass a function/undefined
  3rd arg (legacy path): `util/plugin-helper.ts` (`collation.normalizer`), the deprecated global
  `registerCollation`. The non-function-normalizer reject is preserved (`collation-normalizer.spec.ts`,
  `boundary-validation.spec.ts` still green). The retained `normalizer !== undefined && typeof !==
  'function'` check is still reachable for the object branch (`{ normalizer: <non-fn> }`) — not dead.

### Minor observations — NOT changed (judged not worth churn)
- `_isCollationReplicable(name)` does `name.toUpperCase()` while its only caller `collationIsOffending`
  already passes a `normalizeCollationName`-normalized value (double-normalization). Harmless and makes the
  `@internal` method robust for any future caller; left as-is.
- **Deep hypothetical, out of scope, low risk:** a user could register a custom *logical type* whose
  `supportedCollations` admits a custom collation, then declare a column with it; a no-`COLLATE` body
  reference would then rely on the column-ref scalar's type carrying `collationName` (source 1) to be
  caught. This is well beyond the ticket's scope (built-in TEXT cannot do it) and source 1 almost
  certainly catches it via type propagation; not filed.

### Honest-gap items from the handoff — accepted as-is
- Store host create-time path not exercised by `yarn test` (gap #1): store leaves the flag undefined ⇒ gate
  inert there ⇒ no in-tree demanding store host exists. Same caveat the function gate carried; acceptable.
- Conservative over-reject of a bare custom-collation passthrough (gap #3): by design, documented in the
  gate comment + `docs/materialized-views.md`. False-positive (create-time inconvenience, clear fix) vs.
  false-negative (silent peer divergence) — the right bias. A precision pass is a known scoped enhancement,
  not a regression. **No ticket filed.**

### No major findings — no new tickets filed.

## Validation run
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`): **clean**.
- Full quereus suite (`node test-runner.mjs`): **6309 passing, 9 pending, exit 0** (6307 prior + 2 added).
- Focused `materialized-view-replicable.spec.ts`: **25 passing** (14 function + 11 collation, incl. the 2
  added DISTINCT / subquery pins).
