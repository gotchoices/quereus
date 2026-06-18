description: The "what the value was before" audit/undo info now travels across the JSON wire used between browsers via the sync coordinator; review that it round-trips faithfully and only when it was actually present.
prereq:
files:
  - packages/quereus-sync-client/src/serialization.ts          # client serializeChangeSet/deserializeChangeSet — now carry before-image
  - packages/quereus-sync-client/src/types.ts                  # SerializedChange — added priorValue?/priorHlc?/priorRow?
  - packages/quereus-sync-client/test/serialization.spec.ts    # new "Before-image (prior) round-trip" describe (4 tests)
  - packages/sync-coordinator/src/common/serialization.ts      # coordinator serializeChangeSet/deserializeChangeSet — lockstep, Buffer-based
  - packages/sync-coordinator/test/serialization.spec.ts       # new "before-image (prior) round-trip" describe (4 tests)
  - packages/quereus-sync/src/sync/protocol.ts                  # ColumnChange.priorValue/priorHlc + RowDeletion.priorRow (source of truth, unchanged)
  - packages/quereus-sync/src/metadata/column-version.ts        # encodeSqlValue/decodeSqlValue + present-only pattern reference (unchanged)
difficulty: medium
----

# Review: carry the before-image through the JSON wire transport

## What this implemented

Two completed features added an optional **before-image** to synced changes:

- `ColumnChange.priorValue` / `priorHlc` — per-cell "value this write overwrote".
- `RowDeletion.priorRow` — last-known row image at delete time.

These already round-trip in-process and through the quarantine/CRDT serializers,
but the **JSON wire (de)serializers** used by the coordinator-mediated
(browser ↔ coordinator ↔ browser) path dropped them. This ticket wired them
through both near-duplicate serializers so the before-image survives that path.

This was a pre-existing gap, not a regression.

## Changes made

1. **`SerializedChange` type** (`quereus-sync-client/src/types.ts`) — added three
   optional fields with present-only semantics:
   ```ts
   priorValue?: unknown;   // encodeSqlValue(priorValue) — column, present iff priorHlc
   priorHlc?: string;      // base64-binary HLC — column, present iff priorValue
   priorRow?: unknown[];   // encodeSqlValue per cell — delete, present-only ([] is present)
   ```

2. **Client serializer** (`quereus-sync-client/src/serialization.ts`) — `serialize`
   and `deserialize` now carry the before-image via **conditional spread**:
   - Column branch gates on `priorHlc !== undefined`; when present emits
     `priorValue: encodeSqlValue(c.priorValue ?? null)` and
     `priorHlc: bytesToBase64(serializeHLC(c.priorHlc))` (the same base64-binary
     HLC encoding already used for `hlc` — **not** `hlcToJson`).
   - Delete branch gates on `priorRow !== undefined`, mapping each cell through
     `encodeSqlValue` / `decodeSqlValue`.
   - Added `RowDeletion` to the type import for the delete-branch cast.

3. **Coordinator serializer** (`sync-coordinator/src/common/serialization.ts`) —
   identical logic, only the base64/HLC plumbing differs (`Buffer.from(...).toString('base64')`
   vs the browser-safe `bytesToBase64`). Untyped, so no type plumbing. Added the
   `RowDeletion` import.

4. **Tests** — a new before-image describe block in **both** spec files (4 tests each).

### Shared helper: NOT factored (kept duplicated)

Per the ticket's explicit allowance, the ~6 lines of before-image logic were
**duplicated faithfully** rather than extracted into a shared helper. Reason: the
two serializers live in separate packages and genuinely differ in their base64
plumbing (browser-safe `bytesToBase64`/`base64ToBytes` helpers in the client vs
`Buffer` in the coordinator). A shared helper would have to abstract over the
HLC-base64 codec to be DRY, which is more indirection than the duplication saves.
The two are now byte-for-byte equivalent in logic — **a reviewer should diff the
two `serializeChangeSet`/`deserializeChangeSet` bodies to confirm they stay in
lockstep** (that lockstep is the maintenance risk the duplication introduces).

## Present-only discipline (the crux to verify)

Every before-image field must be **present iff present on the source** — never a
phantom `undefined`/`null` key. The conditional-spread style enforces this. Key
correctness point reviewers should check:

- **Empty-array `priorRow: []` is PRESENT**, not absent. `[].map(...)` is `[]`,
  and `[] !== undefined`, so the gate keeps it. A delete with no `priorRow` stays
  absent. Both directions are asserted.

## Tests added (the floor, not the ceiling)

Both spec files got a before-image describe with these four cases:

- **Absent stays absent** — a column change with no prior and a delete with no
  `priorRow` round-trip with those keys *absent*. Asserted via `'priorValue' in
  change === false` (not merely `=== undefined`, to catch a phantom key) **and**
  on the serialized object (`.to.not.have.property('priorValue')`).
- **Column prior round-trips** incl. `Uint8Array` (exact bytes) and `bigint`
  values, plus matching `priorHlc` wallTime/counter.
- **Delete `priorRow` round-trips** with a mix of `bigint` / string / `Uint8Array`
  / `null` cells.
- **Empty-array boundary** — `priorRow: []` round-trips as present length-0; a bare
  delete round-trips absent. Asserted on both the serialized object and the
  deserialized change.

### Validation run (all green)

- `yarn workspace @quereus/sync-client run typecheck` — clean
- `yarn workspace @quereus/sync-coordinator run typecheck` — clean
- `yarn workspace @quereus/sync-client test` — **49 passing**
- `yarn workspace @quereus/sync-coordinator test` — **125 passing**

## Known gaps / what to scrutinize

- **No end-to-end wire test.** The serializers are tested in isolation
  (serialize → deserialize in one process). There is no integration test that
  pushes a change with a before-image through an actual client → coordinator →
  client hop and asserts the receiver's `applyChanges` sees it. The in-process
  round-trip is a strong proxy, but the real delivery path is untested here.
- **`priorValue ?? null` coercion.** On serialize, a column with `priorHlc` present
  but `priorValue === undefined` (contract says this shouldn't happen — they're
  written together) is coerced to `null`. This mirrors `serializeColumnVersion`
  (`column-version.ts:54`). A genuinely-null prior value (`priorValue: null`)
  round-trips as `null` correctly. Worth confirming the contract guarantee that
  `priorHlc` present ⇒ `priorValue` defined actually holds at every producer, since
  the wire layer now leans on it.
- **`priorHlc` opSeq.** `serializeHLC`/`deserializeHLC` round-trip the full HLC
  including `opSeq` (the prior-HLC test sets `opSeq: 3` but only asserts
  wallTime/counter). If `opSeq` fidelity on the before-image HLC matters to a
  downstream consumer, add an explicit assertion — currently implicit.
- **Untyped coordinator deserialize** casts (`c.priorHlc as string`,
  `c.priorRow as unknown[]`). These match the file's existing style but trust the
  wire shape; a malformed payload would throw inside `decodeSqlValue`/
  `deserializeHLC` rather than be rejected cleanly. Pre-existing posture for this
  file — flagged, not changed.
- **Coordinator test fixture quirk** (unchanged): the existing `makeTestChangeSet`
  helper builds schemaMigrations with `type: 'create-table'` / `sql:` and casts
  `as SchemaMigration`, which does not match the protocol's `create_table` / `ddl`
  shape. The new before-image tests do not touch schemaMigrations, so they sidestep
  this, but it remains a latent inconsistency in that spec.
