description: A new end-to-end test for reviving a retired table by re-deploying its schema uncovered that the revival could hang forever through the real engine; this fixes that deadlock so held edits replay as live rows, and the test proves it.
prereq:
files:
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts                 # NEW describe block (4 tests) for the lens-redeploy revival trigger
  - packages/quereus-sync/test/sync/_peer-harness.ts                       # lens-deploy listener wiring + deployOrdersLens/retireOrdersViaRedeploy/reviveOrdersViaRedeploy helpers
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                    # recordLensDeployment: reactive drain now DEFERRED when inside a live statement (the deadlock fix)
  - packages/quereus/src/core/database.ts                                  # NEW Database._isExecuting() + exec-mutex depth tracking (the re-entrancy signal)
  - docs/sync.md                                                           # § Revival / drain — lens-redeploy deferral + e2e coverage of both triggers
  - docs/migration.md                                                      # § 4 Contract — path (2) deferral note
difficulty: medium
----

# Review: real-engine e2e for the lens-redeploy revival path (+ the deadlock it uncovered)

## TL;DR for the reviewer

This started as a pure test-addition ticket (close the real-engine parity gap for the
lens-redeploy reactive drain, mirroring the inbound-`create_table` e2e). **Writing the test
exposed a real product deadlock**, so the ticket grew a product fix. Treat the fix — not just the
test — as the thing to scrutinize. All gates are green (see Validation), but the fix touches
engine core (`database.ts`) and changes a drain-timing contract, so it deserves a hard look.

## What was built

### The e2e tests (the original ask)
A new `describe('… lens redeploy …')` block in `sync-drain-e2e.spec.ts` (4 tests), plus harness
wiring in `_peer-harness.ts`:
- **Core reactive revival (the headline):** straggler `S` writes a row; holder `H` deploys the
  `app` lens mapping `orders`, then retires it (`drop table orders` → empty-lens redeploy →
  asserts `detached`), relays S→H (held), then `reviveOrdersViaRedeploy(H)` (re-create + re-map).
  Asserts the row materializes via `select`, carries S's origin HLC + siteId, the hold clears, one
  `onHeldChangesDrained` event fires, no spurious local echo, second-order relay serves it — **with
  no explicit `drainHeldChanges` call**. Embeds the idempotent re-deploy parity (no second drain).
- **Schema drift across redeploy:** S carries an extra `memo`; H revives without it; the `memo`
  entry drift-drops (`applied < drained`), siblings materialize.
- **Watch + MV maintenance:** a full `db.watch` + `orders_mv` registered before the re-map; both
  fire on the revival.
- **`store-and-forward` disposition:** the forwardable hold empties after the redeploy drain.

Harness additions: `makePeer` now binds `storeModule.setLensDeploymentListener →
manager.recordLensDeployment` (matching the quoomb-web worker), plus `deployOrdersLens`,
`retireOrdersViaRedeploy`, `reviveOrdersViaRedeploy` (each `await settle()`).

### The deadlock fix (the scope expansion — review this carefully)
**Symptom:** every new test hung at `db.exec('apply schema app')` (2 s timeout). **Root cause:**
the lens-deployment chain runs `recordLensDeployment` *inside* the `apply schema` statement, which
holds the engine exec mutex (`database.ts` `exec` → `_withMutex`). The reactive drain re-enters the
engine via the store adapter's `db.ingestExternalRowChanges`, which **re-acquires that same mutex**
(`database-external-changes.ts:142`). `apply schema` can't release the mutex until the awaited
listener returns, and the listener can't finish until it gets the mutex → **deadlock**. This is a
real production bug: the quoomb-web worker (`quereus.worker.ts:687`) wires this identically, so a
redeploy reviving a held table would hang the worker forever. `ingestExternalRowChanges`'s own
JSDoc already warns "do NOT call from within statement execution … deadlock" — the lens path
violated it. The in-memory stub tests (`basis-lifecycle-recorder.spec.ts`) never caught it because
their `applyToStore` writes a `Map` and never re-enters the engine.

**Fix (two parts):**
1. `Database._isExecuting()` (new, on the consumable type surface — deliberately not `@internal`,
   so it survives `stripInternal`): true while the exec mutex is held. Implemented as a depth
   counter incremented on acquire / decremented in the release wrapper of `_acquireExecMutex`
   (idempotent on double-release).
2. `recordLensDeployment` now branches: when `db._isExecuting?.()`, the drain is **deferred to
   fire-and-forget** (`void drainReappearedTables(...)`) — it queues on the mutex and runs the
   instant `apply schema` commits and releases it; otherwise (no live statement, e.g. the stub
   tests) it awaits inline exactly as before. `drainReappearedTables` never rethrows, so the
   `void` cannot produce an unhandled rejection.

**Behavioral consequence:** the lens-redeploy reactive drain is now *eventually*-immediate (one
event-loop turn after `apply schema` commits, observable after the local-change-capture settle),
not synchronously awaited by the deploy. This matches the inbound path's eventual model and the
periodic sweep; it is strictly better than the prior hang. Docs (`sync.md` § Revival/drain,
`migration.md` § 4) updated to state this and the inbound-vs-lens asymmetry.

## How to validate

```
yarn workspace @quereus/quereus build          # REQUIRED FIRST — see Known gaps; dist is gitignored
yarn workspace @quereus/sync test              # 429 passing (was 425; +4 new e2e)
yarn workspace @quereus/store test             # 671 passing
yarn workspace @quereus/quereus test           # 6364 passing, 9 pending
yarn workspace @quereus/sync typecheck         # exit 0
node_modules/.bin/tsc -p packages/quereus-sync/tsconfig.test.json --noEmit   # exit 0
yarn workspace @quereus/quereus lint           # exit 0 (eslint + test-file typecheck)
```
All run and green on branch `view-updates-lens`. The expected log noise in the sync run
(`recordLensDeployment … hash drifted`, oversized-transaction, failing-KV stubs, the advisory
`drainReappearedTables failed … (test)` swallow line) is pre-existing and documented in the prior
ticket 1.5 — none are failures.

### Load-bearing things the tests pin (don't let a refactor silently break these)
- **Retire ordering:** `drop table orders` MUST precede the empty-lens redeploy, else the table
  classifies `unreferenced` (in basis, unmapped) not `detached`, and the later revive transitions
  `unreferenced → directly-mapped` — not `detached → present` — so the reactive drain never fires
  and the test would silently prove nothing. The core test asserts `getBasisTableLifecycle()` shows
  `detached` after the retire to guard this.
- **`select … from orders` resolves to the physical `main.orders`, not the lens view `app.orders`.**
- **No explicit `drainHeldChanges`** anywhere in the redeploy block — the redeploy is the trigger.

## Known gaps / things for the reviewer to scrutinize

- **`dist` is gitignored.** The engine source change must be compiled into `packages/quereus/dist`
  (which `@quereus/sync` consumes) before the sync tests pass — a fresh checkout that runs
  `yarn workspace @quereus/sync test` WITHOUT building quereus first will hit the *old* dist and
  **deadlock again**. `yarn build` (or `yarn workspace @quereus/quereus build`) first is mandatory.
  The runner/CI normally builds before testing, but flag this loudly because the failure mode is a
  hang, not a clear error.
- **Design choice: conditional defer vs. always-defer.** I kept the inline-await path for the
  no-live-statement case so the existing in-memory `basis-lifecycle-recorder.spec.ts` tests (which
  `await recordLensDeployment` then assert the drain completed synchronously) stay green
  *unmodified*. The alternative — always fire-and-forget + update those stub tests to await a flush
  — is arguably cleaner (uniform behavior, no `_isExecuting` coupling) but touches more. Worth a
  judgment call.
- **Engine surface addition.** `Database._isExecuting()` is now public (sync, a separate package,
  calls it). Confirm that's an acceptable place to expose exec-mutex state, and that the
  `_acquireExecMutex` release-wrapper change (closure with a `released` guard instead of returning
  `releaseMutex` directly) doesn't break any caller relying on the release fn's identity.
- **Lifecycle race (production, not tested here):** the deferred drain is fire-and-forget; if the
  `Database` is closed between `apply schema` committing and the deferred drain running, the drain's
  `ingestExternalRowChanges` throws `checkOpen`, swallowed by `drainReappearedTables`. The e2e
  `await settle()` makes the drain complete before teardown, so this race isn't exercised — consider
  whether a worker closing mid-deploy needs explicit handling.
- **quoomb-web not re-typechecked.** The worker wires this exact path but doesn't call
  `_isExecuting`, and the `Database` surface only *gained* a method (additive — can't break a
  consumer), so I didn't run the slower web build. Low risk; verify if you want belt-and-suspenders.
- **`test:store` not run.** This is test-code + an additive engine signal; the LevelDB store path
  isn't implicated. Not run (slow). Mention if a store-backed pass is wanted.
