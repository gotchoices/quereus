description: A new test proves that refreshing a materialized view whose stored rows have drifted stale republishes the corrected rows to peers as one batched change rather than many; this reviews and accepts that test.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts
difficulty: medium
----

## What was delivered

A new `describe('stale-drift refresh of a materialized view publishes one grouped
change-set')` block in `echo-loop-quiescence.spec.ts` (two tests) plus two module-scope
fixture builders (`makeFilteredFilledPeer`, `makeFilteredEmptyPeer`) layered on the
existing `makeBarePeer`. It covers the second `replaceContents` call site —
`rebuildBacking`'s fast path, reached by `refresh materialized view` when the backing
shape is unchanged — for a refresh that diffs to ≥1 delta, asserting the delta publishes
as ONE grouped change-set under a single HLC (producer side) and converges quiescently
(peer side). The `DEFERRED` comment block at the bottom of the create-fill suite's third
test was removed. This is a test-only change; no engine/source code was touched.

## Review findings

### Checked: correctness of the staleness mechanism (the load-bearing claim) — VERIFIED
The whole test's meaningfulness rests on `alter table src alter column g set collate
nocase` (on the WHERE-only, unprojected column `g`) genuinely marking the MV stale via
the content-stability gate. Confirmed against engine source
(`materialized-view-helpers.ts` `valueSemanticsChangedColumns` / `referencedSourceColumns`
and `database-materialized-views.ts` the schema-change listener): a value-semantics ALTER
on a column the body READS but does NOT project declines the in-place recompile → marks
stale → detaches the row-time plan, while the derived shape stays `(id, v)` so refresh
takes the `replaceContents` fast path (not the reshape arm). This is the exact recipe
`packages/quereus/test/maintained-table-refresh-revalidation.spec.ts` uses (8 call sites).
The plan ticket's only open question — "does staging stale drift need an engine-internal
hook?" — is answered NO; it is fully public SQL.

### Checked: vacuous-green / self-protection — VERIFIED, well-guarded
The test cannot silently pass if the drift fails to stage:
- `derivation.stale === true` is asserted directly after the alter — a no-op alter (e.g.
  if the store ever reconciled non-PK text collations to a default) would fail here, RED.
- `committed MV lags the body` deep-equals SEED before refresh — proves the drift was NOT
  maintained in (genuine divergence to republish).
- Granularity is pinned to `DRIFTED_ROWS × CHANGED_NONPK_COLUMNS = 2`; a full-row
  replacement (4 changes, PK re-recorded) or N-ungrouped-singletons regression both go RED.
- The grouping crux is double-guarded: `afterMvSets.length === 2` AND
  `refreshSets.filter(!beforeTxnIds.has(txnId)).length === 1` — a refresh delta fused into
  the create-fill set (no new txnId) would fail both.

### Checked: single-HLC / one-transaction claim — VERIFIED
Every refresh change is asserted to share the set's `transactionId` (via
`deterministicTxnId(c.hlc)`) and the same base HLC (wallTime/counter/siteId), mirroring
the proven create-fill test. Distinctness from the create-fill txn and from every src
(seed + drift) txn is asserted.

### Checked: peer-side convergence + quiescence (test 2) — VERIFIED, meaningful
B (live, filtered MV over empty src, never receives the alter) ingests A's relayed src
seed + drift + mv refresh delta; convergence deep-equals A's mv & src; B fires remote mv
events, NO local re-derivation event, and logs zero B-origin echo. Collation-qualification
parity holds: the seed value `'keep'` satisfies `g <> 'skip'` under both BINARY (B) and
NOCASE (A), so no row can diverge for a collation reason. This is the established
suppression proof reused for the refresh-delta path — a real, non-redundant coverage add.

### Checked: lint + tests — PASS
- `yarn workspace @quereus/sync run test:single …echo-loop-quiescence.spec.ts` → 10 passing
  (8 pre-existing + 2 new).
- `yarn workspace @quereus/sync run test` (full suite) → **374 passing, 0 failing**. The
  console noise (`recordLensDeployment … hash drifted`, oversized-transaction warnings, a
  stack trace from `sync-manager.spec.ts:1662`) is INTENTIONAL fault-injection error-path
  assertions, not failures — confirmed by inspecting the failing-looking lines (all inside
  `sync-manager.spec.ts` fault tests).
- `yarn workspace @quereus/sync run typecheck` → clean.
- No `packages/quereus` source changed → `packages/quereus` lint unaffected (the only
  package with a lint script); `quereus-sync` has typecheck only, which passed.

### Minor findings — none fixed (deliberately), all acceptable
- **Helper duplication.** `makeFilteredFilledPeer`/`makeFilteredEmptyPeer` structurally
  echo `makeFilledPeer`/`makePeer`. This follows the already-established four-builder
  pattern in the file (each layers on the shared `makeBarePeer` core) and the schemas
  genuinely differ (the `g` staleness lever). Refactoring into a parameterized builder
  would churn the existing fixtures for no behavioral gain — left as-is.
- **`settle()` wall-clock dependency.** The 25ms `setTimeout` flush is inherited harness
  (not new to this ticket) and is documented in the spec's own comments. First suspect if
  the new tests ever flake on a loaded CI box, but not a correctness defect.
- **Scenario-pinned consts.** `DRIFTED_ROWS = 2` / `CHANGED_NONPK_COLUMNS = 1` are tied to
  this exact 2-row/single-column drift and are not derived from the data; a future edit to
  the drift must update them in lockstep. They are named consts (per the plan) so the
  coupling is explicit — acceptable.

### Major findings — NONE
No correctness bugs, no missing-coverage that warrants a new ticket. The reshape-arm
grouping is explicitly and correctly out of scope (the shape-pin assertion guards against
a future projection of `g` silently rerouting onto it); the empty/no-op refresh remains
covered by the create-fill suite's third test. No new fix/plan/backlog tickets filed.

### Not done
- Did not run `yarn test:store` or the full repo `yarn test` — the change is confined to
  one sync spec file with no shared-code impact; the sync suite + typecheck are green.
- No `.pre-existing-error.md` written — no test failures surfaced.
