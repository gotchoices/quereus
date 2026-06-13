description: Review the lens basis-FK gate — a derived, event-invalidated Set on SchemaManager (basis schema.table keys backing ≥1 logical-FK-referenced parent slot) that O(1) short-circuits the three basis-keyed lens FK paths. Verify soundness (never under-reports), invalidation exhaustiveness, and that all existing lens cascade/RESTRICT/divergent behavior is byte-for-byte preserved on a gate hit.
files:
  - packages/quereus/src/schema/manager.ts                    # lensFkGate cache + invalidateLensFkGate() + basisTableBacksLogicalParentFk(); listener + addSchema/getOrCreateSchema/removeSchema/clearAll/importTable invalidation
  - packages/quereus/src/schema/lens-fk-discovery.ts          # buildLensBasisFkGate(); basisFksOverriddenByDivergentLensFk gated at entry
  - packages/quereus/src/runtime/foreign-key-actions.ts       # executeLensForeignKeyActions + assertLensRestrictsForParentMutation gated at entry
  - packages/quereus/src/schema/lens-compiler.ts              # deployLogicalSchema invalidates the gate after clear-and-rebuild
  - packages/quereus/test/lens-enforcement.spec.ts            # describe('lens enforcement: basis-FK gate short-circuit') — 5 cases
  - docs/schema.md                                            # § Lens basis-FK gate (sibling to § Reverse foreign-key index)
----

# Review: Lens basis-FK gate (logical-FK analogue of the reverse-FK index)

## What landed

A derived, event-invalidated `Set<string>` cache on `SchemaManager` — `lensFkGate` — holding the
basis `schema.table` keys (lowercased) that back ≥1 logical parent slot referenced by ≥1 logical FK.
`basisTableBacksLogicalParentFk(schemaName, tableName)` lazily builds it (via `buildLensBasisFkGate`
in `lens-fk-discovery.ts`) and answers in O(1). The three basis-keyed lens FK paths now early-return
on a gate miss instead of running the per-write `for (schema) for (slot) { resolveSlotBasisSource… }`
reverse-map scan:

- `executeLensForeignKeyActions` (runtime cascade walker) — gated after the `foreign_keys` check.
- `assertLensRestrictsForParentMutation` (runtime RESTRICT pre-check) — gated after the `foreign_keys` check.
- `basisFksOverriddenByDivergentLensFk` (divergent-basis suppression set) — gated at entry, returns `new Set()`.

On a gate **hit**, each function's original scan body is **unchanged** — the gate only decides
*whether to scan*; what the scan computes is identical.

`buildLensBasisFkGate` runs exactly that reverse-map scan once: for each lens slot, resolve its single
basis spine (`resolveSlotBasisSource`; multi-source/decomposition → none → no key), and add the basis
key iff `findLogicalParentFkRefs(slot).length > 0`. `findLogicalParentFkRefs` is unchanged and untouched
(still reached only from the already-gated callers at runtime + plan-time `lens-enforcement.ts`).

## Soundness invariant (the load-bearing claim to verify)

The gate must **never under-report**: for every basis parent where the full scan would find ≥1
(parent-slot-backed-by-it × referencing logical FK), the gate holds its key. An under-report silently
drops logical enforcement (cascade not propagated / RESTRICT not enforced / divergent basis action not
suppressed) — the fatal direction. Built directly from the scan it replaces and reset on every event
that can change the scan's result, this holds. Over-reporting (a stray key ⇒ an on-hit scan that finds
nothing) is harmless. The gate is **action-agnostic** (any referencing logical FK ⇒ key present), so a
slot referenced only by a RESTRICT logical FK is a hit for the cascade walker too — which then no-ops
after its own action filter. That is a correct over-report, not a miss.

## Invalidation surface (verify exhaustiveness — this is where a regression would hide)

Two dependencies: (a) the lens-slot set + each slot's `enforced-fk` obligations, and (b) the basis-table
catalog (`resolveSlotBasisSource` resolves a bare name against it). Invalidation points:

- **Lens deploy/redeploy** — `lens-compiler.deployLogicalSchema` calls `schemaManager.invalidateLensFkGate()`
  right after the clear-and-rebuild slot loop (no `SchemaChangeEvent` exists for lens slots; confirmed via
  `find_references(addLensSlot|clearLensSlots|removeLensSlot)` that `deployLogicalSchema` + `removeSchema`
  + `clearAll` are the only slot-mutating sites — no `removeLensSlot` call sites exist in `src/`).
- **Basis-table catalog** — the existing constructor `changeNotifier` listener now also calls
  `invalidateLensFkGate()` on `table_added`/`table_modified`/`table_removed` (alongside the reverse-FK index).
- **Schema attach/detach/reset + silent import** — `addSchema`, `getOrCreateSchema`, `removeSchema`,
  `clearAll`, and the silent `importTable` rehydration path all null the gate alongside the reverse-FK index.

## Key tests (the floor — extend as the review sees fit)

`describe('lens enforcement: basis-FK gate short-circuit')` in `lens-enforcement.spec.ts`, reusing the
block-scoped `deployCascadeLens`:

- **gate miss** — `basisTableBacksLogicalParentFk('y','parent')` true; `('y','child')` and `('main','unrelated')`
  false; case-insensitive (`'Y','PARENT'` → true); `basisFksOverriddenByDivergentLensFk(y.child,…)` returns
  an empty set without scanning.
- **gate miss (no logical FK at all)** — a lens with no FK leaves every basis table a miss.
- **gate hit** — a basis-backed `on delete cascade` still cascade-deletes (behavior unchanged).
- **under-report regression** — force-build the gate *before* `apply schema x` deploys the logical FK
  (gate caches empty), then deploy and confirm the cascade fires. This directly exercises the
  `deployLogicalSchema` invalidation — it would assert `n: 2` (fail) if that `invalidateLensFkGate()` call
  were removed.
- **invalidation on redeploy** — re-declare X dropping the FK ⇒ gate flips `y.parent` to a miss.

Validation run: `yarn workspace @quereus/quereus run lint` clean (eslint + `tsc -p tsconfig.test.json`);
`lens-enforcement.spec.ts` 140 passing (incl. the 5 new); full `yarn workspace @quereus/quereus test`
**6137 passing, 9 pending, exit 0**. The pre-existing cascade/RESTRICT/divergent suites are the primary
regression guard and stayed green untouched.

## Honest gaps / where to point the adversarial pass

- **No dedicated test for the basis-table-event vector (table_added) or the silent `importTable` vector.**
  The under-report regression test pins the `deployLogicalSchema` path only. The constructor-listener and
  `importTable` invalidations are wired (and mirror the proven reverse-FK-index discipline) but not pinned
  by a test that builds the gate, then creates/imports a basis table late, and confirms enforcement still
  fires. Worth adding if the reviewer wants belt-and-suspenders on the late-basis-creation vector. The
  reverse-FK index has the analogous silent-import regression; consider mirroring it.
- **`clearAll` now also nulls `reverseFkIndex`** (it previously nulled neither, despite the ticket's
  assumption). This is a small bonus correctness fix outside the lens scope — a stale-after-`clearAll`
  reverse-FK index would over-report (harmless), but resetting is cleaner and symmetric. The full suite is
  green, so nothing relied on the old behavior, but flagging it as an out-of-scope touch to physical-index
  code for the reviewer's awareness.
- **No cross-schema-basis gate test.** The gate keys by the basis parent's own `schema.table` (lowercased),
  exactly what `resolveSlotBasisSource` returns, and the lowercasing mirrors `reverseFkIndex`; the existing
  divergent/cascade suites are single-schema (basis `y`, logical `x`). A cross-schema logical FK (basis
  parent in a third schema) isn't pinned by a new gate test — the mechanism should be schema-agnostic, but
  it's unverified at the gate level.
- **Doc-link form divergence (intentional):** `foreign-key-actions.ts` references the gate as a
  backticked `SchemaManager.basisTableBacksLogicalParentFk` rather than a `{@link …}` because
  `SchemaManager` is not imported there (type-only would be unused at runtime). `lens-fk-discovery.ts`
  uses `{@link …}` since it already imports the type. Confirm this is acceptable house style.
- **Pre-existing unused param** `parentTable` in `executeSingleFKAction` (foreign-key-actions.ts) surfaced
  as a TS hint during edits — it is untouched by this work, not flagged by eslint's `after-used` rule, and
  out of scope. Not addressed.
