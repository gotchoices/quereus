description: Changing a table's primary key in the persistent store currently holds two full copies of the table in memory at once; halve that peak while keeping the change all-or-nothing.
prereq: store-altertable-decompose
files:
  - packages/quereus-store/src/common/store-table.ts   # rekeyRows (~594-632)
  - packages/quereus-store/test/                        # new spec(s)
difficulty: medium
----

# Store: halve `rekeyRows` peak memory, keep it single-batch atomic

`StoreTable.rekeyRows` (`store-table.ts` ~594) re-keys every row under a new
primary-key definition. It drives `ALTER PRIMARY KEY` and `ALTER COLUMN … SET
COLLATE` on a PK member. It runs the data-store rewrite **in place**, after the
enclosing transaction has been flushed (`StoreModule.ddlCommitPendingOps`), with
**no rollback envelope** — the single `batch.write()` at the end is the *only*
thing making the re-key all-or-nothing. That atomicity **must survive** this
change; do NOT chunk-flush the write.

The problem is peak memory, not atomicity. Today it is a two-pass design that
holds the whole table **twice**:

- **Pass 1** iterates every row and fills
  `Map<string, { newKey, oldKey, row }>` — the collision map — holding **every
  row's full payload** plus both key encodings.
- **Pass 2** drains that map into one `store.batch()` of deletes + puts, then
  `batch.write()`.

So peak ≈ (whole table in the map) + (whole table in the batch).

## The change: signatures-only pass 1, re-scan in pass 2

Pass 1's map exists for **collision detection** (two distinct old keys collapsing
to one new key under the new PK / new collation). That needs only the set of new
key *signatures* — not the rows.

- **Pass 1:** iterate, compute each row's `newKey`, hash to `hex =
  bytesToHex(newKey)`. Keep a `Set<string>`; on a repeat, throw `CONSTRAINT`
  before any write (unchanged rejection semantics). Do **not** retain rows or old
  keys.
- **Pass 2:** re-iterate the committed store (unchanged between the two passes —
  we are single-threaded within the ALTER, outside the coordinator, and
  `ddlCommitPendingOps` already flushed, so no other writer). Recompute `newKey`
  per row (cheap — `buildDataKey`), and when `newKey !== oldKey` (the stored
  entry's key), `batch.delete(oldKey)` + `batch.put(newKey, serializeRow(row))`.
  One `batch.write()` at the end — **still a single atomic batch**.

Net peak ≈ one full table (the batch) + a set of key-signature strings, instead
of ~two full tables. The re-scan recompute is O(rows) extra CPU — acceptable for
a DDL operation, and the memory win is the point.

The residual single-batch peak (the pass-2 batch still holds every changed row)
is **irreducible without breaking atomicity** and is tracked separately in
`debt-store-atomic-batch-bounded-memory` — do not attempt it here.

## Edge cases & interactions

- **Collision rejection stays all-or-nothing.** Pass 1 throws before pass 2
  writes anything; the store is untouched on rejection. Preserve the exact
  `QuereusError` message/`StatusCode.CONSTRAINT`.
- **`newKey === oldKey` rows are no-ops** — same as today; skip them in pass 2.
- **Both call sites** pass through: `ALTER PRIMARY KEY`
  (`alterPrimaryKey` arm) uses the default `newColumns`; `SET COLLATE` on a PK
  member passes the post-ALTER `updatedSchema.columns`. The signature must be
  computed under the SAME `newPkDirections` / `newPkCollations` /
  `this.encodeOptions` as pass 2 uses — factor the newKey computation so both
  passes call one helper, so a collision judged in pass 1 is byte-identical to the
  key written in pass 2.
- **OLD key is the stored entry key, verbatim** (never re-encoded) — unchanged.
- **`any`-typed PK members pin BINARY** regardless of declared collation (see
  `any-json-pk-binary-key.spec.ts`) — the existing no-op re-key case; both passes
  compute the same bytes, so it stays a no-op. Keep that test green.
- **Determinism:** pass 1 and pass 2 iterate the same bounds
  (`buildFullScanBounds()`) over the same committed store — the two scans must see
  identical rows. Confirmed safe because nothing writes between them.

## TODO

- Factor the per-row `newKey` computation (directions + collations +
  `encodeOptions`) into a small helper used by both passes.
- Rewrite pass 1 to a `Set<string>` of signatures (collision detect only, no row
  retention); rewrite pass 2 to re-scan and build the single batch. Keep the
  final single `batch.write()`.
- Tests (new spec, or extend an existing `rekey` / ALTER PK spec under
  `packages/quereus-store/test/`):
  - ALTER PRIMARY KEY and SET COLLATE that **collide** under the new key → reject
    all-or-nothing; the table is unchanged (no partial re-key). This is the
    guarantee that must survive the refactor.
  - ALTER PRIMARY KEY on a multi-row table with no collision → every row present
    under the new key, none lost or duplicated, query results correct.
  - Keep the `any`-PK BINARY no-op re-key case green
    (`any-json-pk-binary-key.spec.ts`).
- `yarn workspace @quereus/quereus-store test` + `yarn lint`, streamed with `tee`.

## Notes

Independent of `store-stream-index-builds` (that ticket edits `store-module.ts`;
this edits `store-table.ts`). No `prereq` between them — either may land first.
Chained after `store-altertable-decompose` because the decomposed `alterColumn` /
PK arms are the callers of `rekeyRows`.
