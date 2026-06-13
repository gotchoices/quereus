description: Review — declared CHECK/FK re-validation on `refresh materialized view` of a constraint-bearing table-form maintained table (the stale-refresh gap). Implemented; build + lint + full memory suite + store workspace green.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # rebuildBacking (the change), hasApplicableConstraints (new), assertRefreshRowsAreSet (new), assertDerivedRowsAreSet (parameterized)
  - packages/quereus/src/runtime/emit/materialized-view.ts           # emitRefreshMaterializedView — unchanged; both arms still funnel through rebuildBacking
  - packages/quereus/src/vtab/backing-host.ts                        # replaceContents doc note updated (refresh now validates constraint-bearing tables away from replaceContents)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts  # NEW spec — 13 cases
  - docs/materialized-views.md                                       # bulk-paths enumeration + out-of-scope note updated
difficulty: medium
----

# Review: refresh re-validation for constraint-bearing maintained tables

## What changed

`refresh materialized view` of a **table-form** maintained table that declares an
applicable CHECK or a child-side FK was the one derivation write path that
committed unvalidated. The real trigger is a **stale** table: a body-relevant
source schema change marks the maintained table stale and releases its row-time
plan, so subsequent source writes drift in **unmaintained** (and never validated);
a later `refresh` recomputed that drifted set and committed it via
`BackingHost.replaceContents` (a committed-state swap that validates nothing).

Both refresh arms funnel through `rebuildBacking` (the fast/data-only path and the
reshape arm's `reshapeBackingInPlace`), so the fix lives entirely there:

- **`hasApplicableConstraints(db, mt)`** (new) — the gate. `mt.checkConstraints`
  with op-mask ∩ (INSERT|UPDATE), OR a child-side FK **when `pragma foreign_keys`
  is on** (FK term pragma-gated so an FK-only table with enforcement off keeps the
  fast path — its bulk FK scan would no-op anyway).
- **Constraint-less / MV-sugar** → unchanged `host.replaceContents(...)` fast path
  (byte-for-byte the prior behavior; no connection, no scan).
- **Constraint-bearing** → mirror the attach core: `assertRefreshRowsAreSet`
  (duplicate-key reject, parity with `replaceContents`) → pending-layer
  `applyMaintenance('replace-all')` → `validateDeclaredConstraintsOverContents`
  (the same bulk `not(<check>)` / FK anti-join scan attach/create-fill use, which
  throws the maintained-table-attributed CONSTRAINT diagnostic **before** the swap
  commits) → `conn.commit()` (commit-first parity).
- `assertDerivedRowsAreSet` gained an optional `onDuplicate` error factory;
  `assertRefreshRowsAreSet` threads `materializedViewNotASetError` through it so
  both refresh branches reject duplicate derived keys with the **identical**
  diagnostic. Single-sourced — no divergence.

On a violation the scan throws before `conn.commit()`; statement-level rollback
discards the pending reconcile, the pre-refresh **committed** contents stay intact,
and the MV stays stale (the emitter clears `stale` only after a successful rebuild).

## Why commit-first (load-bearing, verify this)

`replaceContents` is already commit-first (`begin; refresh; rollback` does NOT undo
a refresh today). The constraint-bearing branch's `conn.commit()` preserves that
exact observable behavior AND is required by the reshape arm:
`reshapeBackingInPlace`'s post-reconcile data-validating ops (retype / recollate /
tighten-NOT-NULL) scan **committed** contents after `rebuildBacking` returns, so
the rebuilt rows must be committed by then. Mirrors the attach reshape path's own
explicit `conn.commit()` before its post-reconcile ops.

## Validation performed

- `yarn workspace @quereus/quereus build` → exit 0.
- `yarn workspace @quereus/quereus lint` → exit 0.
- New spec `test/maintained-table-refresh-revalidation.spec.ts` → 13 passing.
- All `maintained-table*` + `materialized-view*` specs → 114 passing.
- Full memory suite (`yarn workspace @quereus/quereus test`) → 6073 passing, 9
  pending, 0 failing.
- Store workspace (`yarn workspace @quereus/store test`) → 546 passing, 0 failing
  (the logged "Failed to rehydrate / rollback-to savepoint out of range" lines are
  deliberate negative-path test scenarios, not failures).

## Test cases covered (the floor — extend, don't trust)

- **Stale fast-path CHECK violation**: drift `v='poison'` into an unmaintained
  source → refresh throws `row derived into maintained table 'main.mt'`; pre-refresh
  rows intact; mt stays stale. Plus a conforming-refresh variant that clears stale.
- **Stale fast-path child-side FK orphan**: drift an orphan → refresh throws
  `references a missing 'main.parent'`; intact + stale. Plus matching-parent passes,
  NULL-ref passes (MATCH SIMPLE), and **empty recomputed set** passes.
- **Constraint-clean fast path untouched**: spies `db.prepare` and asserts a
  constraint-less table-form refresh and an MV-sugar refresh issue **no** validation
  scan (`where not (` / `not exists (`); positive control asserts a constraint-bearing
  refresh DOES.
- **`pragma foreign_keys = off`**: an orphan-drifted FK-only table refresh succeeds
  (no retro-validation), matching ordinary tables.
- **Reshape arm + violation**: a `select *` constraint-bearing body shape-shifts
  (trailing add) then drifts a violator → refresh throws the attribution; the table
  is not left holding the violating row; mt stays stale.
- **Duplicate-key reject parity**: a NOCASE collation-coarsened backing key
  (`select k collate nocase`) drifts a colliding `'a'`/`'A'` while stale →
  constraint-less and constraint-bearing refresh both reject with the same
  `materializedViewNotASetError` ("body produces duplicate rows").

## Honest gaps / suggested reviewer attention

- **No store-backed test for the NEW constraint-bearing refresh path.** The new
  spec uses the **memory** backing only. Existing store MV tests
  (`packages/quereus-store/test/mv-store-backing.spec.ts`) cover refresh/reshape of
  **constraint-less / MV-sugar** store backings — those take the unchanged
  `replaceContents` fast path, so they don't exercise the new `applyMaintenance` +
  `validateDeclaredConstraintsOverContents` + `conn.commit()` branch on a store
  backing. The store workspace passes (no regression) and the attach core already
  uses the identical sequence on store backings, so risk is low — but a store-parity
  test for a constraint-bearing table-form maintained-table refresh would close the
  gap. `yarn test:store` (the LevelDB sqllogic re-run) was **not** run.
- **No explicit `begin; refresh; rollback` test on a constraint-bearing table.**
  Commit-first parity is preserved by construction (same `conn.commit()` semantics
  as `replaceContents`), but there is no dedicated assertion that a rollback after a
  *successful* constraint-bearing refresh does not undo it.
- **Reshape + collation-sensitive CHECK corner (documented, not covered).** On the
  reshape arm the declared CHECK/FK is validated against rows in their
  pre-post-reconcile (not-yet-retyped/recollated) **physical** form. Fine for
  value-domain CHECK/FK (tested); a recollate that flips a collation-sensitive
  CHECK's outcome is a documented corner with no test.
- **Duplicate-reject construction is indirect.** It relies on NOCASE
  collation-coarsening to force a refresh-time PK collision (a clean-shape collision
  is otherwise hard to produce — most ways to make a body bag also shift the derived
  PK into the reshape/inexpressible path). Worth a sanity read that the construction
  exercises `assertRefreshRowsAreSet`, not some earlier reject.
- **Same-txn connection flush note (unchanged scope).** If `resolveAttachConnection`
  returns a pre-existing registered backing connection carrying unrelated pending
  writes, the `conn.commit()` flushes those too — the same property `replaceContents`
  already has (it ignores all pending state). Not expanded here; flagged in the
  ticket as out-of-scope.

## Out of scope (unchanged, matches ordinary tables)

Rows admitted under `pragma foreign_keys = off` are not retro-validated when the
pragma flips on, nor by a later refresh.
