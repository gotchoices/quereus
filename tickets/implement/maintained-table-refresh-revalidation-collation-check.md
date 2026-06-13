description: Characterize and document the collation-sensitive-CHECK corner of the `refresh materialized view` reshape arm. `rebuildBacking` validates declared CHECKs against the reconciled rows in their PRE-recollate physical form (before the post-reconcile recollate op applies), so a CHECK whose truth flips under a recollate-during-reshape can pass validation and then be recollated into a violating state. Add a characterization test pinning the actual behavior and a documented-limitation note — no behavior change.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking + reshapeBackingInPlace two-phase ordering (code under test)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # add the characterization test to the `reshape arm` area
  - docs/materialized-views.md                                            # documented-limitation note lands here
difficulty: medium
----

# Collation-sensitive CHECK on the refresh reshape arm — characterize + document

On the reshape arm, `refresh materialized view` runs
`reshapeBackingInPlace` (`materialized-view-helpers.ts:1981`), which sequences:

```
1. pre-reconcile structural ops (rename/add/loosen/drop)
2. re-register reshaped (structural) schema   ← column collations still OLD here
3. rebuildBacking → validateDeclaredConstraintsOverContents   ← validates + COMMITS
4. post-reconcile data-validating ops (retype / RECOLLATE / tighten-NOT-NULL)
5. re-register final schema
```

The declared-CHECK scan in step 3 runs against the rows in their **pre-recollate
physical form**: the catalog column still carries the OLD collation, so a CHECK
like `check (v <> 'abc')` resolves its `<>` comparison under the old collation.
This is correct and intentional for value-domain CHECK/FK (already tested) and is
the same two-phase ordering the attach reshape path uses — the data-validating ops
defer past the reconcile so they validate the re-derived body, not the discarded
stale backing (see the `reshapeBackingInPlace` docstring "Why the data-validating
ops defer").

The untested corner: a **recollate** that flips a **collation-sensitive CHECK**'s
outcome. A column `v` recollated `BINARY → NOCASE` during the reshape, with a CHECK
`v <> 'abc'` and a row `v = 'ABC'`:
  - step 3 validates under OLD collation BINARY: `'ABC' <> 'abc'` is **true** → passes, commits;
  - step 4 recollates `v` to NOCASE, under which `'ABC' = 'abc'` → the CHECK would
    now **reject** the very row already committed.

So the backing can end up holding a row that violates its own declared CHECK under
the column's final collation.

## Reachability (confirmed)

- `alter table src alter column v set collate nocase` is valid syntax
  (`parser.ts:3264`) and routes to `setCollation` in
  `alter-table.ts` (~line 896).
- A source collation change is **body-relevant** (`bodyRelevantColumnMatches`
  compares collation via `backingCollationMatches`), so a dependent maintained
  table over `select *` goes **stale** and its row-time plan detaches — exactly the
  stale→reshape trigger the other reshape tests use.
- `classifyBackingReshape` emits a `recollate` **post-reconcile** op when the
  body-derived output collation differs from the live backing column
  (`materialized-view-helpers.ts:1764`). Recollate only ever applies to **non-key**
  columns — a PK-collation change is refused as an inexpressible reshape
  (`describePhysicalPkChange`), so the recollate here is a pure declared-collation
  change on the value column `v`, no re-keying.

The implementer must still confirm end-to-end that the source `set collate nocase`
re-derives the `select *` body's output collation as NOCASE and drives the reshape
arm with a `recollate` op (rather than recompiling in place or taking the fast
path). If it does not reach the reshape arm as expected, capture what it does
instead and pin THAT (the test still characterizes real behavior).

## Decision: documented limitation, not a fix

Resolved at plan: this stays a **documented limitation**; the test characterizes
the actual behavior and a docs/code note records the gap. Rationale:

- **Commit-first ordering blocks a clean fix.** `rebuildBacking` **commits** the
  reconciled set (step 3) BEFORE the post-reconcile recollate (step 4) runs —
  commit-first is load-bearing (the reshape's own post-reconcile ops scan COMMITTED
  contents; an enclosing `begin; refresh; rollback` does not undo a refresh today).
  Re-validating after the recollate would therefore throw AFTER the rows are
  already committed and the schema mutated — it could not roll back to the
  pre-refresh contents the way the pre-commit scan does, leaving a worse state than
  the limitation it would close.
- **Parity with attach reshape.** The attach reshape path uses the identical
  pre-recollate validation ordering; "fixing" only the refresh arm would diverge
  the two for an esoteric corner.
- **Self-correcting on next maintenance.** Once the reshape completes and the
  row-time plan re-binds, the next maintenance write touching the offending row
  runs `buildDerivedRowValidator` under the NEW collation, so the violation does
  not silently persist across ordinary operation. (Characterize this too — see
  edge cases.)

So: no production behavior change. Land a test that pins the post-refresh state,
plus a limitation note.

## Edge cases & interactions

- **The core corner.** CHECK `v <> 'abc'` on an implicit `select *` maintained
  table, `v` recollated `BINARY → NOCASE` by the reshape, row `v = 'ABC'` (clean
  under BINARY, violating under NOCASE). Assert the refresh **succeeds** (the row
  survives) and pin the resulting backing state: `v` is NOCASE and the row is
  present. This documents that the pre-recollate scan does not catch it. If the
  characterization instead shows the row is rejected (e.g. the recollate op itself
  re-runs the CHECK), pin that — the corner is then already sound and the note says
  so.
- **Control: collation-INSENSITIVE CHECK is unaffected.** A value-domain CHECK
  (e.g. `check (id > 0)` on a non-recollated column) over the same reshape still
  validates correctly — this is the already-tested behavior; a one-line control
  keeps the corner scoped to collation sensitivity.
- **Next maintenance re-validates.** After the limitation-state refresh, perform a
  source write that re-derives the offending row (or a row-time touch) and
  characterize whether the row-time `buildDerivedRowValidator` now rejects it under
  NOCASE. Pin the actual behavior (throw vs. accept) so the limitation's blast
  radius is documented, not assumed.
- **Implicit-form requirement.** The reshape arm requires the implicit maintained
  form (`derivation.columns === undefined`): use `create table mt (id integer
  primary key, v text, check (v <> 'abc')) maintained as select * from src` — the
  table-column definitions do NOT make it explicit (only a `maintained (cols)`
  rename list does). This matches the existing `reshape arm + violation` test
  (`maintained-table-refresh-revalidation.spec.ts:234`).
- **Memory backing is sufficient.** This corner is in the engine reshape logic, not
  store-specific; the memory spec is the right home. (No `using store` needed.)

## TODO

- Read `reshapeBackingInPlace`, `classifyBackingReshape`, and
  `validateDeclaredConstraintsOverContents` in `materialized-view-helpers.ts`, plus
  the existing `reshape arm + violation` describe block in the memory spec.
- Build a minimal scenario and confirm it reaches the reshape arm with a
  `recollate` op (instrument/log if needed). Capture the ACTUAL post-refresh
  behavior.
- Add a `describe('reshape arm: collation-sensitive CHECK (documented limitation)')`
  block to `packages/quereus/test/maintained-table-refresh-revalidation.spec.ts`
  pinning: the core corner outcome, the collation-insensitive control, and the
  next-maintenance re-validation behavior. Comment each case with WHY it is the
  expected/limitation behavior (not an aspirational assertion).
- Add a short "Known limitation: collation-sensitive CHECK on the reshape arm" note
  to `docs/materialized-views.md` near the reshape/refresh re-validation section,
  describing the pre-recollate validation window and why it is not closed
  (commit-first ordering + attach-reshape parity). Cross-reference it from a brief
  code comment in `reshapeBackingInPlace` / the constraint-bearing branch of
  `rebuildBacking`.
- Run `yarn test 2>&1 | tee /tmp/test.log; tail -n 60 /tmp/test.log` and
  `yarn lint` (single-quote the globs on Windows). Hand off to `review/` with the
  characterized behavior summarized in the handoff (whether the row survived, and
  what the next maintenance write does).
