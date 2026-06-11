description: Per-table opt-in for recording materialized-view/derivation maintenance writes in the sync change log — a reserved tag the backing host module reads inside applyMaintenance — so a migration target's derived rows replicate while index/perf MVs stay local. Default off. Depends on no-op upsert suppression (echo prevention) and the store backing host.
difficulty: hard
prereq: mv-noop-upsert-suppression, store-backing-host
files:
  - packages/quereus-store/src/common/backing-host.ts   # (once landed) the host that reads the tag
  - packages/quereus/src/schema/reserved-tags.ts        # the tag spec/site
  - docs/migration.md                                   # § Synced vs. local derived tables (the spec)
----

# Synced derivations: change-log opt-in

`docs/migration.md` § Synced vs. local derived tables is the spec. Today a
privileged maintenance write deliberately emits no module data events ("the
sync layer must not replicate derived rows") — correct for the common case
(covering indexes, perf caches: replicating a derived structure to a peer
that derives its own is waste), wrong for a **migration target**, whose rows
must exist independently of the source because the source is scheduled to
retire.

Expected shape:

- A reserved tag (e.g. `quereus.sync.replicate = true`, exact key via the
  typed registry) on the materialized view / maintained table opts its
  backing's **maintenance writes** into the host module's change recording
  (the same recording an ordinary table write gets — column versions, HLC
  stamps, change-log entries, tombstones for maintenance deletes).
- The decision lives in the **host module** inside `applyMaintenance` —
  "synced" never becomes a core-engine concept; the engine just stores and
  round-trips the tag.
- Default **off**; nothing changes for existing MVs.
- Echo safety rests on the no-op suppression contract
  (`mv-noop-upsert-suppression`): a value-identical re-derivation produces no
  ops, hence no change-log entry, hence no peer round-trip. Test the loop
  explicitly: peer A source write → A derives + logs → B ingests source +
  derived rows → B's own derivation of the ingested source change is
  value-identical → B logs nothing new → quiescence (no ping-pong).
- Inbound sync writes to a replicated backing land via the store adapter as
  ordinary table changes; the local maintenance and inbound rows converge by
  column-LWW because the derivation is deterministic (and replicable — see
  `replicable-determinism-class`). Drift between the two paths (a buggy
  non-replicable UDF) must degrade to LWW flapping, never an error loop.
