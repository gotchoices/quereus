description: |
  When a logical table is split across two storage tables that both name their value
  column the same thing, a CHECK or key that spans both columns would currently be
  rewritten into a meaningless expression that confuses the two. Today this is harmless
  because such constraints are simply skipped, but a future change could expose the flaw.
prereq:
files:
  - packages/quereus/src/schema/lens-fk-discovery.ts        # logicalToBasisColumnMap — collapses logical→bare basis name
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # rewriteToBasisTerms — consumes the map
difficulty: medium
---

# Lens basis-term rewrite is ambiguous across colliding basis-column names (latent)

## Context

Surfaced during review of `lens-update-deferred-pk-check-per-op-gate-relation-identity`.
That ticket fixed the **per-op constraint gate** to route lens-synthesized constraints by
*owning basis relation identity* rather than bare column name, closing a crash on a
decomposition whose members back distinct logical columns with **same-named** basis columns
(e.g. two `(rowId, val)` members both spelling their value column `val`).

The gate fix is complete and correct. This ticket tracks a **separate, latent** issue in the
*rewrite* layer that the gate fix deliberately did not touch.

## The latent problem

`logicalToBasisColumnMap` (`schema/lens-fk-discovery.ts`) maps each reconstructible logical
column to the **bare basis-column name** it projects from:

```
id   -> val   (lives on member w_id)
name -> val   (lives on member w_name)
```

`rewriteToBasisTerms` (`planner/mutation/lens-enforcement.ts`) uses this map to rewrite a
logical CHECK / key expression into basis terms. A constraint that references **both** `id`
and `name` over the colliding fixture would rewrite **both** to `NEW.val` — a degenerate
expression that has lost the distinction between the two columns (and their owning members).

## Why it is not a live bug today

The per-op gate (`constraintsForOp`) sees that such a constraint's
`referencedWriteRowRelations` span **more than one** member relation, so it rides **no**
single member op and is **deferred** (never evaluated) on a decomposition write. The
degenerate rewrite is therefore never executed. This is the documented cross-member deferral
contract, and it is exercised green in the existing suite.

The trap: if a future change ever single-member-routes such a cross-member constraint (or
otherwise causes the rewritten expression to be evaluated), the collapsed `NEW.val` /
`NEW.val` expression would silently compute the wrong thing — a correctness bug, not a crash.

## What to do

Relation-qualify the logical→basis rewrite so two logical columns that share a basis-column
*name* but live on *different* members rewrite to relation-distinct terms (carry the owning
relation alongside the bare name, mirroring the `ReferencedWriteRowRelation` metadata the gate
fix already threads). Then the cross-member deferral becomes a performance/timing choice rather
than a correctness necessity, and the rewrite is safe even if such a constraint is ever routed.

## Note on testing

The originating ticket deliberately did **not** add a cross-member-colliding-name behavioral
test, to avoid baking the current degenerate-expr-then-defer behavior in as "expected". A test
added here should assert the *corrected* relation-distinct rewrite, not the current collapse.
