----
description: A typed, validated registry for the reserved `quereus.*` tag namespace, installed BEFORE the two tickets that will first parse these tags (lens-prover acknowledgment tags; the Phase-2 view-mutation `quereus.update.*` override surface). Today the namespace is fully designed in docs but consumed at zero code sites and stored as untyped `Record<string, SqlValue>`; a registry makes an unknown / mis-sited / malformed reserved key FAIL LOUDLY with a sited diagnostic instead of silently no-opping. Design-spike: locks the registry shape, the single validation entry point, and the typed accessors, and names the implement follow-ons it unblocks.
prereq:
files: schema/reserved-tags.ts, parser/ast.ts, schema/manager.ts, schema/lens.ts, docs/sql.md, docs/lens.md, docs/view-updateability.md, docs/schema.md
----

## Why this exists

The reserved tag keys are a precise, growing mini-language designed across the docs —
`quereus.update.{target, exclude, default_for.<column>, delete_via, policy}`
(`docs/view-updateability.md` § Tag-Controlled Propagation), `quereus.lens.ack.<code>`
and `quereus.lens.access.<col>` (`docs/lens.md` § Acknowledging advisories,
`tickets/plan/3-lens-prover-and-constraint-attachment`). Today they are consumed at NO
code site: a `find_references` for every dotted key returns nothing under
`packages/*/src`. Tags are stored as untyped `Record<string, SqlValue>` (`parser/ast.ts`,
frozen per `complete/3-metadata-tags`) and any `quereus.*` key is silently ignored.

The first consumer is imminent — `3-lens-prover` Phase C plans a hand-rolled "reserved
tag parser + validation (rationale required)" and an escalation-policy parser; the
Phase-2 view-mutation tag override surface (`view-mutation-plan-node-substrate`) is the
second. Without a shared registry these two tickets will each independently parse the
namespace at scattered sites — the exact untyped, typo-prone mini-language to avoid. A
typo like `quereus.update.taget` or `quereus.lens.akc` would silently no-op in production
with no diagnostic.

This ticket installs the guard rail as additive infrastructure: it changes NO behavior
for already-shipped user tags (free-form metadata stays free-form) and reads no reserved
tag's *semantics* — it only validates shape and site, and hands the two downstream tickets
a typed surface to consume. It is **not** a refactor of existing scatter (there is none
yet); it is a guard rail installed before proliferation.

## Recommended design (decisive)

A single module `schema/reserved-tags.ts`:

- **`ReservedTagSpec`** — `{ key: string | { template: string } (e.g.
  'quereus.update.default_for.<column>'); sites: ReadonlySet<TagSite>; valueSchema:
  TagValueSchema; description: string }`, where `TagSite` is the union `'view-ddl' |
  'projection' | 'join' | 'union-branch' | 'dml-stmt' | 'logical-table' |
  'logical-constraint'` and `TagValueSchema` is `'string' | 'csv-of-identifiers' | {
  enum: readonly string[] } | 'required-nonempty-rationale' | 'expression'`.
- **`RESERVED_TAGS: readonly ReservedTagSpec[]`** — frozen, seeded directly from the doc
  tables (the five `quereus.update.*` keys with their site/value rules from
  `view-updateability.md` § Tag-Controlled Propagation; `quereus.lens.ack.<code>` as
  `required-nonempty-rationale` on `logical-table` / `logical-constraint`;
  `quereus.lens.access.<col>` per `lens.md`).
- **`validateReservedTags(tags: Record<string, SqlValue>, site: TagSite):
  TagDiagnostic[]`** — the single entry point. For each key in the `quereus.` namespace:
  no matching spec => `unknown-reserved-tag` diagnostic; legal-spec-but-wrong-site =>
  `tag-not-allowed-here`; value fails its schema (notably empty rationale on
  `quereus.lens.ack`) => `invalid-tag-value`. Non-`quereus.*` keys pass through untouched.
  Called at schema-build / lens-compile / dml-plan time.
- **`getReservedTag<K>(tags, key): TypedValueFor<K> | undefined`** — typed accessor so
  downstream consumers read e.g. `delete_via` as the `'left_delete' | 'right_insert' |
  'parent'` union, never a bare `SqlValue` re-parsed inline.

### Why this path, not the alternatives

- **Do nothing / parse ad hoc per ticket** — rejected: produces the scattered
  mini-language the gap warns about; silent no-op on typos in production.
- **A full grammar-backed tag DSL** — rejected as over-scope for a ~7-key namespace; a
  frozen spec table is DRY and sufficient.
- **Registry now** — additive, behavior-neutral for shipped tags, and gives `3-lens-prover`
  Phase C and the view-mutation override surface a ready `validateReservedTags` +
  `getReservedTag` to consume rather than re-implement. Defensible default, single path.

## Proof-of-concept scope

The `reserved-tags.ts` module + `validateReservedTags` entry point + typed accessor for
the `quereus.lens.ack` rationale-required case (the nearest live consumer), wired into the
lens-compile path so an empty/garbage ack rationale on a logical declaration produces a
diagnostic. The PoC does NOT implement any tag's propagation behavior — only the typed
registry and validation skeleton.

## Unblocks (implement follow-ons)

- **`3-lens-prover-and-constraint-attachment`** Phase C: its "reserved tag parser +
  validation (rationale required)" and escalation-policy parser CONSUME this registry
  instead of hand-rolling. This ticket should be added as a prereq of `3-lens-prover` when
  both are scheduled (it has sequence <= 3-lens-prover's seq 3, so the edge is
  invariant-clean).
- **`view-mutation-plan-node-substrate`** Phase-2: the `quereus.update.*` override surface
  validates and reads through this registry (now an explicit prereq edge on that ticket).

## Key validation seeds (for the implement follow-on; not a TODO)

- Unknown `quereus.*` key (`quereus.update.taget`) -> `unknown-reserved-tag` diagnostic at
  the declaring site.
- A `quereus.update.delete_via` on a view-DDL site where only `target`/`exclude` is legal
  -> `tag-not-allowed-here`.
- Empty `quereus.lens.ack.<code>` rationale -> `invalid-tag-value` (meta-warning per
  `docs/lens.md`).
- A valid reserved tag at a legal site -> no diagnostic; `getReservedTag` returns the typed
  value.
- A non-`quereus.*` user tag -> untouched, no diagnostic.

## Out of scope

- Implementing the SEMANTICS of any reserved tag (propagation restriction, `default_for`
  expressions, ack fingerprinting, escalation policy) — those stay in their owning tickets
  (`3-lens-prover`, `view-mutation-plan-node-substrate`).
- Re-touching `complete/3-metadata-tags` (WITH TAGS syntax / hashing / round-trip) or
  `complete/expose-tags-through-introspection` (the `tags` introspection columns).
