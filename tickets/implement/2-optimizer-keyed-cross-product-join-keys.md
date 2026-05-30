----
description: combineJoinKeys / analyzeJoinKeyCoverage advertise the composite product key (leftKey ∪ rightKey-shifted) for a true keyed inner/cross (lateral) join, so keysOf surfaces a column key instead of falling back to isSet / all-columns. Bounded to one lex-min product key per join node.
prereq:
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
effort: high
----

> **Forward-optimizer key-derivation improvement, standalone.** No prereq on the
> maintenance substrate spike. `materialized-view-rowtime-general-bodies` prereqs
> *this* ticket (the explicit reverse edge): it consumes the composite backing PK
> this ticket teaches `keysOf` to surface. Keep scope on `combineJoinKeys` /
> `analyzeJoinKeyCoverage`; do not pull MV-consumption logic in here.

## Background (verified against current code)

`combineJoinKeys` (`key-utils.ts:224`) is the single logical-key function: it is
called from `JoinNode.getType` (`join-node.ts:153`) **and** from every physical
join node's `getType` (`merge-join-node.ts`, `bloom-join-node.ts`,
`hash-join-node.ts`, `fanout-lookup-join-node.ts` all call it via
`buildJoinRelationType`). So a single edit to its `inner`/`cross` branch
propagates the new product key to all logical *and* physical relation types.

The separate **physical FD** path is `JoinNode.computePhysical` →
`analyzeJoinKeyCoverage` (`key-utils.ts:310`) → `propagateJoinFds`
(`join-utils.ts:165`). `propagateJoinFds` already layers each entry of
`preservedKeys` onto the FD set via `superkeyToFd(key, totalColumnCount)`
(`join-utils.ts:197-204`) — it handles **arbitrary** keys including composites
with no change. So the physical side needs *only* a new push into
`preservedKeys`; FD materialization is already generic.

### Today's `inner`/`cross` behavior

`combineJoinKeys` (`key-utils.ts:232-253`): two independent coverage checks.
`joinPairsCoverKey(rightKeys, rightEqSet)` true ⇒ left keys survive;
`joinPairsCoverKey(leftKeys, leftEqSet)` true ⇒ right keys (shifted) survive.
A bare cross join (no equi-pairs, both sides keyed) covers neither ⇒ returns
`[]`. The empty key `[]` on a ≤1-row side makes `joinPairsCoverKey` vacuously
true, so ≤1-row cases already fire a survivor branch (they never reach the gap).

`analyzeJoinKeyCoverage` (`key-utils.ts:384-393`): mirrors this — pushes
`leftKeys` when `rightKeyCovered`, `rightKeysShifted` when `leftKeyCovered`,
and `[]` when both sides are singletons. `leftKeyCovered`/`rightKeyCovered`
fold in the ≤1-row case (`isUnique([], rel)`), so a singleton side is always
"covered" and never reaches the gap.

### The gap

A true relational product — `inner`/`cross`, no equi-pair coverage of either
side, both sides advertise a **non-empty** unique key — is itself keyed by the
pair `(leftKey ∪ rightKey-shifted-by-leftColumnCount)`, but that composite is
not emitted today. `RelationType.isSet` carries the full-row set-ness, but
that is a boolean, not a *column* key, so `keysOf` cannot hand a consumer
(MV backing-PK derivation, distinct elimination, covering proofs) an actual
column key for the product.

## Target behavior

For `inner`/`cross` where **neither** existing coverage branch fired and
**both** sides have at least one non-empty key, emit exactly **one** product
key: the lex-min key from each side, concatenated, with the right side's column
indices shifted by `leftColumnCount`.

- `keysOf` over `a CROSS JOIN b` (both single-col PK) ⇒ the two-column composite
  `[0, leftColumnCount]`.
- `keysOf` over a lateral `base ⋈ tvf(base.x)` whose TVF advertises a per-call
  key ⇒ the composite `(base.PK ∪ tvf-key-shifted)`.
- Physical FD path emits `(left-key ∪ right-key-shifted) → (all join cols)` so
  `isUnique`/`keysOf` over physical properties agree with the logical layer.

Equi-join (one-side-covered), outer, semi, anti, and ≤1-row behavior all
**unchanged** — the new branch is gated to fire only in the previously-empty gap.

## Design constraints (carried from plan)

**Blow-up containment — one product key per call.** Select the lex-min key from
each side: fewest columns, ties broken by lowest first-column index. Concatenate
the two. This bounds growth to ≤1 new key per join node regardless of how many
alternative keys each side carries, keeping chained joins tractable. Document
this policy in the function comment beside the existing soundness argument.

**Gating condition (both layers must agree).** Emit the product key only when:
1. join type is `inner` or `cross`;
2. neither the right-key-covered nor the left-key-covered branch fired (those are
   the existing equi-join survivor branches and already yield correct
   individual-side keys; firing both *is* the key=key product and is already
   handled);
3. both sides have ≥1 **non-empty** key entry. An empty key means ≤1-row, which
   is already handled by the existing branches/empty-key shortcut (a singleton
   side makes the opposite side's keys survive, so the gate in (2) is already
   false); the product key would be redundant and structurally `[]`.

Because the ≤1-row path always trips a survivor branch (empty key ⇒ vacuous
coverage / `isUnique([], rel)` true), condition (3)'s "non-empty" filter and
condition (2)'s "neither fired" gate are mutually reinforcing — verify both
layers reach the new branch *only* in the genuine both-keyed-no-coverage case.

**Soundness note for the comment.** The product is keyed by `(leftKey,
rightKey)` because each `(leftKey-value, rightKey-value)` pair occurs at most
once: leftKey is unique on the left, rightKey on the right, and the product
pairs every surviving left row with every surviving right row exactly once
(inner with a non-covering predicate still only *removes* pairs, never
duplicates them — so the pair stays unique). This is precisely why the branch
must NOT fire when an equi-pair introduces fan-out that one side's coverage
already accounts for: that case is the existing branch's job.

## Implementation notes

- Add a small shared helper in `key-utils.ts`, e.g.
  `selectLexMinKey(keys): key | undefined` (returns the fewest-columns,
  then-lowest-first-index non-empty key, or `undefined` if none). Use it from
  **both** `combineJoinKeys` (ColRef form) and `analyzeJoinKeyCoverage`
  (number[] form) to stay DRY. Pick a signature that works for both shapes
  (e.g. operate on `readonly number[][]` and have `combineJoinKeys` map ColRef
  keys to/from indices, preserving `desc`), or provide one generic over the
  element accessor. Keep it a single-purpose function.
- `combineJoinKeys`: capture the two coverage checks as booleans
  (`leftSurvives`, `rightSurvives`) instead of inlining the `if`s, then after the
  existing pushes add: if `!leftSurvives && !rightSurvives`, select lex-min from
  each side; if both exist (non-empty), push the concatenation
  (`leftPick ∪ rightPick.map(shift by leftColumnCount)`). Run through
  `dedupeKeys` as today.
- `analyzeJoinKeyCoverage` (the `inner`/`cross` block at `key-utils.ts:384`):
  after the existing `rightKeyCovered`/`leftKeyCovered`/both-singleton pushes,
  add the parallel branch: if `!leftKeyCovered && !rightKeyCovered`, pick lex-min
  from `leftKeys` and from `rightKeysShifted` (already shifted — concatenate
  directly), and only push when both picks are non-empty. `propagateJoinFds`
  turns it into the `(left ∪ right-shifted) → all-cols` FD with no change.
- No change needed in `propagateJoinFds`, `superkeyToFd`, or `keysOf` — they
  already consume arbitrary keys.

## Key tests (extend `keys-propagation.spec.ts`)

Unit (`combineJoinKeys`, in the existing `combineJoinKeys unit tests` block):
- `CROSS JOIN`, both sides single-col PK `[[{index:0}]]`, `leftColumnCount=2`,
  no equi-pairs ⇒ output contains the composite `[[0, 2]]`. (This **replaces**
  the current `'CROSS join (no equi-pairs) → []'` assertion at
  `keys-propagation.spec.ts:281-286` — update that test to expect the composite,
  and note in its comment that full-row set-ness is *additionally* carried by
  `isSet`.)
- `a INNER JOIN b ON a.x = b.y` where the equi-pair covers **neither** side's
  key but both sides have keys ⇒ a product key **is** emitted (the inner
  predicate only removes pairs; the `(leftKey, rightKey)` pair stays unique).
  NOTE: re-read the existing `'INNER without coverage … → []'` test
  (`keys-propagation.spec.ts:271-279`) — under this ticket that case now yields
  the composite, so that assertion must be updated too. Be explicit in the
  comment about why the product key is sound there (no duplication, only
  filtering). Confirm this reasoning during implement; if a counterexample
  surfaces (it should not for inner/cross), tighten the gate and document it.
- Composite-PK side: left has composite PK `[[{0},{1}]]`, right single-col
  `[[{0}]]`, cross, `leftColumnCount=3` ⇒ `[[0,1,3]]` (lex-min picks the only
  keys; right shifted by 3).
- Lex-min selection: a side carrying two keys (`[[{1}],[{0}]]` — both length 1)
  ⇒ tie broken by lowest first index ⇒ picks `[{0}]`. A side carrying
  `[[{0},{1}],[{2}]]` ⇒ picks the shorter `[{2}]`.
- ≤1-row guard: one side `[[]]` (empty key) ⇒ NO product key (existing
  survivor branch fires; assert output equals the existing-branch result, not a
  composite). Keep the existing empty-key suite green.

Integration via `query_plan(...)`:
- `SELECT * FROM a CROSS JOIN b` with two keyed base tables ⇒ the join physical
  carries the composite key-encoding FD (`hasKeyFd(fds, totalCols)` true with
  determinant length < totalCols spanning both sides). Use the existing
  `physicalFor`/`hasKeyFd` helpers.
- `SELECT DISTINCT *` over that keyed cross join ⇒ `Distinct` eliminated
  (composite key ⇒ output already a set on those cols). Add a negative control
  (one side keyless ⇒ `Distinct` retained).
- Lateral-TVF shape: a lateral TVF that advertises a per-call key joined to a
  keyed base ⇒ composite FD on the join + `DISTINCT` eliminated above it.
  **De-risk first:** confirm a TVF can advertise a per-call key that reaches
  `combineJoinKeys` (check `table-function-call.ts` `getType().keys`). If no
  readily-available TVF advertises a non-empty key, the base-table
  `CROSS JOIN` integration test above exercises the *same* composite code path —
  use it as the primary integration coverage and add the lateral-TVF test only
  if a keyed TVF is available; otherwise document the deferral in this ticket's
  handoff and leave a focused note for `materialized-view-rowtime-general-bodies`
  (which owns the lateral-TVF consumption) rather than blocking here.

Regression:
- The whole `combineJoinKeys unit tests` block and the `empty-key (≤1-row)
  coverage` suite must stay green (after the two intended updates above).

## Validation

- `yarn workspace @quereus/quereus run build` then targeted unit run:
  `yarn workspace @quereus/quereus test --grep "Key propagation"` (stream with
  `2>&1 | tee /tmp/keys.log; tail -n 80 /tmp/keys.log`).
- Full suite: `yarn test 2>&1 | tee /tmp/test.log; tail -n 120 /tmp/test.log`.
- MV regression corpus (the narrowing from all-columns fallback to the composite
  key alters affected lateral-TVF backing PKs — confirm no behavioral
  regression): `51-materialized-views.sqllogic`,
  `53-materialized-views-rowtime.sqllogic`,
  `54-covering-mv-enforcement.sqllogic`. These run under the standard logic
  harness; they are exercised by `yarn test`.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- If a surfaced failure is plainly pre-existing / outside this diff, follow the
  `tickets/.pre-existing-error.md` protocol rather than chasing it here.

## Docs

Update `docs/optimizer.md` key/FD-propagation section to record: keyed
`inner`/`cross` (and lateral) products now advertise a single lex-min composite
product key `(leftKey ∪ rightKey-shifted)`; state the one-key-per-node blow-up
policy and the gating condition (neither side covered, both sides non-empty
keyed) alongside the existing equi-join / ≤1-row notes.

## TODO

- [ ] Add `selectLexMinKey` helper to `key-utils.ts` (fewest cols, then lowest
      first-col index; `undefined` when only empty/no keys). Single-purpose,
      shared by both call sites.
- [ ] `combineJoinKeys` `inner`/`cross`: capture the two coverage checks as
      booleans; when neither fired and both sides have a non-empty lex-min key,
      push the concatenated `(leftPick ∪ rightPick+leftColumnCount)` composite;
      keep `dedupeKeys`. Update the function comment (soundness + one-key policy).
- [ ] `analyzeJoinKeyCoverage` `inner`/`cross` block: parallel branch pushing the
      composite into `preservedKeys` under the same gate (using `leftKeys` /
      `rightKeysShifted`). Verify `propagateJoinFds` emits the FD unchanged.
- [ ] Update the two existing unit tests that asserted `[]`
      (`CROSS join (no equi-pairs)` and `INNER without coverage`) to expect the
      composite, with comments explaining the soundness.
- [ ] Add the new unit tests: composite-PK side, lex-min tie-breaking, ≤1-row
      guard (no product key).
- [ ] Add integration tests: keyed `CROSS JOIN` composite FD + `DISTINCT`
      elimination (with negative control). De-risk and add the lateral-TVF
      variant if a keyed TVF is available; else document the deferral.
- [ ] Run targeted unit grep, full `yarn test`, MV corpus, and lint; confirm
      green (or file `.pre-existing-error.md` for unrelated failures).
- [ ] Update `docs/optimizer.md`.
- [ ] Write the `review/` handoff: note the two updated-assertion tests, the
      lateral-TVF de-risk outcome, and any MV physical-layout shifts observed.
