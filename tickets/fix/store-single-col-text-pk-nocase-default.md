description: Under the LevelDB store backend, a single-column TEXT PRIMARY KEY column appears to default to NOCASE collation while the memory backend uses BINARY for identical DDL. Confirm whether this memory↔store collation-default divergence is intended; if not, align them. Surfaced during review of authored-bijection-pk-reconstructible.
files:
  - packages/quereus-plugin-leveldb/        # store backend PK/collation handling
  - packages/quereus/src/schema/table.ts    # PK / column collation defaults (memory reference)
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic  # scenarios 18/19 deliberately use INTEGER keys to dodge this

# Store single-column TEXT PK → NOCASE collation default (memory↔store divergence)

## Observed

While implementing/​reviewing the authored-bijection PK reconstructibility work, the
implementer observed that under the LevelDB store backend a **single-column TEXT
`primary key`** column is assigned **NOCASE** collation, whereas the in-memory
backend assigns **BINARY** for the *same* DDL.

Downstream effect that exposed it: the lens prover proves an authored
`upper(code)/lower(grp)` inverse a **bijection** only when the basis column's CHECK
in-list is *value-discriminating*. Under NOCASE, `'a' ≡ 'A'`, so a text CHECK in-list
is not value-discriminating and the value-discrimination gate in
`extractCheckConstraints` correctly drops the enum domain → the bijection cannot be
proven → an authored **text** PK stays **read-only** under store while it is
**writable** under memory. That divergence is *sound* (conservative) given the
collation, but the underlying collation-default difference for a text PK is the root
cause and looks unintended.

To keep the new lens sqllogic scenarios (55.5 scenarios 18/19) behaving identically
on both backends, they were written with **INTEGER** keys, which carry no collation
quirk. The text upper/lower bijection remains covered by scenario 6 (non-PK, both
modes) and the memory-only unit specs. This ticket is the follow-up the implementer
flagged, not a blocker for that work.

## What to determine

- Reproduce: declare `table t (code text primary key)` and inspect the resolved
  column collation under memory vs `QUEREUS_TEST_STORE=true`.
- Decide whether NOCASE-by-default for a single-column text PK in the store backend
  is intentional (e.g. a key-encoding/index-ordering constraint) or an accidental
  default that should be BINARY to match memory.
- If unintended: align the store default to BINARY (or make the memory/store default
  a single shared source of truth), and add a cross-backend sqllogic assertion that a
  text PK round-trips case-sensitively under both.
- If intentional: document the divergence (where collation defaults are resolved) so
  future readers do not treat the read-only-vs-writable lens difference as a bug.

## Notes

- This is a **pre-existing** store/memory inconsistency surfaced during the lens
  work; it is not caused by the lens-prover changes. Parked in backlog as a future
  concern pending confirmation rather than an active fix, since the right resolution
  depends on whether the NOCASE default is load-bearing for store key encoding.
