description: |
  A lens-synthesized row-local CHECK (and child-FK / set-level) obligation is NOT enforced on a
  decomposition (multi-member, primary-storage advertisement) INSERT through the logical view, even
  for a SINGLE-member CHECK that one base member fully resolves. `buildViewMutation` routes a
  decomposition insert to `buildDecompositionInsert` at an early return (view-mutation-builder.ts
  ~L68) — BEFORE the `extraConstraints` collection (~L147) that threads lens obligations onto the
  base ops. The member inserts re-plan through the ordinary base-table builder, so only the BASIS
  tables' own checks fire; the lens-synthesized logical checks never reach them. A single-source
  lens INSERT (and a decomposition UPDATE) DO enforce these, so this is an INSERT-vs-UPDATE /
  single-source-vs-decomposition enforcement inconsistency. It contradicts docs/lens.md § Enforcement
  by constraint class L273 ("A logical `check` ... fires on every insert/update through the lens").
  Decide: enforce single-member-resolvable obligations on the decomposition INSERT path (gate them
  per member op the same way the UPDATE path does, via `constraintsForOp`), accepting that
  cross-member checks remain the documented weaker (deferred) contract; or, if the blanket deferral
  is intentional, tighten docs/lens.md to say so.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation early return ~L68; buildDecompositionInsert ~L568; constraintsForOp gate ~L880; extraConstraints ~L147
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # collectLensRowLocalConstraints etc. — the obligations not currently threaded on decomposition INSERT
  - docs/lens.md                                                     # § Enforcement by constraint class L273 (blanket "fires on every insert/update") + L286 (decomposition INSERT deferral wording)
  - packages/quereus/test/lens-put-fanout.spec.ts                    # surrogate decomposition fixture + the cross-member/single-member CHECK tests to extend with an INSERT enforcement case
----

## The bug

A logical row-local `check` declared on a decomposition-backed logical table is silently **not
enforced** on an INSERT through the lens, even when a single base member fully resolves it.

Confirmed empirically (throwaway repro, since deleted) against the surrogate
`Doc_core`(title)/`Doc_body`(body)/`Doc_meta`(note) decomposition with a single-member CHECK:

```sql
declare logical schema x {
  table Doc { docKey text primary key, title text, body text, note text,
              constraint titlelen check (length(title) < 5) } }
-- title lives wholly on Doc_core (the anchor member)
insert into x.Doc (docKey, title, body) values ('k1', 'toolong', 'b1');
-- EXPECTED: ABORT (length('toolong') = 7, not < 5)
-- ACTUAL:   succeeds; 'toolong' persists in both main.Doc_core and via x.Doc
```

The same CHECK on the **UPDATE** path correctly ABORTs (it rides the Doc_core member op via the
`constraintsForOp` per-op resolvability gate). A **single-source** lens INSERT also enforces it
(it goes through `propagate` → `extraConstraints` → `constraintsForOp`). Only the decomposition
INSERT path skips enforcement.

## Root cause

`buildViewMutation` (`view-mutation-builder.ts`) routes a decomposition INSERT to
`buildDecompositionInsert` at an early return **before** the lens `extraConstraints` are collected
and gated onto the base ops:

```
buildViewMutation:
  ~L68:  if (req.op === 'insert' && decompositionStorage(...)) return buildDecompositionInsert(...);  // ← returns here
  ...
  ~L147: const extraConstraints = [ ...lensRowLocalConstraints, ...lensForeignKeyConstraints, ...lensSetLevelConstraints, ... ];  // ← never reached for decomposition INSERT
  ~L189: baseOps.map(op => buildBaseOp(..., constraintsForOp(op, extraConstraints, ...), ...));        // ← the per-op gate that DOES enforce on UPDATE
```

`buildDecompositionInsert` (~L568) builds each member insert via `buildDecompositionMemberInsert`,
which re-plans through the ordinary base-table builder — reusing each **basis** table's own checks,
but the basis tables carry no logical check, so nothing fires. The lens obligations
(`collectLensRowLocalConstraints` & siblings in `lens-enforcement.ts`) are never consulted on this
path.

This affects the whole lens-synthesized class on decomposition INSERT — row-local CHECK, child-side
FK `EXISTS`, and the commit-time set-level uniqueness count CHECK — not only row-local CHECKs.
(Set-level uniqueness on the decomposition INSERT may have its own covering-structure story; verify
separately.)

## Expected behavior / fix direction

Thread the lens `extraConstraints` onto the decomposition INSERT's member ops, gated per op by the
**same** `constraintsForOp` resolvability rule the UPDATE path uses, so:

- a single-member-resolvable obligation (every write-row column it references lives on one member)
  rides that member's insert and fires (matching the UPDATE and single-source-INSERT contracts);
- a cross-member obligation resolves on no single member op and stays **deferred** — the documented
  deliberately-weaker contract (docs/lens.md L286), which the decomposition INSERT cannot tighten
  without the snapshot-consistent multi-member substrate.

The decomposition INSERT builds member ops as `DecompInsertOp` / plan nodes (envelope-sourced),
not the `BaseOp` shape `constraintsForOp` takes today, so the gate may need a small adapter (it
only reads `op.table.tableSchema.columns`, so an analogous per-member-table column-resolution check
is enough). Confirm the `NEW.*`/bare-column write-row resolution still holds against the envelope
projection scope (the member insert's `new.<col>` surface).

If instead the blanket deferral is intentional (e.g. the envelope path deliberately does not run
logical row-local checks), then this is a **docs** fix: tighten docs/lens.md L273 so the "fires on
every insert/update through the lens" claim excludes the decomposition INSERT path, and reconcile
the L286 wording (its "(matching the decomposition INSERT path, which also defers cross-member
row-local / set-level enforcement)" parenthetical currently reads as if ONLY cross-member is
deferred on INSERT, when in fact the whole class is). The maintainer should choose enforce-vs-document.

## Acceptance

- A single-member logical row-local CHECK ABORTs a violating decomposition INSERT through the lens
  (or: docs explicitly state it does not, with rationale).
- A cross-member logical row-local CHECK remains deferred on decomposition INSERT (unchanged).
- A regression test in `lens-put-fanout.spec.ts` pins the chosen contract (extend the existing
  `decomposition INSERT parity` case, which today only asserts the cross-member deferral).
- docs/lens.md L273 + L286 reflect the shipped reality.
