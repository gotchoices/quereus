description: Validate declared CHECK/FK over the rows `refresh materialized view` writes into a constraint-bearing table-form maintained table — the one derivation write path that still bypasses declared-constraint validation (stale-refresh is the real-world trigger).
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # rebuildBacking (the change site); resolveAttachConnection / validateDeclaredConstraintsOverContents / assertDerivedRowsAreSet / resolveBackingHost / computeBackingPrimaryKey all live here
  - packages/quereus/src/runtime/emit/materialized-view.ts           # emitRefreshMaterializedView (fast path + reshape arm both call rebuildBacking)
  - packages/quereus/src/vtab/backing-host.ts                        # replaceContents vs applyMaintenance('replace-all') contract
  - packages/quereus/src/schema/constraint-builder.ts                # the eager SQL-scan validators the bulk path reuses
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts  # model for the new spec
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts      # model for constructing stale + refresh / reshape scenarios
difficulty: medium
----

# Refresh re-validation for constraint-bearing maintained tables

`maintained-table-derivation-check-fk-validation` validates declared CHECK and
child-side FK on every derivation write path EXCEPT manual
`refresh materialized view` of a table-form maintained table. Both refresh arms
funnel through `rebuildBacking` (materialized-view-helpers.ts ~L1240), which
re-runs the body and swaps the result in via `BackingHost.replaceContents` —
a **committed-state** swap that validates nothing.

## The gap and its trigger

For a continuously-maintained table a refresh re-derives a row set every member
of which already entered through a validated boundary, so it cannot introduce a
violator. The real exposure is a **stale** table: a body-relevant source schema
change marks the maintained table stale and `releaseRowTime` detaches its
row-time plan (`database-materialized-views.ts` ~L487/L493), so subsequent source
writes are NOT maintained into it (and never validated against its declared
constraints). A later `refresh` recomputes from that drifted source state and,
today, commits it unvalidated.

(Pre-existing FK rows admitted under `pragma foreign_keys = off` are out of
scope — pragma flips deliberately do not retro-validate, matching ordinary
tables.)

## Both refresh arms reach `rebuildBacking`

```
emitRefreshMaterializedView (materialized-view.ts)
  ├─ backingShapeMatches  → rebuildBacking(db, mv)        // FAST PATH (data-only swap)
  └─ reshapeBacking       → reshapeBackingInPlace
                              └─ rebuildBacking(db, live)  // RESHAPE arm, between pre/post structural ops
```

`rebuildBacking` is the single choke point and is used by **nothing else** —
create/import (`materializeView`) calls `replaceContents` directly, and the
incremental manager's full-rebuild arm (`applyFullRebuild` in
`database-materialized-views.ts`) already validates via `validateDerivedChanges`.
So adding validation inside `rebuildBacking` covers exactly the two refresh arms
and no hot maintenance path. (Note: `rebuildBacking`'s docstring claims it is
"shared by … the incremental manager's global / cost-fallback branch
(globalRelations)" — that is stale; `applyFullRebuild` does its own
`applyMaintenance`. Fix the docstring while here.)

## Chosen design — pending-layer `replace-all` + bulk scan, gated on declared constraints, commit-first parity

When the maintained table declares ≥1 applicable CHECK or ≥1 FK, `rebuildBacking`
mirrors the **attach core** (`attachMaintainedDerivation`) instead of calling
`replaceContents`:

```
// hasApplicableConstraints(mv): same predicate validateDeclaredConstraintsOverContents uses —
//   mv.checkConstraints.some(c => c.operations & (INSERT|UPDATE)) || (mv.foreignKeys?.length ?? 0) > 0
if (!hasApplicableConstraints) {
    await host.replaceContents(rows, () => materializedViewNotASetError(...));  // UNCHANGED fast path
    return;
}
// constraint-bearing branch:
assertRefreshRowsAreSet(rows, shapePk, mv.schemaName, mv.name);   // replace-all LWW-merges dups; preserve the reject
const conn = await resolveAttachConnection(db, host, `${mv.schemaName}.${mv.name}`);
await host.applyMaintenance(conn, [{ kind: 'replace-all', rows }]);  // pending layer
await validateDeclaredConstraintsOverContents(db, mv);              // eager bulk anti-join scan; throws on violation
await conn.commit();                                                // commit-first parity (see below)
```

`shapePk` is the shape-derived physical key, exactly as the attach core computes
it: `computeBackingPrimaryKey(<shape derived from the body>)` mapped to
`{index, collation}` — OR, simpler and sufficient here since `rebuildBacking`
re-derives the body and the backing already matches that shape on the fast path,
the live backing's `primaryKeyDefinition` mapped to `{index, collation}`. (On the
reshape arm `rebuildBacking` runs after the catalog was re-registered with the
reshaped PK, so the live `primaryKeyDefinition` is already the post-reshape key —
use it.)

### Why this design (resolved, not deferred)

- **Validate BEFORE the swap, no committed violators.** `validateDeclaredConstraintsOverContents`
  runs against the connection's **pending** (reads-own-writes) contents and throws
  on the first violator *before* `conn.commit()`. The failing statement unwinds and
  the pending `replace-all` is discarded by statement-level rollback (exactly how
  the attach core's pre-commit reconcile failures unwind — it does not explicitly
  roll back the connection either). Pre-refresh **committed** contents stay intact.
- **Efficient bulk validation.** A full refresh recomputes the *whole* set, so the
  attach-style single anti-join / `not (<check>)` scan per constraint is the right
  tool — not O(rows) per-row FK EXISTS queries. The attach core already chose the
  bulk scan for the analogous create-fill/reconcile full-set validation; reuse it
  verbatim (it already does the constraint-stripped live-record swap to dodge
  `ruleFilterContradiction` / `ruleAntiJoinFkEmpty` folding, and gates FK scans on
  `pragma foreign_keys`).
- **Commit-first parity keeps the reshape arm correct AND matches today's
  semantics.** `replaceContents` is already commit-first (it swaps committed state,
  bypassing the transaction — `begin; refresh; rollback` does NOT undo a refresh
  today). Calling `conn.commit()` in the constraint-bearing branch preserves that
  exact observable behavior. It is also **load-bearing for the reshape arm**:
  `reshapeBackingInPlace` runs post-reconcile data-validating ops
  (retype/recollate/tighten-NOT-NULL) that scan **committed** contents after
  `rebuildBacking` returns — they must see the rebuilt rows. `replaceContents`
  gives that implicitly today; the pending-layer branch must `conn.commit()` to
  match (the attach reshape path does the same explicit `conn.commit()` before its
  post-reconcile ops). The later statement-level coordinated commit no-ops, as in
  attach.
- **Zero overhead preserved.** Constraint-less maintained tables and every MV-sugar
  backing take the untouched `replaceContents` fast path — no connection, no scan.
  Requirement 5 (constraint-clean refresh unchanged, including `backingShapeMatches`
  data-only fast path) holds by construction.

### Rejected alternative — per-row validator over the in-memory `rows` array

`core/derived-row-validator.ts` (`validateDerivedRowImage`) validates one row
image in isolation. Rejected for the refresh path because: (a) it routes FK-child
and subquery-CHECK to the **deferred** queue, which validates at commit — but
`replaceContents`/commit-first means the rows would already be committed by then
(committed violators); forcing eager evaluation would need a new validator entry
point; and (b) it is O(rows) external-table EXISTS queries, where a full refresh
wants the bulk anti-join. The bulk scan also cannot read an in-memory array — the
rows must be in a queryable (pending) layer regardless, which is exactly the
chosen design.

## Edge cases & interactions

- **Stale fast-path refresh (the headline case).** Source ALTER marks `mt` stale +
  releases its plan → source write drifts a row into CHECK/FK violation (not
  maintained) → `refresh` recomputes the violator into the set → must throw the
  `maintained-table`-attributed CONSTRAINT diagnostic
  (`row derived into maintained table '…' violates its declared constraint` /
  `… references a missing '…'`), and `mt`'s committed rows stay exactly as before
  the refresh. The MV stays stale (the emitter clears `stale` only after a
  successful `rebuildBacking` + `registerMaterializedView`), so the next read
  re-validates/errors rather than serving the rejected set.
- **Stale RESHAPE refresh.** Same drift but the source change also shifted the
  body's output shape, so refresh takes `reshapeBacking` → `reshapeBackingInPlace`
  → `rebuildBacking(live)`. The constraint validation fires inside `rebuildBacking`
  (after pre-reconcile structural ops, before post-reconcile attribute ops). On
  violation, `rebuildBacking` throws after the pre-reconcile structural ops already
  ran (non-transactional) — i.e. the table is left in the reshaped-but-stale state
  the reshape-failure contract already produces for a body the new shape can't
  satisfy. Assert: refresh errors with the attribution; a subsequent read still
  reflects pre-refresh rows or the stale-diagnostic, never the violating set.
  Document that the declared CHECK/FK is validated against the rows in their
  pre-post-reconcile (not-yet-retyped/recollated) physical form — fine for value-
  domain CHECK/FK; a recollate that changes a collation-sensitive CHECK's outcome
  is a documented corner not covered here.
- **Constraint-clean refresh (fast path) unchanged.** A conforming refresh of a
  constraint-bearing table commits the new set and clears `stale`; a
  constraint-LESS / MV-sugar refresh is byte-for-byte the old `replaceContents`
  path (assert no extra connection/scan via the prepare/queue spies used in
  `maintained-table-declared-constraints.spec.ts`'s zero-overhead tests).
- **Duplicate derived keys.** `replace-all` silently LWW-merges duplicate PKs,
  but the `replaceContents` fast path rejects them via `materializedViewNotASetError`.
  Preserve the reject on the constraint-bearing branch: run a dup check (collation-
  aware, like `assertDerivedRowsAreSet`) BEFORE `applyMaintenance` and throw
  `materializedViewNotASetError(mv.schemaName, mv.name)` so the diagnostic is
  identical regardless of whether the table declares constraints. Add a thin
  `assertRefreshRowsAreSet` (or parameterize `assertDerivedRowsAreSet`'s error
  factory) — do not let the two branches diverge on duplicate handling.
- **`pragma foreign_keys = off`, FK-only table.** `validateDeclaredConstraintsOverContents`'s
  FK scan already no-ops when the pragma is off, so it's correct but takes the
  slower pending-layer branch for nothing. Optional micro-opt: gate the FK term of
  `hasApplicableConstraints` on `db.options.getBooleanOption('foreign_keys')` so an
  FK-only table with enforcement off keeps the `replaceContents` fast path. A table
  that also declares a CHECK always takes the validating branch regardless.
- **FK pragma on but parent satisfied / NULL refs.** MATCH SIMPLE: a row with any
  NULL FK column passes; a fully-non-NULL row needs a parent. Covered by the bulk
  FK scan unchanged — add a passing-refresh case and a NULL-ref-passes case.
- **Refresh inside an explicit transaction.** `conn.commit()` mid-statement matches
  `replaceContents`'s existing commit-first behavior; `begin; refresh; rollback`
  does not undo the refresh today and must not change. If `resolveAttachConnection`
  returns a pre-existing registered backing connection carrying unrelated pending
  writes (a same-txn source write that maintained this backing earlier), committing
  it flushes those too — this is the same property `replaceContents` already has
  (it ignores all pending state); note it, don't expand scope to fix it.
- **Live-record identity for the stripped-schema swap.** `validateDeclaredConstraintsOverContents`
  does `schema.addTable(stripped)` then `schema.addTable(mt)` to restore — pass the
  live catalog record (`mv`/`live` as the caller handed it; it is the registered
  object on both arms). Confirm the restore leaves the catalog entry equal to the
  pre-validation record.
- **Empty recomputed set.** `replace-all []` empties the backing; the bulk scan over
  empty contents trivially passes. A refresh that empties a constraint-bearing table
  must succeed.

## Key tests & expected outputs

Add a focused spec (`test/maintained-table-refresh-revalidation.spec.ts`) modeled
on `maintained-table-declared-constraints.spec.ts` (`db.exec` + an `expectError`
helper keyed on the attribution substring). SQL-expressible flows can also go in a
new `test/logic/5x-...sqllogic`, but the stale-then-drift orchestration is clearest
in the .spec.

- **Stale fast-path CHECK violation:** create `src` + `mt (… check (v <> 'poison'))
  maintained as select … from src`; insert a clean row; `alter table src add column
  pad integer` (body-relevant → stale, plan released); `insert into src` a row whose
  derived `v = 'poison'`; `refresh materialized view mt` ⇒ throws
  `row derived into maintained table 'main.mt'`; `select * from mt` still shows only
  the pre-refresh clean row.
- **Stale fast-path FK orphan:** `mt (… ref … references parent(pid)) maintained as
  …`; go stale; drift an orphan into `src`; `refresh` ⇒ throws
  `… references a missing 'main.parent'`; pre-refresh rows intact. Plus a passing
  variant where the parent row exists (refresh succeeds, `stale` cleared).
- **Constraint-clean fast path is untouched:** spy on `db.prepare` / connection
  creation (or the `_queueDeferredConstraintRow` pattern) and assert a
  constraint-less maintained-table refresh and an MV-sugar refresh do NO validation
  prepare/scan — the `replaceContents` path is byte-identical.
- **Reshape arm + violation:** stale via a shape-shifting source ALTER on a
  constraint-bearing `mt`, drift a violator, `refresh` ⇒ throws the attribution;
  assert the table is not left holding the violating set (reads reflect pre-refresh
  or stale-diagnostic).
- **Duplicate-key reject parity:** a body that produces duplicate backing keys on a
  constraint-bearing table refresh ⇒ `materializedViewNotASetError` (same message as
  the constraint-less fast path).
- **`pragma foreign_keys = off`:** an orphan-drifted FK-only `mt` refresh succeeds
  (no retro-validation), matching the ticket's explicit out-of-scope note.

## TODO

- Add `hasApplicableConstraints(mv)` (reuse the exact predicate from
  `validateDeclaredConstraintsOverContents`'s early-return) and branch
  `rebuildBacking`: constraint-less → existing `replaceContents`; constraint-bearing
  → `resolveAttachConnection` + `applyMaintenance('replace-all')` +
  `validateDeclaredConstraintsOverContents(db, mv)` + `conn.commit()`.
- Add `assertRefreshRowsAreSet` (or parameterize `assertDerivedRowsAreSet`) so the
  constraint-bearing branch rejects duplicate derived keys with
  `materializedViewNotASetError`, identical to the `replaceContents` path.
- Optionally gate the FK term of `hasApplicableConstraints` on `pragma foreign_keys`
  to keep the fast path for FK-only tables with enforcement off.
- Update the `rebuildBacking` docstring + the deferral comment (currently citing
  this ticket as a backlog gap) to describe the implemented behavior; fix the stale
  "shared with globalRelations" claim. Update `docs/materialized-views.md` if it
  enumerates the validated derivation write paths (add the refresh path).
- Update `vtab/backing-host.ts` `replaceContents` doc note if it states the
  refresh/create caller validates nothing — refresh now validates for
  constraint-bearing tables (create/MV-sugar still declares nothing).
- Tests: new `test/maintained-table-refresh-revalidation.spec.ts` covering the cases
  above. Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60
  /tmp/t.log` and `yarn workspace @quereus/quereus lint`.
