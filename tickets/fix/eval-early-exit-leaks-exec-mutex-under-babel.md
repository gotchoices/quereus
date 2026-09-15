description: On React Native, where Metro compiles Quereus with Babel, stopping a query early (reading only the first row of `db.eval(...)`) never releases the database's execution lock, so the next statement on that database waits forever. It hangs real apps (Sereus' reference phone app cannot create a chat strand), and about 20 places in the engine have the same code shape.
files:
  - packages/quereus/src/core/database.ts:2183-2225 (`_evalGenerator`: `finally { if (stmt) { await stmt.finalize(); } releaseMutex(); }` — the proven leak)
  - packages/quereus/src/core/database.ts:2139-2181 (`_evalRoutedGenerator`, same shape at 2173)
  - packages/quereus/src/util/async-iterator.ts:32-95 (`wrapAsyncIterator` — its `return()` delegates to the generator's `return()`)
  - packages/quereus/src/core/internal-statement-cache.ts:158-161
  - packages/quereus/src/core/statement.ts:401-481 (`_iterateRowsRawInternal`)
  - packages/quereus/src/func/builtins/explain.ts:498-515, 662-680
  - packages/quereus/src/runtime/async-util.ts:126-156, 193-215 (`buffered`), 298-317 (`merge`)
  - packages/quereus/src/runtime/emit/asof-scan.ts:404-514
  - packages/quereus/src/runtime/emit/bloom-join.ts:84-145
  - packages/quereus/src/runtime/emit/dml-executor.ts:949-1046 (`runWithStatementSavepoints`), 1109-1119 (`stampMutationOrdinal`)
  - packages/quereus/src/runtime/emit/fanout-lookup-join.ts:526-545
  - packages/quereus/src/runtime/emit/remote-query.ts:45-50
  - packages/quereus/src/runtime/emit/scan.ts:152-235
  - packages/quereus/src/runtime/parallel-driver.ts:344-383 (`driveImpl`)
  - packages/quereus-isolation/src/merge-iterator.ts:40-84 (`mergeStreams`)
  - packages/quereus-plugin-leveldb/src/store.ts:148-153 (`iterate`)
  - packages/quereus/eslint.config.mjs
repro: verified
----

# Closing a query early leaks the exec mutex when Quereus runs through Babel

## Symptom (physical device, 2026-09-15)

Sereus' `reference-app-rn` (Expo SDK 53, React Native 0.79.6, Hermes, JS from Metro in a debug build) on a Galaxy Note 9 / Android 10. Creating a chat strand never finishes. Inspected live over the Hermes debugger, the strand's founding runs:

```ts
// sereus packages/cadre-core/src/strand-membership-writer.ts:256-261
for await (const row of db.eval(`select count(1) as Count from Strand.Header`)) {
  return (row.Count as number) ?? 0;
}
// …then, :299
await db.exec(`insert into Strand.Header (…) values (…)`, […]);
```

The insert never completes. Its call chain `Database.exec` → `_withMutex` → `_acquireExecMutex` stays pending forever. The database reports `execMutexDepth: 1` (`_isExecuting() === true`), `getAutocommit() === true`, not evaluating deferred constraints, and no other pending work. The JS thread is idle in its event loop.

The same was reproduced on the device with a fresh `new Database()`, independent of Sereus: `create table t (x integer primary key)`, insert three rows, then `const it = db.eval('select count(1) as c from t')[Symbol.asyncIterator](); await it.next(); await it.return();`. A following `db.exec('insert into t values (4)')` waits on `_acquireExecMutex` indefinitely.

## Root cause

Babel's lowering of **async generator functions** (the transform Metro applies through `babel-preset-expo`) mishandles a `finally` block that contains an `await`, when the generator is closed with `return()` while paused at a `yield`. The `finally` runs **up to its first `await`, and everything after that is silently dropped**: no error, and the `return()` promise still resolves `{ done: true }`. `for await (…) { return … }` / `break` closes the iterator exactly this way.

`_evalGenerator`'s cleanup is `finally { if (stmt) { await stmt.finalize(); } releaseMutex(); }`, so on an early exit `releaseMutex()` never runs and the mutex is held forever.

Node, running the same source natively, releases correctly, which is why no test here has ever seen this.

### Minimal reproduction (Node 24, no device)

Compile with `@babel/core` `transformSync` using `presets: [babel-preset-expo]` and `caller: { name: 'metro', bundler: 'metro', platform: 'android', engine: 'hermes', isDev: true, supportsStaticESM: false }`, then evaluate the CommonJS output. Versions used, as resolved from Sereus' RN app: `@babel/core` 7.29.0, `babel-preset-expo` 13.2.5, `@babel/plugin-transform-async-generator-functions` 7.29.0, `@babel/plugin-transform-regenerator` 7.29.0, `@babel/runtime` 7.28.6.

For each variant: call `next()` once, then `return()`, then check whether `rel()` ran.

| variant (`try { yield 1; … } finally { … }`) | lock released |
|---|---|
| `finally { await Promise.resolve(); rel(); }` | **no** |
| `finally { await null; rel(); }` | **no** |
| `finally { log('before'); await sleep(10); log('after'); rel(); }` | **no** — `before` logged, `after` never |
| body is `for await (x of inner()) yield x;`, `finally { await …; rel(); }` | **no** (inner generator's own `finally` does run) |
| body is `for await (x of inner()) yield x;`, `finally { rel(); }` | yes |
| `finally { rel(); await Promise.resolve(); }` | yes |
| same leaking generator, but drained with `next()` until `done` instead of `return()` | yes |
| same leaking generator consumed fully by `for await` (no early exit) | yes |
| native (untransformed) `finally { await …; rel(); }` | yes |

The result is the same with the global `Promise` replaced by React Native's `promise` polyfill, so it is the generator lowering, not the Promise implementation. A copy of `wrapAsyncIterator` around the generator does not help, because its `return()` delegates to the generator's `return()`.

### End-to-end confirmation on the device

In the running app, `Database.prototype.eval` was patched through the debugger so that an early `return()` on the returned iterator drains it with `next()` until done instead. With nothing else changed, a strand founding that had hung on every previous attempt **resolved in 2.7 s**, with the strand `active` and `execMutexDepth: 0`.

## Scope

A Babel AST scan of every `src/` file in `../quereus`, `../optimystic` and `../sereus` (1593 files) found **20** `try/finally` blocks inside async generators whose `finally` contains an `await`. All of them are in this repo, and they are the `files:` entries above (the first `await` line is cited). `database.ts:2222` is proven reachable from an ordinary `for await … return`. The others share the shape, but whether each can be closed early while suspended has not been checked site by site. Any of them that holds a lock, a savepoint, a transaction or a native cursor would leak that resource on React Native in the same way.

## What the fix has to settle

- **Per site:** make the cleanup that must happen (mutex release, cursor or statement close, savepoint release) independent of anything after an `await` in a generator's `finally`. Options include releasing synchronously before any await, or moving async cleanup out of the generator into a non-generator `return()` path such as `wrapAsyncIterator`. Check that `stmt.finalize()` and the like still run, since today they are skipped as well.
- **Guard at the highest rung of the architecture ladder:** a lint rule that flags `await` inside the `finally` of an async generator (an ESLint `no-restricted-syntax` selector along the lines of `:matches(FunctionDeclaration, FunctionExpression, MethodDefinition > FunctionExpression)[async=true][generator=true] TryStatement > BlockStatement.finalizer AwaitExpression`, verified to exclude nested non-generator functions). `quereus-isolation` and `quereus-plugin-leveldb` have no real lint today, and both contain a site.
- **A regression test that sees what Node cannot:** e.g. run the `for await … return` then `exec` sequence against a Babel-transformed build of the eval path. Whether `@babel/plugin-transform-async-generator-functions` alone reproduces the bug without the whole Expo preset has **not** been checked; settle that before choosing the test's dependencies.
- Upstream: this looks like a Babel bug worth reporting, but the engine should not depend on a transform's correctness for lock release.

## Consumers waiting on this

- Sereus `tickets/fix/rn-solo-founding-stall-on-device` (the phone cannot create strands).
