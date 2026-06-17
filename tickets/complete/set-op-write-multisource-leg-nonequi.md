description: Corrected stale docs, comments, and tests that wrongly claimed the flag-less set-op write path defers non-equi inner-join legs; added tests proving all three write paths accept them uniformly.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md, packages/quereus/src/func/builtins/schema.ts
difficulty: easy
----

## Summary

A precision cleanup, no production logic changed. The implement stage fixed stale comments/docs
that wrongly claimed the flag-less set-op write path *defers* non-equi inner-join legs for
UPDATE/DELETE, and added positive-coverage tests proving the standalone, membership, and flag-less
paths all admit a non-equi (theta) INNER join leg identically for UPDATE/DELETE.

The central facts are sound and were verified against live code:

- `isInnerJoinBody` (`multi-source.ts:341`) keys only on `joinType` (`fc.joinType === 'inner'`),
  never on equi-ness — so a non-equi INNER join is admitted exactly like an equi-join.
- The flag-less path gates on the same `isInnerJoinBody` via `isWritableLeafLeg` (`set-op.ts:1573`).
- A union-like flag-less body additionally requires ≥1 literal discriminator (`set-op.ts:1609`);
  this — not non-equi-ness — is why the existing `NEV` body reports all-`NO`. The `93.6` relabel
  captures this correctly.

## Review findings

### Scrutinized

- **Implement diff** (`0e18a31f`) read first, before the handoff. Diff is comment/doc/test-only.
- **Production claims** verified against live source: `isInnerJoinBody`, `isWritableLeafLeg`,
  `flaglessShape`, `hasLiteralDiscriminator`, `isOperandWritable`, `setOpJoinLegsInsertable`,
  and the `view_info` static-surface computation in `func/builtins/schema.ts`.
- **Test assertions** hand-traced for NJV, NMV, NEVD, and the NEV relabel — all values are
  correct and the suite passes them.
- **Stale-reference sweep**: `git grep` for `stricter` / `non-equi…defer` / the old follow-up
  slug across `src/` + docs — no stale references remain; the removed follow-up ticket slug is
  gone everywhere.
- **Cartesian-dedup**: NEVD's `ne2 = (1,5,15),(2,5,15)` — both rows match `ne1.id=1`, so the
  join genuinely produces two duplicate rows for id=1, and the passing UPDATE/DELETE proves the
  dedup. The implement handoff *undersold* this (claimed "only one unique match"); the coverage
  is in fact present.

### Found and fixed inline (minor)

- **Inaccurate INSERT-deferral reason in the new test comments** (`93.4` NMV, `93.6` NEVD).
  Both comments attributed `is_insertable_into=NO` to "the join leg has no shared-surrogate
  envelope (same as equi-join legs)." This is backwards: `setOpJoinLegsInsertable`
  (`set-op.ts:268`) probes each leg via `analyzeMultiSourceInsert`, which rejects a **non-equi
  ON** with `unsupported-join` → `NO`. An *equi*-join leg with a qualifying shared key reports
  **YES** — proven by the equi-join MXV body (`93.6:436`, `is_insertable_into=YES`) shipped under
  `set-op-write-multisource-leg-insert`. So the INSERT `NO` here is *because* the join is
  non-equi, not "same as equi-join legs." Ironically this re-introduced the exact class of
  inaccurate "non-equi" claim the ticket exists to remove, just inverted onto the INSERT axis.
  Corrected both comments to state the accurate reason and cite the equi-join YES counterexample.
  (Comment-only edits to `--` lines in sqllogic; no execution impact.)

### Not done (no findings)

- **No major findings** → no new fix/plan/backlog tickets filed.
- **No-op write assertion**: still absent. The ticket flagged it as optional and the primary
  goal (visible-row positive writes) is met; not worth a follow-up ticket.

### Validation

- Full suite (`yarn workspace @quereus/quereus run test`): **6330 passing**, 9 pending, 0 failures.
- Lint (`yarn workspace @quereus/quereus run lint`): exit 0, no output.
- (The two inline fixes are SQL `--` comment lines only — no re-run required; sqllogic ignores
  comments and lint does not cover `.sqllogic`.)
