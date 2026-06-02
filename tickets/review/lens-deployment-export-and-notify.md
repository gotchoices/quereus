description: |
  Review the lens-deployment export + module deployment-notification hook.
  `deployLogicalSchema` / `LensDeploymentSnapshot` / `LensTableSnapshot` /
  `LensRelationBacking` / `LensDeployReport` are now re-exported from the
  `@quereus/quereus` package root, and `VirtualTableModule` carries an optional
  `notifyLensDeployment(db, logicalSchemaName, snapshot)` hook fired once per
  successful logical `apply schema X` (forwarded by `IsolationModule`). This is
  the upstream unblock for Lamina's dormant `createDeployedBasisReconciler`.
files:
  - packages/quereus/src/index.ts — added the lens-deployment re-export block (deployLogicalSchema + snapshot types + LensDeployReport)
  - packages/quereus/src/vtab/module.ts — added the optional `notifyLensDeployment` hook + its firing contract (and the `LensDeploymentSnapshot` type import)
  - packages/quereus/src/runtime/emit/schema-declarative.ts — fires `notifyLensDeployment` after a successful logical deploy; new `notifyLensDeployment` helper
  - packages/quereus-isolation/src/isolation-module.ts — straight-delegate forward of the hook to the underlying module
  - docs/lens.md — new "Module deployment notification" subsection + Implementation Surface bullet update
  - packages/quereus/test/lens-deployment-notify.spec.ts — new (4 cases)
  - packages/quereus-isolation/test/isolation-layer.spec.ts — 2 new forward tests
  - packages/quereus/package.json — UNCHANGED (the `.` export already maps to the barrel; see note)
---

# Review: lens-deployment export + module deployment-notification hook

## What landed

**(a) Export surface (`src/index.ts`).** New re-export block:

```ts
export { deployLogicalSchema } from './schema/lens-compiler.js';
export type { LensDeploymentSnapshot, LensTableSnapshot, LensRelationBacking } from './schema/lens.js';
export type { LensDeployReport } from './schema/lens-prover.js';
```

The package `exports` map needed **no change** — `.` already points at the barrel
(`dist/src/index.{d.ts,js}`), so adding to `index.ts` is sufficient. Verified the
symbols land in `dist/src/index.d.ts` (types) and `dist/src/index.js` (the
`deployLogicalSchema` value). The AST types these reference at the public boundary
(`SelectStmt` via `LensTableSnapshot.getBody`, `DeclareSchemaStmt` via
`deployLogicalSchema`'s param) are **intentionally not re-exported from root** —
they are reachable via `@quereus/quereus/parser`, consistent with the established
"AST lives under `/parser`" idiom; structural access (`snapshot.tables.get(k).getBody`)
needs no root name.

**(b) Hook (`src/vtab/module.ts`).** New optional method:

```ts
notifyLensDeployment?(
  db: Database,
  logicalSchemaName: string,
  snapshot: LensDeploymentSnapshot,
): void | Promise<void>;
```

Fired from `emitApplySchema`'s **logical branch** (`schema-declarative.ts`), after
`deployLogicalSchema(...)` returns, via the new `notifyLensDeployment` helper. The
helper reads the just-rotated `current` snapshot back from
`DeclaredSchemaManager.getDeployedLensSnapshots(schema)` and passes that exact
object to every registered module implementing the hook (registration order) —
**no second derivation** (the reconciliation note's explicit requirement).

`IsolationModule` forwards it as a straight delegate (the deployed shape is
isolation-transparent, like `getMappingAdvertisements`).

## Firing contract (as implemented + documented in docs/lens.md § Module deployment notification)

- **Once per successful apply.** Only after `deployLogicalSchema` returns without
  throwing — the deploy is atomic, so a blocked deploy never reaches the hook.
- **Physical `apply schema` never fires it** (no lens deploy on that path).
- **After deploy, no migration batch.** The logical-apply path runs no
  `beginSchemaBatch`/`endSchemaBatch` loop — the notification is the logical
  analogue of "after `endSchemaBatch`".
- **Scoped to the affected schema.** `snapshot` is that schema's `current` rotation.
  Empty (detach-all) deploy still fires with an empty-`tables` snapshot.
- **Every registered module, registration order**; irrelevant modules no-op
  (mirrors `beginSchemaBatch`).
- **Errors propagate** out of `apply schema X`; the deployed lens is **not**
  rolled back; a re-apply re-fires.

## Validation performed (treat as a floor, not a ceiling)

- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn build` (quereus) + isolation `typecheck` — clean (isolation imports the
  real `LensDeploymentSnapshot` from the package root, proving the export resolves).
- **Full quereus suite**: `yarn workspace @quereus/quereus test` → **4386 passing, 9 pending, 0 failing**.
- **Full isolation suite**: 77 passing.
- `yarn workspace @quereus/quereus lint` — clean.
- New `lens-deployment-notify.spec.ts` (4 cases): fires once with the rotated
  `current` (reference identity, not a copy); re-fires per re-apply incl.
  empty/detach-all; error propagates + lens stays deployed/readable; module
  without the hook unaffected.
- New isolation forward tests (2): forwards to underlying; no-ops when underlying
  omits it.

## Reviewer attention — judgment calls + gaps

1. **Error semantics are post-commit.** A throwing notification aborts `apply
   schema X` but does **not** roll back the already-deployed lens (catalog
   mutation + snapshot rotation are not transactional with the statement). Tested
   + documented. Confirm this is the intended contract vs. rolling back the deploy
   on a failed reconcile. I chose post-commit-hook semantics deliberately
   (reconcile is a downstream side effect; the lens itself is sound).

2. **First-throw-wins across modules.** The helper awaits modules sequentially in
   registration order; the first thrown error aborts before remaining modules are
   notified (no aggregation). Fine for v1 (Lamina is the sole consuming module);
   flag if multi-module fan-out with independent reconcilers is anticipated.

3. **Direct `deployLogicalSchema` callers bypass the notification.** The hook is
   wired at the `apply schema` emit layer, not inside `deployLogicalSchema` (which
   is sync and returns `LensDeployReport`; making it async to fire the hook would
   be a broad-blast-radius change). Now that `deployLogicalSchema` is **exported**,
   an embedder calling it directly will not get the notification — they would fire
   it themselves. Acceptable given the ticket ties the notification to `apply
   schema X`, but worth a second opinion.

4. **IsolationModule forward is beyond the ticket's `files:` list.** Added it (plus
   2 tests) because the codebase explicitly pins these forwards ("so a future hook
   is not forgotten") and a missing forward silently strands an isolation-wrapped
   basis module's reconcile — the same silent-degradation footgun the existing
   `getMappingAdvertisements` / batch-hook forward tests guard against. Confirm
   this scope expansion is welcome.

5. **`LensDeployReport` exported but its constituents are not.** `LensDiagnostic` /
   `AcknowledgedAdvisory` / `ConstraintObligation` are reachable structurally but
   not nameable from root. Intentional minimalism — the snapshot types + function
   are the deliverable; the report is exported only because it is the function's
   return. Add the sub-types only if a consumer needs to name them.

6. **No SQL-level (`.sqllogic`) test.** The hook is a module-API surface not
   observable from SQL, so it is covered by TS specs only. Correct, but noting it.

## Out of scope (unchanged, per ticket)

The lens compiler / prover / advertisement / auxiliary-access machinery already
existed on this branch. The Lamina-side binding (`LensDeploymentSnapshotLike` →
real type, and `LaminaModule.notifyLensDeployment` calling
`createDeployedBasisReconciler`) is **Lamina's** blocked work
(`../lamina` `tickets/blocked/`), not this ticket. Verified the real
`LensDeploymentSnapshot` is structurally compatible with Lamina's
`LensDeploymentSnapshotLike` mirror (it reads only `basisSchemaName` + `tables[*].logicalTable`).
