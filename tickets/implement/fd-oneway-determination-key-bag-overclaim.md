description: Gate the one-way single↔single producer FD `{a}→{b}` (from `check (b = a + 1)` or a hoisted assertion) at `TableReferenceNode.computePhysical` on endpoint-superkey-ness, so a narrow `select distinct a, b` over a non-keyed table no longer re-derives `{a}` as a phantom key and drops a REQUIRED DISTINCT (wrong results). Fix verified: broaden `foldGatedProducerFds` to gate EVERY unguarded single↔single FD (drop the `equivPairs`-membership precondition), mirroring the filter gate.
prereq:
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/check-derived-fds.spec.ts, docs/optimizer.md
----

## Confirmed bug (wrong results) — reproduced this run

```sql
create table te (a integer, b integer, c integer, check (b = a + 1));
insert into te values (1, 2, 10), (1, 2, 20), (3, 4, 30);
select distinct a, b from te;
--   RETURNS 3 rows: (1,2), (1,2), (3,4)   -- WRONG (DISTINCT eliminated)
--   CORRECT is 2 rows: (1,2), (3,4)
```

Reproduced via a throwaway spec this run: `findNodes(plan, DistinctNode).length > 0`
fails (DISTINCT eliminated) and the query returns 3 rows. The **assertion-hoist** variant
(`create assertion check (not exists (select 1 from teh where b <> a + 1))` over a no-PK
table) reproduces identically. The **PK control** (`create table tep (a integer primary key,
b integer, check (b = a + 1))`) correctly eliminates the DISTINCT — so the fix must keep the
control passing.

### Mechanism (verified — reference.ts:36-93, 212)

`check (b = a + 1)` → `handleEquality(left=b, right=a+1)` (`check-extraction.ts:180-194`,
the `lIdx` single-column-RHS branch): emits the **one-way** FD `{determinants:[a],
dependents:[b]}` and **no** equiv pair (equiv pairs are pushed only on the `col = col`
branch, `check-extraction.ts:172-178`). `TableReferenceNode.computePhysical` folds it via
`foldGatedProducerFds` (`reference.ts:212`), whose gate skips an FD **only** when its
unordered pair is in the producer's `equivPairs` (`reference.ts:81`). The one-way FD has no
equiv pair, so it folds **unconditionally** — no endpoint-superkey test. `select distinct
a, b` then projects to the 2-col output; `projectFds` carries `a→b` across; on the narrow
output `closure({a}) = {a,b} =` all cols, so `isUnique`'s proper-subset closure branch
(`fd-utils.ts:840`) returns true, `keysOf` reports `{a}` a key, and
`rule-distinct-elimination` drops the DISTINCT — but `{a}` is **not** unique (`a=1` repeats).

Contrast the **filter** gate (`filter.ts:125-135`), which gates **every** single↔single FD
on endpoint-superkey-ness regardless of `equivPairs`. The table-reference gate diverged by
adding the `equivPairs` precondition, and that divergence is exactly this hole. (Documented
gap #4 of the sibling `fd-check-assertion-key-bag-overclaim` ticket, which scoped itself to
the bi-directional shape and explicitly preserved this one-way FD — that preservation is
the bug.)

## Fix — verified working this run (direction A)

Broaden `foldGatedProducerFds` (`reference.ts:61-93`) so the endpoint-superkey gate applies
to **every** unguarded single↔single `col→col` FD, dropping the `equivPairKeys.has(...)`
precondition. With that change applied and the temp specs run:

- repro `select distinct a, b from te` → DISTINCT survives, 2 rows ✓ (CHECK + assertion-hoist)
- PK control → DISTINCT eliminated ✓
- **all of `fd-derived-key-bag-overclaim.spec.ts` sites 1–8 + controls pass** ✓
- the ONLY failure is the regression guard `check-derived-fds.spec.ts:275` — expected (see below).

The `equivPairs` param becomes unused after the change. Two options:
- minimal: drop the `equivPairs` param + `equivPairKeys` Set from `foldGatedProducerFds` and
  its two call sites (`reference.ts:212`, `reference.ts:235`); update the JSDoc
  (`reference.ts:36-60`) which currently describes gating "the over-claiming bi-directional
  value-equality pair" — it now gates **all** single↔single FDs, so the bi-FD-specific prose
  is stale.
- DRY (preferred if clean): the gate body is now identical to the filter gate
  (`filter.ts:125-135`) modulo (1) the key-probe FD set (reference uses the declared-key
  snapshot `realKeyFds`; filter uses source `inputFds`) and (2) reference must **skip**
  guarded FDs (`fd.guard === undefined` — guarded FDs pass through untouched until Filter
  activation), whereas filter's `predFds` are already activated/unguarded. Consider extracting
  a shared `foldSingleSingleGated(fds, producerFds, keyProbeFds, colCount, { skipGuarded })`
  in `fd-utils.ts` used by both. Keep the guard-skip difference explicit; do not regress the
  guarded-FD pass-through (sites 7/8 rely on guarded FDs surviving to the Filter).

**Tradeoff (accept):** this DROPS the true one-way `a→b` on non-keyed tables — an under-claim
(always sound) that loses the FD for any consumer that legitimately used it when NOT projected
narrowly (e.g. ordering/cache reasoning). This matches the shipped strategy of all sibling
tickets (producer-side gating). The heavier reader-side alternative (B: only treat a
closure-covering determinant as a key when the determinant is itself independently unique, at
`fd-utils.ts:840`) was repeatedly flagged and deferred across the sibling tickets; it is NOT
in scope here. If the team wants the FD preserved long-term, file a separate design ticket for
(B) — do not attempt it in this ticket.

## Regression guard to reconcile (REQUIRED)

`check-derived-fds.spec.ts:275` ("table with check (b = a + 1): TableReference exposes FD
a → b") uses `create table t (id integer primary key, a integer, b integer, check (b = a + 1))`.
`id` is the PK, so neither `a` nor `b` is a key ⇒ under the fix the one-way FD `a→b` is
**correctly gated/dropped**, and this test fails (verified this run — it was the sole failure).
Re-point it to assert the **sound, gated** behavior. Two acceptable rewrites:
- assert that on the `id`-PK table the FD `a→b` is **absent** (gated away), AND add a companion
  using `create table t (a integer primary key, b integer, check (b = a + 1))` asserting the FD
  `a→b` **is** present (a is the real key ⇒ FD sound). This pins both arms of the gate.
- or simply re-point the existing assertion at the `a`-PK table.

Prefer the two-arm version — it documents the gate, not just the happy path.

## Tests to add — `fd-derived-key-bag-overclaim.spec.ts`

Sites 1–8 already exist (1–4 producers, 5–6 TableReference bi-FD, 7–8 guard activation). Add
**site 9 (unguarded one-way determination FD at the TableReference)** following the existing
repro+control shape:

- site 9 (CHECK): `create table teo (a integer, b integer, c integer, check (b = a + 1))`
  (no PK; `c` only gives distinct full rows). `select distinct a, b from teo` over rows
  `(1,2,10),(1,2,20),(3,4,30)` → DISTINCT survives, 2 rows.
- site 9 control: `create table teopk (a integer primary key, b integer, check (b = a + 1))`
  → DISTINCT eliminated (`a` is the real key ⇒ `{a}→{b}` sound).
- site 9b (assertion-hoist): `create table teoh (a integer, b integer, c integer)` +
  `create assertion eq_h check (not exists (select 1 from teoh where b <> a + 1))` → same
  one-way FD hoisted per-row; DISTINCT survives, 2 rows.

Update the spec's header doc-comment (currently enumerates sites 1–8) to add site 9 and note
it seals the **unguarded** one-way TableReference producer (sites 7/8 sealed the *guard-activated*
one-way at the Filter; this is its non-guarded sibling at the producer).

## Docs

`docs/optimizer.md:1488-1490` (*Check-derived contributions* table):
- the `col = <expr>` (single-col RHS) row at **line 1490** currently carries a "**Known
  over-claim**" note pointing at this ticket — replace with the gated/fixed behavior, mirroring
  the `col1 = col2` row at line 1488 ("folded at the table reference **only when an endpoint is
  a real declared key**, else gated").
- if the JSDoc/helper prose in `reference.ts:36-60` is rewritten, keep the doc's wording
  consistent (gate applies to all single↔single FDs, not just the bi-FD pair).

## Validation sweep

Run after the change; watch for FD/key-consumer regressions (the under-claim of the one-way
FD could in principle affect ordering/cache reasoning that consumed it):
- `fd-derived-key-bag-overclaim.spec.ts` (sites 1–9 + controls)
- `optimizer/check-derived-fds.spec.ts` (the reconciled guard + the unit `check (b = a + 1)`
  extraction test at the bottom, which is producer-only and should still pass — the FD is still
  *emitted* by `check-extraction`, just gated at the *fold*)
- `fd-propagation.spec.ts`, `rule-orderby-fd-pruning.spec.ts`, `lens-put-fanout.spec.ts`,
  `binding-extractor.spec.ts`
- the `property.spec.ts` "Key Soundness" differential — this is exactly the wrong-results
  class it catches; consider adding a `check (b = a + 1)` + projection + DISTINCT shape to
  strengthen it.
- Full `yarn workspace @quereus/quereus test` + `yarn lint` (Windows: single-quote lint globs).

## TODO

- Broaden `foldGatedProducerFds` (`reference.ts`) to gate every unguarded single↔single FD on
  endpoint-superkey-ness vs `realKeyFds`; drop the `equivPairKeys` precondition. Either remove
  the now-unused `equivPairs` param + both call-site args, or extract a shared
  `foldSingleSingleGated` helper in `fd-utils.ts` reused by `filter.ts` (preserve filter's
  `inputFds` probe and reference's guarded-FD skip).
- Rewrite the `foldGatedProducerFds` JSDoc (`reference.ts:36-60`) to describe gating all
  single↔single FDs (not just the bi-FD value-equality pair).
- Reconcile `check-derived-fds.spec.ts:275` — assert gated (FD absent) on the `id`-PK table and
  present on an `a`-PK table.
- Add site 9 (+ 9 control + 9b assertion-hoist) to `fd-derived-key-bag-overclaim.spec.ts` and
  extend its header doc-comment.
- Update `docs/optimizer.md:1490` (replace the "Known over-claim" note with the gated behavior).
- Run the validation sweep above; `yarn workspace @quereus/quereus test` + `yarn lint` green.
