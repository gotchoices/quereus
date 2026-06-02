description: |
  Lens-deployment export surface + module deployment-notification hook.
  `deployLogicalSchema` / `LensDeploymentSnapshot` / `LensTableSnapshot` /
  `LensRelationBacking` / `LensDeployReport` are re-exported from the
  `@quereus/quereus` package root, and `VirtualTableModule` carries an optional
  `notifyLensDeployment(db, logicalSchemaName, snapshot)` hook fired once per
  successful logical `apply schema X` (forwarded by `IsolationModule`). Upstream
  unblock for Lamina's dormant `createDeployedBasisReconciler`.
files:
  - packages/quereus/src/index.ts — lens-deployment re-export block
  - packages/quereus/src/vtab/module.ts — optional `notifyLensDeployment` hook + firing contract
  - packages/quereus/src/runtime/emit/schema-declarative.ts — fires the hook after a successful logical deploy via `notifyLensDeploymentAll`
  - packages/quereus-isolation/src/isolation-module.ts — straight-delegate forward
  - docs/lens.md — "Module deployment notification" subsection + Implementation Surface bullet
  - packages/quereus/test/lens-deployment-notify.spec.ts — 6 cases (4 original + 2 added in review)
  - packages/quereus-isolation/test/isolation-layer.spec.ts — 2 forward tests
---

# Complete: lens-deployment export + module deployment-notification hook

## What shipped

- **Export surface** (`src/index.ts`): `deployLogicalSchema` (value) + `LensDeploymentSnapshot` / `LensTableSnapshot` / `LensRelationBacking` / `LensDeployReport` (types) re-exported from the package root. No `package.json` `exports` change needed — `.` already maps to the barrel; verified the symbols land in `dist/src/index.d.ts` (all five) and `dist/src/index.js` (the `deployLogicalSchema` value).
- **Hook** (`src/vtab/module.ts`): optional `notifyLensDeployment?(db, logicalSchemaName, snapshot)`, fired once per successful logical `apply schema X` from `schema-declarative.ts` (`notifyLensDeploymentAll` helper) after the lens catalog mutation + snapshot rotation complete. Reads the just-rotated `current` snapshot back from `DeclaredSchemaManager` — no second derivation. Every registered module implementing the hook is notified in registration order; errors propagate out of the apply (lens stays deployed).
- **Isolation forward** (`isolation-module.ts`): straight delegate to the underlying, mirroring `getMappingAdvertisements` / batch-hook forwards.
- **Docs** (`docs/lens.md`): new § Module deployment notification with the full firing contract + Implementation Surface bullet update.

## Review findings

Scrutinized from SPP/DRY/modularity/scalability/maintainability/perf/resource-cleanup/error-handling/type-safety angles. The implement-stage diff was read first, then the handoff.

### Verified correct (no change)
- **Export resolution.** All five symbols exist at source (`lens.ts` 178/210/242, `lens-prover.ts` 175, `lens-compiler.ts` 50) and land in the built barrel (`dist/src/index.{d.ts,js}`). The re-export is sufficient; no `package.json` change required.
- **Firing path + contract.** The `notifyLensDeploymentAll` loop mirrors the established `beginSchemaBatchAll` / `endSchemaBatchAll` pattern (`db.schemaManager.allModules()`, `typeof === 'function'` guard). The defensive `if (!snapshot) return` is harmless dead-code-ish (a successful deploy — including an empty/detach-all one — always rotates a `current`, per `buildDeploymentSnapshot`).
- **Isolation forward** is consistent with the codebase's "pin every forward so a future hook is not forgotten" convention; the deployed shape is genuinely isolation-transparent. Scope expansion beyond the original `files:` list is welcome and correct — a missing forward would silently strand an isolation-wrapped basis module's reconcile.
- **Type safety.** No `any` in production code; the hook is typed against the real `LensDeploymentSnapshot`. Isolation `typecheck` passing proves the cross-package export resolves to the real type.
- **Error semantics (post-commit, first-throw-wins).** Intentional and documented: the lens is not transactional with the statement, so a throwing reconcile aborts `apply schema X` but does not roll back the deployed lens; a re-apply re-fires. First thrown error aborts before remaining modules (no aggregation) — fine for v1 (Lamina is the sole consumer). Both now have explicit tests (see below).
- **Direct `deployLogicalSchema` callers bypass the notification** (the hook is wired at the emit layer, not inside the sync `deployLogicalSchema`). Acceptable — the ticket ties the notification to `apply schema X`; an embedder calling the function directly fires it themselves. Documented.

### Minor — fixed in this pass
- **Helper naming / shadow-name.** The private helper was named `notifyLensDeployment` — identical to the `VirtualTableModule.notifyLensDeployment` interface method it invokes, and inconsistent with the file's `*All` convention for "fire hook on every module" helpers. Renamed to **`notifyLensDeploymentAll`** (`schema-declarative.ts`). Typecheck + spec re-run clean.
- **Test coverage gap (multi-module fan-out + registration order + first-throw-wins).** The docs claim "every registered module, registration order" and the handoff flagged first-throw-wins as an untested judgment call. Added **2 tests** to `lens-deployment-notify.spec.ts`: (a) every hook-implementing module is notified in registration order with a non-implementing module interleaved (silently skipped) and all see the same rotated snapshot object; (b) the first throw aborts the apply before later modules are reached.

### Major — none
No major findings; no new fix/plan/backlog tickets filed.

### Deliberately out of scope (confirmed, not gaps)
- **`LensDeployReport` constituents** (`LensDiagnostic` / `AcknowledgedAdvisory` / `ConstraintObligation`) and **AST types** (`SelectStmt`, `DeclareSchemaStmt`) are reachable structurally / via `@quereus/quereus/parser` but not re-named from root. Intentional minimalism — add only when a consumer needs to name them.
- **No SQL-level (`.sqllogic`) test** — correct; the hook is a module-API surface not observable from SQL, covered by TS specs only.
- **Lamina-side binding** (`LensDeploymentSnapshotLike` → real type, `LaminaModule.notifyLensDeployment` → `createDeployedBasisReconciler`) is Lamina's blocked work, not this ticket. The real snapshot is structurally compatible with Lamina's mirror (reads only `basisSchemaName` + `tables[*].logicalTable`).

## Validation
- `yarn workspace @quereus/quereus typecheck` — clean (incl. after the rename).
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus build` + `@quereus/isolation typecheck` — clean (isolation resolves the real exported type from the package root).
- **Full quereus suite**: 4388 passing, 9 pending, 0 failing (was 4386; +2 from the added tests).
- **Full isolation suite**: 77 passing.
- `lens-deployment-notify.spec.ts`: 6 passing.
