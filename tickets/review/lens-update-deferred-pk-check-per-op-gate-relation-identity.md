description: |
  A logical (lens) UPDATE of a non-key column could throw an internal "no row context" error at
  commit and silently lose the update, when two storage tables behind the view both named their
  value column the same thing. The per-op constraint gate now routes each lens constraint by the
  storage table that actually owns the column, not by bare column name. Fixed and tested.
prereq:
files:
  - packages/quereus/src/schema/table.ts                             # RowConstraintSchema: new `referencedWriteRowRelations` + `ReferencedWriteRowRelation` type
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # owning-relation resolver + all 4 collectors now emit relation-qualified metadata
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # constraintsForOp now matches by owning relation identity (ROOT-CAUSE site)
  - packages/quereus/test/lens-put-fanout.spec.ts                    # new regression describe block (colliding `val` value-column fixture)
  - docs/lens.md                                                     # § Enforcement by constraint class — gate description updated to relation-identity
difficulty: medium
---

# Lens non-key UPDATE crash — per-op constraint gate now routes by owning basis relation, not bare column name

## What was wrong (root cause, confirmed)

On a **decomposition-backed** logical table, a write fans out into one base op per storage member.
Lens-synthesized constraints (the deferred `lens:pk`/`lens:unique` count CHECK, child/parent FK,
row-local CHECK) are threaded onto the member op(s) that can build them by `constraintsForOp`
(`view-mutation-builder.ts`). The old gate decided "can this op carry the constraint?" by testing
whether every referenced **bare basis-column name** appears in the op's target table.

That is ambiguous when two members back distinct logical columns with **same-named** basis columns.
Repro shape: each logical column lives in its own `(rowId, val)` member joined on a surrogate
`rowId`, and **both** members spell their value column `val`. The logical PK `id` maps to
`w_id.val`; a name-only `update … set name='B'` fans out to the `w_name` op **alone**, but `w_name`
*also* has a column called `val`, so the bare-name gate wrongly threaded the `id`-uniqueness
`lens:pk` CHECK (which references `NEW.val` = `w_id.val`) onto the `w_name` op. At commit the
deferred CHECK's count-subquery get-join evaluated against the `w_name` row context and threw
`No row context found for column rowId`; the episode rolled back, **silently losing the update**.

The originating fix ticket's "identical `rowId` spelling" framing was a red herring — the trigger is
the colliding **value**-column name. The get-join is not buggy; only the mis-gated evaluation crashes.

## The fix

Gate by **owning basis relation identity**, not bare column name.

- `RowConstraintSchema` gains `referencedWriteRowRelations?: readonly ReferencedWriteRowRelation[]`
  (`{ schema, table, column }`) — each referenced write-row basis column tagged with the **member
  relation that owns it**. Transient, never persisted/diffed. (`schema/table.ts`)
- All four lens collectors populate it (`lens-enforcement.ts`), sourcing the owning relation from
  `slot.advertisement.storage.members` (decomposition) or `resolveSlotBasisSource` (single-source),
  via the new `makeOwningRelationResolver` + `buildWriteRowRelations` helpers:
  - set-level (`collectLensSetLevelConstraints`, now takes an optional `schemaManager`),
  - child-FK (`collectLensForeignKeyConstraints`),
  - parent-FK (`collectLensParentSideForeignKeyConstraints` — always single-source, owning relation
    = `basisParent`),
  - row-local CHECK (`collectLensRowLocalConstraints` — also still carries the bare
    `referencedWriteRowColumns` for introspection).
- `constraintsForOp` prefers `referencedWriteRowRelations`: a constraint rides an op iff **every**
  entry's `(schema, table)` matches the op's target relation (case-insensitive) and the column
  resolves on it. The bare-name `referencedWriteRowColumns ?? writeRowColumns(expr)` walk survives
  only as a **fallback** for a constraint whose owning relation could not be resolved (EAV-pivot /
  opaque slot). (`view-mutation-builder.ts`)

Single-source lens writes are unaffected: the single base op's relation owns every referenced
column, so relation matching keeps threading the full set onto it (no behavior change).

## How to validate

```
yarn workspace @quereus/quereus test     # full suite — 6375 passing, 9 pending, 0 failing
yarn workspace @quereus/quereus lint      # eslint + tsc (test files) — clean (exit 0)
# focused:
yarn workspace @quereus/quereus test:all --grep "owning basis relation"   # the 7 new tests
yarn workspace @quereus/quereus test:all --grep "lens"                     # 505 passing, 0 failing
```

### Regression tests added (`lens-put-fanout.spec.ts`, new describe block at end)

A name-match per-column decomposition with **colliding `val` value-column names** (mirrors the
ticket's repro; surrogate `rowId` spelled identically across members):

| Test | Asserts |
| --- | --- |
| non-key `set name='B'` (autocommit) | commits + round-trips through lens **and** basis; no `No row context` throw, no lost update |
| non-key `set name='B'` (explicit `begin; update; commit`) | commits through the explicit-tx commit path |
| unique re-key `set id=22` | commits — `lens:pk` rides the `w_id` op and passes |
| duplicate re-key `set id=1` | ABORTs at commit (count ≥ 2); rolls back atomically |
| `delete where id=3` | reaches both members; unaffected |
| `insert (id,name)` + duplicate insert | fan-out across both members; duplicate logical id ABORTs at commit, atomic |
| single-member row-local CHECK (`length(name)<5`) | rides **only** `w_name`; a too-long name ABORTs, a key-only `set id` fan-out does not carry it (no mis-route, no spurious enforcement) — pins the **general** gate, not just set-level |

### The repro genuinely guards the bug (verified)

Forcing the old bare-name path (`if (false && c.referencedWriteRowRelations)`) and re-running the
new block reproduces the **exact** documented failure on 3 of the 7 tests:
`QuereusError: No row context found for column rowId` (stack through
`deferred-constraint-queue → join.ts → context-helpers.resolveAttribute`). Restored → all 7 green.

## Known gaps / what the reviewer should scrutinize

- **No behavioral test for the child-FK class** over the colliding-name fixture. The set-level
  (`lens:pk`) and row-local CHECK classes are behaviorally pinned on the colliding fixture; child-FK
  relation metadata is wired and unit-covered indirectly (single-source FK tests in
  `lens-enforcement.spec.ts` stay green) but not exercised on a colliding-name decomposition. Parent-FK
  is single-source-only (owning relation = `basisParent`), so its metadata is trivially unambiguous.
  A reviewer wanting belt-and-suspenders could add a child-FK over the `W` fixture.
- **Cross-member constraint over colliding names — out-of-scope latent issue.** A row-local CHECK or
  set-level key that references **both** colliding columns (`id` *and* `name`, both → basis `val`)
  has a *separate* latent problem: `logicalToBasisColumnMap` collapses both logical columns to the
  bare name `val`, so `rewriteToBasisTerms` would rewrite both to `NEW.val` (a degenerate expr). The
  gate fix here correctly **defers** such a cross-member constraint (it spans two relations ⇒ rides no
  op ⇒ never evaluates), so it is not a live bug — but the rewrite ambiguity itself is untouched by
  this ticket. If a future change ever single-member-routes such a constraint, the collapsed expr
  would bite. Worth a reviewer's judgment on whether to file a follow-up for the rewrite layer
  (`logicalToBasisColumnMap` / `rewriteToBasisTerms` relation-qualification). I did **not** add a
  cross-member-colliding test to avoid baking in the degenerate-expr behavior as "expected".
- **`referencedWriteRowColumns` retained** on row-local constraints alongside the new
  `referencedWriteRowRelations` (two fields now coexist). Kept because an existing assertion
  (`lens-put-fanout.spec.ts`: "metadata stays consistent with the rewrite" → `['doc_key']`) reads it,
  and it is the introspection/fallback surface. The gate uses the relations field.
- **Downstream verification not run here.** The Lamina board's skipped e2e
  `lens-committed-update-readback-e2e.test.ts` is **not present in this tree**, so it could not be
  flipped green as part of this ticket. It is the downstream confirmation that this fix resolves the
  originating end-to-end symptom.

## Acceptance status

All acceptance criteria from the implement ticket are met and tested: non-key lens UPDATE commits +
round-trips (autocommit + explicit-tx); key-changing UPDATE still enforces `lens:pk` (unique re-key
commits, duplicate ABORTs); DELETE/INSERT correct (duplicate INSERT ABORTs at commit); INSERT|UPDATE
masking and the cross-member deferral contract unchanged; all existing `lens-enforcement.spec.ts` and
`lens-put-fanout.spec.ts` tests stay green.
