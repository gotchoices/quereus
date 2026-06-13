description: Store-backed parity coverage for the constraint-bearing `refresh materialized view` re-validation branch of `rebuildBacking`. A `describe('constraint-bearing refresh re-validation')` block in the store MV harness pins the `applyMaintenance('replace-all')` + `validateDeclaredConstraintsOverContents` + `conn.commit()` arm on the StoreBackingHost. Test-only change — no production code touched.
files:
  - packages/quereus-store/test/mv-store-backing.spec.ts                  # the new block (CHECK/FK reject+clean, commit-first parity)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # the memory spec the store block mirrors
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch (code under test; unchanged)
  - packages/quereus-store/src/common/backing-host.ts                     # StoreBackingHost.applyReplaceAll (reads-own-writes path; unchanged)
----

# Complete: store-backed constraint-bearing refresh re-validation parity

## What landed

A `describe('constraint-bearing refresh re-validation')` block was added to
`packages/quereus-store/test/mv-store-backing.spec.ts`, driving `rebuildBacking`'s
constraint-bearing branch (`assertRefreshRowsAreSet` →
`host.applyMaintenance('replace-all')` → `validateDeclaredConstraintsOverContents`
→ `conn.commit()`) on the StoreBackingHost via a table-form `using store maintained`
table. Test-only — no production source changed. Each sub-block follows the memory
spec's stale→drift flow (seed clean → `alter table src add column` marks `mt` stale +
detaches its row-time plan → drift a violator into the now-unmaintained source →
`refresh materialized view mt` and assert).

Cases (after this review): CHECK violator reject + clean, child-side FK orphan reject +
clean, and **commit-first parity** (added in review — see findings). All green.

## Review findings

### Scope of review
Read the implement diff (`git show 680b32b3`) with fresh eyes before the handoff
summary, then read: the full memory spec it mirrors
(`maintained-table-refresh-revalidation.spec.ts`), the production branch under test
(`materialized-view-helpers.ts:1330` `rebuildBacking`), `StoreBackingHost.applyReplaceAll`
(`backing-host.ts:202`), and the surrounding store harness (provider/`beforeEach`/`rows`/
`expectThrows`, and the existing `refresh` block at lines 285–418). Ran the suite and the
package typecheck.

### Correctness / does-it-test-what-it-claims — CHECKED, sound
- The two reject tests are not false positives. The drift is inserted into `src` (which,
  being stale, does not maintain `mt`), so the only place a CHECK/FK diagnostic can arise
  is `validateDeclaredConstraintsOverContents` scanning the **backing**. For that scan to
  see the violator, `applyMaintenance('replace-all')` must have already written the
  recomputed set to the coordinator's pending layer — so a green reject **transitively
  proves** the store host's reads-own-writes pending path, exactly the point the block
  claims to pin. (No separate positive-control needed; the throw is its own control. The
  memory spec's `capturePrepares` positive control already owns the "a validation scan
  runs" assertion engine-wide.)
- Diagnostic substrings (`row derived into maintained table 'main.mt'`,
  `references a missing 'main.parent'`) match the memory spec exactly. Confirmed against
  the production branch and the memory spec.
- The block correctly reaches the constraint-bearing branch (not `replaceContents`):
  `hasApplicableConstraints` is true for the declared CHECK / FK-enforcement-on tables,
  and a `replaceContents` fast path would have committed the violator and made
  `expectThrows` fail — it doesn't.

### Gap found and FIXED inline (minor) — commit-first parity on the store host
The implement handoff deferred commit-first parity, claiming it was "owned engine-wide by
the memory spec" and "already pinned for the MV-sugar store path." Verified that claim and
found it **incomplete**: the constraint-bearing branch ends in an explicit
`conn.commit()` on the resolved attach connection — a **different commit mechanism** than
(a) the MV-sugar store path's `replaceContents` (what the harness's existing
refresh-in-transaction / refresh-in-savepoint tests at lines 296/328 actually exercise —
both use `create materialized view mv using store`, i.e. constraint-less) and (b) the
memory constraint-bearing branch (memory coordinator, not the store coordinator). The
specific combination *store host + constraint-bearing branch + `conn.commit()` under an
enclosing transaction* was pinned nowhere.

Added `commit-first parity on the store backing` (a `begin; refresh; rollback` over a
conforming drift). Empirically confirmed the store branch matches memory: the refresh's
`conn.commit()` swaps the store backing independently of the outer transaction (rows
survive the rollback, stale clears). Disposition: minor, fixed in this pass.

### Gaps CONSIDERED and deliberately NOT filed (with reasons)
- **Duplicate-derived-key reject** — correctly dropped by the implementer. The set gate
  `assertRefreshRowsAreSet` runs at the engine level **before** `host.applyMaintenance`,
  so it pins nothing store-host-specific; owned by the memory spec's `duplicate-key reject
  parity` and the harness's `PK key collation` collision case. Reasoning verified against
  `rebuildBacking` (the gate precedes `applyMaintenance`). No ticket.
- **Constraint-bearing RESHAPE-arm violation on the store backing** — a real uncovered
  combination (memory covers it at `reshape arm + violation`, line 234; the store harness
  covers only the reshape *happy* path at lines 362/385). NOT filed: the reshape arm's
  validation goes through the **same** `rebuildBacking` constraint-bearing branch and the
  same `conn.commit()` mechanism just verified here, the store reshape happy path is
  already pinned, and `validateDeclaredConstraintsOverContents` / `applyReplaceAll` are
  provider-agnostic — so the residual risk is low and the value of a dedicated store
  reshape-violation test is marginal. Documented here as an explicit, low-priority
  follow-up candidate rather than a defect.
- **Real LevelDB backing** — the new Mocha block runs only against the harness's
  `InMemoryKVStore`; `test:store` re-runs the sqllogic corpus, not this spec, so the
  constraint-bearing branch is exercised against the in-memory KV provider only. Inherent
  to the harness; `applyReplaceAll` is provider-agnostic, no defect expected. No ticket.

### Type safety / DRY / cleanup — CHECKED
- Typecheck: `yarn workspace @quereus/store typecheck` → exit 0. The added test reuses the
  block's existing `isStale`/`rows`/`expectThrows`/`expect` surface; no new types, no
  `any`.
- Resource cleanup: the new sub-block uses the shared `afterEach` (`db.close` +
  `provider.closeAll`); it adds only a `beforeEach` seed, no new resources to leak.
- DRY: the per-`describe` `beforeEach` seed duplication matches the spec's (and the memory
  spec's) established scenario-per-describe style; not worth factoring.

### Validation performed
- `yarn workspace @quereus/store test` → **561 passing, 0 failing** (was 560 before the
  added commit-first test). The log noise (rehydrate-skip warnings, savepoint
  out-of-range warnings, `Data change listener error: boom`) all originates from other
  pre-existing error-path tests (`events.spec.ts`, rehydrate specs), not the new block.
- Confirmed the new block executes (not silently skipped): ran it under `--reporter spec`
  (`--grep "constraint-bearing refresh re-validation"`) → 5 passing, all five tests named
  and ticked.
- `yarn workspace @quereus/store typecheck` → exit 0.
- Did NOT re-run `yarn test:store` (LevelDB sqllogic, ~3 min); the implement pass ran it
  green and this review's change is confined to one in-memory-KV Mocha spec that the
  store sqllogic re-run does not cover. No pre-existing-error protocol triggered.

### Net
Implementation is sound and tests what it claims. One genuine store-specific coverage gap
(commit-first via `conn.commit()`) found and fixed inline; two deferrals confirmed
correct; one low-risk residual (store reshape-arm violation) documented. No production
code touched, no new tickets warranted.
