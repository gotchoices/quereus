description: Suppress value-identical materialized-view maintenance writes in the bounded-delta arms — no backing op, no effective BackingRowChange, no cascade — both as a universal efficiency win and as the echo-prevention prerequisite for change-logged (synced) backings.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # arm kernels (inverse-projection delete+upsert; forward/reverse residual)
  - packages/quereus/src/vtab/memory/layer/manager.ts          # applyMaintenanceToLayer skip-identical backstop
  - packages/quereus/src/vtab/backing-host.ts                  # contract comment: a value-identical upsert reports nothing
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts  # harness still green
  - docs/materialized-views.md                                 # move the limitation bullet into § Maintenance
----

# No-op maintenance write suppression

Design context: `docs/materialized-views.md` § Current limitations
("Value-identical upsert suppression in the bounded-delta arms") and
`docs/migration.md` § Synced vs. local derived tables. The full-rebuild
floor's keyed diff already skips byte-identical rows; this ticket brings the
incremental arms to parity.

Why it is sound: an upsert whose effective existing row is value-identical
changes nothing, so reporting no `BackingRowChange` for it is *accurate* —
the effective-change contract demands fidelity to what actually changed, and
nothing did. Consumers (the MV-over-MV cascade) would have recomputed
byte-identical rows from it anyway. The covering-UNIQUE enforcement scan reads
backing *state*, which a suppressed no-op leaves identical, so the
enforcement-visibility invariant is untouched.

## Where to suppress

Two layers, both needed:

1. **Arm-level (cheap, catches the common echo):** the `'inverse-projection'`
   update arm currently does delete-old-image + upsert-new-image
   unconditionally. When the old and new backing **keys are equal** and the
   projected **values are identical** (collation-aware comparison, the same
   discipline `replace-all`'s keyed diff uses), emit **no ops at all**. This
   is the dominant case — a source UPDATE touching only unprojected columns,
   or rewriting a projected column to its existing value.
2. **Host-level backstop (catches the residual arms):** in
   `applyMaintenanceToLayer`, an `upsert` whose effective existing row (pending
   over committed) is value-identical is skipped and reports nothing. This
   covers the residual arms' recompute-and-upsert without restructuring their
   delete-then-rerun discipline — but note the residual arms **delete first**,
   so the backstop alone doesn't help them; see the next point.
3. **Residual arms (forward residual / join-residual / prefix-delete):** the
   delete-before-rerun discipline means a recomputed-identical row currently
   reports delete+insert churn. Convert the kernel's apply step to a **keyed
   diff against the existing effective slice** (the affected key's current
   backing row(s), readable via the host's `scanEffective` with the key as
   `equalityPrefix`): delete only keys the recompute no longer produces,
   upsert only changed/new rows, skip identical. Emptied-group correctness
   (delete-without-upsert) must be preserved exactly.

## Edge cases & interactions

- **Key-changing update is NOT a no-op** — old key delete + new key insert
  both still fire and report.
- **Emptied group / out-of-scope transition** — residual returns zero rows ⇒
  the existing row is deleted and reported (the diff must not "skip" a
  disappearance).
- **MV-over-MV cascade** — a suppressed producer write must fire no consumer
  maintenance at all (test: write source with unprojected-column change; pin
  zero consumer backing ops via the effective-change return).
- **Reads-own-writes / pending-layer compare** — the identical-compare must
  read the *effective* row (pending over committed), not committed only; a
  same-transaction prior write that changed the row means the second write to
  the same value as committed is NOT a no-op relative to pending.
- **Collation-aware compare** — values equal under the column's collation but
  byte-different: follow `replace-all`'s existing skip-identical semantics
  exactly (one discipline, not two).
- **Rollback** — suppression must not change rollback observability
  (maintenance-equivalence harness covers it; run it).
- **Store host parity** — `StoreBackingHost` (in flight under
  `store-backing-host`) must implement the same skip-and-report-nothing
  upsert; that ticket's text has been aligned. The contract comment in
  `vtab/backing-host.ts` is the single normative statement.
- **`OR FAIL` deferred-flush path** — full-rebuild flush on the FAIL throw
  path already diffs; confirm no interaction.

## Tests

Extend the maintenance-equivalence harness with a no-op-write probe per arm:
(a) source update to an unprojected column, (b) source update rewriting a
projected column to its current value, (c) the same through one
MV-over-MV level — each asserting **zero effective backing changes**
(instrument via the returned `BackingRowChange[]` or a counting wrapper), and
(d) regression: real changes, key-changing updates, emptied groups, and
predicate-scope transitions still report exactly as today. Full
`maintenance-equivalence.spec.ts` must stay green (it is the oracle that
suppression never skipped a real change).

## TODO

- Inverse-projection arm equal-image short-circuit
- Host-level skip-identical upsert (memory) + backing-host contract comment
- Residual-arm keyed-diff apply (forward, join-residual both directions, prefix-delete slice)
- No-op probes + regression tests; run maintenance-equivalence harness
- docs/materialized-views.md: move the limitation bullet into § Maintenance as realized behavior
- `yarn build`, `yarn lint`, `yarn test`
