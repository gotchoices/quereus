---
description: COMPLETE — `delegatesNotNullBackfill?: boolean` capability on `ModuleCapabilities`. A module that advertises it opts out of the engine-generic ADD-COLUMN NOT-NULL-without-usable-DEFAULT rejection on non-empty tables (`runAddColumn` skips `validateNotNullBackfill`) so the decision is owned by its `alterTable`. Default-absent ⇒ unchanged. Native modules (memory, store) leave the flag off — Quereus's own conformance suite is unchanged. Prereq half of cross-repo Lamina ticket `lamina-quereus-add-column-not-null-structurally-total` (still in `implement/` over in `C:\projects\lamina`).
files:
  packages/quereus/src/vtab/capabilities.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/test/alter-add-column-delegate.spec.ts
  docs/sql.md
  docs/design-isolation-layer.md
----

# Complete: `delegatesNotNullBackfill` capability for ADD COLUMN NOT NULL backfill delegation

## Summary of landed change

`ModuleCapabilities` gains one opt-in flag, `delegatesNotNullBackfill?: boolean` (`vtab/capabilities.ts:23`). `runAddColumn` (`runtime/emit/alter-table.ts:235`) reads it via `module.getCapabilities?.()` and, when true, skips the existing `validateNotNullBackfill` pre-check on `ADD COLUMN <NOT NULL, no usable DEFAULT>` against non-empty tables. The remaining engine-generic guards (PRIMARY KEY add, non-foldable DEFAULT, CHECK backfill, generated-column graph, duplicate column) still apply to all modules. Native modules (memory, store) do not advertise the flag, so their behavior — and Quereus's own conformance suite — is byte-for-byte unchanged. APPLY SCHEMA is covered for free because `emitApplySchema` re-executes generated DDL through the same path.

Spec: `test/alter-add-column-delegate.spec.ts` (3 tests — native regression, delegation success, APPLY SCHEMA delegation), using a `TotalMemoryModule` test subclass that relaxes NOT-NULL→nullable when delegating to the base manager and re-marks the returned column NOT NULL (to model a structurally-total module that enforces NOT NULL at write time going forward).

Lamina's actual `alterTable` is the real consumer; it lives in a separate repo and lands separately under `lamina-quereus-add-column-not-null-structurally-total`.

## Review findings

### Scope of review
Read the implement diff (`f641c9a1`) cold before considering the handoff. Audited the source change against the live code paths around ADD COLUMN / ALTER COLUMN / APPLY SCHEMA, traced every consumer of `ModuleCapabilities`, and verified the isolation-layer pass-through. Ran the new spec, the ALTER conformance bucket, typecheck, lint, and the full memory-backed test suite.

### Correctness — verified, no defects
- **Gating is keyed on the explicit capability**, not on "is a virtual table". Reading `module.getCapabilities?.().delegatesNotNullBackfill === true` (note the explicit `=== true`) means an absent method, an absent flag, or a falsy/undefined value all preserve the pre-existing reject. All third-party modules that don't update keep current behavior.
- **Order of pre-checks is preserved.** PK-add rejection (`alter-table.ts:200`) and non-foldable DEFAULT rejection (`alter-table.ts:210`) both run *before* the new gate, so a delegating module cannot bypass them either. Verified.
- **`hasNotNull` keys off explicit AST constraint** (`c.type === 'notNull'`), matching the prior behavior of `validateNotNullBackfill`. The `default_column_nullability='not_null'` pragma path is unchanged by this ticket — it was never gated by `validateNotNullBackfill` and still isn't. The ticket's prose could be read to imply otherwise; behavior is unchanged from before, flagging as a docs nuance not a defect.
- **Isolation layer propagates the flag correctly.** `IsolationModule.getCapabilities` (`packages/quereus-isolation/src/isolation-module.ts:179`) spreads `...underlyingCaps` before stamping `isolation`/`savepoints`, so a module wrapped by the isolation layer keeps any `delegatesNotNullBackfill` the underlying advertised. No isolation-side change needed.
- **SET NOT NULL needs no gate.** Confirmed `runAlterColumn` (`alter-table.ts:490`) delegates the SET-NOT-NULL action straight to `module.alterTable` with no engine-side backfill pre-check. The `SchemaChangeInfo.alterColumn` contract (`vtab/module.ts`) explicitly assigns backfill-from-DEFAULT and CONSTRAINT-on-existing-NULLs to the module. The implementer's investigation conclusion is correct: structurally-total behavior on SET NOT NULL is already module-owned and Lamina inherits it for free. No change needed.
- **CREATE [UNIQUE] INDEX** — confirmed unaffected; `SchemaManager.createIndex → module.createIndex` with no core duplicate-scan. No gate needed.
- **Native backstops kept.** `memory/layer/manager.ts:1024` and `store-module.ts:575` remain dead backstops (generic check still fires first for those native modules since their capability is off). Implementer's choice to leave them in place is correct — they document intent and are a defense-in-depth if a native module is ever (incorrectly) flipped to delegate. The "drift" noted in the implement handoff (memory's `defaultIsLiteral` short-circuit not rejecting `DEFAULT NULL`) is genuine but invisible behind the generic check; not a regression.

### Test coverage — adequate; honestly scoped
The implementer's 3 tests cover the three behaviors that need to land: native still rejects, delegating succeeds, APPLY SCHEMA delegates. The test fake (`TotalMemoryModule`) is intentionally a model, not the real Lamina module — the implement handoff calls this out explicitly. The real consumer (cross-repo Lamina) carries its own validation suite; that's the right division of labor.

Considered (not added) extra tests:
- **DEFAULT NULL drift case (`ADD COLUMN c NOT NULL DEFAULT NULL`):** the generic check rejects this; the memory backstop doesn't. Testing it would only assert "generic check fires first" — which the existing native-rejection test already implies, and the drift is documented in the handoff. Not worth a separate test.
- **`default_column_nullability='not_null'` pragma:** unchanged by this ticket per the analysis above; no new coverage needed.
- **ADD COLUMN NOT NULL DEFAULT 'literal' on delegating module:** would just exercise the DEFAULT branch, which is unchanged. Existing conformance coverage in `41-alter-table.sqllogic` already exercises the literal-DEFAULT path; the delegating fake doesn't touch that branch.

### Findings disposition
- **Major:** none filed. No correctness defect, no missing engine-side gate (SET NOT NULL and CREATE INDEX paths verified module-owned already), no architectural concern. No new ticket warranted.
- **Minor — fixed inline:** `docs/design-isolation-layer.md:218-231` was carrying a stale snapshot of `ModuleCapabilities` (already missing the pre-existing `rangeScans` flag, and would now be missing `delegatesNotNullBackfill` as well). Updated the doc block to include both. The authoritative source remains the JSDoc on the interface in `vtab/capabilities.ts`.
- **Docs:** `docs/sql.md:1143` update is accurate. The JSDoc on the new flag is thorough. No other doc references the now-changed restriction.

### Validation run
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- New spec — 3 passing.
- `--grep 41-alter-table` — passing (native rejection conformance unaffected).
- Full memory-backed `node test-runner.mjs` — **2518 passing, 1 failing** (`Property-Based Planner/Optimizer Tests › Semantic equivalence under optimizer rules › result set unchanged when 'join-key-inference' is disabled` — 2000ms mocha timeout). Re-running the property-planner bucket alone passes all 27. Flaky timeout, unrelated to ALTER (does not exercise the ADD COLUMN path). Different from the failure the implementer reported (a stress 5-way join timeout) — both are unrelated timeout flakes.
- `yarn test:store` not run (per agent-runnable time budget; store path is unchanged — capability off ⇒ same code path).
