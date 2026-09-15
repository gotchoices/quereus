description: Stopping a `db.eval(...)` early on React Native left the execution lock held forever, because of a Babel helper bug fixed upstream in 7.29.2. The engine now refuses such hosts with a clear error before the first statement instead of hanging, and the React Native docs state the version requirement.
files:
  - packages/quereus/src/util/async-generator-support.ts (probe + memoized check factory)
  - packages/quereus/src/core/database.ts (`_acquireExecMutex` runs the check after taking its slot; `_evalGenerator` NOTE)
  - packages/quereus/src/core/statement.ts (`_iterateConcurrent`, the mutex-free read path, runs the check too)
  - packages/quereus/test/async-generator-support.spec.ts
  - packages/quereus/README.md (React Native § Babel helpers)
  - packages/quereus-plugin-react-native-leveldb/README.md (§ Babel Helper Version)
  - docs/plugins.md (React Native polyfills pointer)
repro: verified
----

# Early exit from `eval()` leaks the exec mutex under Babel

## Root cause

Babel's `wrapAsyncGenerator` helper (`@babel/helpers` for inline helpers, `@babel/runtime` under `transform-runtime`)
before 7.29.2 resumes every `await` inside a `finally` that runs during a consumer `return()` with a second
`return()`, aborting the rest of the block:

```js
var nextKey = key === "return" ? "return" : "next";          // <= 7.28.6  (broken)
var nextKey = key === "return" && value.k ? key : "next";    // >= 7.29.2  (fixed)
```

Metro lowers every async generator on Hermes through that helper, so `finally { await stmt.finalize(); releaseMutex(); }`
in `_evalGenerator` never released the mutex after a `break`. Plugin/core versions are irrelevant; only the helper
package version matters.

## What shipped

- `probeAsyncGeneratorCleanup()` — three-line async generator (await in `finally`, `next()` then `return()`); lives in
  engine source so on React Native it is lowered by the helper it tests.
- `createAsyncGeneratorCleanupCheck(probe)` memoizes one probe run; `ensureAsyncGeneratorCleanupSupported` is the
  process-wide instance. After success it returns `undefined` synchronously (no extra `await` per statement); on
  failure every call returns the same promise rejected with `QuereusError` / `StatusCode.UNSUPPORTED` naming the
  upgrade and the Metro cache reset.
- Checked at both statement entry points: `Database._acquireExecMutex` (every serialized statement, external-change
  ingest, MV refresh) and `Statement._iterateConcurrent` (mutex-free committed reads).
- No per-site rewrite of the engine's `finally { await … }` blocks, no lint rule, no Babel-transformed test suite
  (see implement notes: that would codify a workaround for a fixed upstream defect engine-wide).

## Consumer action (Sereus `rn-solo-founding-stall-on-device`)

```bash
cd packages/reference-app-rn && yarn up @babel/runtime @babel/helpers   # both to >= 7.29.2
npx react-native start --reset-cache
```

On-device confirmation after the bump is still pending (not doable from this repo).

## Review findings

**Read first:** implement diff `ac4b72bc8` (5 source/doc files + spec), then every caller of `_acquireExecMutex`
(`database.ts` `_withMutex` / `_evalGenerator`, `statement.ts` `_iterateRowsGenerator` / `_allGenerator`,
`database-external-changes.ts`), the mutex-free read path, and the RN docs in both READMEs and `docs/plugins.md`.

**Correctness**
- *Probe actually detects the defect* — independently verified, not taken on trust: hand-lowered the probe through the
  installed `@babel/helpers` 7.29.7 `wrapAsyncGenerator` / `awaitAsyncGenerator` in Node, once as shipped and once with
  the helper line patched back to the pre-7.29.2 form. Fixed → `completed = true`, broken → `completed = false`, both
  resolve `{ done: true }`. Matches the implement ticket's bisect.
- *First-acquisition ordering (fixed)* — the implementation awaited the probe **before** swapping in its mutex slot.
  Concurrent first callers awaiting the shared promise resume in call order, but a statement issued from a microtask
  that runs between the probe's `verified = true` and those callers' resumption would see the sync fast path and take
  the slot ahead of them. Moved the check after `await previousMutex` (slot held, so no reordering is possible by
  construction) and release the slot before rethrowing on failure. Fast path unchanged: one sync call, no `await`.
- *Mutex-free reads bypassed the check (fixed)* — `readConcurrency: 'committed'` reads go through
  `Statement._iterateConcurrent`, never `_acquireExecMutex`, so on a broken host such a read as the first statement ran
  unrefused (and its `_iterateRowsRawInternal` `finally` would drop `scanConnections.clear()` / `busy = false` after
  the disconnect `await`). Added the same check there; `runtime/types.ts` documents `_iterateConcurrent` as the sole
  setter of `readCommitted`, so these two sites cover every statement entry.
- *Throw path* — every caller does `const releaseMutex = await …_acquireExecMutex()` outside its `try`, so a
  rejection propagates without running a `finally` that references an unassigned release. Checked all five sites.
- *Rejected verdict memoized* — always returned to an awaiting caller, so no unhandled rejection; intended (the host
  does not change mid-process).

**Tests**
- Implementation only exercised the passing path; the refusal — the point of the feature — was untested. Refactored
  the module into `createAsyncGeneratorCleanupCheck(probe)` so a probe can be injected, and added: failing probe →
  `QuereusError` with `UNSUPPORTED` and the version in its message on every call, probe run once; concurrent first
  callers share one probe run, then sync `undefined`.
- Not covered: the Database-level refusal (slot release on failure, mutex-free path refusal) — the process-wide check
  is already verified by the time any spec runs and there is no seam to inject a failing probe into a `Database`.
  Read-verified instead. The existing ordering spec runs after verification, so it guards the fast path only; the
  first-acquisition ordering is now structural rather than tested.
- `yarn workspace @quereus/quereus run lint` exit 0; `run test` 10398 passing, 25 pending, 0 failing. New spec +
  `exec-mutex-reentrancy.spec.ts` run with spec reporter: 8 passing. Other workspaces not run — no source outside
  `packages/quereus` changed and the post-verification mutex path is identical.

**Docs**
- RN LevelDB README: the new "Babel Helper Version" section had been inserted between the polyfill list and its
  "You can use packages like core-js…" install instructions, orphaning them under the wrong heading. Moved the section
  after the polyfill code block.
- Metro caches transformed modules with the old helper inlined, so `yarn up` alone may not take effect. Added
  `--reset-cache` to both READMEs and the error message (the implement ticket's consumer notes already said so; the
  shipped text didn't).
- `docs/plugins.md` repeats the React Native polyfill list; added a one-line pointer to the Babel requirement.
- `docs/architecture.md` / `docs/usage.md` mutex descriptions don't need the check — it is a host-compatibility gate,
  not mutex semantics.

**Hygiene / design** — module is small and single-purpose; the conditional `await` pattern appears twice (two lines
each), judged not worth a helper. Error wording reads fine in a red box: symptom, cause, command.

**Tripwire from implement handoff** — "a throwing `disconnectVTable` in `_iterateRowsRawInternal`'s `finally` skips
`scanConnections.clear(); busy = false`": checked `runtime/utils.ts` `disconnectVTable`; it already `.catch`es and logs
a rejected `disconnect()`. Only a *synchronous* throw from a `disconnect()` typed `Promise<void>` escapes — a module
contract violation, not a reachable engine path. No NOTE or ticket.

**Tickets filed** — none.
