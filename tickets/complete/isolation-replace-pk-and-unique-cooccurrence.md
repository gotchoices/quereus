description: Fixed isolation-layer commit-flush ordering so an `INSERT OR REPLACE` that both replaces a PK-colliding underlying row AND evicts a different row on a secondary UNIQUE keeps the new row's values. Flush now applies deletes before inserts/updates and throws (instead of silently swallowing) on a constraint result from an underlying write.
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/design-isolation-layer.md
----

## What shipped

Two-part fix in `flushOverlayToUnderlying` (`packages/quereus-isolation/src/isolated-table.ts`):

1. **Deletes before inserts/updates.** Overlay entries are sorted so tombstones flush
   first (`sort((a,b) => a.isTombstone===b.isTombstone ? 0 : a.isTombstone ? -1 : 1)`;
   `Array.prototype.sort` is spec-stable, preserving order within each group). This frees
   a secondary-UNIQUE value being evicted in the same commit before the colliding write
   is applied. Each PK appears at most once in the overlay, so the reorder never inverts a
   same-PK delete/insert pair.
2. **Stop swallowing flush write results.** Each flush write branch captures the
   `UpdateResult` and passes it to `assertFlushWriteOk(result, op, pk)`, which throws
   `QuereusError(INTERNAL)` on a constraint result. The merged-view pre-checks resolve
   every constraint before commit, so a constraint at flush time is a real invariant
   violation — previously lost silently (the corruption root cause), now loud and rolled
   back.

Doc: `docs/design-isolation-layer.md` § Commit step 2 documents tombstone-first ordering
and throw-on-constraint.

Regression tests added to `packages/quereus-store/test/isolated-store.spec.ts` (describe
"INSERT OR REPLACE co-occurrence: PK collision AND secondary-UNIQUE collision"):
- keeps the new PK-slot value and evicts the secondary-UNIQUE conflict → `p5` = `[[5,'dup']]`.
- cascades FK ON DELETE for both the evicted row and the replaced PK row → `c5` = `[]`.

## Review findings

### Verified correct

- **Fix is load-bearing — proven red.** I reverted only the ordering change (keeping the
  hardening), rebuilt `@quereus/isolation` (consumed from `dist`, so a rebuild is
  required), and ran the two new tests: both fail with exactly the predicted
  `Isolation flush update on 'p5' (pk=[5]) hit a unique constraint` INTERNAL throw. The
  handoff had not proven this; it is now confirmed. Restored and re-verified green.
- **Hardening throw breaks nothing legitimate.** `yarn test:store` (full logic suite
  through the isolation flush path) = **4088 passing, 13 pending, 0 failing**. The throw
  never fires on any covered path.
- **Ordering direction is universally safe.** Delete-first only ever *frees* a UNIQUE
  slot; deletes never need a slot freed for them, so tombstone-first cannot introduce a
  new collision. Insert-before-delete is never required for correctness.
- **Types / guards.** `UpdateResult`, `RowOp`, `isConstraintViolation`, `QuereusError`,
  `StatusCode` imports and the `assertFlushWriteOk` signature all check out against
  `packages/quereus/src/common/types.ts`. No `any`, small single-purpose helper, matches
  surrounding style.
- **Test placement.** Living in `isolated-store.spec.ts` rather than the dual-mode `55`
  sqllogic file is correct: the memory module short-circuits the secondary-UNIQUE check
  on a PK collision, so a shared dual-mode `→` expectation is impossible. Confirmed the
  reasoning by reading the memory `manager.ts` path described in the handoff.
- **FK-cascade assertion (`c5` empty) is correct.** The INSERT path fires
  `executeForeignKeyActions('delete', replacedRow)` for the same-PK replaced row
  (`dml-executor.ts`), matching SQLite REPLACE = delete-then-insert; the evicted
  secondary-UNIQUE row cascades via `evictedRows`. Both children cascade → empty. The
  implement ticket's original prediction (`[{50,5}]`) was wrong; the shipped test asserts
  the correct behavior.
- **Lint:** `yarn workspace @quereus/quereus run lint` clean. **Build:** `yarn build`
  clean. **`yarn test:store`** green (above). **Store unit suite** 281 passing.
- **Docs:** the only doc describing the commit flush ordering is
  `docs/design-isolation-layer.md` § Commit; it was updated and is accurate. No other doc
  references this path.

### Found — filed as a new ticket (major, out of scope, pre-existing)

- **`fix/isolation-merged-unique-stale-underlying-false-positive`** — while probing
  whether the new hardening throw could fire on a non-tombstone *update cycle*, I found
  it cannot (the statement-time check rejects first), but that rejection is itself a
  **false positive**: a legitimate cross-row UNIQUE-value swap inside one transaction is
  wrongly rejected. Root cause: `findMergedUniqueConflict` compares the new value against
  the *stale committed* underlying row and only skips overlay *tombstones* — it ignores
  overlay non-tombstone updates that moved the candidate off the constrained value.
  Pre-existing, unrelated to this fix, and explicitly out of scope here. Reproduction and
  root-cause analysis captured in the ticket.

### Considered, no action

- **Update-cycle at flush.** The fix reorders only tombstones vs non-tombstones, not
  among non-tombstones, so a UNIQUE swap of two updates could in principle hit the flush
  hardening throw. Verified empirically this is unreachable — such swaps are rejected at
  statement time (see filed ticket), never reaching flush. No change needed here.
- **Minor nits, not worth a change:** the ordering comment says sort is "stable in
  V8/Node" (it is in fact ECMAScript-spec-guaranteed); `sort()` runs even when there are
  no tombstones (O(n log n), negligible). Neither affects correctness.

### Not applicable

- No covered-MV co-occurrence variant was added (ticket flagged it optional; the
  flush-ordering fix is agnostic to how the conflict was detected). Acceptable gap.
- Memory/store INSERT short-circuit (skips secondary-UNIQUE check on PK collision)
  remains out of scope, as directed.

## Validation summary

- `yarn build` — clean
- `yarn test:store` — 4088 passing / 13 pending / 0 failing
- `yarn workspace @quereus/store test` — 281 passing
- `yarn workspace @quereus/quereus run lint` — clean
- New regression tests proven red without the ordering fix, green with it
