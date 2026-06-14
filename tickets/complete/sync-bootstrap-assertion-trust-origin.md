description: Settled the snapshot-bootstrap global-assertion contract as trust-the-origin (Option 1) in two doc locations and pinned it with a contract test. Reviewed and completed.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts             # doc block :30-66 — settled trust-the-origin contract
  - docs/materialized-views.md                                  # § Snapshot bootstrap defers maintenance (~:623) + fixed botched sentence
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts  # contract-pin test: assertion-violating bootstrap succeeds
----

## Summary

Docs-and-test ticket; no production behavior change. Settled the previously-open design question (whether the bootstrap finalize should re-validate global assertions) as **trust-the-origin**: bootstrap installs one origin's already-converged state wholesale (replace, not merge), so no assertion is evaluated at finalize — uniform with the seam's posture for every other constraint type. Pinned with a test that is the deliberate inverse of the incremental seam's "assertion failure propagates" test.

## Review findings

### What was checked

- **Implement diff read first** (`git show 10ea40ca`), before the handoff summary.
- **Doc-vs-code accuracy** — traced `applyToStore` → bootstrap flush skips the seam (`store-adapter.ts:198`), and `finalizeBootstrap` (`:242-259`) calls only `refreshAllMaterializedViews()` + `notifyExternalChange`, with **no** `ingestExternalRowChanges`/assertion path. The doc claims (no assertion at finalize, not even no-dependency; MV-backed moot; per-flush can't serve bootstrap) match the code.
- **store-adapter.ts doc block** — coherent, accurate, no dangling backlog-ticket reference.
- **Test harness reuse** — the new test reuses `installSpies`, `makeSyncManager`, `cvEntry`, `toStream`, `collect` with no new infra; all symbols (`generateSiteId`, `HLCManager`, `SnapshotChunk`, `SyncState`, `InMemoryKVStore`, `SyncEventEmitterImpl`) are imported.
- **Checkpoint-key encoding** — `new TextEncoder().encode('sc:${snapshotId}')` matches the production prefix (`snapshot-stream.ts:45 CHECKPOINT_PREFIX = 'sc:'`) and the existing resumed-snapshot test's read/write convention. Production clears the checkpoint only after the finalize succeeds (`snapshot-stream.ts:510-513`), so the `=== undefined` assertion genuinely proves the success path.
- **Inverse cross-reference** — `store-adapter-seam.spec.ts:321 'assertion failure propagates …'` exists and uses the *same* `non_negative` assertion; the new test is a true inverse (bootstrap path, `seamCalls === 0`, no-throw vs. propagation).
- **Stale-reference sweep** — no `src/` or `docs/` references to the deleted backlog ticket `sync-bootstrap-assertion-enforcement` or the old "open design question" framing remain (only this ticket + archived complete tickets, which are immutable history).
- **`#trust-boundary` anchor** — exists (`materialized-views.md:587 ### Trust boundary`); both cross-references resolve.
- **Lint/tests** — `yarn workspace @quereus/sync test`: **191 passing** (ts-node/mocha typechecks the spec on load). The error lines in output are deliberate KV error-injection tests, not failures.

### Major findings → new tickets

None.

### Minor findings → fixed inline

- **Botched doc sentence (fixed).** The implement edit to `materialized-views.md` left a run-on splice: the old sentence's first half survived and a new sentence was glued on with an em-dash, duplicating "Skipping assertion checks" and producing a grammatically broken capital-after-dash. Rewrote it into one clean statement preserving all substance (settled contract, replace-vs-merge, spurious-partial-data point folded in, no-dependency + MV-backed edge points).

### Noted, not actioned

- The doc asserts "not even a no-dependency one" but no test exercises a *no-dependency* assertion specifically. Acceptable: the entire seam is skipped on every bootstrap flush, so `seamCalls === 0` proves **all** assertion types are uniformly unevaluated — a dedicated no-dependency case would add no coverage.
- The archived complete ticket `2-sync-bootstrap-defer-mv-maintenance.md` still phrases the assertion question as open; left as-is (historical record, not live docs).
