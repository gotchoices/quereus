description: Characterize + document the `retype`-flips-CHECK corner on the `refresh materialized view` reshape arm — the type-affinity-sensitive sibling of the recollate known-limitation. A plan-stage probe CONFIRMED the corner is reachable: a metadata-only `set data type` retype is a POST-reconcile op, so the constraint-bearing `rebuildBacking` bulk scan validates + commits the reconciled rows while the catalog column still carries the OLD logical type, then the retype flips the column's affinity and a declared CHECK whose comparison depends on that affinity is left violated on a committed row. Add a sibling characterization-test trio (core / control / next-maintenance) mirroring the recollate block, plus a sibling docs note cross-referenced from the same code comments.
prereq:
files:
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts     # add a sibling `describe('reshape arm: type-sensitive CHECK (documented limitation)')` next to the collation block (~line 261-375)
  - docs/materialized-views.md                                              # add a "Known limitation — type-sensitive CHECK on the reshape arm" note next to the collation note (line 219)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # rebuildBacking constraint-bearing comment (~line 1371-1382) and reshapeBackingInPlace post-reconcile comment (~line 2047-2051) — extend the recollate cross-refs to also name the retype analog
difficulty: medium
----

# Reshape arm: type-sensitive CHECK known-limitation (sibling of the recollate corner)

## Determination (resolved at plan stage — the corner IS reachable)

A plan-stage throwaway probe established the corner empirically. It is a genuine
sibling of the collation limitation, reachable as black-box SQL, with the **identical
structural cause** and the **same bounded, non-propagating blast radius**.

**Root cause.** In this engine `alter column … set data type <T>` is a **metadata-only**
logical-type change — it validates convertibility but does **not** rewrite the stored
representation (confirmed by the probe and by the existing note in
`materialized-view-refresh-reshape.spec.ts` ~line 208-213; the value rides as the body
produced it). CHECK comparisons, however, resolve type **affinity** from the column's
**declared logical type**, not from the value's runtime JS type. So a byte-identical
stored value can satisfy a CHECK under one declared type and violate it under another.

The reshape arm sequences (`reshapeBackingInPlace`):
  3. `rebuildBacking` → `validateDeclaredConstraintsOverContents` (validates **and
     commits** the reconciled rows) — runs while the catalog column still carries the
     **OLD** logical type, because
  4. the `retype` op is in `postReconcileOps` and applies **after** that commit.

So a declared CHECK whose truth flips under the affinity change passes the step-3 scan
(resolved under the OLD type), commits, and is then retyped into a violating state. The
post-retype step runs no CHECK re-scan, so the violating row survives committed. This
is exactly the recollate window — `retype` and `recollate` sit in the same
`postReconcileOps` batch.

**Witness repro (the core corner — pin this ACTUAL behavior, it is NOT desired):**

```sql
create table src (id integer primary key, v text);
create table mt (id integer primary key, v text, check (v < '9'))
    maintained as select * from src;
insert into src values (1, '10');          -- clean: under TEXT, '10' < '9' is TRUE (lexicographic, '1' < '9')
alter table src alter column v set data type integer;  -- body-relevant ⇒ mt stale, plan detached; refresh takes the reshape arm with a `retype` op on v
refresh materialized view mt;              -- step-3 scan validates v < '9' under TEXT (passes, COMMITS); step-4 retype flips v to INTEGER
-- mt now holds v = '10' (value byte-unchanged, typeof still 'text'); under the FINAL INTEGER affinity, v < '9' is numeric 10 < 9 = FALSE
-- ⇒ the committed row violates its own CHECK under the column's final type. refresh SUCCEEDED. stale cleared.
```

Probe-confirmed facts to assert:
- After the refresh, `select v, typeof(v) from mt` → `'10'`, `'text'` (metadata-only retype; value not rewritten); catalog `v` logical type is `INTEGER`.
- `select (v < '9') from mt` (re-evaluated under the final INTEGER column) → **false** — the committed row violates the CHECK.
- The refresh **succeeds** and clears `stale` (this is the limitation; not the behavior we'd want if it were closed).

## Why the value flips on `<` but the probe found `<>` and `=` do NOT

The probe also tried `check (v <> '1')` over `'01'` and a `typeof(v) <> 'integer'` CHECK
— neither flipped (equality/`typeof` did not change truth under the retype; only the
ordering comparison `<` did, because numeric vs lexicographic ordering of `'10'` vs
`'9'` diverges). Use the **ordering** witness (`v < '9'` over `'10'`) as the core test;
it is the cleanest reachable flip. (`v <> 1` / `v < 9` are rejected at INSERT time
because numeric coercion already makes them violate over text — not viable as
"clean-then-flips" seeds; do not use them.)

## Blast radius (probe-confirmed — mirror the recollate trio's third test)

Once the row-time plan re-binds, the violation does **not** spread via ordinary writes —
identical to the recollate case:
- A **no-delta touch** (`update src set v = v where id = 1`) produces no derived-row
  delta ⇒ no row-time validation ⇒ the frozen `'10'` row is left exactly as-is, no error.
- A **genuine re-derivation** of an offending value (`update src set v = 11 where id = 1`
  — distinct from 10 so a real delta is produced, but `11 < '9'` is still false under
  INTEGER) runs `buildDerivedRowValidator` under the **NEW** type ⇒ **rejected** with
  `row derived into maintained table 'main.mt'`; the rejected write rolls back, leaving
  the already-committed row unchanged.
- A **brand-new offending source row** (`insert into src values (2, 20)`) is likewise
  **rejected** under the new type; the original frozen row is untouched.

## Control (probe-confirmed — the validation path itself is sound)

A type-**insensitive** CHECK (`check (id > 0)`) over the **same** retype reshape still
rejects a genuine violator: drift `insert into src values (-1, '5')`, retype `v` to
integer, `refresh` → **rejected** (`id > 0` over `-1`), pre-refresh contents survive,
`stale` stays true. This scopes the limitation strictly to comparisons whose result
depends on the retyped column's affinity — exactly parallel to the collation-insensitive
control.

## Not closed (same rationale as recollate)

The bulk scan is **commit-first** (the reshape's own post-reconcile ops scan committed
contents, so re-validating *after* the retype would throw with rows already committed
and the schema mutated — a strictly worse state, with no path back to the pre-refresh
contents the pre-commit scan preserves), and the **attach reshape** path uses the
identical pre-retype ordering — closing only the refresh arm would diverge the two.
This is a **characterization/documentation** task, not a behavior fix; do not attempt
to close the gap. (Memory backing is sufficient for this engine-level corner — the
recollate sibling made the same call; store parity is tracked separately by
`maintained-table-refresh-revalidation-store-parity`.)

## Edge cases & interactions

- **Reshape-arm proof.** The catalog `v` logical type must read `TEXT` pre-refresh and
  `INTEGER` after — that flip is the observable proof the refresh took the **reshape**
  arm with a `retype` op (the fast path would leave the type untouched). Assert it,
  mirroring the recollate test's `vCollation` helper with a `vType` helper. If a future
  optimizer change made the type change recompilable-in-place (fast path, no reshape),
  the scenario would no longer be reachable — the assertion catches that.
- **Stale + plan-detach trigger.** `alter column … set data type` must reliably mark
  `mt` stale and detach its row-time plan (probe-confirmed: `stale=true` after the
  source retype). The flip relies on the row NOT being re-validated until refresh.
- **Metadata-only retype invariant.** The test should assert `typeof(v)` stays `'text'`
  after the retype (the value is not rewritten) — this is the crux that makes the flip
  affinity-driven rather than value-driven. If `set data type` ever starts rewriting the
  stored representation (physical convert), re-derive: the body-produced value would
  then already be converted at scan time and the scan would catch it (the corner would
  close itself). Pin the metadata-only behavior so that regression is visible here.
- **Equality/`typeof` do NOT flip.** Only the ordering comparison flips; do not assert a
  flip for `<>`/`=`/`typeof` shapes (probe-confirmed they stay clean).
- **Genuine-delta requirement in the next-maintenance arm.** The re-derivation value
  must differ from the committed `'10'` (use `11`) so a real derived-row delta is
  produced and the validator actually runs; a value-identical touch is the no-delta case
  and validates nothing.
- **`db.close()` per case.** Mirror the recollate block's per-`it` fresh `Database` or
  the file-level `beforeEach`/`afterEach`; do not leak state across cases.

## Test expectations (sibling trio in `maintained-table-refresh-revalidation.spec.ts`)

Add `describe('reshape arm: type-sensitive CHECK (documented limitation)')` immediately
after the collation block, with a leading comment mirroring the collation block's
explanation (point at `retype`/`postReconcileOps` and the same two-phase ordering), and
a `vType(name)` helper paralleling `vCollation`:

- **`it('the core corner: a retype-during-reshape commits a row that violates its CHECK under the FINAL type')`** — the witness repro above; assert `vType` flips `TEXT → INTEGER`, the refresh succeeds, the committed row is `{ id: 1, v: '10' }`, `select (v < '9') from mt` is now `false`, and `stale` cleared.
- **`it('control: a type-INSENSITIVE CHECK over the same retype reshape still rejects a genuine violator')`** — the `check (id > 0)` control; assert the refresh is rejected with `row derived into maintained table 'main.mt'`, pre-refresh contents survive, `stale` stays true.
- **`it('next maintenance re-validates under the NEW type: a genuine re-derivation is rejected, but the already-committed row is frozen')`** — reach the limitation state, then assert: no-delta touch leaves it frozen; `update src set v = 11` rejected + rolled back (row frozen); fresh `insert into src values (2, 20)` rejected (original frozen).

## Docs note (sibling of line 219 in `docs/materialized-views.md`)

Add **"Known limitation — type-sensitive CHECK on the reshape arm."** immediately after
the collation note, same structure: state that `retype` is a post-reconcile op while the
constraint-bearing `rebuildBacking` scan validates+commits under the OLD logical type;
give the `check (v < '9')` / row `'10'` / `TEXT → INTEGER` concrete example; note it is
**not closed** (commit-first + attach-path parity); state the bounded, non-propagating
blast radius (genuine re-derivations rejected under the new type; frozen row stays until
corrected); scope it to affinity-sensitive comparisons (the `id > 0` control validates
correctly); and end with the spec cross-reference
(`maintained-table-refresh-revalidation.spec.ts` § *reshape arm: type-sensitive CHECK
(documented limitation)*). Note explicitly that this engine's `set data type` is
metadata-only — that is what makes the corner affinity-driven (mention it, since a reader
might expect a physical convert to scrub the value).

## Code-comment cross-refs

Extend the existing recollate cross-reference comments to also name the `retype` analog
(both ops share the `postReconcileOps` batch and the same window):
- `materialized-view-helpers.ts` `rebuildBacking` constraint-bearing branch (~line
  1371-1382) — the "Documented limitation (collation-sensitive CHECK …)" paragraph.
- `materialized-view-helpers.ts` `reshapeBackingInPlace` post-reconcile loop (~line
  2047-2051) — the `NOTE: a recollate here applies AFTER …` block.
Keep them terse: one clause noting a `retype`'s affinity flip is the same class of
post-reconcile limitation, pointing at the same docs section.

## TODO

- Add a `vType(name)` helper and the `describe('reshape arm: type-sensitive CHECK (documented limitation)')` block (the three `it`s above) to `maintained-table-refresh-revalidation.spec.ts`, with a leading explanatory comment mirroring the collation block.
- Add the "Known limitation — type-sensitive CHECK on the reshape arm" note to `docs/materialized-views.md` after line 219.
- Extend the recollate cross-ref comments in `rebuildBacking` and `reshapeBackingInPlace` to also name the `retype` analog.
- Run `yarn test` (or at least `node packages/quereus/test-runner.mjs --grep "type-sensitive CHECK"`) and confirm the new trio passes; run `yarn lint` for the spec's tsc pass.
