----
description: |
  Export the lens-deployment surface from the `@quereus/quereus` package root and
  add a module-facing deployment-notification hook. Today `deployLogicalSchema`
  (schema/lens-compiler.ts) and `LensDeploymentSnapshot` / `LensTableSnapshot` /
  `LensRelationBacking` (schema/lens.ts) exist but are NOT re-exported from the
  package barrel (the package.json exports map exposes only `.`, `/parser`,
  `/emit`), and `VirtualTableModule` (vtab/module.ts) has `getMappingAdvertisements`
  / `beginSchemaBatch` / `endSchemaBatch` but NO deployment-notification callback.
  A consuming `VirtualTableModule` therefore cannot (a) bind to the real snapshot
  type — it mirrors a local structural copy — nor (b) be told the deployed
  `LensDeploymentSnapshot` on each `apply schema X` so it can react to a deployment.
files:
  - packages/quereus/src/schema/lens-compiler.ts — deployLogicalSchema (exists; not exported from root)
  - packages/quereus/src/schema/lens.ts — LensDeploymentSnapshot / LensTableSnapshot / LensRelationBacking (exists; not exported from root)
  - packages/quereus/src/index.ts — package barrel (add the re-exports here)
  - packages/quereus/src/vtab/module.ts — VirtualTableModule surface (add the deployment-notification hook near getMappingAdvertisements / beginSchemaBatch, ~245-300)
  - packages/quereus/package.json — exports map (. / parser / emit)
  - docs/lens.md — document the exported surface + the notification contract
----

# Export the lens-deployment surface + a module deployment-notification hook

## Why (downstream consumer)

This is the upstream blocker for the Lamina adapter's lens-deployment → basis-
reconciliation path. Lamina (`packages/lamina-quereus/src/lens-deployment.ts`, a
separate repo at `../lamina`) currently:

- consumes a hand-maintained structural **mirror** `LensDeploymentSnapshotLike`
  because the real `LensDeploymentSnapshot` type is not importable from
  `@quereus/quereus`; and
- has a `createDeployedBasisReconciler` facade
  (`packages/lamina-quereus/src/host-composition.ts`) wired but **dormant** —
  nothing fires it, because the engine never hands a deployed snapshot to the
  module on `apply schema X`.

Until both land, Lamina's deploy→reconcile pipeline cannot bind to the real type
nor auto-trigger. (Lamina tracks the dependent work in its own `blocked/`:
`lamina-retire-schema-migrate-fact-sl7` and the lens-deployment consumer ticket
both name this slug.)

## Deliverable

**(a) Export the lens-deployment surface from the package root.** Re-export from
`packages/quereus/src/index.ts` (and, if the exports map is the gate, confirm `.`
covers it):

- `deployLogicalSchema` (the function)
- `LensDeploymentSnapshot`, `LensTableSnapshot`, `LensRelationBacking` (the types)
- any supporting types those three transitively require at the public boundary

**(b) Add a deployment-notification hook to `VirtualTableModule`.** An optional
method (alongside `getMappingAdvertisements` / `beginSchemaBatch` / `endSchemaBatch`)
that hands the module the `LensDeploymentSnapshot` produced by `deployLogicalSchema`
on each successful `apply schema X`, so a module can realise/reconcile its backing
relations against the freshly deployed lens. Define the exact firing contract
(once per successful apply, after `endSchemaBatch`, snapshot scoped to the affected
schema) and document it in `docs/lens.md`.

## Notes / reconciliation

- Scope is the **export + hook surface only** — the lens compiler / prover /
  auxiliary-access machinery already exist on this branch and are out of scope.
- Coordinate the hook's snapshot shape with whatever `apply schema` already
  produces internally so the notification carries the same `LensDeploymentSnapshot`
  the compiler built (no second derivation).
