description: Hoist the duplicated `maxHLCFromChangeSets` helper into a shared `maxHLC` in clock/hlc.ts (DRY) — currently copied in quereus-sync and quereus-sync-client.
prereq:
files:
  - packages/quereus-sync/src/clock/hlc.ts                       # add `maxHLC(hlcs: Iterable<HLC>): HLC | undefined`; export from src/index.ts
  - packages/quereus-sync/src/index.ts                           # export the new helper
  - packages/quereus-sync/src/sync/change-applicator.ts          # replace local maxHLCFromChangeSets with maxHLC(changeSets.map(cs => cs.hlc))
  - packages/quereus-sync-client/src/sync-client.ts              # replace its local maxHLCFromChangeSets copy with the shared helper imported from '@quereus/sync'
difficulty: easy
----

An identical `maxHLCFromChangeSets(changeSets: ChangeSet[]): HLC | undefined` helper
now exists in two packages:

- `packages/quereus-sync/src/sync/change-applicator.ts` (added by
  sync-unified-group-atomic-ingress, used for the wire-batch watermark)
- `packages/quereus-sync-client/src/sync-client.ts` (pre-existing, used for
  per-peer `lastSyncHLC` tracking and delta-send bookkeeping, 3 call sites)

This violates the project's DRY rule. The clean fix respects the clock→protocol
layering by hoisting a **pure HLC** helper (not a `ChangeSet`-typed one) into the
lowest layer:

```ts
// clock/hlc.ts
export function maxHLC(hlcs: Iterable<HLC>): HLC | undefined {
  let max: HLC | undefined;
  for (const hlc of hlcs) {
    if (!max || compareHLC(hlc, max) > 0) max = hlc;
  }
  return max;
}
```

Call sites then pass `changeSets.map(cs => cs.hlc)`. `compareHLC` is already
exported from `@quereus/sync`, so sync-client can import `maxHLC` alongside it.

Deferred from the implement/review of sync-unified-group-atomic-ingress because
sync-client consumes `@quereus/sync` as a built package, so the new export needs a
rebuild ordering step that was out of scope for a review-stage inline fix. Low risk,
small change — just touches a package boundary, so validate both
`@quereus/sync` and `@quereus/sync-client` typecheck/build after.
