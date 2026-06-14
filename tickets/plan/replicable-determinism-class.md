description: A "replicable" determinism class for functions — bit-identical across peers/platforms/app-versions, stronger than the existing per-database determinism gate — declared on UDFs, auto-satisfied by builtins, and demanded by backing hosts (via a backing-host capability field) whose tables replicate, validated at materialized-view/derivation create.
difficulty: hard
files:
  - packages/quereus/src/func/registration.ts        # UDF flag surface
  - packages/quereus/src/vtab/backing-host.ts        # host-declared requirement
  - docs/migration.md                                # § Determinism requirements (the spec)
----

# Replicable determinism class

`docs/migration.md` § Determinism requirements is the spec. The engine's
create-time determinism gate means "pure within this database"; a derivation
whose backing replicates across peers must additionally be **bit-identical
across platforms and app versions** (case-folding/locale drift in a UDF would
make peers permanently disagree on derived bytes — convergence livelock).

Expected shape (the design stays out of the core-engine "synced" vocabulary):

- Builtins qualify automatically (Quereus implements its own collation and
  case-folding).
- A UDF opts in by declaration (`replicable: true` at registration) — a
  deliberate authoring assertion, not inferred.
- The backing-host capability gains a declared requirement (e.g.
  `requiresReplicableDerivations`); when the resolved host for a
  `create materialized view … using <module>` (or a maintained-table attach)
  demands it, the create validates that every function in the body is
  replicable, with a sited error naming the offending function. Hosts that
  don't demand it (memory) see no behavior change.
- Also enforce the derived-identity rule from the migration doc where cheap:
  a non-replicable-host create is unaffected; a replicable-host body is
  already required deterministic, so the only new check is the class.

Use case: the sync-store module declares the requirement, so a migration
target (`docs/migration.md` § 1 Expand) cannot deploy with a
platform-dependent conversion function.

---

## Promotion note (2026-06-14): runner-ready, self-contained, inert-by-default

Promoted backlog → plan. This is the self-contained determinism-class piece, NOT
the broader sync layer: a `replicable: true` UDF declaration (builtins auto-qualify),
a backing-host capability field (`requiresReplicableDerivations`), and create-time
validation that every function in a materialized-view / derivation body is replicable
when the resolved host demands it. The design is fully specified in
docs/migration.md § Determinism requirements — no open human decision. Hosts that
don't demand it (memory) see zero behavior change, so it ships inert until a
sync-store host opts in; safe to build ahead of the rest of the sync roadmap.
