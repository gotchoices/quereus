description: Review the characterization test + documented-limitation note for the collation-sensitive-CHECK corner of the `refresh materialized view` reshape arm. No production behavior change — a 3-case characterization test, a docs note, and two cross-reference code comments. Verify the pinned behavior is the ACTUAL behavior (not aspirational) and that the limitation's blast radius is documented honestly.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch + reshapeBackingInPlace post-reconcile phase (comments added; no logic change)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # new describe block 'reshape arm: collation-sensitive CHECK (documented limitation)'
  - docs/materialized-views.md                                            # 'Known limitation — collation-sensitive CHECK on the reshape arm' note in the REFRESH section
difficulty: medium
----

# Review: collation-sensitive CHECK on the refresh reshape arm — characterize + document

## What was done (no behavior change)

The reshape arm of `refresh materialized view` sequences (`reshapeBackingInPlace`,
`materialized-view-helpers.ts:1981`):

```
1. pre-reconcile structural ops (rename/add/loosen/drop)
2. re-register reshaped (structural) schema      ← column collations still OLD
3. rebuildBacking → validateDeclaredConstraintsOverContents   ← validates + COMMITS
4. post-reconcile data-validating ops (retype / RECOLLATE / tighten-NOT-NULL)
5. re-register final schema
```

Step 3 validates declared CHECKs against rows in their **pre-recollate** physical
form (the catalog column still carries the OLD collation), so a CHECK whose truth
flips under a recollate-during-reshape passes validation, commits, and is then
recollated into a violating state. Resolved at plan as a **documented limitation,
not a fix** (commit-first ordering is load-bearing; attach-reshape parity). This
ticket lands a characterization test + docs note + code comments only — **zero
production logic change** (the only edits to the `.ts` source are comments).

## Behavior confirmed empirically (via a throwaway probe, since deleted)

The ticket asked the implementer to confirm the scenario actually reaches the
reshape arm with a `recollate` op and to **pin the ACTUAL behavior**. Confirmed:

- `alter table src alter column v set collate nocase` is body-relevant for a
  `select *` maintained table ⇒ `mt` goes **stale**, plan detaches. (Catalog `v`
  still reads `BINARY` at this point.)
- `refresh materialized view mt` takes the **reshape arm**: `v` flips
  `BINARY → NOCASE` (the observable proof the recollate op ran — the fast path
  would leave collation untouched), the refresh **succeeds**, and the offending
  row `{id:1, v:'ABC'}` (clean under BINARY `'ABC' <> 'abc'`, violating under
  NOCASE `'ABC' = 'abc'`) **survives**. Limitation confirmed exactly as predicted.

### Next-maintenance blast radius — the plan's "self-correcting" framing was refined

The plan hypothesized the limitation is "self-correcting on next maintenance." The
ACTUAL behavior is more nuanced, and the test + docs now pin the real shape:

- A **value-identical / no-delta** source touch (`update src set v = v`) produces
  no derived-row change ⇒ no row-time validation runs ⇒ the violator is left
  **frozen** (not corrected, not re-rejected).
- A **genuine delta** that re-derives the offending value (`update src set v =
  'Abc'` — distinct under BINARY, still `= 'abc'` under NOCASE) is **REJECTED** by
  `buildDerivedRowValidator` under the NEW collation; the rejected write rolls
  back, leaving the already-committed row unchanged.
- A **fresh** source row deriving the offending value (`insert (2, 'ABC')`) is
  likewise **rejected** under NOCASE.

So: the violation does **not** silently spread via ordinary writes (any genuine
re-derivation throws), but the already-committed row stays **frozen** until
manually corrected — it does **not** auto-heal. This is the honest framing the
test and docs now carry (not "self-correcting").

## Tests added (`maintained-table-refresh-revalidation.spec.ts`, memory backing)

New `describe('reshape arm: collation-sensitive CHECK (documented limitation)')`,
three cases, each commented with WHY it is the limitation/expected behavior:

1. **Core corner** — pins that the refresh succeeds, `v` recollates to NOCASE, and
   the CHECK-violating-under-NOCASE row survives. Asserts the collation flip as the
   reshape-arm-+-recollate proxy.
2. **Control** — a collation-INSENSITIVE CHECK (`id > 0`) over the **same**
   recollate reshape still correctly rejects a genuine violator (`-1`), scoping the
   limitation strictly to collation-sensitive comparisons (proves the validation
   path itself is sound).
3. **Next maintenance** — pins the three-way blast radius above (frozen on no-delta
   touch; rejected on genuine update delta; rejected on fresh insert).

All 20 tests in the file pass; `yarn lint` clean; full `yarn test` green (6149
quereus + all other workspaces passing, 0 failing — the `boom`/`batch write
failed`/`iterate failed` lines in the log are deliberate error-injection inside
passing sync/listener tests, unrelated to this ticket).

## Reviewer attention points / known gaps (honest floor, not a finish line)

- **Reshape-arm confirmation is by OUTCOME, not op-list.** The core test confirms
  the reshape-with-recollate ran by asserting the `v` collation flips
  `BINARY → NOCASE` across the refresh. It does **not** instrument the internal
  `ReshapeColumnOp` list to assert a `recollate` op specifically. The collation
  flip is a faithful proxy (only the reshape arm's post-reconcile recollate changes
  the backing collation), but if the reviewer wants a stronger pin, the classifier
  (`classifyBackingReshape`) could be unit-tested directly. Judged out of scope here.
- **Memory backing only** (per plan decision — engine-level corner, not
  store-specific). Not exercised against `using store`. A `yarn test:store` pass
  was **not** run (the corner is in `reshapeBackingInPlace`/`rebuildBacking`, both
  store-agnostic), but a reviewer wanting belt-and-suspenders could spot-check.
- **Only the collation→CHECK flip is characterized.** The analogous `retype`-flips-
  a-CHECK corner (a type change that alters a CHECK's truth over the same
  pre-validate/post-convert window) is NOT covered — plausibly the same class of
  limitation, but unverified. Flagging as a possible follow-up rather than asserting
  it behaves identically.
- **The "frozen until manually corrected" claim** is pinned for the update-delta
  and fresh-insert paths. There may be other re-derivation shapes (e.g. a
  delete-then-reinsert of the same source key within one statement, or a body whose
  maintenance arm is bounded-delta rather than full-rebuild) that the three cases do
  not exercise. The general claim rests on `buildDerivedRowValidator` running under
  the new collation for any genuine new image, which is the documented steady-state
  contract — but only the two shapes above are directly pinned.
- **Docs note placement** is in the REFRESH section of `docs/materialized-views.md`
  (after the explicit-column-list paragraph). Reviewer may prefer it nearer the
  `## Derived-row constraint validation` § "Still out of scope" line (549) instead —
  a judgment call; it is cross-referenced from both code comments either way.

## Suggested review validation

- Re-read the three test cases against `reshapeBackingInPlace` /
  `rebuildBacking` and confirm each assertion is the *actual* (not aspirational)
  behavior — especially that the core corner asserts the row **survives** (the
  limitation), not that it is rejected.
- Confirm the docs note and the two code comments
  (`rebuildBacking` constraint-bearing branch; `reshapeBackingInPlace`
  post-reconcile phase) accurately describe commit-first ordering and
  attach-reshape parity as the reasons the limitation is left open.
- Optional: decide whether the `retype`-flips-CHECK analog warrants its own
  backlog ticket.
