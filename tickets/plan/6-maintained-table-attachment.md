description: Design the first-class derivation lifecycle ("maintained tables") — stable backing identity, adopt-on-create, attach/detach verbs (promote MV→base table / demote base table→maintained), and declarative-differ recognition of those transitions as non-destructive. The substrate the synced-migration pattern's expand/flip/contract phases stand on.
files:
  - docs/migration.md                                              # the consuming pattern (expand/converge/flip/contract)
  - docs/materialized-views.md                                     # § Current limitations "First-class derivation lifecycle" bullet (the spec seed); § Substrate
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # backing name derivation, create/fill, rebuild
  - packages/quereus/src/schema/manager.ts                         # dual registration; importMaterializedView
  - packages/quereus/src/schema/schema-differ.ts                   # body-change drop+recreate path to be made transition-aware
  - packages/quereus/src/core/database-materialized-views.ts       # maintenance plan registration/detach
----

# Maintained tables: derivation as an attachment

## Problem

The hidden, engine-owned, `_mv_<name>`-named backing is the right model for
local caches and covering indexes, and the wrong model for a **migration
target** (`docs/migration.md`): there the backing must be an ordinary,
stably-named, sync-addressable basis table whose *derivation* is an
attachment to it — because the table outlives the derivation (the source is
what retires). Today every lifecycle verb is identity-destroying: drop-MV
drops the backing; refresh's shape rebuild and the declarative differ's
body-change path drop+recreate (a new incarnation — fatal to a replicated
table's row metadata); create always fills (no way to attach a definition to
existing rows).

Guiding principle (the dual of "a constraint is a logical claim; the
enforcing structure is an optional physical optimization"):
**a table is a stored relation; a derivation is an optional maintenance
contract attached to it.**

## What to design (resolve these, then emit implement tickets)

1. **The schema model.** Two candidate shapes: (a) keep `MaterializedViewSchema`
   + backing `TableSchema` dual registration but give the backing first-class
   identity (a public name, catalog visibility, survival of MV-record drop);
   or (b) a single `TableSchema` carrying an optional derivation attachment
   (body AST, maintenance plan), with today's hidden-`_mv_` MV as the
   anonymous special case. (b) was the direction favored in design discussion
   — it dissolves the dual-registration name-disjointness questions and makes
   both conversions pure catalog flips — but weigh the migration cost of the
   existing MV machinery (query resolution, write-through dispatch,
   bodyHash differ keying, rename propagation, staleness) against it.
2. **Syntax.** Candidates to settle: `create table X (…) using store()
   maintained as <body>`; `alter table X set maintained as <body>` /
   `alter table X drop maintained` (attach/detach); how `create materialized
   view` maps onto the same substrate (sugar for an anonymous maintained
   table?). Declarative-schema item forms for all of it (the basis schema is
   declarative — the migration pattern authors these in `declare schema`
   blocks). Lowercase keywords; `maintained` contextual.
3. **Adopt-on-create / attach semantics.** Attaching a derivation to a table
   that already has rows (the upgrading-peer case — the table arrived via
   sync before the app version that defines it): verify-or-trust question —
   re-derive and diff (reconciling lag, recording only genuinely changed
   rows), trust blindly, or gate like the rehydrate adopt
   (`mv-adopt-fast-path` — note that ticket is the *rehydrate* trust path,
   orthogonal to but informing this engine-level attach). Shape mismatch on
   attach is an error; content divergence is the design question.
4. **Detach semantics (the promote).** Drop the derivation, keep the table —
   nothing physical changes; the table sheds READONLY and becomes ordinary.
   Interaction with `backing-tables-readonly-enforcement` (backlog): the
   enforcement seam should key off the *derivation attachment*, not the
   `_mv_` name, so promotion sheds it structurally.
5. **Differ recognition.** `declare schema` transitions — table→maintained,
   maintained→table, body change on a named maintained table — must be
   recognized as attach/detach/re-attach (non-destructive to the table and
   its rows), not drop+create. A body change re-derives content (that part is
   a refresh, not a recreate). The bodyHash mechanism likely keys the
   re-attach; the name-stability is what changes.
6. **Identity preservation in existing verbs.** Refresh's shape rebuild and
   rename propagation against a *named* maintained table must preserve table
   identity (module-level alterTable, not drop+recreate) or error cleanly
   where they cannot.
7. **Out of scope here (already parked in backlog):** sync change-logging of
   maintenance writes (`sync-derivation-changelog-optin`), replicable
   determinism (`replicable-determinism-class`), eviction policy
   (`sync-basis-eviction-policy`).

## Key tests to sketch for the implement tickets

- attach-to-empty ≡ create-MV (same fill, same maintenance behavior).
- attach-to-populated with identical derivable content: zero row writes.
- attach-to-populated with divergence: per the resolved semantics (diff-and-
  reconcile or reject) — pin both the data outcome and the reported changes.
- detach: table survives with rows, becomes user-writable, maintenance stops;
  re-attach later resumes.
- differ round-trip: declare maintained → apply → declare same table without
  `maintained` → apply ⇒ detach (table + rows intact); reverse ⇒ attach.
- migration end-to-end (the docs/migration.md worked example): expand
  (maintained Contact_v2 over Contact_v1), writes both directions, flip
  (detach v2's derivation + attach inverse derivation to v1), contract
  (detach + drop v1) — data identical throughout.
