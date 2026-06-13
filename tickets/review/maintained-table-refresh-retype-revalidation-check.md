description: Review the characterization of the `retype`-flips-CHECK corner on the `refresh materialized view` reshape arm — the type-affinity-sensitive sibling of the recollate known-limitation. Implement added a sibling characterization-test trio (core / control / next-maintenance) mirroring the recollate block, a sibling docs note, and extended the two code-comment cross-refs to name the `retype` analog. This is a characterization/documentation task — the tests PIN current (limitation) behavior, NOT a fix.
prereq:
files:
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts     # new describe('reshape arm: type-sensitive CHECK (documented limitation)') after the collation block
  - docs/materialized-views.md                                              # new "Known limitation — type-sensitive CHECK on the reshape arm" note after the collation note
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # rebuildBacking + reshapeBackingInPlace cross-ref comments extended to name retype
difficulty: medium
----

# Reshape arm: type-sensitive CHECK known-limitation (review handoff)

## What was implemented

A sibling to the existing collation-sensitive-CHECK characterization. The corner: on the
refresh **reshape arm**, `reshapeBackingInPlace` sequences (3) `rebuildBacking` →
`validateDeclaredConstraintsOverContents` (validates + **commits**) then (4) the
`retype` op from `postReconcileOps` (same batch as `recollate`). CHECK comparisons
resolve **affinity** from the column's *declared* logical type; the step-3 scan runs while
the catalog column still carries the OLD type, so a CHECK whose truth flips under the
retype passes, commits, and is then retyped into a violating state. This engine's
`set data type` is **metadata-only** (validates convertibility, does NOT rewrite the
stored value), which is exactly what makes the flip affinity-driven, not value-driven.

Three deliverables, all mirroring the recollate sibling:

1. **Test trio** in `maintained-table-refresh-revalidation.spec.ts` — new
   `describe('reshape arm: type-sensitive CHECK (documented limitation)')` immediately
   after the collation block, with a leading explanatory comment and a `vType(name)`
   helper (parallels `vCollation`) that reads `col.logicalType.name`.
2. **Docs note** in `docs/materialized-views.md` — "Known limitation — type-sensitive
   CHECK on the reshape arm." immediately after the collation note (line 219).
3. **Code-comment cross-refs** — extended the recollate cross-ref comments in
   `rebuildBacking`'s constraint-bearing branch and `reshapeBackingInPlace`'s
   post-reconcile loop to also name the `retype` analog (both share `postReconcileOps`).

## The witness (the core test pins this ACTUAL behavior — it is NOT desired)

```sql
create table src (id integer primary key, v text);
create table mt (id integer primary key, v text, check (v < '9')) maintained as select * from src;
insert into src values (1, '10');                       -- clean under TEXT: lexicographic '10' < '9' is true ('1' < '9')
alter table src alter column v set data type integer;   -- body-relevant ⇒ mt stale, plan detached; refresh takes reshape arm w/ retype op on v
refresh materialized view mt;                            -- step-3 scan validates v < '9' under TEXT (passes, COMMITS); step-4 retype flips v to INTEGER
-- mt holds v='10' (typeof still 'text'); under FINAL INTEGER affinity v<'9' is numeric 10<9 = FALSE.
-- refresh SUCCEEDED, stale cleared, committed row violates its own CHECK.
```

## Use cases the tests cover (validation floor — treat as a floor, not a ceiling)

- **Core corner** — `vType` flips `TEXT → INTEGER` (proof the reshape+retype arm ran);
  refresh succeeds; `select v, typeof(v) from mt` → `'10'`, `'text'` (metadata-only retype
  invariant pinned); `select (v < '9') from mt` → `false` (boolean) under the final
  INTEGER column; row is `{ id: 1, v: '10' }`; `stale` cleared.
- **Control** — a type-INSENSITIVE `check (id > 0)` over the same retype reshape still
  rejects a genuine `-1` drift (`row derived into maintained table 'main.mt'`); pre-refresh
  contents survive; `stale` stays true. Scopes the limitation to affinity-sensitive
  comparisons — the validation path itself is sound.
- **Next maintenance** — after reaching the limitation state: a no-delta touch
  (`update src set v = v`) leaves the frozen row as-is; a genuine re-derivation
  (`update src set v = 11`, distinct so a real delta is produced) is rejected + rolled
  back under the NEW type; a fresh `insert … values (2, 20)` is rejected; the original
  frozen row survives every case. The violation does NOT propagate via ordinary writes.

## Validation run (all green)

- `node packages/quereus/test-runner.mjs --grep "type-sensitive CHECK"` → 3 passing.
- `node packages/quereus/test-runner.mjs --grep "Maintained-table refresh re-validation"`
  → 23 passing (20 prior + 3 new).
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) → exit 0, no signature drift.

Did **not** run the full `yarn test` suite or `yarn test:store` — see gaps below.

## Known gaps / things for the reviewer to probe

- **Characterization only.** The tests pin a *documented limitation*, not a fix. If the
  reviewer thinks the corner should be **closed** rather than characterized, that is a new
  fix/plan ticket — the implement ticket explicitly scoped this as docs+pins (commit-first
  ordering + attach-path parity block a clean fix; same rationale as the recollate sibling).
- **Reachability hinges on the reshape arm.** The core corner only exists if `set data type`
  routes through the reshape arm with a `retype` `postReconcileOps` op. The `vType` flip
  assertion is the guard: if a future optimizer change made the type change
  recompilable-in-place (fast path, no reshape), the scenario would no longer be reachable
  and the assertion would catch it. Worth a reviewer sanity-check that this guard is doing
  its job.
- **Metadata-only retype invariant.** The `typeof(v) === 'text'` assertion pins that
  `set data type` does not rewrite the stored value. If `set data type` ever becomes a
  physical convert, the body-produced value would already be converted at scan time and the
  scan would catch the violation (the corner closes itself) — that regression would surface
  as a failure here. Confirm the reviewer agrees this is the right place to pin it.
- **Equality/`typeof` shapes intentionally NOT tested.** Only the ordering comparison `<`
  flips under the affinity change (probe-confirmed `<>`/`=`/`typeof` stay clean). No
  negative assertions were added for those — the reviewer may want one if they value
  pinning the non-flip explicitly, but the implement ticket did not call for it.
- **Memory backing only.** No store-path coverage here — `yarn test:store` was not run.
  Store parity for this engine-level corner is tracked separately by
  `maintained-table-refresh-revalidation-store-parity` (the recollate sibling made the
  same call). If the reviewer wants store coverage folded in, that is the other ticket.
- **Boolean representation.** `select (v < '9')` returns a JS `false` (comparisons emit JS
  booleans via `buildCmpToResult`), asserted as `{ lt: false }`. Verified against the
  runtime, but a reviewer relying on `0`/`1` SQLite-style truthiness should note this
  engine uses native booleans.

## Review checklist

- [ ] Confirm the new describe block reads as a faithful sibling of the collation block
      (leading comment points at `retype`/`postReconcileOps` + the two-phase ordering).
- [ ] Confirm the docs note is structurally parallel to the collation note and the
      metadata-only `set data type` caveat is stated (a reader might expect a physical
      convert to scrub the value).
- [ ] Confirm the two code comments name the `retype` analog tersely and point at the same
      docs section.
- [ ] Decide: characterize (current) vs. close (new ticket). If close, spawn fix/plan.
