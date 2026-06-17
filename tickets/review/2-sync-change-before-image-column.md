description: A write now remembers the value it overwrote (and when), and carries that "before" snapshot alongside each synced column change, so a receiving replica can see what changed from what without a separate lookup.
prereq:
files:
  - packages/quereus-sync/src/sync/protocol.ts                  # ColumnChange.priorValue/priorHlc, ConflictContext.remotePrior*
  - packages/quereus-sync/src/sync/events.ts                    # ConflictEvent.remotePrior*
  - packages/quereus-sync/src/metadata/column-version.ts        # ColumnVersion.priorHlc/priorValue + (de)serialize
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # recordColumnVersions, resolveLogEntry, collectAllChanges
  - packages/quereus-sync/src/sync/change-applicator.ts         # commitColumnMetadata, resolveChange enrichment
  - docs/sync.md                                                # § Data Structures, § Pluggable Conflict Resolution, § Reactive Hooks
  - packages/quereus-sync/test/metadata/column-version.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - packages/quereus-sync/test/sync/conflict-resolvers.spec.ts
difficulty: medium
----

# Review: inline per-cell before-image on `ColumnChange`

## What was built

An optional, purely-additive per-cell **before-image** mirroring Lamina's
`UpdateCellFact(new_value, prior_value?, prior_hlc?)`. A write now records the cell
version it overwrote, and that `(priorValue, priorHlc)` pair rides on the synced
`ColumnChange` and is surfaced to conflict resolvers — for audit trails, undo, and
conflict debugging — without a second lookup.

### Phase 1 — types & persistence
- `ColumnChange` (protocol.ts): added `priorValue?: SqlValue`, `priorHlc?: HLC`.
- `ConflictContext` (protocol.ts): added `remotePriorValue?`, `remotePriorHlc?`.
- `ConflictEvent` (events.ts): added `remotePriorValue?`, `remotePriorHlc?`.
- `ColumnVersion` (column-version.ts): added `priorHlc?`, `priorValue?`.
- **Serialization format changed** (back-compat not required per AGENTS.md): still
  `30-byte HLC prefix + JSON`, but the JSON is now a self-describing payload
  `{ v, pv?, ph? }` — `v`/`pv` via the existing `encodeSqlValue`/`decodeSqlValue`
  (so `Uint8Array`/`bigint` priors round-trip), `ph` via `hlcToJson`/`hlcFromJson`.
  `deserializeColumnVersion` is **absent-tolerant**: a prior-less record yields a
  `ColumnVersion` with neither field present (no phantom `undefined`).

### Phase 2 — producer & apply plumbing
- `recordColumnVersions`: when `oldVersion` exists, sets `priorHlc`/`priorValue`
  (from the prior **CRDT cell version**, not `oldRow[i]`) on both the persisted
  `ColumnVersion` **and** the inline `ColumnChange`. First write → both omitted.
- `resolveLogEntry` + `collectAllChanges`: copy the stored `cv.priorHlc/priorValue`
  onto the resolved `ColumnChange` (conditional spread — absent stays absent).
- `commitColumnMetadata`: persists the before-image from **`oldColumnVersion`**
  (the receiver's local lineage), keeping it symmetric with `recordColumnVersions`.
- `resolveChange`: passes the *incoming* change's `priorValue`/`priorHlc` into the
  `ConflictContext` and both `emitConflictResolved` calls. Resolution logic is
  unchanged; the no-resolver/no-prior fast path stays byte-identical (the spread is
  empty when absent, and `ConflictContext` is only built when a resolver is set).

### Phase 3 — tests & docs
- `column-version.spec.ts`: round-trip with/without prior; `null`, `Uint8Array`,
  and `bigint` prior values; explicit "absent, not undefined" assertions.
- `sync-protocol-e2e.spec.ts` (new "Before-image (per-cell prior)" block): first
  insert omits prior + later overwrite carries the exact overwritten HLC; relay
  preserves the origin's prior chain; in-batch dedup keeps the **pre-batch** prior.
- `conflict-resolvers.spec.ts` (new "Remote before-image exposure" block): resolver
  observes `remotePriorValue`/`remotePriorHlc`; no-resolver LWW conflict still emits
  the before-image on the `ConflictEvent`; first-write incoming change omits both.
- `docs/sync.md`: § Data Structures (the before-image + its semantics, incl. the
  "no re-read" optimization intentionally not taken), § Pluggable Conflict
  Resolution (the `ctx.remotePrior*` fields), § Reactive Hooks (`ConflictEvent`).

## Validation run

- `yarn workspace @quereus/sync test` → **290 passing, 0 failing** (11 new). NOTE the
  ticket said `@quereus/quereus-sync`; the actual workspace name is **`@quereus/sync`**.
  (The `[Sync] Error handling transaction commit` lines in output are pre-existing
  intentional error-injection tests in `sync-manager.spec.ts`, not failures.)
- `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit` (strict, src + tests) → clean.
- `yarn lint` → exit 0 (note: only lints `@quereus/quereus`, which this ticket does
  not touch; there is **no eslint config covering `quereus-sync`** — the strict
  typecheck above is the real type gate for this work).

## KEY DESIGN DECISION the reviewer should scrutinize

**The stored before-image is treated as *replica-local lineage*, not a globally
invariant property of `(value, hlc)`.** `commitColumnMetadata` persists the prior
from `oldColumnVersion` (what *this* replica overwrote), exactly as the ticket's
Phase-2 instruction states — **not** from the incoming `change.priorValue/priorHlc`.

Consequence (best-effort, by design):
- **Causal-order / incremental delivery** (receiver got v1 then v2 in separate
  rounds): the receiver's `oldColumnVersion` for v2 *is* v1, so the stored prior
  equals the origin's prior and re-relay preserves the chain. ✔ Tested.
- **Dedup'd single delta to a fresh receiver** (receiver never saw v1; gets only the
  surviving v2 carrying `prior=(v1,h1)` on the wire): apply finds no local version,
  so `oldColumnVersion` is undefined and the receiver stores v2 with **no** prior —
  the origin's chain is **not** persisted past this hop. The wire change still
  carried it, and the resolver still saw it via `remotePrior*`, but it is dropped
  from storage.

I read the ticket's two explicit "persist from `oldColumnVersion`" instructions as
the authoritative intent and did **not** add a `?? change.prior` fallback. If the
reviewer/product wants the chain preserved even through a fresh-receiver dedup'd
delta, the minimal change is: in `commitColumnMetadata`, fall back to
`change.priorHlc/priorValue` when `oldColumnVersion` is undefined. That is strictly
more chain-preserving and safe (the fallback only triggers on a true first-write,
where the incoming prior is the only prior info available), but it diverges from the
literal instruction and changes the meaning of "prior" from local-lineage to
origin-lineage. **This is a genuine design fork — please confirm which semantics are
wanted.** It is documented in `docs/sync.md` § Data Structures and in a code comment
on `commitColumnMetadata`.

## Known gaps / where tests are a floor, not a ceiling

- **No negative test for the dropped-chain case above.** The relay test only
  exercises the causal-order path (chain preserved). The fresh-receiver dedup'd-delta
  path (chain dropped) is documented but not asserted. Worth a deliberate
  assertion once the semantics fork is resolved.
- **In-memory store only.** `test:store` (LevelDB) was not run (slow; not
  agent-runnable in-budget). The serialization format changed, and the store path
  round-trips through the same `serialize/deserialize`, so it *should* be fine, but a
  LevelDB-backed round-trip of a prior-bearing `ColumnVersion` is unverified here.
- **Snapshot paths** (`snapshot.ts`, `snapshot-stream.ts`) deliberately reconstruct
  prior-less cells (a snapshot is a fresh basis). Verified by inspection that they
  only read `hlc`/`value` and construct `{ hlc, value }`; relying on existing
  snapshot tests for regression rather than a dedicated "snapshot drops prior" assert.
- **Equal-HLC `priorHlc` disambiguation** is only checked via round-trip; there is no
  test proving "no resolution logic keys off `priorHlc`" beyond the unchanged
  fast-path tests (it is informational by construction).
- **Existing `onConflictResolved` consumers**: the new fields are optional/additive;
  existing tests pass unchanged, but no audit was done of out-of-repo listeners.

## Suggested review focus

1. Confirm the local-lineage vs origin-lineage semantics fork (above) — the single
   most consequential decision.
2. Verify the conditional-spread pattern never emits explicit `undefined`/`null`
   keys on the wire (JSON transports must not carry phantom nulls) — see
   `recordColumnVersions`, `resolveLogEntry`, `collectAllChanges`, `resolveChange`.
3. Confirm the fast path (no `conflictResolver`, no prior) is truly unchanged.
4. Sanity-check the serialization payload `{ v, pv?, ph? }` for falsy priors
   (`0`/`false`/`''`/`null`) — the gate keys off `priorHlc !== undefined`, not value
   truthiness, and `encodeSqlValue(priorValue ?? null)` only coerces null/undefined.
