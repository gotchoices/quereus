<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-11T14:17:10.944Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\check-extraction-rowop-mask-transition-checks.review.2026-06-11T14-17-10-944Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Review — row-invariant gate on CHECK fact extraction (operation mask ⊇ insert|update, no `old.` refs, not deferred); assertion-hoist synthetic checks now carry the default mask.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts          # isRowInvariantCheck + containsOldRowImageRef, gate at top of extraction loop
  - packages/quereus/src/planner/analysis/predicate-shape.ts           # columnIndexFromExpr docblock: deliberate new./self-qualifier tolerance (no code change)
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts     # synthetic checks: operations 0 → DEFAULT_ROWOP_MASK; comment rewritten
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts          # new "row-invariant gate" describe block (14 tests)
  - packages/quereus/test/logic/40.2-check-extras.sqllogic             # new "Row-invariant gate" section: 4 wrong-result repros + 3 controls
  - docs/optimizer.md                                                  # § Check-derived contributions — row-invariant gate paragraph ahead of shape table
----

# Review: row-invariant gate on CHECK fact extraction

## What was implemented

`extractCheckConstraints` (check-extraction.ts) previously minted unconditional
value facts (FDs, EC pairs, constant bindings, domain constraints) from every
entry in `tableSchema.checkConstraints`, ignoring the operation mask and
`old.` row-image references. That let `ruleFilterContradiction` fold WHERE
predicates to empty against rows that legally violate a check the engine never
enforced on their entry path (confirmed wrong-result repros in fix research).

Per the implement ticket, a per-check **row-invariant gate**
(`isRowInvariantCheck`) now runs at the top of the extraction loop, before
`containsNonDeterministicCall`. A check contributes facts only when ALL hold:

1. **Mask ⊇ INSERT|UPDATE** — `(operations & (RowOpFlag.INSERT |
   RowOpFlag.UPDATE)) === both`. DELETE membership irrelevant. Mirrors
   enforcement's `shouldCheckConstraint` (constraint-builder.ts).
2. **Not deferred** — skip on `deferrable || initiallyDeferred`. Defensive:
   the parser rejects DEFERRABLE on CHECK (parser.ts ~4696), so no SQL can
   set these today; pinned via unit test on hand-built `RowConstraintSchema`.
3. **No `old.`-qualified `ColumnExpr`** — new local helper
   `containsOldRowImageRef` walks `walkAstNodes(check.expr)` (reflective, so
   guard disjuncts / compound operands / between bounds / in-lists are all
   covered by one screen) and matches `table === 'old'` case-insensitively.

`new.<col>` stays allowed deliberately (NEW is the stored row image →
same-row); pinned by a unit test (`new.a = b` extracts deep-equal to `a = b`)
and documented on the `columnIndexFromExpr` docblock (predicate-shape.ts —
docblock-only change there).

**Assertion-hoist path preserved**: assertion-hoist-cache.ts's synthetic
checks changed from `operations: 0 as RowOpMask` (which the mask gate would
silently drop) to `operations: DEFAULT_ROWOP_MASK`; the stale "operations is
unused by extractCheckConstraints" comment was rewritten. The unused
`RowOpMask` type import was removed.

All consumers ride the shared gate (`getCheckExtraction` →
`TableReferenceNode.computePhysical`; lens-prover `enumerableDomain`; the
assertion-hoist direct call). The WeakMap cache needed no change.

docs/optimizer.md § Check-derived contributions gained a "Row-invariant
gate" paragraph ahead of the shape table covering all three legs plus the
`new.` tolerance and the assertion-hoist mask.

## Validation performed

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Full `yarn test` (all workspaces) — green: quereus 5850 passing / 9 pending,
  zero failures anywhere.
- New unit tests (check-derived-fds.spec.ts, "row-invariant gate" block, 14
  tests): each non-qualifying mask (insert-only, update-only, delete-only,
  insert|delete, update|delete) extracts nothing across equality + range + in
  shapes; insert|update and insert|update|delete extract as before;
  deferrable / initiallyDeferred extract nothing; `old.` in a plain operand,
  compound RHS (`a = old.b + 1`), implication-form guard disjunct, and
  BETWEEN/IN each kill the whole check; OLD matches case-insensitively; a
  gated check does not suppress sibling checks in the same array; `new.a = b`
  deep-equals `a = b` extraction.
- New sqllogic pins (40.2-check-extras.sqllogic, "Row-invariant gate"
  section): the four fix-stage wrong-result repros now return their rows
  (insert-only check after UPDATE; update-only `old.a = b`; default-mask
  `old.a = b`; delete-only check), plus controls: default-mask fold still
  empty, explicit `check on insert, update` fold still empty,
  `new.`-qualified check rows returned.
- Pre-existing watch-list confirmed passing: 40.2's delete-only
  `t_selfq_d.qty = 0` section (extraction now mints nothing from it — test
  exercises deletes only, still passes), `check on update (old.c = c)`
  NOCASE section, check-fold-gated-by-capability.spec.ts,
  assertion-as-premise.spec.ts (its existing "folds qty<0 query to empty"
  test IS the fold-to-empty pin through the hoist path with the new mask —
  no new test needed there).

## Known gaps / reviewer notes

- The wrong-result repros were verified at pre-fix HEAD during the fix stage;
  I did not re-revert to reconfirm they fail without the gate. The unit tests
  pin the gate behavior directly, so a regression would be caught at that
  layer regardless.
- No lens-specific test was added for the gate flowing through
  `lens-prover.ts` `enumerableDomain` — the ticket scoped that as covered by
  the shared gate (lens logical constraints carry real parsed masks
  verbatim). Existing lens-prover specs pass.
- The conservative edge — a table literally named `old` using self-qualified
  `old.col` refs loses facts — is documented in the helper docblock but not
  tested (sound direction: under-claim only).
- `yarn test:store` was not run (AGENTS.md: only for store-specific issues).
- The `new.` sqllogic control verifies correct rows are returned; the claim
  that `new.` facts still fold contradictions end-to-end is pinned only at
  the unit level (deep-equal with bare extraction), not via a fold-to-empty
  sqllogic query.
