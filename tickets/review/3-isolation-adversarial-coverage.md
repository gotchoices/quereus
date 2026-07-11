description: Added adversarial tests to the transaction-isolation layer for the hard cases that were genuinely untested — one connection not seeing another's uncommitted writes, two connections writing the same key, and range reads staying incremental instead of loading everything into memory.
prereq:
files:
  - packages/quereus-isolation/test/isolation-layer.spec.ts (added a cross-connection describe at end of file)
  - packages/quereus-isolation/test/merge-iterator.spec.ts (added a laziness describe before the top-level close)
  - packages/quereus-isolation/src/flush.ts (read-only: insert-vs-update-by-existence is what makes commit last-writer-wins)
  - packages/quereus-isolation/src/merge-iterator.ts (read-only: the streaming primitive the laziness tests pin)
  - packages/quereus-isolation/src/isolated-table.ts (read-only: query() clean-read fast path at line 379)
difficulty: medium
----

## What this ticket did

Targeted adversarial-gap audit of the isolation layer (as the ticket framed it —
**not** build-from-scratch; the layer already had ~205 cases across 5 specs). I read
all 5 specs, built a coverage map against the ticket's adversarial surface, and added
tests **only for the real gaps**. Net: **6 new tests, 0 duplicates**, suite now
**230 passing** (was ~224 on this branch at audit time).

Everything is test-only — **no `src/` changed**. `tsc -p tsconfig.test.json --noEmit`
is clean (exit 0), so no signature drift.

## Coverage map (what I found)

| Adversarial-surface item | Status before | Action |
|---|---|---|
| Read-your-own-writes, single connection | COVERED (line 103, 581, 661, 1100, 1262…) | none (no dup) |
| **Cross-connection visibility** (sibling can't see uncommitted; sees after commit) | **MISSING** | **added** |
| **Write-write conflict** (two conns, same key) | **MISSING (highest-value gap)** | **added — last-writer-wins** |
| Overlay merge: delete-shadow, insert-ordering, sort-key-change update | COVERED (merge-iterator 84/102/245/309; isolation 392/2915) | none |
| **Range/bounded iteration stays incremental (not full-materialization)** | **NOT explicitly asserted** (356 checks correctness, not pull-count) | **added — laziness guard** |
| Empty-overlay pass-through / all-overlay shadowed | COVERED (merge-iterator 40/179/292; isolation 636/1207) | none |
| Rollback discards / commit makes visible | COVERED (116/699/739/92) | none |
| **Double-commit / commit-then-clear well-defined** | not explicit at module level | **added — redundant re-commit no-op** |
| ALTER / schema seam under open overlay | COVERED heavily (1791/1912; alter-table-conformance 326) | none |
| Collation across the seam | COVERED (collation-resolver.spec.ts; isolation 478) | none |

## The 6 new tests — how to exercise / validate

Run: `yarn workspace @quereus/isolation test` → **230 passing**.
To see just the new suites:
`cd <repo> && node --import ./packages/quereus-isolation/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-isolation/test/**/*.spec.ts" --reporter spec --grep "cross-connection isolation|iteration laziness"`

**`isolation-layer.spec.ts` → `cross-connection isolation` describe (4 tests):**
- Two `Database` instances share ONE `IsolationModule` — each gets a distinct `dbId`,
  both share the committed underlying (the `MemoryTableModule` holds base data). Only
  `dbA` carries the SQL schema; `dbB` is a bare connection identity that owns its own
  overlay and reads the shared base via `iso.connect(dbB, …)`. This is the same
  white-box pattern the existing row-validating-DDL poison suite (line 1912) uses.
  Overlays are injected via `setConnectionOverlay`; commits are driven through
  `iso.commitConnectionOverlays(db)`.
  1. *own uncommitted writes visible, sibling's not until commit* — dbA stages id=20;
     dbA sees it merged, dbB sees only the base; after `commitConnectionOverlays(dbA)`
     dbB sees it.
  2. *write-write ⇒ last-writer-wins* — dbA and dbB both stage id=10 ('A'/'B'); each
     reads its own; dbA commits (flushed as insert), dbB still reads its own 'B', then
     dbB commits (id=10 now exists ⇒ flushed as **update**, overwriting 'A'). Final: 'B'.
  3. *reverse commit order flips winner* — same overlays, commit dbB then dbA ⇒ 'A'
     wins. Proves it's genuinely commit-order last-writer, not a fixed dbA precedence.
  4. *committed overlay cleared; redundant re-commit is a no-op* — after commit
     `getConnectionOverlay` is `undefined`; a second `commitConnectionOverlays` neither
     throws nor double-applies.

**`merge-iterator.spec.ts` → `iteration laziness` describe (2 tests):**
- Counting async sources record how many times the iterator is pulled. `mergeStreams`
  primes both heads once, then pulls one row ahead of the consumer — it must NOT drain
  the whole source. A materializing rewrite (buffer underlying into an array) would pull
  all 100 rows on the first consume; the tests assert `pulls ≤ 2` (one consume) and
  `≤ 4` (a 3-row take), so the guard has teeth (fails loudly at 100). This is the
  full-materialization drift the ticket and the sibling KVStore conformance work guard.

## Semantics: intended vs current — no divergence-failure, but a tension to track

Per the ticket's caveat I asserted the **intended** semantics (AGENTS.md:
*"read-your-own-writes; not snapshot isolation"*). Last-writer-wins is both the intended
contract **and** the current behavior (flush decides insert-vs-update by whether the PK
already exists underlying — `flush.ts:71`), so **all 6 tests pass on current code — none
documents a bug against implementation.**

The divergence the ticket references (strategic **rec #3**) is **docs-vs-docs**: the
IndexedDB plugin's settings help text advertises *"snapshot isolation"*, which AGENTS.md
contradicts. The isolation-layer *behavior* matches AGENTS.md, so there was no failing
test to leave red. **Coordination for rec #3:** if that rec resolves toward snapshot
isolation, the write-write expectation here (last-writer-wins, no abort) is exactly what
must flip to first-committer-wins / abort — the two `write-write` tests are the ones to
edit, and the describe's header comment calls this out inline so the future editor finds
it. Until then AGENTS.md is authoritative.

## Known gaps / floors (reviewer: treat tests as a floor, not a finish line)

- **Cross-connection tests use the white-box inject + `commitConnectionOverlays` path,
  not a full SQL `BEGIN…COMMIT` across two SQL sessions.** In this harness only one
  `Database` can hold the SQL schema for a shared module, so a second SQL session can't
  drive DML against the same table by name. The write-write test therefore exercises the
  flush/commit *resolution*, not the statement-level path. A higher-fidelity end-to-end
  (e.g. two engines over a shared LevelDB base) would be a stronger — but heavier —
  follow-up. Not filed as a ticket; noting it here as a floor.
- **The laziness guard is unit-level on `mergeStreams` (the primitive).** It does not
  assert that `IsolatedTable.query` streams a real bounded PK/secondary *range* from
  storage incrementally end-to-end — the existing "handles range scans on secondary
  index with overlay changes" (line 356) covers range *correctness* but not pull-count.
  A full-materialization regression introduced *above* `mergeStreams` (in the
  IsolatedTable layer) would slip past the primitive-level guard. Floor, not a ticket.
- **Not added (lower value, deliberate):** write-write where one side tombstones a
  committed key the other side updates; three-way same-key races. Straightforward
  extensions of the added pattern if a reviewer wants them.

## Reviewer checklist

- Confirm the write-write assertion is the semantics you want (see rec #3 tension above)
  — this is the one place a reviewer might disagree with the *intended* call.
- Sanity-check the laziness thresholds (`≤2`, `≤4`) aren't so loose they'd pass a
  partial-materialization regression — they're tight against the current one-row-ahead
  behavior (actual pull count is 1 and ~3 respectively).
- All new tests close their connections (`afterEach` closes dbA/dbB; laziness tests call
  `iter.return?.()`), per the ticket's cleanup requirement.
