description: A JSON/mixed-numeric value's hash and stored key now always agree with the comparator that decides equality, so grouping, joins, de-duplication, and uniqueness no longer wrongly split equal values apart or merge different ones together.
files:
  - packages/quereus/src/util/json-canonical.ts               # canonicalJsonString — recursive object-key sort
  - packages/quereus/src/util/key-serializer.ts               # appendValue: numeric-class + OBJECT canonicalization
  - packages/quereus/src/util/comparison.ts                   # objectCanonicalString → canonical form
  - packages/quereus/src/index.ts                             # exports canonicalJsonString
  - packages/quereus-store/src/common/encoding.ts             # encodeValue OBJECT branch canonicalizes
  - packages/quereus/src/vtab/memory/utils/primary-key-encode.ts  # REVIEW FIX: memory PK Map encoder canonicalizes JSON
  - packages/quereus/src/core/database-transaction.ts         # REVIEW FIX: change-log tuple key canonicalizes JSON
  - packages/quereus/src/planner/stats/histogram.ts           # REVIEW: NOTE tripwire (JSON NDV undercount)
  - packages/quereus/test/util/json-canonical.spec.ts         # unit spec
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts  # REVIEW: canonical + JSON-PK MemoryIndex tests
  - packages/quereus/test/logic/06.9-json-canonical-key.sqllogic  # sqllogic (memory + store)
  - packages/quereus-store/test/encoding.spec.ts              # OBJECT canonical byte-key assertions
  - docs/types.md, docs/schema.md                             # JSON key/equality semantics
difficulty: medium
----

## What shipped

One canonical JSON serializer (`canonicalJsonString`) + numeric-class normalization,
routed through the derived-key paths so they agree with the equality source of truth
`deepCompareJson` (`types/json-type.ts`, unchanged). Implement-stage delivered:

- `util/json-canonical.ts` — `canonicalJsonString(v)`: recursively rebuilds the value
  with object keys sorted ascending (matching `deepCompareJson`), arrays positional,
  then `JSON.stringify`s. Exported from `packages/quereus/src/index.ts`.
- `util/key-serializer.ts` `appendValue` — numeric classes (number/bigint/boolean)
  collapse to one `n:` tag via `canonicalNumeric` (`5n`==`5`, `true`==`1`); OBJECT
  branch canonicalizes (was `'o:[object Object]'` for every object).
- `util/comparison.ts` `objectCanonicalString` → `canonicalJsonString` (still WeakMap
  cached), so `compareSqlValues` OBJECT equality/order matches `deepCompareJson`.
- `quereus-store` `encodeValue` OBJECT branch canonicalizes persisted byte keys.

Key derivation only — storage/display stay insertion-order.

## Review findings

Adversarial pass. Read the implement diff (`2fc4c48e`) with fresh eyes before the
handoff, traced every JSON→string key-derivation path against the now-canonical
comparator, then verified against the type comparator (`deepCompareJson`).

**What was checked**

- **Comparator ↔ key agreement (the core invariant).** Confirmed `compareSqlValuesFast`
  treats numeric class (`number`/`bigint`/`boolean`) as value-equal (`5n`==`5`,
  `true`==`1`) and OBJECT class via `objectCanonicalString` — both now match the
  key-serializer and store encoder. The old separate `n:`/`b:` tags and boolean→`o:true`
  were pre-existing key/comparator *disagreements* this work correctly retires.
- **Within-object scalar typing.** `deepCompareJson` orders JSON scalars by type
  (null<bool<number<string); `canonicalJsonString` (via `JSON.stringify`) emits
  `true`/`1`/`"1"` as distinct strings, so nested `{x:true}` vs `{x:1}` never over-merge —
  equality agrees. Numeric `5`≡`5.0` agrees (both `"5"`).
- **NaN/Infinity/-0, bigint-in-JSON.** Canonical form inherits `JSON.stringify` coercions;
  bigint inside a JSON object throws under both the old and new path (no regression).
- **All derived-key sites, not just the three in the diff** (see the two fixes below).
- **`decodeObject` round-trip / covering scans** — re-verified no production path
  reconstructs a PK from a decoded key; display unaffected. Consistent with the handoff.
- **Lint + full suites** — see Validation.

**Found & fixed inline (minor — same bug class the ticket targets, missed by implement)**

The handoff claimed the canonical form is *"routed through every derived key path."* It
was not — two JSON→string key paths still used bare `JSON.stringify`, so after the
comparator went canonical they *disagreed* with it:

1. **`vtab/memory/utils/primary-key-encode.ts` `encodeScalar`** — the memory-vtab PK Map
   encoder keyed JSON via `'j' + JSON.stringify(v)`. Its own doc asserts it "mirrors the
   PK comparator's equality" — now false for reorder-equal JSON objects. The sqllogic
   JSON-PK test passed only because PK *conflict* detection routes through the BTree
   `compare` (canonical); the `primaryKeys` Map is a separate structure. Latent defect:
   an UPDATE of a JSON PK between reorder-equal forms would leave a phantom entry in a
   secondary index (remove keys by the new object's string, misses the old). **Fixed**:
   canonicalize the JSON branch; stale doc corrected.
2. **`core/database-transaction.ts` `serializeKeyTuple`** — the change-log (CDC/assertion)
   Map key was `JSON.stringify(values)`, so a JSON-object PK component split reorder-equal
   values into separate change records. **Fixed**: `canonicalJsonString(values)`. Strictly
   an improvement — only reorders object keys; scalar/BLOB tuples serialize byte-identically.

Both fixes are covered by new tests (`memory-index-pk-value-identity.spec.ts`: the
`encodeScalar` reorder-equal/nested assertions, plus a MemoryIndex-level JSON-PK dedup +
remove-by-value test). The full memory + store suites stayed green after the change.

**Recorded as a tripwire (not a ticket)**

- `planner/stats/histogram.ts:100` keys per-bucket distinct-count on `String(val)`, which
  collapses every JSON object to `object:[object Object]`, undercounting NDV for a JSON
  column. Genuinely conditional — this is a cost-estimation statistic, never a correctness
  key, so it only matters *if* JSON-column cardinality ever drives a bad plan. Parked as a
  `NOTE:` at the site.

**Major / new tickets** — none. No correctness gap survived that warranted a follow-up
ticket; the two disagreements found were minor and fixed in this pass.

**Explicitly empty categories**

- No `blocked/` decision — no human/external dependency arose.
- No `fix/`/`plan/` spawned — nothing major found.
- Docs (`types.md`, `schema.md`) re-read against the code: they describe the *semantics*
  ("a value's key always agrees with the comparator; one canonical form for hash + byte
  keys"), which the two fixes make more true, not less. No wording change needed.

**Gaps the implementer flagged, re-assessed**

- *Bloom/hash-join not pinned to the hash path* — accepted. `serializeRowKey` shares
  `appendValue` with `serializeKey` (unit-tested directly), so the JSON path is covered at
  the unit level; a large-row forced-hash-join integration test remains optional
  belt-and-suspenders, not a correctness gap.
- *Store-side numeric `5n`/`5` UNIQUE re-validation not asserted at store level* — accepted
  as low-value; the same `appendValue` code the store re-validator calls is unit-tested for
  numeric-class equality. Not worth the awkward SQL to force a bigint down that path.
- *OBJECT-class ordering changed to sorted-key order* — conscious, correct alignment with
  `deepCompareJson`; full suites green.

## Validation performed (all green, post-review-fix)

- `packages/quereus` full memory suite: **6496 passing**, 9 pending (+1 = new JSON-PK
  MemoryIndex test).
- `packages/quereus` full **store mode** (`test:store`): **6491 passing**, 14 pending.
- `packages/quereus-store` `yarn test`: **679 passing**.
- `packages/quereus` `yarn lint` (eslint + `tsc -p tsconfig.test.json`): clean.

## Tripwire (also recorded in code)

- `key-serializer.ts` `canonicalNumeric`: NaN/±Infinity emit `n:NaN`/`n:Infinity` (two
  NaN keys alike, but NaN never keys equal to a finite value), whereas the numeric
  comparator treats NaN as equal to everything — a degenerate SQL edge. `NOTE:` at the
  site; revisit only if NaN-valued numeric keys ever matter.
- `histogram.ts:100`: JSON NDV undercount (see Review findings). `NOTE:` at the site.
