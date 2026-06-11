description: A configured disposition + telemetry in @quereus/sync for inbound changes that reference a table outside the receiver's basis (the post-retirement straggler case), plus the retention-horizon configuration that retirement timing inherits. No wire versioning — table presence is the unit of compatibility.
difficulty: hard
files:
  - packages/quereus-sync/src/sync/                  # applyChanges path; where the unknown table surfaces today
  - docs/migration.md                                # § 4 Contract / Retirement (the spec)
----

# Unknown-table disposition and the retention horizon

`docs/migration.md` § The invariant and § 4 Contract are the spec. The lens
architecture deliberately has **no schema version on the wire**: peers
interoperate on exactly the basis tables they share, each
identity-and-configuration-stable for life. The one residual is the
**straggler**: after a legacy table retires everywhere, a long-offline peer
reconnects and sends changes referencing a table the receiver no longer (or
never) has. Detection is structural — the table simply isn't in the local
basis — but the behavior today is undefined/ad-hoc, and the failure mode of
silently dropping is write loss the straggler never learns about.

Expected behavior:

- A configured **disposition** for inbound changes naming an unknown table:
  `ignore` | `quarantine` (retain the changesets durably for manual/late
  processing) | `store-and-forward` (hold and relay to peers that do hold the
  table). Per-deployment default; sensible out-of-box choice to be argued in
  the plan pass.
- **Telemetry always** — an event/counter surfaced through sync events
  regardless of disposition, so an operator can see straggler traffic.
- A **retention horizon** configuration ("changes older than T are not
  guaranteed deliverable") — the same bound tombstone GC needs — exposed as a
  first-class setting that retirement guidance keys off: drop a legacy basis
  table no sooner than the horizon after its last directly-mapped write; a
  peer offline longer than the horizon was already outside the delivery
  guarantee.
- Interaction note: the flip phase (`docs/migration.md` § 3) makes straggler
  *support* possible via DML replay through the compatibility table; this
  ticket is about what happens when that table is finally gone.
