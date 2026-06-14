description: Review the replicable-collation gate — a second create-time gate (same shape as the shipped replicable-function gate, same host capability `requiresReplicableDerivations`) that rejects a non-replicable custom collation governing a derivation body (comparison / ORDER BY / GROUP BY / DISTINCT / backing key) on a demanding backing host. Inert by default; exercised via the existing ReplBackingModule test host. Built-in collations auto-qualify; custom collations opt in with `replicable: true`.
files:
  - packages/quereus/src/core/database.ts                         # collations Map entry += replicable?; registerCollation options-object 3rd arg; registerDefaultCollations stamps builtins; new _isCollationReplicable
  - packages/quereus/src/core/database-materialized-views.ts      # findNonReplicableCollation (body scalar-walk + backing-key second source) + nonReplicableCollationDerivationError; wired into the existing requiresReplicableDerivations block after the function check
  - packages/quereus/src/vtab/backing-host.ts                     # requiresReplicableDerivations doc: now governs collations too (reused, no new flag)
  - packages/quereus/test/materialized-view-replicable.spec.ts    # new `replicable-collation gate` describe (9 cases) + collation reject helper; table `t` gained a `c text` column
  - docs/migration.md                                             # § Determinism requirements + Current gaps: collations now covered
  - docs/materialized-views.md                                    # § Maintenance strategy: the collation gate paragraph
----

# Review: replicable collation class

## What landed

A **second create-time gate of the same shape** as the shipped replicable-**function** gate, under the **same** host capability (`BackingHost.requiresReplicableDerivations`), **inert by default**. When the resolved backing host declares the capability, `buildMaintenancePlan` now rejects — after the function check, over the same analyzed plan — any **non-replicable custom collation** that governs derived bytes. No new host flag.

Registration surface (`database.ts`):
- the per-database collation registry entry gained an optional `replicable?: boolean`;
- `registerCollation`'s third parameter widened from `normalizer?` to `((s)=>string) | { normalizer?, replicable? }` — a **function-typed** third arg is the legacy normalizer path (all existing call sites unchanged, `replicable` defaults to `false`); an **object** reads `normalizer`/`replicable`; any other non-undefined third arg throws the legacy "normalizer must be a function" error (preserves the boundary-validation contract);
- `registerDefaultCollations` stamps `replicable: true` on `BINARY`/`NOCASE`/`RTRIM` (the single builtin seam, parallel to `registerBuiltinFunctions`);
- new `_isCollationReplicable(name)` → `collations.get(NAME)?.replicable === true` (unknown ⇒ false, defensive).

Gate (`database-materialized-views.ts`), two sources, **soundness-first** (any non-builtin non-replicable collation anywhere rejects):
1. **Body walk** — `findNonReplicableBodyCollation` recurses the plan via `getChildren()` (same recursion as `findNonReplicableFunction`) and reads each scalar node's `getType().collationName`. The collation name rides a scalar node's resolved type at every fold/order/key site (explicit `COLLATE` → `CollateNode` type; declared/default column collation → column-ref type; comparison effective collation, ORDER BY / GROUP BY / DISTINCT keys → the operand/key scalar types).
2. **Backing key** — `findNonReplicableKeyCollation` checks `mv.primaryKeyDefinition[].collation` and the secondary-UNIQUE per-column enforcement collations via the existing `uniqueEnforcementCollations(mv, uc)` helper (which resolves an **index-derived** override, not just the column collation). This catches a key that folds under a custom collation the SELECT body never names.

Built-in names (`BINARY`/`NOCASE`/`RTRIM`) short-circuit to OK regardless of `collationSource`; only a custom name is subjected to `_isCollationReplicable`. Dedicated `StatusCode.UNSUPPORTED` error `nonReplicableCollationDerivationError` — names the collation, steers to `replicable: true` (built-ins qualify automatically), does NOT steer to a plain view (the body is fine, it just folds under a host-required collation). Orthogonal to `pragma nondeterministic_schema` (not lifted by it).

## How to exercise / validate

- Focused spec: `test/materialized-view-replicable.spec.ts` → `replicable-collation gate` describe. 23 total in the file (14 pre-existing function cases + 9 new collation cases), all green.
- `db.registerCollation(name, cmp)` defaults non-replicable; `db.registerCollation(name, cmp, { replicable: true })` opts in.
- Body cases reject through the `repl` host (memory + `requiresReplicableDerivations` flipped on): `where c collate MYLOCALE = 'alpha'`, `order by c collate MYLOCALE` (no LIMIT — the Sort survives `optimizeForAnalysis`), `select id, c collate MYLOCALE as ck`, `group by c collate MYLOCALE`.
- Accept cases: same body once `MYLOCALE` is re-registered `replicable: true`; any `COLLATE NOCASE` body; a custom-collation body `using memory` (inert).
- **Second source** is reachable ONLY via: `create table … using repl` + `create unique index … (code collate MYLOCALE)` + `alter table … set maintained as <body that never names MYLOCALE>` → rejected (the body walk sees nothing; only the backing-key source catches it). A NOCASE index control attaches fine.

## Honest gaps / things for the reviewer to probe

1. **Store host create-time path is NOT exercised by `yarn test`** — same caveat the function gate carried. The gate is create-time and memory-exercised; `yarn test:store` was not run (the store host leaves `requiresReplicableDerivations` undefined, so the gate is inert there anyway). If a reviewer wants store coverage, it requires a store-backed demanding host, which no in-tree host provides.
2. **Why custom collations can ONLY enter a body via a `COLLATE` expression** (worth confirming the precision boundary): `validateCollationForType` rejects declaring a custom collation on a TEXT column (`supportedCollations` = BINARY/NOCASE/RTRIM), and the parser rejects inline `unique (col collate X)`. So a custom collation reaches the schema only through (a) a body `COLLATE` expression (always a body scalar → source 1) or (b) a `create unique index (col collate X)` (source 2). Consequence: source 1 and source 2 are **not** independently constructible for the *same* body the way the ticket's prose implies — a custom collation that lands in the backing key via the body always shows up on a body scalar too. The independent second-source test deliberately uses the index-via-`set maintained` path so the body walk genuinely sees nothing.
3. **Deliberate conservative over-reject** (by design, documented in the gate comment + `docs/materialized-views.md`): a bare passthrough projection of a custom-collation value (`select id, c collate MYLOCALE as ck`) rejects even though the bytes are copied verbatim. False positive = create-time inconvenience with a clear fix; false negative = silent peer divergence. A future precision pass (gate only true fold/order/key positions) is a known, scoped enhancement — NOT a regression.
4. **Test floor — positions covered vs. relied-upon-but-not-pinned.** Pinned: WHERE comparison, ORDER BY, projection-COLLATE, GROUP BY, second-source UNIQUE (custom + NOCASE control), accept-when-replicable, builtin accept, inert memory, pragma-orthogonality. NOT separately pinned (they ride the same `getChildren()` walk the function gate's nested-call test already exercises, so they're covered structurally but not by a collation-specific assertion): DISTINCT / set-op dedup collation, a collation only inside a subquery/CTE leg, an MV-over-MV body reading a producing backing's published collation, and the coarsened-key output collation. A reviewer who wants belt-and-suspenders could add one DISTINCT and one subquery case.
5. **`registerCollation` signature widening is backward-compatible** but is a public-API change. Verified: `util/plugin-helper.ts` and the `custom-collations` sample plugin pass a function/undefined third arg (legacy path); `boundary-validation.spec.ts` / `collation-normalizer.spec.ts` non-function-normalizer rejects still pass. Full monorepo `yarn test` (all workspaces) green.

## Validation run

- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`): clean.
- `yarn test` (quereus): **6307 passing, 9 pending**.
- Root `yarn workspaces foreach -A run test` (every workspace): **green, exit 0** (the `boom` / `[Sync] Error …` lines are deliberate error-injection test output).
- Focused spec re-run explicitly: 23 passing.
