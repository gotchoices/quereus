description: Mapped-since / unmapped-since bookkeeping for basis tables — maintained module/sync-side off the existing notifyLensDeployment snapshot, with the three-state classification (directly mapped → derivation-source only → unreferenced) and a default retention/eviction policy in the sync system. No new core-engine surface expected.
files:
  - packages/quereus/src/vtab/module.ts              # notifyLensDeployment (existing hook — the data source)
  - packages/quereus-sync/                           # policy + bookkeeping home
  - docs/migration.md                                # § 2 Converge and § 4 Contract (the spec)
----

# Basis-table lifecycle tracking and eviction policy

`docs/migration.md` § 2 Converge and § 4 Contract are the spec. The engine
already delivers the needed facts and should need **nothing new**: the
`notifyLensDeployment` hook hands every module the deployment snapshot
(`relationBacking` — which basis relations the lens directly maps) on each
apply, and the basis schema's own derivation dependencies (`sourceTables`)
identify tables referenced only as a maintained table's source.

Expected shape:

- Per basis table, a module/sync-side classification with timestamps:
  **directly mapped** (lens backs a logical column with it) →
  **derivation-source only** (the legacy table during a migration window) →
  **unreferenced** (eviction candidate). Transitions recorded persistently
  (mapped-since / unmapped-since), surviving restarts.
- The transition into *derivation-source only* is the developer's
  "safe to schedule retirement" hint — surface it (sync events, an
  introspection query, or a TVF; pick in the plan pass).
- A **default eviction policy** in the sync system for *unreferenced* tables:
  retain for the retention horizon (see `sync-unknown-table-disposition`),
  then drop local storage (module-level table drop) — with an override knob
  (never-evict, immediate, custom).
- The dynamic network-wide half — "when did a change to this table last
  originate at a peer that maps it directly?" — is derivable from the change
  log / peer state the sync layer already keeps; expose it alongside the
  static classification so the developer hint combines both.
- The engine boundary stays where lens.md draws it: detach retains storage;
  reclaiming is below the engine. If the plan pass finds a genuinely missing
  engine ingredient (e.g. the snapshot lacks derivation-source info a module
  can't otherwise see), that's a small engine ticket, not a redesign.
