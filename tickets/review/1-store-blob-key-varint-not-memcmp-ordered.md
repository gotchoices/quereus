description: Fixed a persistent-store bug where binary (BLOB) primary keys sorted in the wrong byte order, so range queries over a binary key could silently drop qualifying rows. Blobs now encode so their stored bytes sort the same way SQL compares blobs.
files:
  - packages/quereus-store/src/common/encoding.ts          # encodeBlob/decodeBlob rewrite; new shared escape helpers; varint removed
  - packages/quereus-store/test/pushdown.spec.ts            # new blob-PK range describe block (ASC/DESC + memory-vtab oracle)
difficulty: medium
----

# Review: Store BLOB key encoding — length-prefix → order-preserving escape+terminator

## What was wrong (one paragraph)

The store compares keys byte-for-byte (memcmp). The old `encodeBlob` wrote
`TYPE_BLOB` + varint(length) + raw content, so memcmp hit the length bytes
first: a shorter blob always sorted before a longer one regardless of content
(`x'03'` sorted below `x'0102'`). SQL compares blobs element-by-element
(`x'0102' < x'03'` because `0x01 < 0x03`). Because `StoreModule` advertises
leading-PK range filters as handled and the runtime seeks only the byte window
`buildPKRangeBounds` derives, a mis-ordered window silently skipped qualifying
rows — and `matchesFilters` can only re-filter rows the seek already yielded, so
it cannot recover a skipped one. Result: a wrong (short) answer, no error.

## What changed

Blobs now use the same order-preserving escape+terminator scheme TEXT/OBJECT
already used, minus the collation/UTF-8 step (a blob is already raw bytes):
- Keep the `TYPE_BLOB` (`0x04`) tag.
- Escape each content byte: `0x00`→`0x01 0x01`, `0x01`→`0x01 0x02`.
- Append a `0x00` terminator.

This is memcmp-order-preserving for variable-length byte strings: the terminator
sorts below any escaped continuation (which starts at `0x01`, or a raw byte
`>= 0x02`), so a proper prefix sorts before its extensions, and the escape map is
monotonic in the source byte.

**DRY refactor (kept — stayed readable):** extracted two private helpers in
`encoding.ts` and pointed all three variable-length encoders/decoders at them:
- `writeEscapedWithTerminator(typeTag, bytes)` — used by `encodeText`,
  `encodeObject`, `encodeBlob`.
- `readEscapedUntilTerminator(buffer, offset)` — used by `decodeText`,
  `decodeObject`, `decodeBlob`.

TEXT and OBJECT byte output is **unchanged** — the refactor only moves the
identical loop into a helper (verified: full logic suite green on both memory and
store paths). Only BLOB's on-wire format changed.

**Dead code removed:** `encodeVarInt` / `decodeVarInt` (were used only by the old
blob path; confirmed no other references). The old blob-underflow branch is gone
with them. Header comment (`0x04 - BLOB (length-prefixed)`) and the
`encodeBlob`/`decodeBlob` doc comments updated.

## How to validate / reviewer use cases

Tests added: `packages/quereus-store/test/pushdown.spec.ts`, describe block
`blob primary key range seek (store-blob-key-varint-not-memcmp-ordered)`.

Seed rows (n = row id): `x'0102'`=1, `x'03'`=2, `x'0102ff'`=3. Element-wise order
by b is `x'0102' < x'0102ff' < x'03'` (n = 1, 3, 2). `x'0102ff'` also exercises
prefix < extension.

- **ASC oracle test** — runs `where b >= x'0102' order by b` against BOTH a
  `using store` table and a default in-memory vtab (the full-scan oracle), asserts
  they agree AND equal `[1,3,2]`. This is the red test: under the old encoding the
  store dropped `x'03'` and returned `[1,3]`.
- **ASC strict `>`** — `b > x'0102'` excludes the equal blob → `[3,2]`.
- **DESC** — `b blob primary key desc`, `where b >= x'0102' order by b desc` →
  `[2,3,1]`. Confirms the variable-length scheme stays correct under
  `encodeCompositeKey`'s `^0xff` DESC bit-inversion.

Run just these:
```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/pushdown.spec.ts" --grep "blob"
```
(4 passing — 3 new + the pre-existing point-lookup case.)

Full validation run for this ticket (all green):
- `yarn workspace @quereus/store test` → 682 passing
- `yarn workspace @quereus/store typecheck` → clean
- `yarn test` (all workspaces, memory path) → 6511 + siblings passing, 0 failing
- `yarn test:store` (quereus logic suite over LevelDB store — exercises the real
  seek path) → 6506 passing
- `yarn lint` → clean (`Done in 38s`)

## Reviewer: treat tests as a floor. Suggested probes / known gaps

- **Round-trip / decode coverage is thin.** New tests assert query *results*
  (which exercise encode + seek + `matchesFilters`), but there is no direct
  unit test that `decodeBlob(encodeBlob(x)) === x` for adversarial content —
  specifically blobs containing `0x00` and `0x01` bytes (the escaped ones) and an
  empty blob `x''`. The escape/un-escape is shared with TEXT (well-exercised) and
  the store logic suite decodes keys throughout, but a focused encode/decode
  round-trip test on `x'00'`, `x'01'`, `x'0001'`, `x''` would harden it. Worth
  adding.
- **Cross-type ordering at the type-band boundary.** Blobs stay in the `0x04`
  band, so BLOB-vs-TEXT/INTEGER ordering is by type tag as before — unchanged, but
  not explicitly asserted.
- **Multi-column PK with a trailing blob** (blob as a *non-leading* composite PK
  member) is not directly tested here; the terminator makes each component
  self-delimiting so composite decode should be fine, but a `(int, blob)` PK range
  case would confirm the boundary between components.
- **Empty blob `x''`** encodes to `04 00` (tag + terminator) — sorts below any
  non-empty blob, which is correct (empty < anything). Not asserted; easy to add.

## On-disk format change (flag, not a blocker)

This changes the persisted byte layout of BLOB keys. Any store data written by a
prior version with a blob primary/index key will not decode or sort correctly
after this change. Per `AGENTS.md` ("Backwards compat: don't worry yet") no
migration path is included and none was requested. Reviewer: confirm that stance
is still acceptable; if a real on-disk store predates this, it needs a rebuild.

## Review findings

- Tripwire (storage size): the escape scheme worst-cases at ~2× bytes for a blob
  that is all `0x00`/`0x01`. Fine for keys (typically small); no code NOTE added
  since it mirrors the long-standing TEXT/OBJECT behavior. Parked here only.
- Gap noted above: no direct `decode(encode(x))` round-trip unit test for
  escaped-byte / empty blobs — results-level tests cover the reported bug but a
  reviewer may want the focused round-trip added before closing.
