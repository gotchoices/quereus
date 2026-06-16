description: Apply-path within-batch dedup — commitChangeMetadata now collapses same-key repeats inside ONE applyChanges batch to the max-HLC winner, closing the relay re-attribution / duplicate-fact hazard for both delete and column entries. Ready for review.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitChangeMetadata rewrite + helpers (keepMaxHLC/deleteKey/columnKey/commitDeleteMetadata/commitColumnMetadata); new ColumnChange/RowDeletion/WriteBatch imports
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince LOAD-BEARING INVARIANT comment extended for the apply-path in-batch collapse (~485-510)
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # 3 new tests in applyChanges describe (after the cross-batch dedup test ~706)
  - docs/sync.md                                               # § Transaction-granularity bounding — in-batch collapse note (~302-315)
difficulty: medium
----

# Review: apply-path within-batch dedup

## What the implement stage delivered

`commitChangeMetadata` (Phase 3 of `applyChanges`) was rewritten to **collapse in-batch
repeats per key** before writing any metadata. When two versions of the same key land in a
single `applyChanges` call, Phase 1 (`resolveChange`) resolves **both** against the same
**pre-batch** prior version — neither sees the other — so the old code wrote two change-log
entries for one key. The older entry then resolved (non-null) to the single current version
and re-attributed to the later HLC, breaking `collectChangesSince`'s LOAD-BEARING INVARIANT
(survivor log HLC == current version HLC) and re-introducing the transaction-split /
duplicate-fact hazard on a relay.

The fix builds two `Map<key, ResolvedChange>` winner tables (deletes keyed by
`(schema, table, pk)`, columns by `(schema, table, pk, column)`), keeping only the
**max-HLC** change per key via `compareHLC`. Only winners' metadata + change-log entries are
written; the single pre-batch prior entry is deleted once; `deleteRowVersions` runs once per
winning delete. Delete and column branches are symmetric. Decomposed into small helpers
(`deleteKey`, `columnKey`, `keepMaxHLC`, `commitDeleteMetadata`, `commitColumnMetadata`) per
house style. `result.applied/skipped/conflicts` accounting is unchanged — collapse happens at
commit time, so two applied same-key changes still count `applied: 2`.

## Use cases / what to validate

- **In-batch delete dedup** — two same-pk deletes (distinct sites, `hlcA < hlcB`) in ONE
  `applyChanges` call → exactly one delete surfaces from `getChangesSince(peer, sinceHLC=epoch)`,
  at `hlcB`. (Test: `dedupes same-pk deletes batched into ONE applyChanges call`.)
- **In-batch column dedup** — same shape for `(pk, column)` writes → one column entry at the
  winner HLC. This path had the latent gap since **before** the delete ticket; it now reaches
  parity. (Test: `dedupes same-(pk,column) writes batched into ONE applyChanges call`.)
- **No transaction split on a relay** — `batchSize=1` multi-round walk: two same-pk deletes
  **plus** a separate multi-fact transaction (delete pk[5] + write pk[6], same base HLC /
  distinct opSeq) batched into one `applyChanges`, then walked round-by-round advancing
  `sinceHLC = last.hlc`. Asserts: no repeated transactionId, strictly-ascending watermark, the
  multi-fact transaction surfaces whole in exactly one ChangeSet, the collapsed pk[1] delete
  surfaces once at the winner HLC. (Test: `does not split a separate transaction when same-pk
  deletes are collapsed in one batch`.)
- **Reviewer suggestion (not yet covered):** the regression tests assert the **deduped**
  outcome but I did not pin them as red-without-fix in the committed tree. The ticket's
  reproduction notes both in-batch tests were verified to fail against the pre-fix tree. A
  worthwhile adversarial check: temporarily replace the collapse with the old straight-line
  loop (or drop the `keepMaxHLC` max-HLC guard) and confirm the delete/column length-1
  assertions flip to 2 — i.e. the tests are genuine guards, not tautologies. **CRITICAL** for
  the `sinceHLC`: a no-arg `getChangesSince` assertion passes even with the bug (scans current
  `cv:`/`tb:` keyed by table/pk → one per key); all three tests pass an epoch `sinceHLC` to hit
  the delta (`collectChangesSince`) path where both entries live.

## Known gaps / residual (honest handoff — treat tests as a floor)

- **Phase 2 data-value divergence is explicitly OUT OF SCOPE** and untouched. This fix
  guarantees the **metadata** invariant only (change-log survivor HLC == columnVersion /
  tombstone HLC). `dataChangesToApply` is still built in Phase-1 resolve order and applied in
  that order, so the host store's final *value* for a repeated `(pk, column)` reflects the
  last-applied change, not necessarily the max-HLC one. Non-issue in the normal relay flow
  (`getChangesSince` emits ascending-HLC, so max-HLC applies last and value == metadata); only
  reachable if a caller hands `applyChanges` same-key changes in **descending** HLC order,
  which this package never produces. Delete is idempotent, unaffected. If ever hardened it is a
  separate concern (HLC-sort or collapse `dataChangesToApply`) — do **not** fold it in here.
- **Test type-checking is not in this package's CI gate.** `packages/quereus-sync/tsconfig.json`
  excludes `test/`, so the `typecheck` script (`tsc --noEmit`) covers `src` only, and the mocha
  runner uses Node type-stripping (no checking). I type-checked the spec separately via a
  transient `tsconfig.spec-check.json` (src + test, `noEmit`) — clean — then deleted it. The
  spec's new code only uses already-imported types (`ChangeSet`, `HLC`, `generateSiteId`,
  `compareHLC`), so drift risk is low, but the reviewer should know the standard gate would not
  have caught a spec type error.
- **`test:store` (LevelDB) not run.** This change is metadata-logic only (change-log / tombstone
  / column-version KV writes), fully exercised by the memory-backed suite; no store-specific
  code path is touched. Deferred deliberately per agent-runnable guidance.
- **Carried-forward pre-existing note (not actioned, not mine):** a row delete leaves the row's
  `cl:` column change-log entries behind (`deleteRowVersions` clears `cv:` rows, not `cl:`);
  they resolve to null and are correctly skipped — footprint only, not correctness. Flagged in
  the prior `sync-stale-delete-entry-reattribution` review; unchanged here.

## Validation performed

- `yarn workspace @quereus/sync test` → **260 passing**, 0 failing (was 257 before this ticket;
  +3 new tests). The `Oversized transaction` warnings (incl. the new `batchSize=1` multi-fact
  walk) and the `Error handling transaction commit` lines are from tests that intentionally
  exercise oversized / failing-KV paths — not regressions.
- Focused run of the 3 new tests + the existing cross-batch dedup test → 4 passing.
- `yarn workspace @quereus/sync typecheck` (`tsc --noEmit`, src) → clean.
- Transient src+test type-check (`tsconfig.spec-check.json`, then removed) → clean.
- `yarn lint` (quereus package) not run: it lints/type-checks `@quereus/quereus`, which this
  diff does not touch; `@quereus/sync` has no lint script. The sync typecheck + test run above
  are the meaningful gate.
