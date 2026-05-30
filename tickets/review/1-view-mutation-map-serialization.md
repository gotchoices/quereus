description: Review the serializer-infrastructure change that unblocks `Map`-valued `PhysicalProperties` fields. `safeJsonStringify`/`jsonStringify` now render a `Map` as a bounded, deterministic `{ "$map": [...], "size": N }` summary instead of the default `{}`, so the next two view-mutation tickets can thread real `Map` fields (`updateLineage`, attribute→default) onto `PhysicalProperties` without EXPLAIN / `query_plan()` golden churn. Pure infrastructure — no view-mutation behavior. Verify the summary shape/cap/ordering, recursive value handling, and that no golden moved.
prereq:
files: packages/quereus/src/util/serialization.ts (the `jsonStringify` inline replacer + new `MAP_SUMMARY_ENTRY_CAP`), packages/quereus/test/util/serialization.spec.ts (new unit tests), packages/quereus/src/func/builtins/explain.ts (the `safeJsonStringify(node.physical)` consumer at ~line 170, plus logical-attr/trace consumers at ~164/~541), packages/quereus/src/planner/util/fd-utils.ts (MAX_FDS_PER_NODE/MAX_INDS_PER_NODE = 64, the cap convention matched), packages/quereus/src/planner/framework/serialization.ts (the OTHER serializer — `serializePhysicalProperties`, used by the golden path; NOT touched here)

# View-Mutation `Map` Serialization — Review Handoff

## Summary

`safeJsonStringify` (via the shared `jsonStringify` inline replacer in
`util/serialization.ts`) now renders any `Map` value as a deterministic, bounded
plain-object summary rather than the default `{}` that `JSON.stringify` produces
for a Map (a Map has no enumerable own properties). This is the "known blocker"
from `docs/view-updateability.md` § Implementation Surface: until the serializer
handled `Map`, the moment a `Map`-valued field (`updateLineage`, attribute→default)
lands on `PhysicalProperties`, the EXPLAIN / `query_plan()` physical block would
silently drop it (`{}`) or churn every golden. This commit is behavior-free
infrastructure so the lineage diff in the follow-up tickets stays clean.

## What shipped

- **`Map` branch in the replacer** (`util/serialization.ts`): a `Map<K,V>` renders as

  ```jsonc
  { "$map": [ ["k1", <v1>], ["k2", <v2>], ... ], "size": N }
  ```

  - **Deterministic order** — entries in `Map` insertion order (JS-deterministic);
    no key sort (matches local convention — the FD/binding/domain summaries don't
    sort either).
  - **Recursive** — entries are plain `[String(key), value]` pairs that *re-enter*
    the same replacer, so nested `bigint` / `Uint8Array` / nested `Map` values are
    handled exactly as at top level (values are NOT pre-stringified).
  - **Keys stringified** — `String(k)`; covers `AttributeId` (number) and string
    keys, which are the intended `updateLineage` / attribute-default key types.
  - **Bounded** — entries capped at `MAP_SUMMARY_ENTRY_CAP`; `size` always records
    the *true* count even when truncated.
- **`MAP_SUMMARY_ENTRY_CAP = 64`** — new exported const. Chosen to match the
  existing physical-summary bounding convention (`MAX_FDS_PER_NODE` /
  `MAX_INDS_PER_NODE = 64` in `planner/util/fd-utils.ts`), per the ticket's
  instruction to not invent a new number. (The ticket's example sketch said
  "first N"; 64 is that N.)
- **`safeJsonStringify` unchanged** — still wraps `jsonStringify` in the existing
  try/catch fallback. All call sites (explain physical block, logical attributes,
  trace rows in `func/builtins/explain.ts`) benefit uniformly since the handling
  lives in the shared serializer.

## Tests added

`packages/quereus/test/util/serialization.spec.ts` (9 cases, all green):
- `$map` + `size` shape for a basic Map.
- Insertion order preserved (not sorted by key).
- Numeric (AttributeId-style) keys stringified.
- **bigint values** re-enter the replacer (safe-int → number; oversized → string).
- **nested Map** rendered recursively as a nested `$map` summary.
- **over-cap Map** (`CAP + 17`): rendered length == cap, `size` == true count,
  first-N-by-insertion-order retained.
- Map nested inside a plain object.
- empty Map → `{ $map: [], size: 0 }`.
- regression: top-level bigint / Uint8Array still serialize as before.

## Validation performed

- Focused unit spec — **9 passing**.
- Plan + golden tests (`test/plan/**/*.spec.ts`) — **66 passing, zero churn**.
  The 3 golden fixtures (`basic/simple-select`, `aggregates/group-by`,
  `joins/simple-join`, each `.logical.json` + `.physical.json`) are byte-identical;
  no `UPDATE_PLANS` regeneration was needed (confirming no existing physical field
  was a latent `Map`-as-`{}`).
- `yarn typecheck` (tsc --noEmit) — clean.
- `yarn lint` (eslint src + test) — clean.
- Full suite `yarn workspace @quereus/quereus test` — **4004 passing, 0 failing,
  9 pending** for the `@quereus/quereus` package (other workspaces also green;
  the whole `yarn test` run exited 0). The 9 pending are pre-existing skips
  unrelated to this change. No new failures; nothing was skipped or worked around.
- `git status` confirms the diff is exactly two files: the serializer and its spec.

## Notes / things for the reviewer to scrutinize

- **Golden path vs EXPLAIN path are different serializers — this is the key risk
  for the NEXT ticket.** The `test/plan/` golden corpus serializes plan trees via
  `serializePlanTree` (`planner/debug.ts`) → `safeJsonStringify` of a
  `PlanNodeDebugInfo` whose `properties` are built by `processValue`. Crucially,
  `serializePlanTree`'s property walk **skips** the live `physical` getter (it only
  enumerates own-enumerable fields and skips nested plan-node refs), so the
  golden JSON does NOT currently contain a serialized `physical` block at all —
  which is why this change cannot move the goldens, and the empty-diff result
  confirms it. Only the EXPLAIN / `query_plan()` columns use `safeJsonStringify`
  on `node.physical` directly. **Implication for `view-mutation-physical-lineage`:**
  when it threads a real `Map` field onto `PhysicalProperties`, it should verify
  *which* surface is expected to expose it (`query_plan().properties` per the
  doc § Information Schema Surface) and add coverage there — the static
  `test/plan/` JSON goldens may not exercise it. Also note
  `planner/framework/serialization.ts` defines a separate
  `serializePhysicalProperties`; if a future consumer routes physical props
  through *that* instead of `safeJsonStringify`, Map handling would need to be
  taught there too. This ticket fixed only the `safeJsonStringify` path, as scoped.
- **No circular-reference handling was added** (out of scope). A `Map` whose
  values hold circular plan-node references still throws inside `JSON.stringify`
  and is caught by `safeJsonStringify`'s existing try/catch → fallback string.
  The follow-up ticket should ensure the `Map` fields it adds contain
  serialization-safe data (ids/enums/expr strings), not live node references.
- **Cap = 64** is generous for per-output-column lineage maps (tables rarely
  exceed a few dozen columns); truncation is a pathological-plan safety valve, not
  an expected case. Unlike the FD/binding caps in `fd-utils.ts`, a truncated
  `$map` does **not** emit a debug-log line — `size` vs rendered length is the only
  signal. Flag if you want a parity log line; I judged it unnecessary for a
  display-only summary.
- **`$map` key collision:** a user-constructed plain object literally containing a
  `"$map"` key would be indistinguishable from a serialized Map in the output.
  This is a theoretical ambiguity only — `PhysicalProperties` is engine-controlled
  and contains no such key. Noting for completeness.

## Known gaps (reviewer: treat tests as a floor)

- The unit tests assert the serializer in isolation. There is **no** end-to-end
  test that runs `EXPLAIN` / `query_plan()` over a query whose `node.physical`
  actually contains a `Map` — because no such field exists yet (that's the next
  ticket). The acceptance claim "EXPLAIN prints byte-identical physical blocks" is
  verified by reasoning (the new branch only fires for `value instanceof Map`,
  which no current physical field is) + the zero-churn golden run, not by a
  Map-bearing EXPLAIN fixture. A reviewer wanting belt-and-suspenders could add a
  throwaway test that stuffs a `Map` onto a node's physical props and EXPLAINs it,
  but that's arguably the next ticket's job.
- Key stringification uses `String(k)`. For the intended key types (number
  `AttributeId`, string) this is unambiguous, but exotic key types (objects,
  symbols) would stringify lossily (`"[object Object]"`). Not a concern for the
  declared use, noted for completeness.
