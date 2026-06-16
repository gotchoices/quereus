description: collectChangesSince invariant breaks on the APPLY path when two same-key versions (delete or column) arrive in one applyChanges batch — both survive in the change log, re-attributing the older entry to the later HLC and re-introducing the transaction-split / duplicate-fact hazard on a relay. Fix by collapsing in-batch repeats per key in commitChangeMetadata.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitChangeMetadata (Phase 3) — the fix site
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince LOAD-BEARING INVARIANT comment (~485-502); recordDataEvent / recordColumnVersions write-path dedup for reference
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # applyChanges describe block (~671-706 existing cross-batch dedup tests); getChangesSince transaction-grouping multi-round walk (~298-360)
difficulty: medium
----

# Implement: apply-path within-batch dedup (re-attribution still reachable on a relay)

## Reproduced & confirmed

The bug is real and reproduces on **both** the delete and column paths. Two same-key
versions batched into **one** `applyChanges` call both survive in the change log, so the
delta path (`collectChangesSince`, the `sinceHLC` branch of `getChangesSince`) surfaces the
fact twice and mis-counts the scan bound.

Key finding from reproduction: the duplicate surfaces **only on the `sinceHLC` delta path**
(`collectChangesSince`, which scans the change *log* keyed by HLC — both entries live there).
The no-arg `getChangesSince` path (`collectAllChanges`) scans current `cv:`/`tb:` versions
keyed by table/pk, so it yields one per key regardless and does **not** expose the bug. Any
regression test MUST pass a `sinceHLC` (e.g. epoch zero) — a no-arg assertion passes even
with the bug present (verified: the no-arg form returned 1, the `sinceHLC` form returned 2).

These two tests were run against the current tree and **both fail** (confirming the bug); they
were then removed so the handoff tree stays green. Re-add them (and the split-walk test below)
in this stage:

```ts
    it('dedupes same-pk deletes batched into ONE applyChanges call (in-batch repeat)', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const now = Date.now();

      const deleteFrom = (site: Uint8Array, wall: number, counter: number, tx: string): ChangeSet => {
        const hlc: HLC = { wallTime: BigInt(wall), counter, siteId: site, opSeq: 0 };
        return { siteId: site, transactionId: tx, hlc, changes: [{ type: 'delete', schema: 'main', table: 'users', pk: [1], hlc }], schemaMigrations: [] };
      };

      // Both deletes resolve against the SAME pre-batch state (no tombstone yet),
      // so neither sees the other — both delete entries are recorded today.
      const result = await manager.applyChanges([
        deleteFrom(siteA, now, 1, 'tx-a'),
        deleteFrom(siteB, now + 1000, 1, 'tx-b'),
      ]);
      expect(result.applied).to.equal(2);

      const peer = generateSiteId();
      const sinceHLC: HLC = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      const sets = await manager.getChangesSince(peer, sinceHLC);
      const deletes = sets.flatMap(s => s.changes).filter(c => c.type === 'delete' && JSON.stringify(c.pk) === '[1]');
      expect(deletes, 'in-batch stale delete entry not deduped').to.have.lengthOf(1);
      // Survivor's HLC must equal the current tombstone's (the max-HLC delete).
      expect(compareHLC(deletes[0].hlc, { wallTime: BigInt(now + 1000), counter: 1, siteId: siteB, opSeq: 0 })).to.equal(0);
    });

    it('dedupes same-(pk,column) writes batched into ONE applyChanges call (in-batch repeat)', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const now = Date.now();

      const writeFrom = (site: Uint8Array, wall: number, value: string, tx: string): ChangeSet => {
        const hlc: HLC = { wallTime: BigInt(wall), counter: 1, siteId: site, opSeq: 0 };
        return { siteId: site, transactionId: tx, hlc, changes: [{ type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value, hlc }], schemaMigrations: [] };
      };

      const result = await manager.applyChanges([
        writeFrom(siteA, now, 'Alice', 'tx-a'),
        writeFrom(siteB, now + 1000, 'Bob', 'tx-b'),
      ]);
      expect(result.applied).to.equal(2);

      const peer = generateSiteId();
      const sinceHLC: HLC = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      const sets = await manager.getChangesSince(peer, sinceHLC);
      const cols = sets.flatMap(s => s.changes).filter(c => c.type === 'column' && JSON.stringify(c.pk) === '[1]');
      expect(cols, 'in-batch stale column entry not deduped').to.have.lengthOf(1);
      expect(compareHLC(cols[0].hlc, { wallTime: BigInt(now + 1000), counter: 1, siteId: siteB, opSeq: 0 })).to.equal(0);
    });
```

## Root cause

`applyChanges` is a 3-phase pipeline (`change-applicator.ts`):
- **Phase 1** `resolveChange` resolves **all** incoming changes against the store *before any
  writes*, capturing the **pre-batch** prior version on each result
  (`resolved.oldTombstone` / `resolved.oldColumnVersion`).
- **Phase 3** `commitChangeMetadata` writes tombstones/column-versions + change-log entries,
  deduping the *prior* entry via that captured pre-batch version.

When two versions of the same key are in one batch, **both** `resolveChange` calls observe the
**same pre-batch prior version** and neither sees the other. So in Phase 3 both branches run:
each records its own change-log entry (`@hlcA` and `@hlcB`) and neither deletes the other (the
dedup only removes the shared pre-batch entry, if any). Both stale entries then resolve
(non-null) to the single current version (`hlcB`):
- the `@hlcA` entry re-attributes to `txn(hlcB)` while `collectChangesSince` boundary detection
  counts it under `txn(hlcA)` → scan-bound mis-count → a later transaction can split across
  rounds, and
- both entries resolve to the same `RowDeletion(hlcB)` → a duplicate fact in one ChangeSet.

This exactly mirrors the local-write-path hazard fixed by
`sync-stale-delete-entry-reattribution`, re-introduced on any node that *applies* changes
(a relay / coordinator). Needs ≥3 nodes (two origins + one relay) with same-key versions in a
single sync round — common with concurrent deletes of the same row in a mesh.

The **column** path has had this gap since before the delete ticket; the delete path now merely
reaches parity with it. Fix both symmetrically.

## Fix direction

Collapse in-batch repeats **per key** inside `commitChangeMetadata` (Phase 3), keeping only the
**max-HLC** change per key (compare via `compareHLC`, already imported in this file). Only the
winner's metadata (tombstone / column version) and change-log entry are written; losers are
never written, and the single pre-batch prior entry is deleted once. This keeps the survivor's
change-log HLC equal to the survivor's metadata HLC (the invariant) regardless of how many
versions of a key were batched, and keeps the column & delete paths symmetric.

Key separation: deletes keyed by `(schema, table, pk)`, columns by `(schema, table, pk,
column)` — they are distinct change-log entry types and never collide. Use a stable string key,
e.g. `JSON.stringify([change.schema, change.table, change.pk])` (and `, change.column` for the
column branch); `JSON.stringify(pk)` is the serialization already used elsewhere in this
package (see `snapshot-stream.ts` / `collectAllChanges`).

Sketch (adapt to house style — tabs, small functions):

```ts
export async function commitChangeMetadata(ctx, resolvedChanges) {
  if (resolvedChanges.length === 0) return;

  // Collapse in-batch repeats per key, keeping the max-HLC change. Two versions of one
  // key can land in a single applyChanges batch (e.g. concurrent deletes of the same pk
  // relayed together); Phase 1 read the SAME pre-batch prior version for both, so writing
  // both leaves two change-log entries for one key — breaking collectChangesSince's
  // LOAD-BEARING INVARIANT. Keep only the winner; the loser's metadata and change-log
  // entry are never written, and the single pre-batch prior entry is deleted once.
  const deleteWinners = new Map<string, ResolvedChange>();
  const columnWinners = new Map<string, ResolvedChange>();
  for (const resolved of resolvedChanges) {
    if (resolved.outcome !== 'applied') continue;
    const c = resolved.change;
    if (c.type === 'delete') {
      const key = JSON.stringify([c.schema, c.table, c.pk]);
      const prev = deleteWinners.get(key);
      if (!prev || compareHLC(c.hlc, prev.change.hlc) > 0) deleteWinners.set(key, resolved);
    } else {
      const key = JSON.stringify([c.schema, c.table, c.pk, c.column]);
      const prev = columnWinners.get(key);
      if (!prev || compareHLC(c.hlc, prev.change.hlc) > 0) columnWinners.set(key, resolved);
    }
  }

  const batch = ctx.kv.batch();
  for (const resolved of deleteWinners.values()) { /* delete-old-if-any + setTombstone + recordDeletion */ }
  for (const resolved of columnWinners.values()) { /* delete-old-if-any + setColumnVersion + recordColumnChange */ }
  await batch.write();

  // deleteRowVersions once per winning delete (idempotent, but no need to iterate losers).
  for (const resolved of deleteWinners.values()) { await ctx.columnVersions.deleteRowVersions(...); }
}
```

Decompose into small helpers if it reads better (e.g. a `keyOf(change)` and per-branch
commit helpers) — match the surrounding style.

## Out-of-scope / residual note (do NOT chase here)

This fix guarantees the **metadata invariant** (change-log survivor HLC == columnVersion /
tombstone HLC). It does **not** touch Phase 2 data application: `dataChangesToApply` is built in
Phase-1 resolve order and applied in that order, so the host store's final *value* for a
repeated `(pk, column)` reflects the last-applied change, not necessarily the max-HLC one. In
the normal relay flow this is a non-issue — `getChangesSince` emits facts in ascending HLC
order, so the max-HLC change is applied last and store value == metadata value. A divergence is
only reachable if a caller hands `applyChanges` same-key changes in descending HLC order, which
this package never produces. If that ever needs hardening it is a separate concern (collapse or
HLC-sort `dataChangesToApply`), not this ticket. Delete is unaffected (idempotent).

## TODO

- [ ] Rewrite `commitChangeMetadata` in `packages/quereus-sync/src/sync/change-applicator.ts`
      to collapse applied resolved changes per key (max-HLC winner), writing only winners'
      metadata + change-log entries and deleting each key's single pre-batch prior entry once.
      Keep delete and column branches symmetric. Decompose into small helpers per house style.
- [ ] Keep the `result.applied/skipped/conflicts` accounting unchanged — collapse happens at
      commit time, not at resolve time, so two applied same-key changes still count as
      `applied: 2` (matches the regression tests above).
- [ ] Re-add the two `applyChanges` in-batch regression tests above to
      `packages/quereus-sync/test/sync/sync-manager.spec.ts` (in the existing `applyChanges`
      describe block, after the cross-batch dedup test ~line 706).
- [ ] Add a `batchSize = 1` multi-round walk that proves no transaction splits when same-key
      deletes are batched, mirroring `walks a multi-round delta over a delete→reinsert→delete
      key reuse…` (~line 298). Suggested shape: apply, in one `applyChanges` call, two
      same-pk deletes (`hlcA < hlcB`, distinct site IDs) **plus** a separate multi-fact
      transaction (e.g. one ChangeSet that deletes a different pk and inserts another), then
      walk `getChangesSince(peer, sinceHLC)` round-by-round advancing `sinceHLC = last.hlc`
      and assert: no repeated transactionId, strictly-ascending watermark, and the multi-fact
      transaction surfaces whole in exactly one ChangeSet.
- [ ] Re-confirm the `collectChangesSince` LOAD-BEARING INVARIANT comment
      (`sync-manager-impl.ts` ~485-502) still holds verbatim; if it credits only the write path
      for the DELETE/COLUMN dedup, extend it to note the apply path (`commitChangeMetadata`)
      now also collapses in-batch repeats. Update `docs/sync.md` if it describes the apply-path
      dedup.
- [ ] `yarn workspace @quereus/quereus-sync run test` green; then `yarn lint` (from
      `packages/quereus`) for type-check of spec call sites if any shared types drift. Stream
      output with `tee`.
