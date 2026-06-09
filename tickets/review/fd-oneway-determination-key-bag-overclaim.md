description: Review the gating of the one-way single↔single producer FD `{a}→{b}` (from `check (b = a + 1)` / hoisted assertion) at `TableReferenceNode.computePhysical`. The fold now gates EVERY unguarded single↔single FD on endpoint-superkey-ness (dropping the prior `equivPairs`-membership precondition), so a narrow `select distinct a, b` over a non-keyed table no longer re-derives `{a}` as a phantom key and drops a REQUIRED DISTINCT (wrong results). Implemented via a shared `foldSingleSingleGated` helper reused by both the table-reference producer fold and the filter predicate-FD fold.
prereq:
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/check-derived-fds.spec.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md
----

## What was broken (wrong results)

```sql
create table te (a integer, b integer, c integer, check (b = a + 1));
insert into te values (1, 2, 10), (1, 2, 20), (3, 4, 30);
select distinct a, b from te;
--   WAS: 3 rows (1,2),(1,2),(3,4)  -- DISTINCT eliminated, WRONG
--   NOW: 2 rows (1,2),(3,4)        -- DISTINCT survives, CORRECT
```

`check (b = a + 1)` emits the **one-way** FD `{a}→{b}` and **no** equiv pair
(`handleEquality` pushes equiv pairs only on the `col = col` branch). The old
`foldGatedProducerFds` gate skipped an FD *only when its unordered pair was in the
producer's `equivPairs`* — so the one-way FD, lacking an equiv pair, folded
**unconditionally** with no endpoint-superkey test. On the 2-col output of `select
distinct a, b`, `closure({a}) = {a,b} =` all cols, so `{a}` was read as a key and
`rule-distinct-elimination` dropped the DISTINCT. The bi-directional sibling (sites
5/6) was already gated; this one-way shape was the documented hole (gap #4 of
`fd-check-assertion-key-bag-overclaim`, which explicitly *preserved* this FD — that
preservation was the bug). The assertion-hoist variant (`create assertion … not
exists (… b <> a + 1)`) reproduced identically.

## The fix (direction A — producer-side gating, DRY)

Extracted `foldSingleSingleGated(fds, producerFds, keyProbeFds, colCount, { skipGuarded })`
into `fd-utils.ts` (next to `isSuperkey`). It gates **every** single↔single
`{a}→{b}` FD on endpoint-superkey-ness against `keyProbeFds`, dropping it unless `a`
or `b` is a superkey there. Non-single↔single FDs (`∅→col`, multi-dependent key FDs)
pass through. The gate keys off the FD **shape**, never the `valueEquality` marker.

- `reference.ts`: deleted `foldGatedProducerFds`; both call sites now use
  `foldSingleSingleGated(…, realKeyFds, colCount, { skipGuarded: true })`.
  `skipGuarded: true` passes guarded FDs through untouched (they are gated later at
  Filter activation, sites 7/8). `isSuperkey` import dropped (now only referenced in
  a prose comment).
- `filter.ts`: the inline predicate-FD gate loop (the site-4 gate) is now
  `foldSingleSingleGated(fds, predFds, inputFds, colCount)` (no `skipGuarded` — filter
  `predFds` are already unguarded). `addFd` import dropped (no longer used there).
- The EC merge in both callers stays unconditional (unchanged), so `check (a = b)`'s
  equiv pair still merges; `check (b = a + 1)` has no equiv pair anyway.

This is the same producer-side-gating strategy shipped by all sibling tickets.

## Tradeoff (accepted, documented — REVIEW FOCUS)

The fix **drops the true one-way `{a}→{b}` on non-keyed tables** — an *under-claim*
(always sound) that loses the FD for any consumer that legitimately used it when the
output is NOT projected narrowly (e.g. ordering / cache reasoning). This matches
every sibling ticket. The heavier reader-side alternative (**direction B**: at
`fd-utils.ts` `isUnique`'s proper-subset closure branch, only treat a
closure-covering determinant as a key when the determinant is *itself* independently
unique) was repeatedly flagged and deferred across the sibling tickets and is **NOT
in scope** here. If the team wants the FD preserved long-term, file a separate design
ticket for (B). The full test sweep surfaced **no** FD/key-consumer regression from
the under-claim (ordering, cache, lens-put, binding-extractor all green).

## Use cases to validate

**Wrong-results repros (DISTINCT must SURVIVE, correct row counts):**
- `select distinct a, b from te` where `te(a,b,c, check (b = a + 1))` no PK → 2 rows.
- assertion-hoist twin: `create assertion … not exists (select 1 from teoh where b <> a + 1)` → 2 rows.

**Controls (DISTINCT must still be ELIMINATED — soundness preserved when key is real):**
- `create table teopk (a integer primary key, b integer, check (b = a + 1))` →
  `select distinct a, b from teopk` eliminates DISTINCT (`{a}→{b}` sound, `a` is the key).
- Sites 1–8 + their controls (bi-FD, join, filter, guard-activation) all still pass.

**FD-presence unit assertions (the reconciled regression guard):**
- `check (b = a + 1)` on an **id-PK** table → one-way FD `a→b` is **gated away** (absent
  from TableReference physical fds, since neither a nor b is a key).
- `check (b = a + 1)` on an **a-PK** table → FD `a→b` is **present** (a is the real key).
- Producer-only extraction still emits the FD: `extractCheckConstraints` unit test for
  `check (b = a + 1)` is unchanged (the FD is *emitted*, just *gated at the fold*).

## Tests added / changed

- `fd-derived-key-bag-overclaim.spec.ts`: added **site 9** (CHECK, repro+control) and
  **site 9b** (assertion-hoist) + extended the header doc-comment. Tables `teo`/`teopk`/
  `teoh` added to the `beforeEach` schema.
- `optimizer/check-derived-fds.spec.ts`: the old single-arm `:275` guard ("exposes FD
  a → b" on an id-PK table) **flipped** — it now asserts the FD is **gated away** on the
  id-PK table, plus a **companion** asserting it is **present** on an a-PK table (two-arm,
  pins both sides of the gate).
- `property.spec.ts` (Key Soundness differential): added a third generative table
  `tc(a,b,c, check (b = a + 1))` (no PK) and the shape `select distinct a, b from tc`,
  threaded `rowArbC`/`rowsC` through `createTables`/`seedTables` and all three properties
  (Tier-1 result-node, Tier-2 isolated-node, singleton-equivalence). `rowArbC` derives
  `b = a + 1` so inserts satisfy the CHECK; seeding dedups on `(a,c)` because the no-PK
  table has an implicit all-columns key (exact-dup rows would collide) while still
  repeating `a` across distinct `c`. This is exactly the wrong-results class the
  differential catches — without the fix the eliminated DISTINCT surfaces duplicate `a`
  and reds the soundness check.

## Validation run (all green this implement pass)

- `yarn typecheck` — clean.
- `fd-derived-key-bag-overclaim.spec.ts` + `optimizer/check-derived-fds.spec.ts` — 46 passing.
- FD-consumer sweep `fd-propagation` + `rule-orderby-fd-pruning` + `lens-put-fanout` +
  `binding-extractor` — 128 passing.
- `property.spec.ts` — 223 passing.
- Full `yarn workspace @quereus/quereus test` — **5527 passing, 9 pending**.
- `yarn workspace @quereus/quereus lint` — clean.
- NOT run (memory-backed default only): `yarn test:store` / `test:full` — no store-specific
  surface touched here (pure planner FD logic); reviewer may run if desired.

## Docs

`docs/optimizer.md` Check-derived contributions table: the `col = <expr>` (single-col
RHS) row's "**Known over-claim**" note replaced with the gated/fixed behavior, noting
both single↔single shapes now share one producer gate (`foldSingleSingleGated`).

## Suggested reviewer attention

- **`foldSingleSingleGated` unification correctness.** Confirm the shared helper is a
  faithful merge of the two prior gates: the only intended differences are (a) the
  key-probe set (`realKeyFds` snapshot for reference vs source `inputFds` for filter)
  and (b) `skipGuarded` (reference must pass guarded FDs through untouched; filter
  predFds are never guarded). Verify guarded-FD pass-through at the TableReference is
  not regressed (sites 7/8 depend on it — they pass).
- **The accepted under-claim.** Decide whether losing the true one-way FD on non-keyed
  tables warrants the direction-B follow-up design ticket, or is acceptable as-is
  (consistent with all siblings).
