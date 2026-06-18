description: When changes travel through the sync coordinator between browsers, the extra "what the value was before" audit/undo information is silently dropped; carry it across the JSON wire so receivers on that path see it.
prereq:
files:
  - packages/quereus-sync-client/src/serialization.ts          # serializeChangeSet/deserializeChangeSet — drops before-image (client side)
  - packages/quereus-sync-client/src/types.ts                  # SerializedChange interface — needs the optional before-image fields
  - packages/quereus-sync-client/test/serialization.spec.ts    # add round-trip tests (client)
  - packages/sync-coordinator/src/common/serialization.ts      # same JSON (de)serializer on the coordinator side (untyped)
  - packages/sync-coordinator/test/serialization.spec.ts       # add round-trip tests (coordinator)
  - packages/quereus-sync/src/sync/protocol.ts                  # ColumnChange.priorValue/priorHlc + RowDeletion.priorRow (source of truth)
  - packages/quereus-sync/src/metadata/column-version.ts        # encodeSqlValue/decodeSqlValue (reuse for payload)
  - packages/quereus/src/common/types.ts                        # Row = SqlValue[]
difficulty: medium
----

# Carry the before-image through the JSON wire transport

## Problem

Two completed features added an optional **before-image** to synced changes:

- `ColumnChange.priorValue` / `priorHlc` — per-cell "value this write overwrote".
- `RowDeletion.priorRow` — last-known row image at delete time.

(Source of truth: `packages/quereus-sync/src/sync/protocol.ts:20-59`.)

These round-trip in-process and through the quarantine/CRDT serializers, but the
**JSON wire (de)serializers** used by the coordinator-mediated path drop them
entirely. Those two serializers are near-duplicates:

- `packages/quereus-sync-client/src/serialization.ts` — `serializeChangeSet` /
  `deserializeChangeSet` (typed against `SerializedChangeSet`).
- `packages/sync-coordinator/src/common/serialization.ts` — same functions,
  untyped (`serializeChangeSet(cs): object`, `deserializeChangeSet(cs: unknown)`).

Both only emit `type / schema / table / pk / hlc` (+ `column / value` for column
changes). For a browser ↔ coordinator ↔ browser deployment this JSON boundary is
the **primary delivery path**, so the before-image never reaches receivers there.

This is a pre-existing gap, not a regression.

## Encoding decisions (match surrounding code)

The wire serializers already encode each per-change `hlc` as **base64-of-binary**:

- client: `bytesToBase64(serializeHLC(c.hlc))` ⇄ `deserializeHLC(base64ToBytes(...))`
- coordinator: `Buffer.from(serializeHLC(c.hlc)).toString('base64')` ⇄
  `deserializeHLC(Buffer.from(..., 'base64'))`

So **`priorHlc` reuses that exact base64-binary HLC encoding** — *not* `hlcToJson`
(the ticket left this open; base64-binary is what matches the file). SqlValues
already go through `encodeSqlValue`/`decodeSqlValue` (imported in both files);
reuse those for `priorValue` and for each `priorRow` cell.

`Row = SqlValue[]` (`packages/quereus/src/common/types.ts:28`), so `priorRow`
serializes as `priorRow.map(encodeSqlValue)` and deserializes as
`(arr).map(decodeSqlValue)`.

## Present-only discipline (the crux)

Every before-image field must be **present iff it was present on the source** —
never emit a phantom `undefined`/`null` key. Use conditional spread, matching the
discipline in `serializeColumnVersion` (`column-version.ts:49-62`):

- `ColumnChange`: write `priorValue` **and** `priorHlc` together or not at all.
  Gate on `priorHlc !== undefined` (per protocol contract: "Present iff
  `priorValue` is"). When present, emit `priorValue: encodeSqlValue(c.priorValue ?? null)`
  and `priorHlc: <base64-HLC>(c.priorHlc)`. On deserialize, only set them when the
  serialized key is present.
- `RowDeletion`: gate on `priorRow !== undefined`. Critically, an **empty array
  `[]` is present** — `[].map(...)` is still `[]`, and `[] !== undefined`, so the
  conditional spread naturally preserves the empty-array-present vs absent
  boundary. Do **not** collapse `[]` to absent.

Sketch (client `serializeChangeSet`, column branch):

```ts
if (c.type === 'column') {
  const cc = c as ColumnChange;
  return {
    ...base,
    column: cc.column,
    value: encodeSqlValue(cc.value),
    ...(cc.priorHlc !== undefined
      ? { priorValue: encodeSqlValue(cc.priorValue ?? null),
          priorHlc: bytesToBase64(serializeHLC(cc.priorHlc)) }
      : {}),
  };
}
// delete branch:
const rd = c as RowDeletion;
return {
  ...base,
  ...(rd.priorRow !== undefined
    ? { priorRow: rd.priorRow.map(v => encodeSqlValue(v)) }
    : {}),
};
```

Deserialize mirrors it: build `base`, then conditionally attach `priorValue`/
`priorHlc` (when the serialized object has `priorHlc`) and `priorRow` (when the
serialized object has `priorRow`, mapping each cell through `decodeSqlValue`).
Keep the conditional-spread style so absent stays absent (not `undefined`).

Keep the two serializers **in lockstep** — identical logic, only the
base64/HLC plumbing differs (browser-safe helpers vs `Buffer`). A shared helper
would be ideal but is explicitly not required; if it's clean, factor one, but
duplicating the ~6 lines of logic faithfully is acceptable. The coordinator
serializer is untyped, so no type plumbing there.

## Types (client only)

Extend `SerializedChange` in `packages/quereus-sync-client/src/types.ts:231` with
the optional fields so the typed client serializer compiles without casts:

```ts
export interface SerializedChange {
  type: 'column' | 'delete';
  schema: string;
  table: string;
  pk: unknown[];
  column?: string;
  value?: unknown;
  hlc: string;
  priorValue?: unknown;   // encodeSqlValue(priorValue) — column, present iff priorHlc
  priorHlc?: string;      // base64-binary HLC — column, present iff priorValue
  priorRow?: unknown[];   // encodeSqlValue per cell — delete, present-only ([] is present)
}
```

## Tests

Add round-trip tests to **both** spec files
(`packages/quereus-sync-client/test/serialization.spec.ts`,
`packages/sync-coordinator/test/serialization.spec.ts`), covering:

- **Absent before-image stays absent** — a column change with no `priorValue`/
  `priorHlc` and a delete with no `priorRow` round-trip with those keys *absent*
  (assert `'priorValue' in change === false`, etc. — not merely `=== undefined`,
  to catch a phantom key). Also assert the *serialized* object lacks the keys.
- **Present column prior round-trips** incl. `Uint8Array` and `bigint` values
  (and matching `priorHlc` wallTime/counter); verify `priorValue` decodes back to
  the exact bytes / bigint.
- **Delete `priorRow` round-trips** with a mix incl. `Uint8Array`, `bigint`, and
  `null` cells.
- **Empty-array boundary** — `priorRow: []` round-trips as a present `[]` (length
  0, not absent); a delete with no `priorRow` round-trips as absent.

Note the existing coordinator test helper builds schemaMigrations with
`type: 'create-table'` / `sql:` (not the protocol's `create_table` / `ddl`) and
casts `as SchemaMigration` — don't be misled; follow the protocol shape from
`protocol.ts` for any new fixtures, or mirror the file's existing local style for
consistency within that spec.

## Validation

Run from repo root (stream output, don't silently redirect):

- `yarn workspace @quereus/sync-client test 2>&1 | tee /tmp/sc.log; tail -n 40 /tmp/sc.log`
  (confirm the actual workspace/package name from each package.json — adjust if it differs)
- `yarn workspace <coordinator-pkg> test 2>&1 | tee /tmp/coord.log; tail -n 40 /tmp/coord.log`
- A build/typecheck of the touched packages to catch the new `SerializedChange`
  fields and the typed client serializer.

If the runner's full `yarn test` is faster to reason about, use it — but make sure
both serialization specs actually execute.

## TODO

- [ ] Extend `SerializedChange` in `quereus-sync-client/src/types.ts` with
      `priorValue?`, `priorHlc?`, `priorRow?` (present-only semantics).
- [ ] Update client `serializeChangeSet`/`deserializeChangeSet`
      (`quereus-sync-client/src/serialization.ts`) to carry the before-image
      via conditional spread; `priorHlc` as base64-binary HLC, `priorValue`/
      `priorRow` cells via `encodeSqlValue`/`decodeSqlValue`. Import `serializeHLC`
      is already present; add `RowDeletion` type import if needed for the cast.
- [ ] Apply the identical logic to the coordinator serializer
      (`sync-coordinator/src/common/serialization.ts`), keeping the two in
      lockstep (Buffer-based base64). Add any needed imports (`serializeHLC` is
      already imported; `RowDeletion` may be needed).
- [ ] Add the round-trip tests above to both spec files (absent-stays-absent,
      column prior incl. Uint8Array/bigint, delete priorRow incl.
      Uint8Array/bigint/null, empty-array present-vs-absent boundary).
- [ ] Run both serialization test suites + a typecheck/build of the touched
      packages; confirm green. Stream output via `tee`.
- [ ] Note in the review handoff whether you factored a shared helper or kept
      the two duplicated (and why).
