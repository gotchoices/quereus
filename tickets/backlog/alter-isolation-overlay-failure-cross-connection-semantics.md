description: Decide whether a mid-transaction ALTER through the isolation layer should be allowed to fail because a *different* connection's uncommitted staged overlay row cannot satisfy the schema change (e.g. ADD COLUMN ... NOT NULL DEFAULT (new.x) where connection B has a staged row yielding NULL). Today `IsolationModule.alterTable` collects every connection's overlay for the table into `affected` and migrates them all, so connection B's un-backfillable *uncommitted* row aborts connection A's ALTER. This is a semantics question distinct from the atomicity fix (`alter-isolation-prevalidate-overlay-backfill`, which only makes the existing abort atomic).
files: packages/quereus-isolation/src/isolation-module.ts
----

## The question

In a "real" isolated system, ALTER observes only committed rows; another connection's
uncommitted insert/update is invisible and cannot influence the DDL. The isolation layer,
however, migrates *every* per-connection overlay across the column-layout change to keep each
connection's uncommitted writes consistent with the new schema. If one of those overlays holds
a staged row that cannot satisfy the new column (NOT NULL per-row backfill yields NULL), the
question is **whose problem that is**:

- **(A) Abort the ALTER (current behavior).** Any connection's un-backfillable staged row
  rejects the issuer's ALTER. Simple, but lets one connection's *uncommitted* data block
  another connection's schema change — arguably an isolation violation, and a denial-of-service
  vector between sessions.
- **(B) Connection-scoped failure ("poisoned overlay").** The ALTER applies to the shared
  underlying and the catalog regardless; each overlay is migrated best-effort, and an overlay
  whose staged row cannot be carried forward is marked invalid so its *owning* connection errors
  on next access / commit — without aborting the issuer or corrupting the base. Closer to real
  isolation semantics, but introduces a new overlay state and changes observable behavior (the
  cross-connection case that throws today would instead succeed-and-poison).

The issuer's OWN staged overlay is a sub-case: even under (B) it is defensible to reject the
ALTER when the issuer's own uncommitted data violates the new column, since the user issued
both.

## Why backlog (needs design sign-off)

This is a genuine semantics fork with no obvious default — (A) and (B) give different,
user-visible outcomes for the same statement, and (B) requires a new "invalid overlay"
mechanism with its own lifecycle (when does the owning connection observe the poison? at next
read, next write, or commit? how does it interact with savepoints / rollback?). It warrants
human/design input before implementation. The companion ticket
`alter-isolation-prevalidate-overlay-backfill` deliberately preserves behavior (A) and only
makes it atomic; this ticket revisits whether (A) is the behavior we want.

## Acceptance ideas

- Pick (A) or (B) (or a hybrid: reject on the issuer's own overlay, poison others) with a
  documented rationale in the isolation layer.
- If (B): design the poisoned-overlay state and its observation point; cover savepoint /
  rollback interaction; test that connection A's ALTER succeeds while connection B sees an
  error only when it next touches the table or commits, and that the shared base + catalog stay
  consistent throughout.
- If (A) is kept deliberately: document the cross-connection coupling at the `alterTable` API
  boundary so it is an intentional, stated limitation rather than an accident.
