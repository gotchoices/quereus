description: |
  A logical (lens) UPDATE of a non-key column could throw an internal "no row context" error
  at commit and silently lose the update, when two storage tables behind the view both named
  their value column the same thing. The per-op constraint gate now routes each lens
  constraint by the storage table that actually owns the column, not by bare column name.
  Fixed, tested, and reviewed.
prereq:
files:
  - packages/quereus/src/schema/table.ts                             # RowConstraintSchema: `referencedWriteRowRelations` + `ReferencedWriteRowRelation` type
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # owning-relation resolver + all 4 collectors emit relation-qualified metadata
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # constraintsForOp matches by owning relation identity (ROOT-CAUSE site)
  - packages/quereus/test/lens-put-fanout.spec.ts                    # regression describe block (colliding `val` value-column fixture)
  - docs/lens.md                                                     # § Enforcement by constraint class — gate description updated to relation-identity
difficulty: medium
---

# Lens non-key UPDATE crash — per-op constraint gate routes by owning basis relation, not bare column name

## Summary of the implemented change

On a decomposition-backed logical table a write fans out into one base op per storage member.
Lens-synthesized constraints (deferred `lens:pk`/`lens:unique` count CHECK, child/parent FK,
row-local CHECK) are threaded onto member op(s) by `constraintsForOp` (`view-mutation-builder.ts`).
The old gate matched by **bare basis-column name**, which mis-routed a constraint over one
member's column onto a *sibling* member that merely spelled a column the same way (two members
both naming their value column `val`). At commit the mis-gated deferred CHECK's count-subquery
get-join evaluated against the wrong member's row context and threw
`No row context found for column rowId`, rolling back and **silently losing the update**.

The fix gates by **owning basis relation identity**: `RowConstraintSchema` gained
`referencedWriteRowRelations` (`{schema, table, column}` per referenced write-row basis column,
tagged with the member relation that owns it — transient, never persisted/diffed). All four lens
collectors populate it via `makeOwningRelationResolver` + `buildWriteRowRelations`, sourcing the
owning relation from the decomposition advertisement members (or the single basis source).
`constraintsForOp` now rides a constraint on an op iff **every** entry's `(schema, table)` matches
the op's target relation (case-insensitive) and the column resolves on it; the bare-name walk
survives only as a fallback when the owning relation cannot be resolved (EAV-pivot / opaque slot).
Single-source writes are unaffected (the one base op owns every referenced column).

## Review findings

Adversarial pass over commit `193f5511`. Read the full diff (table.ts, lens-enforcement.ts,
view-mutation-builder.ts, lens.md, test) before the handoff summary, then traced the gate logic
end-to-end through both the UPDATE fan-out (`buildViewMutation`) and INSERT fan-out
(`buildDecompositionInsert`) paths.

**Verification run (all green):**
- `yarn workspace @quereus/quereus test:all --grep "owning basis relation"` → **7 passing**.
- `yarn workspace @quereus/quereus test:all --grep "lens"` → **505 passing**, 0 failing.
- `yarn workspace @quereus/quereus test` (full suite) → **6375 passing, 9 pending, 0 failing** (exit 0).
- `yarn workspace @quereus/quereus lint` (eslint + tsc on test files) → **exit 0, clean**.

**Correctness / aspect scrutiny:**
- **Root-cause site correct.** `constraintsForOp` matches `op.table.tableSchema.{schemaName,name}`
  (lowercased) against each `referencedWriteRowRelations` entry, with `opCols.has(r.column)`. The
  relation `every()` is the right quantifier: a cross-member constraint spanning two relations rides
  no single op ⇒ correctly deferred (documented contract).
- **Single-source unchanged — and now exercised through the new path.** The existing
  `lens-enforcement.spec.ts` end-to-end ABORT tests run through the production
  `lensSetLevelConstraints(ctx, …)` path, which now passes `ctx.schemaManager` and populates
  `referencedWriteRowRelations`. Those tests stay green, which proves the relation gate matches the
  single base op for single-source (a mismatch would have dropped the constraint and the duplicate
  would not ABORT).
- **Backward-compat of the signature change.** `collectLensSetLevelConstraints(slot, schemaManager?)`
  made `schemaManager` optional; the several `lens-enforcement.spec.ts` direct callers that omit it
  resolve `referencedWriteRowRelations = undefined` → bare-name fallback (single base op) → correct.
  No call-site drift (tsc-on-tests clean).
- **Parent-FK single-source assumption verified.** `collectLensParentSideForeignKeyConstraints`
  early-returns for a multi-source/decomposition parent, so its inline-built relation metadata
  (always `basisParent`) is trivially unambiguous.
- **Empty-array edge case examined (not a regression).** A row-local CHECK referencing no write-row
  column yields `referencedWriteRowRelations = []`; `[].every()` is `true` ⇒ rides every op. This
  matches the pre-fix bare-name behavior exactly (`refs = [] ⇒ resolvable`), so it is not introduced
  here.
- **Docs consistent.** `docs/lens.md` § Enforcement by constraint class accurately rewritten to
  relation-identity. Other docs' "gate" hits (`optimizer.md`, `view-updateability.md`, `schema.md`)
  are unrelated subsystems — no stale references to the lens per-op gate anywhere.
- **Test quality.** The new block covers happy path (non-key UPDATE autocommit + explicit-tx),
  edge (unique re-key), error path (duplicate re-key ABORT, duplicate INSERT ABORT, atomic
  rollback), regression (the exact `No row context` crash — implementer verified the test guards it
  by forcing the old bare-name path and reproducing the failure on 3 of 7), and interactions
  (DELETE, INSERT fan-out, row-local CHECK pinning the *general* gate, not just set-level).

**Minor findings — none requiring an inline fix.**
- Parent-FK builds its `referencedWriteRowRelations` inline (not via `buildWriteRowRelations`) and
  without dedup. Harmless: it is single-source (one op) and duplicate entries are inert under
  `every()`; the inline shape (raw basis columns, not logical-derived) is a deliberate, documented
  difference, so reusing the helper would not be cleaner. Left as-is.

**Major findings — filed as a follow-up.**
- **Cross-member basis-term rewrite ambiguity (latent).** `logicalToBasisColumnMap` collapses two
  logical columns sharing a basis-column *name* to the same bare name (`id`→`val`, `name`→`val`), so
  `rewriteToBasisTerms` would rewrite a constraint referencing **both** to a degenerate
  `NEW.val`/`NEW.val`. Confirmed by reading `logicalToBasisColumnMap`. **Not a live bug** — the gate
  defers any such cross-member constraint, so the degenerate expr is never evaluated — but it is a
  real latent correctness trap if a future change ever single-member-routes such a constraint. Filed
  as `tickets/backlog/lens-cross-member-rewrite-relation-qualification.md` so it survives this
  ticket's archival. This is the only known gap the implementer flagged that warranted independent
  tracking.

**Other implementer-flagged gaps — assessed, no action needed.**
- *No child-FK behavioral test over the colliding fixture.* Acceptable: child-FK uses the identical
  `buildWriteRowRelations` helper as set-level/row-local (both behaviorally pinned on the colliding
  fixture), and single-source child-FK tests stay green. Risk is low; a belt-and-suspenders test is
  optional, not required.
- *Downstream e2e (`lens-committed-update-readback-e2e.test.ts`) not flipped.* That spec is not
  present in this tree (lives on the Lamina board), so it is out of scope here — correctly noted as
  downstream confirmation, not a gap in this ticket.

## Disposition

Implementation is correct, DRY, type-safe, well-documented, and fully covered. All acceptance
criteria met; full suite + lint green. One latent rewrite-layer issue filed to backlog; no inline
changes were necessary during review.
