description: When attaching a maintained view fails, the engine has a hook to clean up a freshly-created storage backing — but nothing in this repo uses or tests it, so add a test that proves the cleanup fires only in the right cases.
files:
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/test/materialized-view-discard-backing.spec.ts
difficulty: medium
----

# Independent review + coverage for the `discardBackingForAttach` cleanup seam

## Background

This is item 2 of the follow-up review of the MV engine changes that landed under the
LevelDB ticket (commit `45619c26`). The change under review:

- `vtab/module.ts` adds optional `VirtualTableModule.discardBackingForAttach(db, schemaName,
  tableName)`.
- `materialized-view-helpers.ts`'s `attachMaintainedDerivation` gained a
  `discardBackingOnFailure` flag (default `false`). On a **failed fresh attach** it calls
  `module.discardBackingForAttach?.(...)` to drop a durable store that
  `ensureBackingForAttach` freshly created in this attach.
- `runSetMaintained` in `alter-table.ts` (the `alter table … set maintained as` verb)
  passes `discardBackingOnFailure = true`. `createMaintainedTable` (`create table …
  maintained`) deliberately does **not** — there the store was made by the prior
  `createTable(preferBacking)` and its own `dropTable` cleanup retires it; a discard there
  would double-drop and strand the catalog entry.

The precise firing condition (in the attach `catch`, ~line 1186):

```
if (discardBackingOnFailure && !reconcileCommitted && !priorMaintained) {
    await module.discardBackingForAttach?.(db, schemaName, name);
}
```

**No module in this repo implements `discardBackingForAttach`**, so the call is a no-op
everywhere here; the real implementor is downstream (lamina). The three companion seams
`ensureBackingForAttach` / `retireBackingForAttach` are likewise unimplemented in-repo.

## Decision: keep the seam, add coverage

Keep `discardBackingForAttach` in the engine now. Rationale:

- It completes the **attach-lifecycle triad** already present in `module.ts`:
  `ensureBackingForAttach` (create durable store on attach) →
  `retireBackingForAttach` (migrate rows back + drop store on detach) →
  `discardBackingForAttach` (drop the freshly-created store on a *failed* fresh attach).
  Removing only the failure-cleanup verb would leave the success and detach paths able to
  create/retire a store with no way to clean one up on attach failure — an incoherent,
  leaky surface. The condition guarding it (`!reconcileCommitted && !priorMaintained`) is
  subtle and worth pinning with tests rather than deleting and re-deriving later.
- It is optional (presence-is-capability), default-inert, and a pure no-op for every
  in-repo module — zero behavior change for memory/store.
- AGENTS.md: backwards-compat is not a concern, so "keep forward infra + cover it" beats
  "remove and re-add under the downstream ticket."

The gap is that the careful firing condition is **dead in-repo**, hence untested. Close it
with an in-repo spy module and a focused spec that drives each branch of the condition.

## Implementation

### Test module (spy)

In the new spec, define a `MemoryTableModule` subclass that records calls to the three
seams without changing hosting behavior (memory hosts the live table directly, so the
inner host resolution and reconcile work unchanged):

- `ensureBackingForAttach(db, schema, name, backingSchema)` → push `'ensure'`; `await`
  nothing (no separate store needed for the test — the assertion is about *which engine
  branch calls which seam*, not real durable storage).
- `discardBackingForAttach(db, schema, name)` → push `'discard'`.
- (Optionally `retireBackingForAttach` → push `'retire'`, for symmetry / a detach assertion.)

Register it as e.g. `using spy`.

### Triggering a failed fresh attach

A fresh attach fails **after** `ensureBackingForAttach` (so the discard branch is reached)
by way of a declared CHECK the derived rows violate — `validateDeclaredConstraintsOver
contents` throws at ~line 1140, inside the try, `reconcileCommitted` false,
`priorMaintained` undefined:

```sql
create table src (id integer primary key, v integer);
insert into src values (1, -5);
create table mt (id integer primary key, v integer check (v > 0)) using spy;
-- derived row (1, -5) violates check (v > 0) ⇒ attach fails AFTER ensureBackingForAttach
alter table mt set maintained as select id, v from src;
```

### Tests (`materialized-view-discard-backing.spec.ts`)

- **Fresh-attach failure invokes `discardBackingForAttach`.** Run the failing
  `alter … set maintained` above; expect the statement to throw (the CHECK violation),
  the spy log to contain `'ensure'` **then** `'discard'`, and `mt` to remain a plain
  (non-maintained) table afterwards (`getMaintainedTable` undefined; a plain
  `select`/`insert` still works).

- **Re-attach failure does NOT invoke discard (`priorMaintained` branch).** First attach a
  body that succeeds, then re-attach a body that fails the CHECK:
  ```sql
  create table mt2 (id integer primary key, v integer check (v > 0)) using spy;
  alter table mt2 set maintained as select id, v from src_ok;   -- succeeds (v > 0)
  -- now re-attach a violating body:
  alter table mt2 set maintained as select id, v from src_bad;  -- fails CHECK
  ```
  Clear the spy log after the first attach; expect the second to throw but the log to
  contain **no** `'discard'` (the re-attach reused the existing store, kept by
  `restorePrior`). Confirm `mt2` reverts to its prior maintained derivation (still
  maintained, prior body intact / re-registered).

- **Create-`maintained` failure does NOT invoke discard (`discardBackingOnFailure` false).**
  A `create table mt3 (… check (v > 0)) maintained as select … (violating)` using `spy`
  must throw and clean up via the create path's own `dropTable`, with **no** `'discard'`
  in the log (createMaintainedTable passes `discardBackingOnFailure = false`). Confirms the
  flag gating, not just the condition.

- **Successful attach invokes neither discard.** A clean `alter … set maintained` with a
  satisfying body logs `'ensure'` and no `'discard'`, leaving `mt` maintained.

- **Reconcile-committed branch (documented as not directly covered).** The
  `!reconcileCommitted` term only excludes a failure on the *post-reconcile reshape* ops
  (which commit the reconcile first, then run data-validating column ops). Reproducing that
  in-repo requires a reshape-on-attach whose `postReconcileOps` throw after the eager
  commit — substantially more setup than the other branches and of marginal value for an
  in-repo spy. **Do not** build it here; instead add an inline comment in the spec naming
  this as the one uncovered branch and why (the committed store is intentionally kept
  stale, never discarded), so the omission is explicit rather than silent.

## Edge cases & interactions

- **Ordering: `ensure` before `discard`.** The discard must only ever be observed after an
  `ensure` in the same attach (the discard exists to undo that ensure). Assert the ordering,
  not just membership.
- **Optional-call safety.** `discardBackingForAttach?.` is an optional call; a module that
  omits it (memory/store) must be unaffected — include a control with a plain
  `MemoryTableModule` whose fresh-attach failure simply rolls back catalog-only with no
  crash.
- **Idempotence / double-drop avoidance.** The decision rationale rests on create-MV NOT
  discarding (its `dropTable` already retires the store). The create-path test pins that no
  double-cleanup signal is emitted.
- **Interaction with the item-1 defensive guard.** If implemented alongside
  `mv-replicable-gate-late-host-coverage`, the new INTERNAL guard throws inside the same
  `try` as the reconcile, so on a fresh attach it too routes through the
  `discardBackingForAttach` cleanup. The spy's `discardBackingForAttach` must tolerate being
  called after such a throw (a no-op spy already does). These tickets are independent (no
  `prereq`); if both land, neither test should assume the other's module exists.
- **Statement atomicity.** The failing attach must leave the catalog and any pending
  reconcile rolled back (the table is plain/prior, the source rows untouched) — assert the
  post-failure readability of `mt` and that `src` is unchanged.

## TODO

- Add `packages/quereus/test/materialized-view-discard-backing.spec.ts` with the spy module
  and the four covered branches (fresh-attach failure → discard; re-attach failure → no
  discard; create-maintained failure → no discard; success → no discard) plus the
  optional-omit control.
- Add the inline comment documenting the reconcile-committed branch as the single
  intentionally-uncovered path.
- Optionally tighten `discardBackingForAttach`'s doc-comment in `module.ts` to cross-link
  the firing condition and the create-path exclusion (the rationale already lives in
  `attachMaintainedDerivation`'s flag doc — keep it DRY, just cross-reference).
- Run `yarn workspace @quereus/quereus test` (or the new spec) and `yarn lint`
  (single-quote globs on Windows); stream output with `tee`.
