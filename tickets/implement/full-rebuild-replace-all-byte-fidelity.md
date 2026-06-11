description: Make the full-rebuild floor's `replace-all` identical-row skip byte-faithful (`rowsValueIdentical`) instead of collation-aware (`rowsEqual`), so a collation-equal / byte-different row re-keys the backing bytes — aligning the wholesale skip with the byte-faithful point-op skip and the byte-exact maintenance-equivalence oracle. Keep key pairing collation-aware (the PK comparator). Update the two pinning spec cases, add a floor NOCASE equivalence suite, and collapse the documented two-discipline divergence to one.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                    # replace-all arm (~L1419) uses this.rowsEqual; private rowsEqual (~L225-239) becomes dead
  - packages/quereus-store/src/common/backing-host.ts                    # applyReplaceAll (~L210) uses this.rowsEqual; private rowsEqual (~L329-344) becomes dead; compareSqlValues import becomes unused
  - packages/quereus/src/util/comparison.ts                              # rowsValueIdentical — the byte-faithful discipline (already imported by both hosts)
  - packages/quereus/test/vtab/maintenance-replace-all.spec.ts          # L137 "collation-equal rows skip" case must flip; update header doc
  - packages/quereus-store/test/backing-host.spec.ts                     # add store-side replace-all NOCASE byte-faithful case (parity w/ existing upsert case L345)
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts   # add full-rebuild floor NOCASE-PK equivalence suite (forceFullRebuild helper exists)
  - docs/materialized-views.md                                          # § Value-identical (no-op) write suppression, L399 — remove the "replace-all retains a collation-aware skip" divergence note
  - docs/incremental-maintenance.md                                     # § replace-all primitive, L188-193 — clarify collation-aware KEY pairing + byte-faithful VALUE compare
----

# Full-rebuild floor: make the `replace-all` skip byte-faithful

## Confirmed repro (reproduced end-to-end during fix)

```sql
create table t (id text collate nocase primary key, v integer);
insert into t values ('apple', 1);
create materialized view mv as select id, v from t;
-- forceFullRebuild(db,'main','mv') swaps in a 'full-rebuild' plan, then:
update t set id = 'APPLE' where id = 'apple';
select id from mv;   -- BUG: returns 'apple' (stored, stale); live body returns 'APPLE'
```

Verified with a throwaway spec driving `forceFullRebuild`
(`maintenance-equivalence.spec.ts`): the MV backing returned `'apple'` while the live
body returned `'APPLE'` — a byte-wise `read(MV) != evaluate(body)` divergence, exactly
the maintenance-equivalence oracle's definition of a bug. The candidate one-line fix
(below) was applied temporarily and the repro flipped to `'APPLE'`; both temporary
changes were then reverted, so the tree is clean for this ticket.

## Root cause

`MemoryTableManager.applyMaintenanceToLayer`'s `replace-all` arm computes a keyed diff
of the recomputed rows against the backing's before-image. Key pairing is **collation-
aware** (the PK comparator — correct and load-bearing: it pairs `'apple'` with a stored
`'APPLE'` under NOCASE so the result is an `update`, never a spurious insert+delete that
leaks secondary-index bookkeeping). But the **identical-row skip** that decides whether
a paired row is a no-op uses the collation-aware `this.rowsEqual` (per-column
`compareSqlValues` under each column's collation). Under NOCASE, `'apple'` ≡ `'APPLE'`
and the payload matches, so the row is skipped and the backing keeps the stale bytes.

The point-op `upsert` arm in the SAME method was already made byte-faithful
(`rowsValueIdentical` — BINARY per column, numeric-storage-class tolerant) by
`mv-noop-upsert-suppression`, precisely so a case-only rewrite re-keys the stored bytes.
The two skip disciplines coexist today; the wholesale one is unfaithful to the oracle.
The store host (`StoreBackingHost.applyReplaceAll`) mirrors the memory host and has the
identical defect (its own private collation-aware `rowsEqual`).

`docs/incremental-maintenance.md` (L188-193) describes the intent as: a collation-equal
key resolves to an `update` "rather than a spurious insert + delete" — i.e. collation-
aware **key pairing** with (implicitly) a faithful **value compare**. The implementation
conflated the two and made the value compare collation-aware too. The fix splits them:
collation-aware key pairing (unchanged), byte-faithful value compare.

## Fix direction (verified)

ONE discipline: collation governs **key identity** (which old row a new row pairs with);
value fidelity is **binary** (`rowsValueIdentical`). A byte-identical paired row still
skips; a collation-equal / byte-different paired row is an `update` that re-keys the
stored bytes. No spurious insert+delete for collation-equal keys (the PK-comparator
pairing is retained). Both hosts align identically; the docs collapse to one rule.

## TODO

### Engine + store: swap the skip comparison, drop the dead `rowsEqual`

- In `packages/quereus/src/vtab/memory/layer/manager.ts`, `replace-all` arm (~L1419):
  change `!this.rowsEqual(existing.row, newRow)` → `!rowsValueIdentical(existing.row, newRow)`
  (`rowsValueIdentical` is already imported). Update the adjacent inline comment
  ("else: equal under each column's collation — a no-op") to say byte-faithful identity.
- Remove the now-dead private `rowsEqual` method (~L225-239) and its doc comment. Confirm
  no other caller (verified during fix: `replace-all` was its sole use; the upsert arm
  already uses `rowsValueIdentical`). The `compareSqlValues` import stays — still used
  elsewhere in the manager.
- In `packages/quereus-store/src/common/backing-host.ts`, `applyReplaceAll` (~L210):
  same swap to `rowsValueIdentical`. Update the surrounding comments (method doc ~L188-189
  and the inline "equal under each column's collation" at ~L214) to byte-faithful.
- Remove the store host's now-dead private `rowsEqual` (~L329-344). Drop the
  `compareSqlValues` import (verified: it was used only inside `rowsEqual`). Keep the
  `rowsValueIdentical` import (already present).

### Specs: flip the pinned cases, add NOCASE coverage

- `packages/quereus/test/vtab/maintenance-replace-all.spec.ts`:
  - The "NOCASE PK: a key differing only by case matches its old row (collation-equal
    rows skip)" case (L137) must flip. With `[['apple', 1], ['banana', 2]]` over stored
    `['Apple', 1], ['Banana', 2]`: keys NOCASE-pair (updates, not insert+delete) but the
    key bytes differ → two `update`s re-keying the stored bytes. Rename to something like
    "a collation-equal key with byte-different bytes is an update that re-keys the stored
    bytes". Expect (new-row order):
    `[{update Apple→apple}, {update Banana→banana}]`, scan `[['apple',1],['banana',2]]`.
  - Add a sibling case pinning that a **byte-identical** NOCASE row still skips (e.g.
    replace-all with the exact stored bytes `[['Apple',1],['Banana',2]]` → `[]`, scan
    unchanged) — the narrowed skip must still suppress true no-ops.
  - The existing "collation-equal key with a changed payload is an update" case (L151) is
    unaffected (it was already an update); re-confirm it stays green.
  - Update the `describe` header doc (L21-34) bullet "an identical row at the same key →
    skipped" to "a byte-identical row at the same key → skipped".
- `packages/quereus-store/test/backing-host.spec.ts`: add a `replace-all` NOCASE
  byte-faithful case in the DESC/NOCASE describe block (parity with the existing upsert
  case at L345): a collation-equal / byte-different row is an `update` re-keying the
  bytes, a byte-identical row skips.

### Equivalence oracle: cover the floor's NOCASE behavior

- `packages/quereus/test/incremental/maintenance-equivalence.spec.ts`: add a full-rebuild
  floor suite over a NOCASE-PK body so the byte-exact oracle covers the floor's collation
  behavior (the existing floor suites use integer PKs; the existing NOCASE suite at L284
  is the bounded-delta `prefix-delete` arm, not the floor). Use a bounded-delta-eligible
  body (so `create` builds a backing) like `select id, v from t` over
  `t (id text collate nocase primary key, v integer)`, call `forceFullRebuild`, then:
  - a deterministic case-only-rewrite test (analogue of the L345 prefix-delete test):
    `update t set id='APPLE' where id='apple'` then assert `select distinct id from mv`
    reads the new byte value and the oracle is equivalent; and/or
  - a property run with case-colliding single-letter keys + case-only `updateKey`s,
    asserting `assertEquivalent` mid-transaction and post-rollback.

### Docs: one discipline

- `docs/materialized-views.md` § Value-identical (no-op) write suppression (L399): delete
  the sentence noting the `replace-all` diff "retains its own, deliberately collation-aware
  identical-row skip ... the point-op skip is strictly narrower". State both skips are
  byte-faithful (`rowsValueIdentical`); collation governs key identity only.
- `docs/incremental-maintenance.md` § the `replace-all` primitive (L188-193): keep the
  collation-aware **key pairing** description; change the **skip-identical** comparison
  from "`compareSqlValues` per column" to byte-faithful `rowsValueIdentical` (note the
  collation-equal / byte-different row is an `update` that re-keys the bytes).

### Validate

- `yarn workspace @quereus/quereus run test:single packages/quereus/test/vtab/maintenance-replace-all.spec.ts`
  and `.../test/incremental/maintenance-equivalence.spec.ts` (stream with `tee`).
- `yarn test` (full memory suite) and `yarn lint` (single-quoted globs on Windows).
- The store-host change is exercised by `packages/quereus-store` vitest
  (`backing-host.spec.ts`); run that workspace's tests. A `yarn test:store` run is the
  store logic-test path but is slower — prefer the targeted vitest unit run for the host.
