description: A view that joins two tables with a comparison condition (like "x is between lo and hi") can already be edited through all three set-operation write paths, but the docs, code comments, and one test still wrongly claim one path refuses it — correct them and add tests proving the consistent behavior.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
difficulty: easy
----

## Decision: Option A — accept (already the de-facto behavior; this is a consistency/coverage cleanup)

The plan ticket framed this as a live design split between the two set-op write paths
(membership composes a non-equi inner-join leg; flag-less defers it all-`NO`) and asked for a
pick between **accept everywhere** and **reject everywhere**.

**Empirical probing during planning showed the split does not actually exist in the current
code.** All three write-through paths already *accept* a non-equi (theta) INNER-join leg for
UPDATE/DELETE. The flag-less recognizer's leaf gate is `isWritableLeafLeg`
(`set-op.ts:1563`), which rejects only `isJoinBody(leaf) && !isInnerJoinBody(leaf)` — and
`isInnerJoinBody` (`multi-source.ts:340`) keys **only** on `joinType === 'inner'`, never on
equi-ness. So a non-equi inner leg passes the flag-less gate exactly as it passes the
membership gate.

The `93.6` test `NEV` reports all-`NO` **not because the join is non-equi** but because its
`union all` body carries **no literal discriminator** — and a union-like flag-less body without
a discriminator is non-writable regardless of equi-ness (`flaglessShape`,
`set-op.ts:1608`). The test name and its inline comment mis-attribute the deferral to the
non-equi join.

Probe results (verified, then reverted — scratch `view_info` + dynamic UPDATE/DELETE):

| path | example | `is_insertable_into` | `is_updatable` | `is_deletable` | dynamic UPDATE/DELETE |
|---|---|---|---|---|---|
| standalone join-view | `select a.id,a.x from a join b on a.x>b.lo and a.x<b.hi` | `YES` | `YES` | `YES` | composes |
| set-op **membership** leg | `… union exists left as inA …` | `NO` | `YES` | `YES` | composes |
| set-op **flag-less** leg (with discriminator) | `… ,'a' as tag … union all … ,'b' as tag …` | `NO` | `YES` | `YES` | composes |

(The set-op legs report `is_insertable_into = NO` because **join-leg INSERT** is deferred
separately — `setOpJoinLegsInsertable` / `set-op-write-multisource-leg-insert` — unrelated to
equi-ness. The standalone path's insert envelope admits the non-equi leg, hence `YES` there.)

**Why Option A, not Option B:** Option A is what the engine already does on every path, so it
needs no production-logic change. Option B (tighten `isInnerJoinBody` to require an equi-join)
would *remove* existing, working capability — including the standalone join-view path's
`YES/YES/YES` — for no correctness benefit; the plan ticket itself confirms both behaviors are
safe (the non-equi cartesian duplicates dedupe harmlessly through the PK-keyed base op). The
standalone path long ago set the direction (admit non-equi inner joins); aligning the docs and
tests to that reality is the conservative move.

**Therefore this ticket changes no write-decomposition logic.** It is a precision fix:
correct the stale docs + code comments that assert a non-existent split, relabel the
mis-attributed `93.6` deferral test, and add the positive non-equi coverage that is currently
missing on all three paths.

## Background — the stale assertions to fix

1. **`docs/view-updateability.md`** (≈ lines 494–498, § Set-operation membership writes):
   > "A **non-equi (theta) inner** join leg … composes here … *(The flag-less route, by
   > contrast, is stricter: its recognizer conservatively defers a non-equi leg to all-`NO`.
   > Aligning non-equi handling across the two set-op paths is a follow-up —
   > `set-op-write-multisource-leg-nonequi`.)*"

   The parenthetical is false. Rewrite to state both set-op paths (and the standalone path)
   admit a non-equi inner leg identically, and drop the follow-up self-reference (this ticket).

2. **`set-op.ts` `isWritableLeafLeg`** (≈ lines 1565–1572): the comment says "An OUTER … /
   **non-equi** join leg is **deferred**: falling to `false` here…" — but the code does **not**
   fall to `false` for a non-equi inner leg (only for non-inner). Fix the comment to match the
   code: non-equi inner legs ARE admitted; only OUTER/cross legs fall to `false`.

3. **`set-op.ts` `isOperandWritable`** (≈ lines 203–209): the comment correctly says non-equi is
   admitted/composes, but tacks on "— **the flag-less route is stricter**". Drop that clause
   (the flag-less route is not stricter on equi-ness).

4. **`93.6-set-op-flagless-write.sqllogic`** § "Non-equi (theta) INNER join leg deferral"
   (≈ lines 530–552, view `NEV`): relabel. The all-`NO` here is the **missing-discriminator**
   deferral, not a non-equi deferral. Keep the assertion (it is a valid missing-discriminator
   regression) but rename the section and rewrite the comment to attribute it correctly, then
   add the positive non-equi case below it.

## Edge cases & interactions

- **Keep the missing-discriminator deferral intact.** After relabeling `NEV`, it must STILL
  report all-`NO` and still reject the dynamic write — a union-all flag-less body with no
  literal discriminator is non-writable irrespective of equi-ness. Do not "fix" it into
  writability; only its label/comment is wrong.
- **The positive flag-less case needs a literal discriminator.** Add a sibling view (e.g.
  `NEVD`) that mirrors `NEV` but projects a literal `tag` discriminator in each leg, so
  `flaglessShape` admits it; assert `is_insertable_into=NO, is_updatable=YES, is_deletable=YES`
  and that a dynamic UPDATE/DELETE composes (no internal `k.k0_0` capture error).
- **`is_insertable_into` differs by path — assert the right value per path.** A set-op leg
  (membership or flag-less) reports `NO` for insert (join-leg insert deferred); the standalone
  join-view reports `YES`. A test copy-pasting the wrong expected value will silently encode the
  bug.
- **Non-equi visibility / no-op writes.** A row is visible through the view only when the theta
  predicate matches; an UPDATE/DELETE `where id = <non-matching>` is a correct no-op (observed
  during planning: deleting `id=2` with `x=20` did nothing because `20 ≮ 15`). Pick **visible**
  rows in the positive tests, and optionally add one no-op assertion to document the boundary.
- **Cartesian duplicates dedupe.** A non-equi join can match multiple partner rows per base
  row; the base op is PK-keyed so the duplicate identities collapse harmlessly. Optionally cover
  a base row with ≥2 partner matches and assert the single base mutation still lands once.
- **Membership `set <flag> = true` into a non-equi leg stays deferred (`NO` insert).** The flip
  routes through the insert envelope, which is deferred for a join leg regardless of equi-ness —
  same as equi. No change; just don't let a new test assert it as writable.
- **No production logic change ⇒ the whole existing 93.x suite must still pass.** The only code
  edits are comments. Run the full logic suite + lint to confirm no behavioral drift.
- **Cross-path consistency check.** The standalone (`93.4` or wherever) and membership tests
  currently have **no explicit** non-equi positive coverage either (the `YES/YES/YES` and
  `NO/YES/YES` rows are unasserted). Add them so all three paths are pinned by a test and a
  future tightening of `isInnerJoinBody` would fail loudly.

## TODO

- [ ] **Docs:** rewrite `docs/view-updateability.md` § Set-operation membership writes (≈ 494–498)
      to state all three paths admit a non-equi inner leg identically; remove the
      "flag-less route is stricter / defers a non-equi leg / follow-up
      `set-op-write-multisource-leg-nonequi`" sentence. Scan the rest of the § for any other
      "split"/"stricter" wording and align it.
- [ ] **Comment fix `set-op.ts` `isWritableLeafLeg`** (≈ 1565–1572): non-equi inner legs ARE
      admitted; only OUTER/cross legs return `false`. Match the membership-path wording.
- [ ] **Comment fix `set-op.ts` `isOperandWritable`** (≈ 203–209): drop "the flag-less route is
      stricter".
- [ ] **Sanity-check `multi-source.ts` `isInnerJoinBody` JSDoc** (≈ 330–346): it says the
      compose "ships INNER equi-join legs" — clarify it admits non-equi inner legs too (the gate
      is purely `joinType`-based), so the doc does not re-introduce the equi claim.
- [ ] **`93.6` test:** relabel the `NEV` section to "missing-discriminator deferral" and rewrite
      its comment to attribute the all-`NO` to the absent literal discriminator (not non-equi).
      Add a positive `NEVD` (discriminator-carrying, non-equi inner leg) asserting
      `NO/YES/YES` + a dynamic UPDATE and DELETE through it (using visible rows).
- [ ] **`93.4` test:** add a positive non-equi inner-join leg case on the **membership** set-op
      path (`NO/YES/YES` + dynamic UPDATE/DELETE) and a **standalone** join-view non-equi case
      (`YES/YES/YES` + dynamic write), so every path that this ticket reasons about is pinned.
- [ ] **Validate:** `node test-runner.mjs` (full logic suite, stream with `tee`) green, then
      `yarn lint` (single-quote globs on Windows). No production-logic diff expected — only
      comments + tests.
