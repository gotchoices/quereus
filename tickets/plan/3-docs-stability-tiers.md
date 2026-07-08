description: The project ships a mix of rock-solid features and experimental research features, but nothing tells a user which is which, so someone can build on an experimental feature thinking it is stable; publish clear stability tiers that label each major feature area.
files:
  - packages/quereus/README.md (user-facing status / docs index — likely canonical home)
  - docs/architecture.md (§ What's fragile / Scope discussion)
  - docs (topic docs for the features being tiered: materialized-views, lenses, migration, parallel-runtime, etc.)
----

## Problem

Quereus spans a wide maturity range — a battle-tested SQL core alongside
research-grade tracks — but nothing published tells a user which features are safe
to build on and which are experimental. A user can adopt an experimental feature
believing it is stable, and a maintainer has no declared boundary to point at when
deciding how much a change to an experimental track is allowed to break.

The review (strategic recommendation #6) proposes declaring explicit **stability
tiers**, and the architecture assessment already implicitly maps the terrain
("what's sound" vs. "what's fragile" vs. "speculative"). The proposed assignment:

- **Stable**: core SQL, the virtual-table framework, and views.
- **Beta**: materialized views.
- **Experimental**: lenses, migration, and the parallel runtime track.

The recommendation also suggests *containing the blast radius* of the research
tracks — up to and including freezing the parallel-runtime track until a real
federated consumer justifies its ongoing cost — but that freeze decision is a
product call and is **not** part of this ticket; this ticket is about *declaring
and documenting* the tiers.

## Goal

A clear, published stability-tier declaration that a user reads before depending on
a feature, and that a maintainer cites when scoping how much an experimental-track
change may break. Each major feature area carries a tier label; the meaning of each
tier (what stability/compat promise it does and does not make) is defined once.

## To resolve in this plan

- **The tier definitions**: what "stable / beta / experimental" each *promise* —
  API stability, backwards-compat expectations, data-format stability, support
  level. A tier label is only useful if its guarantees are spelled out.
- **The canonical home**: where the tier table lives so it is discoverable
  (`packages/quereus/README.md` status section is the likely spot), and how the
  per-feature topic docs reference it (each topic doc's header states its tier and
  links to the definitions, rather than restating them).
- **The exact per-feature assignment**: confirm the proposed mapping above, and
  place every user-facing feature area into a tier (nothing user-facing left
  unlabeled). Edge calls: where declarative schema, FD framework, and view
  updateability (which MVs/lenses/migration all sit on) land.
- Whether an experimental feature needs a visible in-product signal (a startup
  log / doc banner) beyond the docs table — recommend, don't mandate.

## Non-goals

- Deciding whether to *freeze* the parallel-runtime track — that is a separate
  product decision (route to `blocked/` if/when it needs a call), not a doc edit.
- Changing any feature's actual behavior — this is a labeling/documentation effort.
