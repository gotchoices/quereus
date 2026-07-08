description: The isolation layer now commits every table in a multi-table transaction together or not at all, so a mid-commit failure can no longer leave data half-saved — reviewed and verified.
prereq:
files:
  - packages/quereus-isolation/src/isolation-module.ts        # commitConnectionOverlays(db) two-phase coordinator
  - packages/quereus-isolation/src/flush.ts                    # applyOverlayToUnderlying (apply-only) + assertFlushWriteOk
  - packages/quereus-isolation/src/filter-info.ts              # shared makeFullScanFilterInfo / makePkPointLookupFilter
  - packages/quereus-isolation/src/isolated-table.ts           # commit()/onConnectionCommit() delegate to coordinator
  - packages/quereus-isolation/src/isolated-connection.ts      # commit() calls onConnectionCommit() then overlay/underlying commit
  - packages/quereus-isolation/test/isolation-layer.spec.ts    # "atomic multi-table commit (torn-commit fix)" describe
  - docs/design-isolation-layer.md                             # § Commit and § Commit Failure Recovery
----

# Complete: torn multi-table commit in the isolation layer (implemented + reviewed)

## Summary of the work

Multi-table transaction commit in the isolation layer was **torn**: each table flushed
*and committed* its own underlying store independently, so table A landed durably before
table B applied — a failure in B left A committed. For a shared-coordinator `quereus-store`
the damage was worse: A's per-table commit flushed the whole coordinator, committing every
pending table.

The fix replaces per-table commit with a **transaction-wide, two-phase flush driven once**
(`IsolationModule.commitConnectionOverlays`): Phase 1 begins each underlying and applies its
overlay rows *without committing*; Phase 2 commits the affected underlyings only after all
have applied. A Phase-1 error (data conflict, injected IO fault, poisoned overlay) rolls back
every begun underlying and rethrows — atomic abort. `IsolatedTable.commit()` and
`onConnectionCommit()` now delegate to the coordinator; the first connection in the db commit
loop runs the whole flush and clears all overlays, later connections no-op. Per-table apply
logic was extracted to `flush.ts`; two duplicated `FilterInfo` builders were consolidated into
`filter-info.ts`.

## Review findings

### Scope reviewed
Read the full implement diff (commit `3a68a4ca`) before the handoff summary: the new
coordinator, `flush.ts`, `filter-info.ts`, the `isolated-table.ts` delegation, the connection
commit path, the new tests, and the rewritten docs. Traced the commit sequence end-to-end
(db commit loop → connection.commit → onConnectionCommit → coordinator → phase 1/2 →
overlay/underlying trailing commits).

### Verification run
- `yarn workspace @quereus/isolation run test` → **146 passing**.
- `yarn workspace @quereus/isolation run typecheck` → clean (exit 0).
- `yarn lint` (whole monorepo; only `packages/quereus` has a real eslint+tsc lint) → clean,
  no errors/warnings.

### Correctness — checked, no defects found
- **Two-phase coordinator:** apply-all before commit-all; Phase-1 catch rolls back exactly
  the begun set (tables are pushed to `applied` *before* `applyOverlayToUnderlying`, which
  begins up front, so a mid-apply throw is still rolled back); `Promise.allSettled` on
  rollback so a rollback failure can't mask the original error. Correct.
- **Overlay key ↔ underlying key mapping:** `commitConnectionOverlays` slices the `<dbId>:`
  prefix off the lowercased overlay key to get the `underlyingTables` key; both are lowercased
  and the `:` delimiter prevents a `dbId=1` prefix from matching `dbId=11` keys. Correct.
- **Idempotent completion:** the coordinator deletes **all** overlay entries it gathered
  (including no-change overlays), so later connections in the commit loop find nothing and
  no-op — no explicit "already flushed" latch needed. Matches the old `clearOverlay()` →
  `clearConnectionOverlay()` (same `connectionOverlays.delete`).
- **Poison abort:** the poison check runs while gathering entries, *before* any apply, so a
  poisoned overlay in a multi-table commit aborts before any table is touched; overlay left
  intact for the ensuing rollback to discard. Correct.
- **Preserved semantics:** delete-before-insert ordering, stable sort, `preCoerced`/
  `trustedWrite`, and the loud-INTERNAL `assertFlushWriteOk` all carried over intact.
- **Trailing connection commits:** for a covering connection `underlyingConnection` is
  `undefined`, so the only underlying commit is the coordinator's; the trailing
  `overlayConnection.commit()` acts on the ephemeral overlay only — harmless.

### DRY / structure — clean
- `filter-info.ts` and `flush.ts` extractions remove real duplication; the `isolated-table.ts`
  wrapper methods that now delegate (`createFullScanFilterInfo`, `buildPKPointLookupFilter`)
  are still live callers elsewhere in the file — not dead code.

### Tests — reviewed, adequate as a floor
The new `describe('atomic multi-table commit (torn-commit fix)')` covers happy path,
second-table-fails (the reproduced tear — asserts BOTH tables empty), first-table-fails
(order independence), pre-existing-rows-survive-abort, and the degenerate single-table case.
The `FaultyFlushModule` correctly wraps the memory module *as the isolation underlying* and
gates its injected failure on `trustedWrite` so user DML is untouched. Implementer confirmed a
manual regression-proof (reverting to per-table commit turns the tear tests red).

### Findings dispositioned
1. **Store-atomic path untested end-to-end (coverage gap) — filed.** The single-atomic-batch
   guarantee for a shared-coordinator store (IndexedDB/LevelDB) is proven only by construction
   and by the memory-backed ordering tests; no test wraps a real store in the isolation layer
   and asserts one batch. Filed as `tickets/backlog/debt-iso-store-atomic-commit-coverage.md`
   (debt, not a known defect — the coordinator code is underlying-agnostic).
2. **Multi-table poison-abort not specifically tested — reviewed, no ticket.** The poison
   check provably precedes all applies, and single-table commit-on-poison is already tested
   (`isolation-layer.spec.ts` "errors a poisoned connection at read, write, and commit").
   Added value of a dedicated multi-table poison test is marginal against non-trivial
   cross-connection-ALTER setup cost. Left as-is.
3. **Memory-underlying commit-phase infra tear (tripwire) — verified parked.** A bare IO
   failure *during* Phase 2 on a per-table-domain underlying (default memory vtab) can still
   tear; this is the documented atomicity contract, parked in
   `docs/design-isolation-layer.md` § "Commit Failure Recovery" and the
   `commitConnectionOverlays` doc comment. Confirmed present. Not a defect.
4. **Vestigial table-level `begin()`/`rollback()` — noted, out of scope.** The db transaction
   system drives *connections*, not tables; `commit()` was routed through the coordinator for
   consistency but `begin()`/`rollback()` were left untouched. If truly dead a follow-up could
   remove them; not pursued to keep the diff scoped. No action taken.

### Docs
`docs/design-isolation-layer.md` § Commit and § Commit Failure Recovery accurately describe
the two-phase flush, the delete-before-insert rationale, `trustedWrite`, and the
underlying-dependent atomicity contract. Verified against the code — up to date.

## Outcome
Implementation correct and complete for the memory/data-driven case; the store-atomic
end-to-end coverage gap is tracked as backlog debt. No inline fixes were required. Tests,
typecheck, and lint all green.
