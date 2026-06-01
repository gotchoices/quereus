description: Forward optional `beginSchemaBatch`/`endSchemaBatch` module hooks from `IsolationModule` to its underlying module so a batching-capable underlying still gets single-commit APPLY SCHEMA batching under isolation. Plus an audit of the remaining un-forwarded optional `VirtualTableModule` hooks.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-isolation/README.md, packages/quereus/src/vtab/module.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/vtab/concurrency.ts
----

## What was implemented (implement stage)

`IsolationModule` now forwards both APPLY SCHEMA batch hooks to the underlying module as straight optional-call delegates (`isolation-module.ts`, directly above `getBestAccessPlan`):

```ts
async beginSchemaBatch(db, schemaName) { await this.underlying.beginSchemaBatch?.(db, schemaName); }
async endSchemaBatch(db, schemaName, error) { await this.underlying.endSchemaBatch?.(db, schemaName, error); }
```

The forward closes a silent-degradation gap: when a basis is isolated, the *registered* module is the `IsolationModule` wrapper, so APPLY SCHEMA's `runBatchedMigrationLoop` (which iterates `db.schemaManager.allModules()`) fires the hooks on the wrapper. Before this change the wrapper neither implemented nor forwarded them, so a batching-capable underlying never received begin/end and silently fell back to per-DDL commits. The feature is future-facing — no production module (memory/store/sync) implements the hooks today.

Implement-stage validation: `@quereus/quereus` + `@quereus/isolation` build clean, isolation suite 74 passing.

## Review findings

Reviewed the implement diff (`fe362ee3`) with fresh eyes against the engine-side batch-hook machinery, the planner read paths, and the un-forwarded-hook audit. Aspect angles checked: correctness, SPP/DRY, error handling, type safety, resource cleanup, performance, test coverage (happy/edge/error/regression/interaction), and docs.

**Implementation correctness — confirmed.** The forward is a correct straight delegate. Signatures match the `VirtualTableModule` interface exactly (`error?: unknown`). `db`/`schemaName` are passed verbatim — correct, the batch is engine-scoped. Error handling is sound: a throw from the underlying's `begin` propagates to `beginSchemaBatchAll` (tears down already-started modules); a throw from `end` propagates to `endSchemaBatchAll` (rethrown only when no prior loop error). Nothing swallowed; no resource the wrapper itself must clean up. The overlay-non-participation verdict holds: APPLY SCHEMA migrations are DDL against the underlying substrate, not staged user-data writes, so there is nothing overlay-side to fold into the batch commit.

**Audit table re-verified — all verdicts hold:**
- `shadowName` (implementer flagged as their least-certain item): **definitively resolved.** A whole-repo scan for the call pattern `\.shadowName\s*\(` returns **zero callers** — the `VirtualTableModule.shadowName?(name)` hook is a vestigial interface member (a SQLite `xShadowName` analogue) that the engine never invokes on *any* module, wrapped or not. Not forwarding it is correct; forwarding would be dead code. No action needed. (The `shadowName` local-variable hits in `alter-table.ts` are the unrelated `__rekey_` temp-table name, not this hook.)
- `concurrencyMode` / `expectedLatencyMs`: confirmed these are read **directly off the registered module** (`reference.ts` `TableReferenceNode.computePhysical` → `getModuleConcurrencyMode(this.vtabModule)` in `vtab/concurrency.ts`, and `this.vtabModule.expectedLatencyMs`), **not** via `getCapabilities()`. `IsolationModule` declares neither, so an isolated table resolves to `concurrencySafe=false` (serial) and `expectedLatencyMs=0`. Suppressing `concurrencyMode` is a genuine correctness safeguard — forwarding a `'fully-reentrant'` underlying value would let the parallel runtime issue concurrent `query()` calls that corrupt overlay-merge cursor state. Suppressing `expectedLatencyMs` is additionally *inert*: every parallel rule that consumes it (`rule-async-gather-*`, `rule-fanout-*`, `rule-eager-prefetch-probe`) also requires `concurrencySafe === true`, which the serial wrapper never satisfies — so the latency hint could never be actionable anyway.
- `supports` (full-query push-down): correctly suppressed — pushing a subtree to the underlying would bypass the overlay merge and hide uncommitted overlay rows.

### Findings & disposition

- **[minor — fixed inline] No end-to-end test.** The implementer's three tests are direct unit calls on the module; they prove the forward but not that APPLY SCHEMA's registered-module loop actually *reaches* the wrapper. Added `reaches the underlying through a real APPLY SCHEMA under isolation` to the `capability forwarding` block: registers a `RecordingModule extends MemoryTableModule` as the `underlying` of an `IsolationModule`, sets it as the default vtab, runs a real `declare schema` + `apply schema main`, and asserts (a) exactly one `begin('main')`/`end('main', undefined)` pair reached the underlying via the wrapper, and (b) both table `create` callbacks fired while the batch was open (`batchActiveAtCall === true`), and the batch closed after the loop. This is the stronger floor the implementer flagged as missing; re-implementing a minimal recording module locally was cheaper than a cross-package export of the `quereus`-test `RecordingMemoryModule`. (Note: the implementer's existing unit tests use the `{...new MemoryTableModule(), hook}` spread, which copies only own-enumerable hook props and never exercises `create` — a real subclass was required for the e2e path.)
- **[minor — fixed inline] Forwarding-transparency contract undocumented.** This is now the *second* forwarded optional hook (after `getMappingAdvertisements`) with no doc coverage of the wrapper's forward-vs-suppress policy. Added a **Transparent hook forwarding** bullet to `packages/quereus-isolation/README.md` § Key Features enumerating what is forwarded (`getMappingAdvertisements`, `getBestAccessPlan`, `beginSchemaBatch`/`endSchemaBatch`) and what is intentionally suppressed/augmented (`getCapabilities`, `supports`, `concurrencyMode`/`expectedLatencyMs`) with the reason for each. `docs/schema.md` § Module Batch Hooks remains accurate as-is ("every registered module that defines it" — the wrapper now defines them), so it was left unchanged.
- **[observation — no action] Double-begin under shared-underlying registration.** If the *same* underlying instance were registered both directly *and* via a wrapper (or shared across two wrappers), the batch loop — which iterates registered modules without deduping by underlying identity — would call `beginSchemaBatch` on the underlying more than once. This is a pre-existing property of the batch-loop design, not introduced by this change, and not a realistic configuration (the documented pattern registers only the wrapper). Flagging for awareness; no fix warranted.

**Major findings:** none — no new tickets filed.

### Review-stage validation

- `yarn workspace @quereus/isolation test` — **75 passing** (was 74; +1 e2e test).
- No `@quereus/quereus` source touched, so no lint/test re-run there was warranted (only README/test edits in `@quereus/isolation` plus the engine files were read, not modified).

## Carried-forward note for a future batching consumer

When a real batching underlying (e.g. a store module folding APPLY SCHEMA into one substrate commit) lands, add an isolation+batch integration test that asserts a single substrate commit end-to-end, and empirically confirm the overlay-non-participation verdict against it.
