description: Verify the new test proving that refreshing a materialized view whose stored rows have drifted stale republishes the corrected rows to peers as one batched change (not many).
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # all new code lives here (fixtures + new describe block); DEFERRED comment removed
difficulty: medium
----

## What landed

A new `describe('stale-drift refresh of a materialized view publishes one grouped
change-set')` block in `echo-loop-quiescence.spec.ts`, covering the **second**
`replaceContents` call site — `rebuildBacking`'s fast path
(`materialized-view-helpers.ts`), reached by `refresh materialized view` when
`backingShapeMatches` (`materialized-view.ts`) — for a refresh that diffs to **≥1
delta**. This is the non-empty refresh-grouping half that the create-fill suite
explicitly deferred; the `DEFERRED` comment block (formerly at the bottom of the
create-fill suite's third test) has been removed.

Two new module-scope fixture builders layered on the existing `makeBarePeer`:

- `makeFilteredFilledPeer(name, seedRows)` — `src(id, v, g)`, seeded all-qualifying
  in ONE multi-row insert, then a tagged MV `select id, v from src where g <> 'skip'`
  (so `g` is read by the body but NOT projected). Non-empty create-fill (producer A).
- `makeFilteredEmptyPeer(name)` — identical schema, MV over an empty `src` (peer B).

These reuse the existing `relay` / `changesFor` / `settle` / `collect` / `closePeer`
harness verbatim.

## How the drift is staged (no engine-internal hook — all public SQL)

The plan ticket's only open question was whether staging a genuine stale drift needs
an engine-internal hook. **It does not** — the WHERE-only column `g` is the staleness
lever, the exact recipe `packages/quereus/test/maintained-table-refresh-revalidation.spec.ts`
already uses. End to end (in `staleAndDrift()`):

1. `alter table src alter column g set collate nocase` — value-semantics change to a
   body-READ column → content-stability gate declines in-place recompile → MV marked
   **stale**, row-time plan **detached**. `g` is not projected, so the derived shape
   stays `(id, v)` → `backingShapeMatches` true → refresh takes the **fast path**.
2. `update src set v='A2' where id=1` / `…='B2' where id=2` — while stale these are
   NOT maintained into the MV, so the committed MV backing LAGS the body (genuine drift).
   id=3 is left untouched, so the refresh diffs to exactly two `op:'update'` deltas.
3. `refresh materialized view mv` — recomputes; replicating `replaceContents` diffs vs
   the committed before-image and queues `op:'update'` per drifted key, batched under
   `db._ensureTransaction()` → ONE grouped change-set / one HLC.

I verified each property against the source (not just the proven recipe):
- `reconcilePkCollations` (store) is PK-only → non-PK `g` keeps its BINARY default →
  `set collate nocase` is a genuine BINARY→NOCASE change (NOT a no-op on store tables).
- `valueSemanticsChangedColumns` flags `g`; `referencedSourceColumns` includes `g`
  (read in WHERE) → gate declines → stale.
- `recordColumnVersions` records only columns where `oldValue !== newValue`; an UPDATE
  carries `oldRow`, so only the changed non-PK `v` is recorded (the PK is NOT
  re-recorded — contrast a fresh insert).

## Assertions to validate (what the reviewer should confirm holds / is meaningful)

**Producer (A), test 1:**
- Before refresh: exactly 1 mv ChangeSet (create-fill), `N × COLUMNS_PER_FRESH_INSERT`
  (3 × 2 = 6) changes.
- Vacuous-green guards: committed MV still serves the SEED values before refresh (drift
  not maintained), and `derivation.stale === true`.
- After refresh: exactly 2 mv ChangeSets; the NEW one (txnId not seen before) is the
  refresh delta and is exactly ONE set (the grouping crux — N singletons would be N sets).
- Granularity: refresh-set mv changes `=== DRIFTED_ROWS × CHANGED_NONPK_COLUMNS` (2 × 1
  = 2), each `type:'column'`, `column === 'v'`, distinct values `['A2','B2']`.
- One transaction / one base HLC: every refresh change shares `transactionId` and base
  HLC (wallTime/counter/siteId; only opSeq differs).
- Distinctness: refresh txnId ≠ create-fill txnId and ≠ every src (seed + drift) txnId.
- Fast-path/shape pin: MV columns stay `(id, v)` after refresh; stale cleared.

**Peer (B), test 2:** B holds zero B-origin mv changes pre-relay; `relay` applies > 0;
B's mv & src deep-equal A's (the drifted contents); B saw the mv rows `remote:true`,
fired NO local mv event, and `changesFor(B, A.siteId)` is length 0 (quiescence).

## Verification performed

- `yarn workspace @quereus/sync run test:single packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts`
  → **10 passing** (8 pre-existing + 2 new).
- `yarn workspace @quereus/sync run test` (full suite) → **374 passing**. NOTE: the
  console shows `[Sync] Error handling transaction commit: …` and oversized-transaction
  warnings — these are INTENTIONAL error-path assertions in `sync-manager.spec.ts`
  (fault-injection tests), not failures.
- `yarn workspace @quereus/sync run typecheck` (`tsc --noEmit`) → clean (no output).
- No `packages/quereus` source changed, so `yarn workspace @quereus/quereus lint` is
  unaffected and was not re-run.

## Honest gaps / things to scrutinize

- **Timing dependency (inherited).** The suite uses `settle()` (a 25ms `setTimeout`) to
  flush the engine's fire-and-forget transaction-boundary capture before reading the
  change log. This is the established harness pattern, not new to this ticket, but it is
  a wall-clock dependency — a heavily loaded CI box could in principle race it. If the
  new tests ever flake, `settle`'s delay is the first suspect.
- **Granularity consts are scenario-specific.** `DRIFTED_ROWS = 2` and
  `CHANGED_NONPK_COLUMNS = 1` are pinned to this exact 2-row / single-column drift. They
  are named consts (per the ticket) so the reasoning is explicit, but a reviewer editing
  the drift must update them in lockstep — they are not derived from the data.
- **Fast path only.** This test deliberately covers ONLY the `replaceContents` fast-path
  seam (shape unchanged). The shape-pin assertion guards against a future projection of
  `g` silently rerouting to the reshape arm, but the reshape arm's own grouping is out of
  scope here (and the create-fill suite's third test still covers the empty/no-op refresh).
- **`set collate` no-op edge.** If a future change made the store reconcile non-PK text
  collations to a table-level default (it currently does not — PK-only), `set collate
  nocase` could become a no-op and silently fail to stale, making test 1 vacuously…
  except the explicit `derivation.stale === true` and "committed MV lags" guards would
  catch it (go red). Worth a glance to confirm those guards read as intended.
- I did not run `yarn test:store` or the full repo `yarn test` — the change is confined
  to one sync spec file and the sync suite + typecheck are green.
