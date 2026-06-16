description: Hoist the duplicated `maxHLCFromChangeSets` helper into a shared `maxHLC` in clock/hlc.ts (DRY) — currently copied in quereus-sync and quereus-sync-client.
prereq:
files:
  - packages/quereus-sync/src/clock/hlc.ts                       # add `maxHLC(hlcs: Iterable<HLC>): HLC | undefined`
  - packages/quereus-sync/src/clock/index.ts                     # re-exports via `export *` — no edit needed
  - packages/quereus-sync/src/index.ts                           # re-exports via `export * from './clock/index.js'` — no edit needed
  - packages/quereus-sync/src/sync/change-applicator.ts          # remove local helper; call `maxHLC(changes.map(cs => cs.hlc))`
  - packages/quereus-sync-client/src/sync-client.ts              # remove local helper; import `maxHLC` from '@quereus/sync'; update 3 call sites
difficulty: easy
----

An identical `maxHLCFromChangeSets(changeSets: ChangeSet[]): HLC | undefined` helper
exists in two packages, violating the DRY rule.  The fix adds a pure HLC helper at
the clock layer (no ChangeSet dependency) so both packages can share it.

## Architecture

`clock/hlc.ts` already exports all HLC primitives.  `clock/index.ts` re-exports
everything from `hlc.ts` via `export *`, and `src/index.ts` re-exports
`from './clock/index.js'` — so adding an export to `hlc.ts` automatically surfaces
it on the `@quereus/sync` public API with no other file edits.

The new function accepts `Iterable<HLC>` (not `ChangeSet[]`) so it lives cleanly
in the clock layer with no protocol-type import:

```ts
export function maxHLC(hlcs: Iterable<HLC>): HLC | undefined {
  let max: HLC | undefined;
  for (const hlc of hlcs) {
    if (!max || compareHLC(hlc, max) > 0) max = hlc;
  }
  return max;
}
```

Call sites pass `changeSets.map(cs => cs.hlc)` (Array.prototype.map returns an
array, which is Iterable).

`compareHLC` is already exported from `@quereus/sync`, so sync-client can add
`maxHLC` to its existing import without any new import statement.

## Build ordering note

`quereus-sync-client` consumes `@quereus/sync` as a built package.  After editing
`quereus-sync`, run `yarn workspace @quereus/sync build` (or the repo-level
`yarn build`) before type-checking `quereus-sync-client`.  The implement agent must
ensure `@quereus/sync` is built before running typecheck/build on sync-client.

## Edge cases & interactions

- **Empty iterable** — loop body never executes; returns `undefined`. Matches
  behaviour of both existing copies.
- **Single element** — returns that element unchanged.
- **Lazy iterables** — `Iterable<HLC>` accepts generators/iterators; each element
  is visited exactly once; no rewind required.
- **`null`/`undefined` elements** — not expected; HLC is a non-nullable interface.
  No guard needed — trust internal call sites.
- **Three call sites in sync-client** — all three (`handleChanges`, `pushLocalChanges`,
  `pendingSentHLC` assignment) must be updated; missing one leaves a dead private function.
- **Export surface** — `maxHLC` is a new public export on `@quereus/sync`.  No
  existing code breaks; purely additive.
- **Type compatibility** — `Iterable<HLC>` is a supertype of `HLC[]`, so the
  `Array.map()` return value satisfies it directly.

## TODO

- Add `maxHLC(hlcs: Iterable<HLC>): HLC | undefined` to `packages/quereus-sync/src/clock/hlc.ts`
  after the `hlcEquals` function (near other pure HLC utilities)
- In `packages/quereus-sync/src/sync/change-applicator.ts`:
  - Remove the local `maxHLCFromChangeSets` function
  - Import `maxHLC` from `'../clock/hlc.js'`
  - Replace `maxHLCFromChangeSets(changes)` with `maxHLC(changes.map(cs => cs.hlc))`
- Build `@quereus/sync` (`yarn workspace @quereus/sync build`)
- In `packages/quereus-sync-client/src/sync-client.ts`:
  - Remove the local `maxHLCFromChangeSets` function (lines ~43-51)
  - Add `maxHLC` to the existing import from `'@quereus/sync'`
  - Replace all 3 call sites of `maxHLCFromChangeSets(...)` with `maxHLC(...map(cs => cs.hlc))`
    — check `handleChanges`, `pushLocalChanges`, and the `pendingSentHLC` assignment
- Run `yarn build` and `yarn test` (both packages); confirm no type errors
