description: Stopping a `db.eval(...)` early on React Native left the execution lock held forever. Root cause is a Babel helper bug fixed upstream in 7.29.2, so the engine now refuses such hosts with a clear error before the first statement instead of hanging, and the React Native docs state the version requirement. No engine cleanup paths were rewritten.
files:
  - packages/quereus/src/util/async-generator-support.ts (new: probe + memoized `ensureAsyncGeneratorCleanupSupported()`)
  - packages/quereus/src/core/database.ts:652-658 (`_acquireExecMutex` runs the check first), 2229-2233 (`_evalGenerator` NOTE)
  - packages/quereus/test/async-generator-support.spec.ts (new)
  - packages/quereus/README.md (React Native § Babel helpers)
  - packages/quereus-plugin-react-native-leveldb/README.md (§ Babel Helper Version)
repro: verified
----

# Early exit from `eval()` leaks the exec mutex under Babel — re-scoped

## Root cause (settled; supersedes the fix ticket's "what the fix has to settle")

The fix ticket blamed Babel's async-generator lowering in general and proposed rewriting ~20 `finally` blocks, an ESLint
rule, and a Babel-transformed regression suite. Bisecting in Node (no device) narrows it to one line in one helper:

`wrapAsyncGenerator` (shipped identically in `@babel/helpers`, used for inline helpers, and `@babel/runtime`, used under
`transform-runtime`) chooses how to resume the generator after an awaited value with

```js
var nextKey = key === "return" ? "return" : "next";                 // <= 7.28.6  (broken)
var nextKey = key === "return" && value.k ? key : "next";           // >= 7.29.2  (fixed, 2026-03-16)
```

While a consumer `return()` is being delivered, every `await` inside the `finally` (an `OverloadYield` with `k === 0`)
was resumed with a second `return()`, aborting the rest of the block. The fixed line keeps `return` only for a
delegated `yield*` (`k === 1`). Verified by compiling `try { yield } finally { await p; rel() }`, calling `next()` then
`return()`, and checking whether `rel()` ran:

| helper source | result |
|---|---|
| `@babel/runtime` 7.26.10, 7.27.0, 7.27.6, 7.28.6 | dropped |
| `@babel/runtime` 7.29.2, 7.29.7 | runs |
| `@babel/helpers` 7.28.6 (inline, no transform-runtime) | dropped |
| `@babel/helpers` 7.29.2, 7.29.7 | runs |
| Babel 8.0.5 | runs |

Plugin/core version is irrelevant: `@babel/core` 7.29.0 with `@babel/helpers` 7.29.7 passes; the Sereus app has
`@babel/core` 7.29.0 with `@babel/helpers` **7.28.6** and `@babel/runtime` **7.28.6** (lockfile stale; every RN / Expo
package pins `^7.20.0`, so a plain `yarn up @babel/runtime @babel/helpers` in the app resolves it).

## What changed here

- **Fail loud, once.** `ensureAsyncGeneratorCleanupSupported()` runs a 3-line probe generator (await in `finally`,
  `next()` then `return()`) and memoizes the verdict. `_acquireExecMutex` calls it before touching the mutex chain, so
  every `exec` / `eval` / statement path is covered. After the first success it is a synchronous `undefined` — no extra
  `await` in the acquisition path, so mutex ordering stays call order. On failure every statement throws a
  `QuereusError` with `StatusCode.UNSUPPORTED` naming the upgrade. The probe lives in engine source, so on RN it is
  lowered by the same helper it is testing.
- **Docs.** Both React Native README sections state the `>= 7.29.2` requirement, the symptom, and the command.
- **`_evalGenerator` NOTE** pointing at the check, so a reader of the `await finalize(); releaseMutex()` shape knows
  why it is left spec-shaped.

## What was deliberately not done

- No per-site rewrite of the 20 `finally { … await … }` blocks and no lint rule banning `await` in async-generator
  `finally`. Those codify a workaround for a fixed upstream defect across the whole engine, permanently, and awaiting a
  cursor close in `finally` is exactly what async generators are for. Only one site was ever observed to leak; the
  others were shape matches.
- No Babel-transformed regression suite: it would have to pin a known-broken `@babel/runtime` as a devDependency to
  test a transpiler, not the engine. The probe's contract is the guard instead.
- No upstream report: already fixed.

## Consumer action (Sereus `rn-solo-founding-stall-on-device`)

```bash
cd packages/reference-app-rn && yarn up @babel/runtime @babel/helpers   # both to >= 7.29.2
```

then clear Metro's cache and rebuild. With stale helpers the app will now fail on its first statement with the
`UNSUPPORTED` message rather than hang. On-device confirmation of the strand founding after the bump is still pending
(not doable from this repo).

## Testing

- `packages/quereus/test/async-generator-support.spec.ts`: probe returns true natively; second call is the sync fast
  path; three concurrent `exec` calls still complete in call order.
- `yarn workspace @quereus/quereus run lint` and `run test` green (see handoff run).
- The failing path (probe returns false → `UNSUPPORTED` thrown on every statement) cannot be exercised under Node's
  native generators and is not simulated; the reviewer should read `ensureAsyncGeneratorCleanupSupported()` for the
  rejection-memoization behaviour (a rejected `pending` stays rejected for the process — intended: the environment
  does not change).

## Reviewer checklist

- `_acquireExecMutex` now has a conditional `await` before the mutex swap on the very first acquisition in a process.
  Confirm nothing relies on the first-ever acquisition swapping synchronously (`exec-mutex-reentrancy.spec.ts` and
  `statement-iterator-cleanup.spec.ts` pass).
- Message wording in `UNSUPPORTED_MESSAGE` is user-facing; check it reads well in a red-box.
- Tripwire, not a ticket: the fix-stage agent noticed that natively a throwing `disconnectVTable` in
  `_iterateRowsRawInternal`'s `finally` (statement.ts ~474-486) skips `scanConnections.clear(); this.busy = false;`.
  Unrelated to Babel; only matters if a vtab's `xDisconnect` ever throws.
