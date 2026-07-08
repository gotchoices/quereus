description: Fixed a persistent-store bug where binary (BLOB) primary keys sorted in the wrong byte order, so range queries over a binary key could silently drop qualifying rows. Blobs now encode so their stored bytes sort the same way SQL compares blobs.
files:
  - packages/quereus-store/src/common/encoding.ts   # encodeBlob/decodeBlob rewrite; shared escape helpers; varint removed
  - packages/quereus-store/test/pushdown.spec.ts     # blob-PK range describe block (ASC/DESC + memory-vtab oracle)
  - packages/quereus-store/test/encoding.spec.ts     # review-added: blob sort-order + DESC-blob unit tests
difficulty: medium
----

# Complete: Store BLOB key encoding — length-prefix → order-preserving escape+terminator

## What shipped

BLOB primary/index keys now encode via the same order-preserving escape+terminator
scheme TEXT/OBJECT already used (minus collation/UTF-8, since a blob is already raw
bytes): `TYPE_BLOB` tag, each content `0x00`→`0x01 0x01` / `0x01`→`0x01 0x02`, then a
`0x00` terminator. Fixes the old `length-prefix + raw content` layout, where memcmp hit
the length bytes first and sorted a shorter blob before a longer one regardless of
content (`x'03'` below `x'0102'`). Because `StoreModule` advertises leading-PK range
filters as handled and the runtime seeks only the derived byte window, a mis-ordered
window silently skipped qualifying rows (`matchesFilters` can only re-filter rows the
seek already yielded — it cannot recover a skipped one). Result was a wrong short answer,
no error.

Refactor extracted `writeEscapedWithTerminator` / `readEscapedUntilTerminator` shared by
all three variable-length encoders/decoders. TEXT/OBJECT on-wire bytes unchanged; only
BLOB's format changed. Dead `encodeVarInt`/`decodeVarInt` removed.

## Review findings

**Scope reviewed:** full implement diff (`encoding.ts` rewrite + `pushdown.spec.ts`),
the escape-scheme order-preservation reasoning, DESC bit-inversion interaction, dead-code
removal, doc/comment accuracy, and test coverage across every value type.

- **Correctness — order preservation: CONFIRMED sound.** Terminator `0x00` sorts below
  any escaped continuation (`0x01…`) or raw byte (`>=0x02`), so prefix < extension; escape
  map is monotonic in the source byte. Holds under DESC `^0xff` inversion (inverted
  terminator `0xff` becomes the high byte, reversing order correctly). Verified by
  reasoning and by the added unit tests.

- **Test coverage — gap found and FIXED INLINE (minor).** Every other value type
  (INTEGER/REAL/TEXT) had a `compareBytes` sort-order unit test in `encoding.spec.ts`;
  BLOB — the exact type this ticket fixes — did **not**. Added:
  - `should preserve blob sort order (element-wise, matching SQL)` — asserts the full
    ordering `x'' < x'00' < x'0000' < x'01' < x'0102' < x'0102ff' < x'02' < x'03' < x'ff'`,
    covering the reported bug (`x'0102' < x'03'`), prefix<extension, empty<non-empty, and
    escaped content bytes `0x00/0x01/0x02` in order. This is the red test at the unit
    level (old encoding sorted `x'03'` before `x'0102'`).
  - `single DESC BLOB inverts variable-length order under bit inversion` — mirrors the
    existing DESC INTEGER/TEXT/REAL cases, which had no BLOB variant.
  Both pass; store suite now 684 passing (was 682).

- **Implementer's flagged "round-trip decode gap" — NOT actually a gap.** The handoff
  worried no direct `decodeBlob(encodeBlob(x))` test existed for escaped/empty content.
  It already does: `encoding.spec.ts` `should encode and decode blobs` round-trips
  `[0,1,2,3]` (exercises the escaped `0x00`/`0x01`) and `x''`. The real hole was
  *sort-order* coverage, now closed above. No further round-trip test needed.

- **Dead code removal — CONFIRMED clean.** `encodeVarInt`/`decodeVarInt` referenced
  nowhere outside the ticket text after removal (grep verified). Header comment and
  encode/decode doc comments updated to the new format.

- **DESC decode path (not this ticket's bug; noted).** `decodeCompositeKey` takes no
  `directions` and does not un-invert DESC components before decoding to values — a
  pre-existing property shared by TEXT/OBJECT/INTEGER, unchanged here. It does not affect
  the store *seek* path (which compares raw inverted bytes), which is what the reported
  bug and the new tests exercise. Flagging only so a future reader doesn't mistake it for
  a regression from this change; if value-level decode of DESC keys is ever needed, it is
  a separate, older concern.

- **Cross-type / non-leading-blob-in-composite ordering — not explicitly asserted.**
  Blobs stay in the `0x04` type band so BLOB-vs-other ordering is by type tag as before
  (unchanged). A `(int, blob)` composite-PK range case isn't directly tested, but the
  terminator makes each component self-delimiting, and the added DESC/ASC single-blob unit
  tests plus the existing composite decode tests cover the mechanism. Low risk; left as
  suggested future coverage, not filed — no defect identified.

### Tripwire (recorded, not a ticket)

- **Storage size ~2× worst case** for a blob that is all `0x00`/`0x01`. Fine for keys
  (typically small) and mirrors the long-standing TEXT/OBJECT behavior. No code `NOTE:`
  added since the scheme is now shared and the property is documented in
  `writeEscapedWithTerminator`'s doc comment. Parked here.

### On-disk format change (flagged, accepted)

BLOB key byte layout changed on disk. Store data written by a prior version with a blob
primary/index key will not decode or sort correctly after this change. Per AGENTS.md
("Backwards compat: don't worry yet") no migration is included and none was requested —
a real pre-existing on-disk store with blob keys would need a rebuild. Accepted stance,
not a blocker.

## Validation (all green)

- `yarn workspace @quereus/store test` → 684 passing (682 prior + 2 review-added)
- `yarn workspace @quereus/store typecheck` → clean (exit 0)
- Implement-stage full runs (unchanged by review edits): `yarn test` all workspaces,
  `yarn test:store` LevelDB seek path, `yarn lint` — all green per handoff.
