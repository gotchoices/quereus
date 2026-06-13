description: Declared CHECK/FK re-validation on `refresh materialized view` of a constraint-bearing table-form maintained table (the stale-refresh gap). The one derivation write path that committed unvalidated now mirrors the attach core's bulk scan inside `rebuildBacking`. COMPLETE (reviewed).
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch + hasApplicableConstraints + assertRefreshRowsAreSet + assertDerivedRowsAreSet onDuplicate param
  - packages/quereus/src/runtime/emit/materialized-view.ts                # emitRefreshMaterializedView — funnels both arms through rebuildBacking (UNCHANGED by this ticket)
  - packages/quereus/src/vtab/backing-host.ts                             # replaceContents doc note (refresh validates constraint-bearing tables away from replaceContents)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # NEW spec — 17 cases (13 from implement + 4 added in review)
  - docs/materialized-views.md                                            # bulk-paths enumeration, refresh §, out-of-scope note
  - tickets/backlog/maintained-table-refresh-revalidation-store-coverage.md  # parked follow-up coverage (filed in review)
----

# Refresh re-validation for constraint-bearing maintained tables — COMPLETE

## What landed

`refresh materialized view` of a **table-form** maintained table declaring an
applicable CHECK or a child-side FK was the one derivation write path that
committed unvalidated. The real trigger is a **stale** table: a body-relevant
source schema change marks the table stale and releases its row-time plan, so
later source writes drift in **unmaintained** (never validated); a subsequent
`refresh` recomputed that drifted set and committed it via
`BackingHost.replaceContents` (a committed-state swap that validates nothing).

Both refresh arms funnel through `rebuildBacking` (the data-only fast path and the
reshape arm's `reshapeBackingInPlace`), so the fix lives entirely there:

- **`hasApplicableConstraints(db, mt)`** — the gate: an applicable CHECK
  (op-mask ∩ INSERT|UPDATE), OR a child-side FK **when `pragma foreign_keys` is on**.
- **Constraint-less / MV-sugar** → unchanged `host.replaceContents(...)` fast path
  (byte-for-byte the prior behavior).
- **Constraint-bearing** → mirror the attach core: `assertRefreshRowsAreSet`
  (duplicate-key reject) → pending-layer `applyMaintenance('replace-all')` →
  `validateDeclaredConstraintsOverContents` (the shared bulk `not(<check>)` / FK
  anti-join scan, throwing the maintained-table-attributed CONSTRAINT diagnostic
  **before** the swap commits) → `conn.commit()` (commit-first parity).
- `assertDerivedRowsAreSet` gained an optional `onDuplicate` factory;
  `assertRefreshRowsAreSet` threads `materializedViewNotASetError` through it so
  both refresh branches reject duplicate derived keys with the identical
  diagnostic — single-sourced.

On a violation the scan throws before `conn.commit()`; statement-level rollback
discards the pending reconcile, the pre-refresh committed contents stay intact,
and the MV stays stale (the emitter clears `stale` only after a successful rebuild).

## Review findings

Adversarial pass over the implement diff (commit `35f0e1d9`), read before the
handoff. The implementation is sound, DRY (genuine reuse of the attach core's
`validateDeclaredConstraintsOverContents` — no fork), well-scoped, and the docs
were updated to match. Lint clean. Full `@quereus/quereus` memory suite green
(**6077 passing**, 9 pending — up from 6073, the +4 review tests below).

### Checked — correctness / architecture

- **Gate ↔ validator consistency.** `hasApplicableConstraints` (the branch gate)
  and `validateDeclaredConstraintsOverContents` (the scan) filter CHECKs by the
  same `INSERT|UPDATE` op-mask, and the FK term is pragma-gated in both (the gate
  early-returns; the validator's FK scan no-ops). A CHECK+FK table with the pragma
  **off** still takes the validating branch (CHECK) and the FK scan correctly
  no-ops — verified consistent. ✔
- **`validateDeclaredConstraintsOverContents` reads PENDING, not committed.** The
  bulk scan must see the `applyMaintenance('replace-all')` writes, not the
  pre-refresh committed contents — otherwise it would validate the wrong rows and
  silently pass. It reads through the registered backing connection
  (reads-own-writes; memory host `scanEffective` reads `pendingTransactionLayer ??
  readLayer`), the same mechanism the attach core uses. Empirically confirmed:
  every violation test catches the drifted row. ✔
- **Declared-constraint folding handled.** A declared CHECK/FK is a *proven*
  invariant the optimizer would fold the validation scan to empty against;
  `validateDeclaredConstraintsOverContents` swaps the live record for a
  constraint-stripped clone for the scan's duration (the ADD COLUMN
  intermediate-schema discipline) and restores it in `finally`. The refresh path
  reuses this function unchanged, so the discipline applies. ✔
- **Commit-first parity is real and matches the constraint-less path.** The
  load-bearing claim — `replaceContents` swaps committed state, so `begin; refresh;
  rollback` does NOT undo a refresh today, and the constraint-bearing branch's
  explicit `conn.commit()` must preserve that exactly. **Empirically verified**:
  a probe ran `begin; refresh; rollback` on both a constraint-less and a
  constraint-bearing table — both leave the refresh **persisted**, byte-identical.
  `replaceContents → replaceBaseLayer` confirmed to swap the committed base layer
  directly (commit-first). Pinned by a new regression test. ✔
- **Reshape arm ordering.** `reshapeBackingInPlace` calls `rebuildBacking` between
  pre- and post-reconcile structural ops; the post-reconcile data-validating ops
  scan **committed** contents, so the rebuilt rows must be committed by the time
  `rebuildBacking` returns — which the explicit `conn.commit()` guarantees
  (mirroring the attach reshape path's own commit). `shapePk` uses the live
  post-reshape `primaryKeyDefinition`, correct because the catalog is re-registered
  with the reshaped PK before `rebuildBacking` runs. ✔
- **`rebuildBacking` callers.** Exactly two: the fast path
  (`emitRefreshMaterializedView`) and the reshape arm (`reshapeBackingInPlace`).
  Create/import uses `replaceContents` directly; the incremental manager's
  full-rebuild arm does its own per-delta validation. No caller unexpectedly hits
  the new branch. ✔
- **Type safety.** The `if (!isMaintainedTable(backing) || !hasApplicableConstraints(...))`
  guard narrows `backing` to `MaintainedTableSchema` for the validator call. No
  `any`, no non-null assertions in the new code. Build (`tsc`) clean — note the
  test runner type-strips, so the explicit `yarn build` was the real type check. ✔
- **Duplicate-reject construction.** Confirmed the NOCASE-collation-coarsened
  construction in the dup-parity test genuinely reaches `assertRefreshRowsAreSet`
  (source keys 'a'/'A' as distinct BINARY rows; the backing NOCASE PK collides
  them post-derivation, before `applyMaintenance`). ✔

### Found / done — tests added (minor, fixed inline)

The implementer's 13-case spec is a solid floor (stale CHECK, stale FK, no-scan
fast-path controls, pragma-off, reshape+violation, dup-key parity). Added 4 cases
to close the gaps the handoff flagged as untested:

- **commit-first parity** — `begin;` + a *successful* constraint-bearing refresh +
  `rollback` leaves the refresh persisted and stale cleared. Pins the load-bearing
  semantic the handoff explicitly flagged as having no dedicated test.
- **CHECK + FK both declared (×3)** — a CHECK-clean/FK-orphan drift is caught by
  the FK validator; an FK-clean/CHECK-violating drift is caught by the CHECK
  validator; a both-clean drift passes and clears stale. Distinguishes a branch
  that silently ran only one validator — the prior spec tested CHECK-only and
  FK-only tables but never both on one table.

### Found / filed — coverage gaps (major, ticketed)

Filed `tickets/backlog/maintained-table-refresh-revalidation-store-coverage.md`
for two low-risk, untested corners of the new branch (neither a known defect):
- **Store-backed parity** — the new spec is memory-only; the store path runs the
  identical sequence the attach core already store-tests, so risk is low, but a
  constraint-bearing **store** refresh case (and a `yarn test:store` pass) would
  close it.
- **Collation-sensitive CHECK on the reshape arm** — the bulk scan validates the
  reconciled rows in pre-recollate physical form; a recollate that flips a
  collation-sensitive CHECK's outcome is an esoteric, documented, untested corner.

### Not changed / out of scope (confirmed, matches ordinary tables)

- **Same-txn backing-connection flush.** `conn.commit()` flushes any pending
  writes on the resolved backing connection. In practice moot: a stale refresh has
  no pending maintenance (plan released), and `applyMaintenance('replace-all')`
  subsumes any prior pending row-writes on that per-table connection. Same property
  `replaceContents` effectively has; left as-is.
- **NOT NULL on derived rows.** The bulk scan validates CHECK/FK, not the NOT NULL
  column attribute — but that is a pre-existing, path-agnostic property of *all*
  maintained-table write paths (create-fill, maintenance, refresh), not introduced
  or worsened here, and outside this ticket's CHECK/FK scope. Noted, not actioned.
- **`pragma foreign_keys = off` admits.** Rows admitted with enforcement off are
  not retro-validated when the pragma flips on, nor by a later refresh — matches
  ordinary tables.

### Pre-existing test failure flagged

The default `yarn test` (`test-runner.mjs`, hard-coded `--bail`, mocha's **default
2000 ms** timeout) intermittently aborts on `93.4-view-mutation.sqllogic` timing
out. **Not mine**: that file contains zero `refresh`/`maintained` statements (my
diff never executes in it), it passes in isolation in ~2 s (right at the 2000 ms
boundary), and the full memory suite is green at **6077 passing / 0 failing** with
`--timeout 20000`. Documented in `tickets/.pre-existing-error.md` (validated this
ticket with the raised timeout; no test disabled). Suggested durable fix for
triage: raise the test-runner's default per-test timeout or split that file.

## Validation performed

- `yarn workspace @quereus/quereus build` → exit 0 (real type check; runner strips types).
- `yarn workspace @quereus/quereus lint` → exit 0.
- New spec → **17 passing** (13 implement + 4 review).
- Full memory suite (`test-runner.mjs --timeout 20000`) → **6077 passing, 9 pending, 0 failing**.
- Commit-first parity probe (constraint-less vs constraint-bearing `begin;refresh;rollback`) → identical, both persist.
