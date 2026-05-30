description: Reconcile the two notions of "known `quereus.*` tag keys" — the typed reserved-tag registry (schema/reserved-tags.ts, wired into the lens-compile path) and schema-differ.ts's `warnUnknownQuereusKeys` (the physical declarative-schema path). Today they are disjoint sets on disjoint paths; once `quereus.update.*` is wired into physical view/DML DDL, a typo in a reserved key on a *physical* schema would only soft-warn (DEBUG-gated, effectively silent) instead of failing — exactly the silent-no-op class the registry was built to prevent.
prereq:
files: packages/quereus/src/schema/reserved-tags.ts (the typed registry: validateReservedTags / RESERVED_TAGS / getReservedTag), packages/quereus/src/schema/schema-differ.ts (warnUnknownQuereusKeys ~line 502, KNOWN_QUEREUS_KEYS = {quereus.id, quereus.previous_name} ~line 17, readQuereusHint), packages/quereus/src/runtime/emit/schema-declarative.ts (emitApplySchema branch: logical → deployLogicalSchema, physical → computeSchemaDiff)
----

## Problem

There are currently two independent registries of recognized `quereus.*` tag keys, on two
non-overlapping code paths:

| | Typed reserved-tag registry | schema-differ `warnUnknownQuereusKeys` |
|---|---|---|
| Keys known | `quereus.update.{target,exclude,default_for.<col>,delete_via,policy}`, `quereus.lens.ack.<code>`, `quereus.lens.access.<col>` | `quereus.id`, `quereus.previous_name` only |
| Unknown key | hard **error** (sited `QuereusError`) | soft **warning** via `warnLog` (DEBUG-gated, silent in normal runs) |
| Path | lens-compile (`deployLogicalSchema`) — runs only for a **logical** declared schema | physical declarative-schema differ (`computeSchemaDiff`) — runs only for a **physical** declared schema |
| Site model | `TagSite` (7 sites), value-schema validated | none; key-name allow-list only |

The two are disjoint today (disjoint key sets + disjoint apply paths — `emitApplySchema` routes a
logical schema to `deployLogicalSchema` and never calls `computeSchemaDiff`), so they do not
*conflict*. But the split is a latent correctness hole:

- The differ knows nothing of `quereus.update.*` / `quereus.lens.*`. The moment view-mutation
  Phase 2 makes `quereus.update.*` legal on a **physical** view DDL / DML statement, a typo
  (`quereus.update.taget`) on a physical schema would hit `warnUnknownQuereusKeys` and only
  soft-warn — the very silent-no-op the typed registry exists to eliminate. On a logical schema
  the same typo already hard-errors. Same namespace, two behaviors, depending on schema kind.
- The registry does not know `quereus.id` / `quereus.previous_name` — the rename-hint keys the
  differ owns. If a future caller validates differ-path tags through the registry, those legitimate
  hint keys would be flagged `unknown-reserved-tag`.

## Requirement

A single source of truth for "what `quereus.*` keys exist, where each is legal, and what its value
must look like," consulted by **both** the physical-differ path and the lens-compile path, so that
an unknown/mis-sited/malformed reserved key is diagnosed **consistently** regardless of whether the
schema is logical or physical.

Decisions to settle (design, not yet decided):

- Whether `quereus.id` / `quereus.previous_name` become first-class `ReservedTagSpec`s (with a site
  covering the physical declarative-schema positions: table / column / view / index / constraint),
  or stay a differ-local concern the registry explicitly delegates.
- Whether the differ's *soft-warn-on-unknown* posture should be preserved for forward-compat of the
  physical declarative path (older parser tolerates newer keys), or whether unknown reserved keys
  should become hard errors there too — and if the two paths are allowed to keep *different
  severities* for the same diagnostic, that divergence must be a deliberate, documented policy, not
  an accident of which path you came in through.
- The new `TagSite` value(s) needed to model physical declarative-schema positions (the current 7
  sites do not include a generic physical table/column/view/index DDL site).

## Notes

- This was logged as known gap #1 of `reserved-tag-namespace-typed-registry` (now in complete/),
  deliberately left out of scope as the PoC was lens-only.
- Closely related to `view-mutation-plan-node-substrate` Phase 2, which is what first makes
  `quereus.update.*` reachable on a physical path — that work should either depend on this
  reconciliation or carry it.
