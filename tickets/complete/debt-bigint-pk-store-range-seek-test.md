description: Added and reviewed the end-to-end test that writes a very large integer primary key and reads it back through a range query against the store module's SQL path.
files:
  - packages/quereus-store/test/pushdown.spec.ts   # new describe block + planOps helper hoisted to one copy
difficulty: easy
----

## What landed

`packages/quereus-store/test/pushdown.spec.ts` gained a describe block
**`bigint primary key range seek (debt-bigint-pk-store-range-seek-test)`** that
runs a real `INSERT` → range-`SELECT` through `StoreModule`/`StoreTable` for an
`integer primary key` holding values past 2^53, using the memory vtab as an
oracle (the pattern the neighbouring blob-PK / numeric-PK regression blocks in
this file already use).

After review the block is four tests over a six-row seed
(`-2^53-2`, `-2^53-1`, `1`, `2`, `2^53+1`, `2^53+2`):

- inclusive range `id >= 2^53+1` matches the oracle, in order, with exact values,
  and the returned `id` is a `bigint` (a lossy `number` cast would collapse the
  two large keys onto the same double);
- exclusive bound `id > 2^53+1` returns only the following row;
- range below zero, `id <= -(2^53+1)`, matches the oracle in order with exact
  values;
- the seek plans as `INDEXSEEK` and *not* `SEQSCAN`.

Full workspace `yarn test` green (quereus-store 799 passing, 0 failing; all other
packages passing). `yarn workspace @quereus/quereus run lint` clean.
`tsc --noEmit --skipLibCheck` over the edited spec clean — the store package's own
`typecheck` script excludes `test/`, so spec files are not covered by it.

## Review findings

**Correctness of the code under test.** Nothing wrong found. The write path
(change-log key serialization on a bigint PK, fixed under `txn-changelog-bigint-key`)
and the byte encoding (`encoding.spec.ts`) both hold up under the new end-to-end
exercise; the new tests pass on current `main` and no production code needed to
change.

**Coverage gaps — fixed inline (minor).**

- *Negative large integers were untested anywhere.* Neither `encoding.spec.ts`
  (its bigint case is positive-only) nor the implement-stage test covered a key
  below `-2^53`, where the sign flips the encoded byte layout. Added a seed row
  pair at `-2^53-2` / `-2^53-1` and a `id <= -(2^53+1)` range test against the
  oracle. It passes — the encoding is order-correct across the sign boundary —
  but it was previously unpinned.
- *Exclusive bounds were untested.* Only `>=` was exercised. Added a `>` test so
  a bound that rounded through a double (and therefore compared equal to its
  neighbour) would be caught.
- *The plan test did not assert what its name claimed.* It was named "not a full
  scan" but only asserted `INDEXSEEK` was present. Added the matching
  `not.match(/SEQSCAN/)` assertion, mirroring the sibling negative-control test
  in the same file.
- *Missing length guard on an indexed read.* The implement-stage plan test read
  `rows[0].ops` without first asserting the result had one row.

**DRY — fixed inline (minor).** The implement stage inlined a fourth copy of the
`planOps` helper (`query_plan(?)` → `json_group_array(op)`), which already
existed verbatim in three sibling describe blocks. Hoisted a single copy to the
top-level `StoreModule predicate pushdown` describe and deleted all four
in-block copies. Net −18 lines, same behavior.

**Docs.** Checked every doc the change could touch. `docs/store.md`,
`docs/types.md`, `docs/plugins.md` and `docs/design-isolation-layer.md` all
already describe bigint value handling and the change-log codec fix accurately;
this ticket added tests only, no production behavior changed, so no doc is now
stale. No doc edits needed.

**Major findings → new tickets.** None. Nothing found that warrants its own
ticket; the two real coverage gaps (negatives, exclusive bounds) were small
enough to close in this pass.

**Tripwires.** None recorded. The one thing worth naming — the "store" path in
this spec is the in-memory `KVStoreProvider`, not a LevelDB-backed one, despite
the original ticket saying "persistent (LevelDB) storage path" — is not a
tripwire and not a defect. The LevelDB plugin swaps only the key-value backend
beneath `StoreTable`; the encoding, PK range-bound construction, and seek logic
under test here are store-module level and identical either way. Every sibling
PK-shape test in this file (blob, mixed int/real, collated, DESC) uses the same
in-memory provider, and `yarn test:store` separately re-runs the `packages/quereus`
logic suite against LevelDB. Consistent with convention, so it is left as-is.

**Not covered, deliberately.** A bigint PK on a `desc` key, or as one column of
a composite key, is still untested end-to-end. Both are out of the ticket's
scope (it asked for the single-column ASC boundary case), and both dimensions —
DESC inversion and composite key layout — are already independently pinned for
other value types in this same file. Not filed as a ticket; the combination
carries no specific suspicion.
