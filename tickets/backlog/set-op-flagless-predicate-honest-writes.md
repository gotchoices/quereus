description: Make a flag-less set-operation body (e.g. a flat `union all` of literal-discriminator legs) writable via predicate-honest branch dispatch — the "projected-attribute idiom" the 6.4 plan pass identified as the reuse-aligned alternative to the product-coordinate membership model. Today such a body is read-only (writes are rejected). NEEDS AN APPETITE CHECK: this partially re-opens the deliberate "membership columns replace routing-tag dispatch" decision.
prereq:
files: packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/analysis/sat-checker.ts, packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts, docs/view-updateability.md, docs/sql.md
difficulty: hard
----

## Use case

The dev's redirect that opened the 6.4 plan pass: *"explore if we can accomplish the same
thing [set-op branch membership writes] using projected attributes, since this would add to
the predicate."* The idiom is a **flat `union all` whose legs project ordinary discriminating
attributes** that participate in the row predicate, instead of bespoke membership flags:

```sql
create view U as
  select id, x, 'red'   as kind, 'A' as src from A where color = 'red'
    union all
  select id, x, 'red'   as kind, 'B' as src from B where color = 'red'
    union all
  select id, x, 'large' as kind, 'A' as src from A where size  = 'large'
    union all
  select id, x, 'large' as kind, 'B' as src from B where size  = 'large';
```

`kind` / `src` are *read* by ordinary predicates (`select … from U where src = 'A'`), and the
intent is that *writes* route by them: `insert into U (id, x, kind, src) values (…, 'red', 'B')`
lands in `B where color = 'red'` (the `where color='red'` constant-FD recovers the omitted base
column); `delete from U where kind = 'large'` fans out to every leg whose σ is consistent.

## The gap (why this is not already supported)

A flag-less set-operation body is **read-only today**. `propagate` rejects every
`SetOperationNode` body (`propagate.ts` — `unsupported-set-op`), and the *only* set-op write
path that exists is the membership-column decomposition (`view-mutation-builder.ts` intercepts
`isSetOpMembershipBody` bodies; a flag-less body falls through and rejects). The predicate-honest
branch-dispatch fan-out once sketched in `docs/view-updateability.md` § "Union All" / "Intersect"
/ "Except" is explicitly the **aspirational design that was never built** — the engine chose
membership columns (`6.1-set-op-membership-write`) as its replacement and removed the
`quereus.update.*` routing-tag surface (`remove-update-routing-tag-surface`).

So the projected-attribute idiom requires **building** that flag-less predicate-honest write
path. It is *not* the bespoke product-coordinate novelty (see the shelved
`set-op-product-coordinate-model`); it is the engine's foundational predicate-rules idiom
(Bancilhon–Spyratos, the whole § "Philosophy: Predicates Rule") applied to plain set-op bodies.

## Requirements / expected behavior

- A flag-less `union [all]` / `intersect` / `except` view body becomes writable for
  **INSERT** (existence-predicate branch dispatch — fan to every leg whose accumulated σ is
  consistent, skip provably-inconsistent legs), **DELETE** (fan-out to consistent legs), and
  **UPDATE** of *data* columns (fan-out per § "Per-Operator Semantics").
- **Routing reuses the existing predicate pipeline.** Branch consistency is decided by the same
  predicate-normalizer / FD-EC machinery the optimizer uses (`sat-checker` /
  `rule-filter-contradiction`), per § "Branch Consistency": provably-consistent ⇒ fan; provably-
  inconsistent ⇒ skip; unknown ⇒ include (honest fan-out over silent suppression).
- **Literal discriminators fall out for free.** A projected literal (`'red' as kind`) is a
  constant FD on the leg; an insert supplying `kind = 'red'` is consistent only with the legs
  carrying that constant, and `where color='red'` recovers the omitted base column via the
  existing constant-FD insert defaulting (§ Projection insert rule). Verify the FD framework
  emits the constant FD from a *projected* literal (not only from a `where col=const` predicate)
  — load-bearing, and not yet confirmed by the plan pass.
- **Discriminator columns are not directly assignable** (a projected literal is `computed`
  lineage ⇒ `no-inverse`). "Moving a row between legs" is expressed by INSERT+DELETE, not by
  `update … set kind = …`. Document this boundary; it is the deliberate read-only-discriminator
  posture, distinct from the membership-flag flip.
- **Static surfaces** (`view_info` / `column_info`) must report the new writable shape (and keep
  reporting read-only for the boundary cases below).

## Boundaries / open questions for the plan pass

- **Appetite.** This partially re-opens a settled design decision (membership columns *replaced*
  predicate-honest set-op fan-out). Confirm the dev wants the flat projected-discriminator
  spelling writable, given the membership-column path already serves the nested/flagged spelling.
- **Relationship to membership writes.** Decide whether the two paths coexist (a body with flags
  → membership decomposition; a flag-less body → predicate-honest dispatch) or unify. They share
  the up-front Halloween-safe capture substrate (`__vmupd_keys`) and the per-branch recursive
  `propagate`, so unification is plausible.
- **Non-literal discriminators / σ-guards.** A leg σ the predicate pipeline marks `unknown`
  (function call, correlated, OR-tree) routes by the honest "include on unknown" rule, but cannot
  recover omitted base columns on insert — characterize and document (matches the FD framework's
  existing boundary).
- **`union all` bag identity.** Duplicate data tuples fan a delete/update to all copies (the same
  v1 limitation the membership path documents; a count variant stays deferred).
