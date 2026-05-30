----
description: Resolve the "known blocker" that gates the whole view-mutation substrate — `Map`-valued fields cannot be added to `PhysicalProperties` until `safeJsonStringify` renders `Map`s as a bounded summary and the golden-plan snapshots are regenerated. the EXPLAIN / `query_plan()` physical-block serializer (`func/builtins/explain.ts:170`, `physical = safeJsonStringify(node.physical)`) renders `node.physical`; today `safeJsonStringify` does not handle `Map` (it serializes to `{}`), so the moment `updateLineage` / attribute-default maps land on `PhysicalProperties` the EXPLAIN/`query_plan()` output churns or silently drops them. This ticket teaches the serializer to emit a stable, bounded `Map` summary and regenerates the golden plans, so the next two tickets can thread real `Map` fields without snapshot noise. Pure infrastructure — no view-mutation behavior yet. Design source: `docs/view-updateability.md` § Implementation Surface ("Known blocker to resolve first").
prereq:
files: packages/quereus/src/util/serialization.ts, packages/quereus/src/func/builtins/explain.ts (the `safeJsonStringify(node.physical)` call at line ~170), packages/quereus/test/plan/
----

## Why this lands first and standalone

`view-mutation-physical-lineage` adds `Map`-valued fields (`updateLineage`,
attribute→default) to `PhysicalProperties`. The EXPLAIN / `query_plan()` physical-block
serializer (`func/builtins/explain.ts:170`) serializes `node.physical` via
`safeJsonStringify`. `util/serialization.ts`
today: `safeJsonStringify(obj, space)` wraps `jsonStringify(obj, space)` in a
try/catch; `jsonStringify` calls `JSON.stringify` with an **inline replacer** that
handles only `bigint` (→ number or string) and `Uint8Array` (→ `0x…` hex). There is
no `createReplacer` helper and no circular-reference handling — a `Map` value hits
the default JSON path and serializes to `"{}"`.

So a `Map` field would either (a) vanish into `{}`, hiding the new lineage from
the very surface meant to expose it, or (b) if naively spread into a plain object,
hold plan-node references that are circular/huge. Either way every golden plan that
prints a physical block churns. Fixing the serializer and regenerating goldens as a
**separate, behavior-free commit** keeps the lineage diff in the next ticket clean
and reviewable.

## What lands here

### 1. `safeJsonStringify` renders `Map` as a bounded summary

Extend the inline replacer inside `jsonStringify` (alongside the existing `bigint` /
`Uint8Array` cases) so a `Map` value serializes to a deterministic,
bounded, ordering-stable plain object — not `{}`, not a circular dump. Shape
(implementer's discretion on exact keys, but it must be stable and bounded):

```jsonc
// a Map<K, V> renders as:
{ "$map": [ ["k1", <v1>], ["k2", <v2>], ... ], "size": N }
```

Requirements:

- **Bounded.** Cap the number of entries rendered (e.g. first N by insertion
  order) and record `size` so a large map does not blow up EXPLAIN output. Pick a
  cap consistent with how the codebase already bounds other physical summaries
  (check the FD/key summary rendering in `plan-node.ts` / `explain.ts` for the
  existing convention before inventing a new number). Note `func/builtins/explain.ts`
  also calls `safeJsonStringify` on logical attributes / trace rows (lines ~164, ~541+) —
  the `Map` handling is in the shared serializer, so all call sites benefit uniformly.
- **Deterministic ordering.** Render entries in `Map` insertion order (which is
  deterministic in JS); do not sort by key unless the existing physical summaries
  already sort — match local convention so goldens are stable cross-platform.
- **Values still pass through the replacer.** Nested `bigint` / circular / nested
  `Map` values must continue to be handled (the replacer already runs recursively
  via `JSON.stringify`; ensure the `$map` array entries are plain values that
  re-enter the replacer rather than being pre-stringified).
- **Keys are stringified safely.** `Map` keys here are `AttributeId`s (numbers) or
  strings; render them as their string form.

### 2. Regenerate golden plans

After the serializer change, regenerate the golden-plan snapshots under
`packages/quereus/test/plan/` (and any other golden corpus that prints a physical
block — search for `safeJsonStringify` consumers and `query_plan` golden fixtures
first). No physical `Map` fields exist yet, so this regeneration should be a **no-op
or near-no-op** — the point is to confirm the serializer change alone does not move
goldens, isolating any later churn to the real lineage fields. If a golden DOES move
here, investigate: it means some existing physical field is already a `Map` that was
silently `{}` before, which is exactly the kind of latent bug this ticket should
surface.

## Tests / acceptance

- A focused unit test on `safeJsonStringify` over a `Map` (incl. a `Map` with a
  `bigint` value, a nested `Map`, and a map larger than the cap) asserting the
  `$map` + `size` shape, the entry cap, and that `size` reflects the true count.
- `yarn workspace @quereus/quereus test` green, including the regenerated plan
  goldens.
- EXPLAIN of an existing query still prints byte-identical physical blocks (no
  pre-existing `Map` field surfaced unexpectedly), OR the surfaced field is
  documented in the PR as a pre-existing latent `{}`.

## TODO

- [ ] Extend the inline replacer in `jsonStringify` (`util/serialization.ts`) to render
      `Map` as a bounded `$map` summary (entries re-enter the replacer; record true `size`).
- [ ] Confirm the entry cap matches the existing physical-summary bounding convention.
- [ ] Add unit tests: Map with bigint value, nested Map, over-cap Map.
- [ ] Regenerate `test/plan/` (and any other physical-block golden) corpus; confirm
      the diff is empty or fully explained.
- [ ] Run `yarn workspace @quereus/quereus test` and the lint script; confirm green.
