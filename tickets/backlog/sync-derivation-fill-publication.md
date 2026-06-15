description: Decide whether a replicate-opted-in derived backing should publish its CREATE-fill / full-rebuild REFRESH rows (the `replaceContents` path) to the sync change log, so derived rows that are never subsequently edited still reach never-upgrading old peers. Adjacent to `sync-derivation-changelog-optin`, which scopes change-logging to `applyMaintenance` only.
prereq: sync-derivation-changelog-optin
files:
  - packages/quereus-store/src/common/backing-host.ts   # replaceContents (committed bulk replace, currently event-free)
  - docs/migration.md                                   # § Synced vs. local derived tables / § The pattern (Expand)
----

# Synced derivations: should the create-fill / refresh publish?

`sync-derivation-changelog-optin` made a replicate-opted-in backing's **row-time
maintenance writes** (`applyMaintenance`) record change-log entries. It
**deliberately excluded** the bulk `replaceContents` path (create-fill and
full-rebuild refresh), because `replaceContents` has no value-identical
suppression — publishing it would storm the change log across every peer that
independently derives the same fill (replicable determinism means they all
compute identical bytes).

## The gap this leaves

A migration target's derived rows reach an **old / never-upgrading** peer (which
stores the new table opaquely) only when an upgraded peer publishes them. Today
that happens via row-time maintenance — i.e. only when a source row is
**subsequently edited**. A derived row whose source is filled at deploy and then
**never edited again** is never published, so a never-upgrading old peer never
receives it. For the common migration (active data churns) this self-heals; for
cold/static rows it does not.

## The tension to resolve

- **Publish the fill** → cold rows reach old peers, but N upgraded peers each
  publishing the same fill creates redundant change-log entries (LWW settles
  them — harmless to correctness, costly in traffic / log size). Needs a
  suppression or single-publisher story.
- **Don't publish** (status quo after the prereq) → no fill-storm, but cold rows
  never reach never-upgrading old peers without an edit.

## Candidate directions (not yet decided — this is a backlog spec, not a plan)

- Make `replaceContents` on an opted-in backing diff against the **committed**
  contents (like `applyMaintenance('replace-all')` does against pending) and
  publish only genuine deltas — so a re-fill that matches already-synced rows
  publishes nothing. This restores suppression for the bulk path.
- Or: leave `replaceContents` event-free and rely on the reconcile/attach path
  (`applyMaintenance('replace-all')`, which the prereq already change-logs) to
  carry cold rows when a peer attaches over existing data — accepting that a
  cold row authored on a *fresh* fill at the first deriving peer still needs one
  edit (or one attach elsewhere) to propagate.
- Or: out-of-band — let the sync layer's snapshot/bootstrap stream carry the
  opaque table's rows to old peers, decoupling cold-row delivery from the change
  log entirely.

Decision needs the retention-horizon / unknown-table-disposition design (the
rest of `docs/migration.md` § Current gaps "Sync-layer policies") to be in view —
those govern what an old peer does with rows for a table outside its basis, which
bounds how urgently the fill must publish at all.
