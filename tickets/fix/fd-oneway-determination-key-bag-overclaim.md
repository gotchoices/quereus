description: A DISTINCT over a narrow projection of a NON-keyed table whose CHECK (or hoisted assertion) emits a *one-way* single-column determination FD `{a}→{b}` returns WRONG results. `check (b = a + 1)` on a no-PK table makes `TableReferenceNode.computePhysical` fold the one-way FD `a→b` (via `handleEquality`'s single-column-RHS branch — no equiv pair). The `fd-check-assertion-key-bag-overclaim` table-reference gate (`foldGatedProducerFds`) only gates the *bi-directional* value-equality pair (it keys off `equivPairs` membership), so the one-way FD passes through unguarded. A subsequent key-dropping projection (`select distinct a, b`) makes `closure({a}) = {a,b} =` all output columns, `isUnique`'s proper-subset closure branch (`fd-utils.ts:840`) reports `{a}` unique, `keysOf` returns it, and `rule-distinct-elimination` drops the REQUIRED DISTINCT — leaking duplicate rows. Same bag-as-set over-claim class as `fd-derived-key-bag-overclaim` (4 sites + filter gate), `fd-check-assertion-key-bag-overclaim` (the bi-directional TableReference gate), and `fd-guarded-activation-key-bag-overclaim` (guard activation). This is the remaining *one-way* producer at the TableReference. Confirmed during the `fd-check-assertion-key-bag-overclaim` REVIEW stage with a throwaway spec (3 rows instead of 2; DISTINCT eliminated).
prereq:
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/test/optimizer/check-derived-fds.spec.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, docs/optimizer.md
----

## Confirmed bug (wrong results)

```sql
create table te (a integer, b integer, c integer, check (b = a + 1));
insert into te values (1, 2, 10), (1, 2, 20), (3, 4, 30);

select distinct a, b from te;
--   RETURNS 3 rows: (1,2), (1,2), (3,4)
--   CORRECT answer is 2 rows: (1,2), (3,4)   -- the duplicate (1,2) must dedup
```

Reproduced during the `fd-check-assertion-key-bag-overclaim` REVIEW stage with a
throwaway spec (then deleted): `findNodes(plan, DistinctNode).length === 0` (DISTINCT
eliminated) and the query returns 3 rows instead of 2.

Note the `c` column only exists to give the no-PK table distinct *full* rows (Quereus'
implicit all-columns key forbids two identical rows); the bug is independent of it —
even a table that *does* have an unrelated PK exhibits it once the PK is projected away
(`create table te (id integer primary key, a integer, b integer, check (b = a + 1))`
then `select distinct a, b from te` — `id` is dropped, so the only output-covering key
claim is the phantom `{a}`).

### Mechanism (verified)

`check (b = a + 1)` → `handleEquality(left=b, right=a+1)` (`check-extraction.ts:161-211`):
`b` is a column, `a + 1` is a single-column expression, so it emits the **one-way** FD
`{determinants:[a], dependents:[b]}` and **no** equiv pair (the equiv pair is pushed only
on the `col = col` branch, `check-extraction.ts:172-178`). The same one-way FD arises
from a hoisted assertion `create assertion check (not exists (select 1 from te where b <> a + 1))`
(negate `b <> a + 1` → `b = a + 1`).

`TableReferenceNode.computePhysical` folds it through `foldGatedProducerFds`
(`reference.ts:38-90`). That gate skips an FD **only** when its unordered pair is in the
producer's `equivPairs`. The one-way FD has no equiv pair, so the gate's
`equivPairKeys.has(...)` check is false and the FD is folded **unconditionally** — with no
endpoint-superkey test. (This is the `fd-check-assertion-key-bag-overclaim` ticket's
documented gap #4: "only unguarded single↔single FDs whose pair is in `equivPairs`"; that
ticket scoped itself to the *bi-directional* shape and explicitly preserved the one-way FD
as correct — `check-derived-fds.spec.ts:275` is a regression guard asserting `a → b` is
present. That preservation is the bug: the one-way FD over-claims the same phantom key as
the bi-FD.)

`select distinct a, b` projects to the 2-column `(a, b)` output. `projectFds` carries the
ungated `a→b` across; on the narrow output `closure({a}) = {a,b} =` all cols, so
`isUnique`'s proper-subset closure branch (`fd-utils.ts:840`,
`colSet.size < columnCount && isSuperkey(...)`) returns true, `keysOf` reports `{a}` as a
key, and `rule-distinct-elimination` (eliminate iff `keysOf(source).length > 0`) drops the
DISTINCT. But `{a}` is **not** unique among the rows — `a = 1` repeats. Hence the leaked
duplicate `(1, 2)`.

Contrast the **filter** gate (`filter.ts:114-126`), which gates **every** single↔single
FD on endpoint-superkey-ness regardless of `equivPairs` — so `select a, b from t where b = a + 1`
does **not** over-claim. The table-reference gate diverged from the filter gate by adding
the `equivPairs` condition, and that divergence is precisely this hole.

## Expected behavior

`select distinct a, b from te` must return 2 rows — the DISTINCT must survive whenever
neither endpoint of the one-way determination FD is a genuine key of the table. The control
(an endpoint that IS a real key) must still eliminate the DISTINCT:

```sql
-- control: a is the PK ⇒ {a} is a genuine key ⇒ a→b is sound ⇒ DISTINCT eliminated
create table tep (a integer primary key, b integer, check (b = a + 1));
insert into tep values (1, 2), (3, 4), (5, 6);
select distinct a, b from tep;   -- DISTINCT correctly eliminated
```

## Fix direction (for the implement stage — not prescriptive)

Two candidate fixes; pick after weighing the tradeoff and sweeping the test impact.

**(A) Broaden the table-reference gate to match the filter gate.** Drop the `equivPairs`
condition in `foldGatedProducerFds` (`reference.ts`) so *every* unguarded single↔single
`col→col` FD is folded only when an endpoint is a superkey of `realKeyFds` — identical to
`filter.ts:116-126`. This is the smallest, most consistent change and actually **simplifies**
the helper (the `equivPairs` param becomes unused and can be removed; the helper then
mirrors the filter gate 1:1, satisfying DRY — consider extracting one shared
`foldSingleSingleGated(fds, producerFds, keyProbe, colCount)` used by both
`reference.ts` and `filter.ts`). Cost: it *drops* the true one-way FD `a→b` on non-keyed
tables (an under-claim — always sound, but loses the FD for any consumer that legitimately
used it when NOT projected narrowly, e.g. ordering/cache reasoning). Must update the
regression guard `check-derived-fds.spec.ts:275` (it asserts `a→b` present for a table that
*does* have a PK `id` — verify whether `id` makes an endpoint a superkey; for the PK-`id`
shape neither `a` nor `b` is a key, so the FD would now be dropped and the test must change
to assert it is gated, or be re-pointed at a table where `a` is the PK).

**(B) Fix the reader instead of the producer.** A one-way `a→b` is a *true and useful* FD;
the real defect is that `isUnique`/`deriveKeysFromFds` treat a non-unique determinant whose
closure happens to cover all output columns as a *key*. A reader-side guard (only treat a
closure-covering determinant as a key when the determinant set is itself independently
unique) would keep the FD available while closing this AND potentially the sibling sites
without dropping sound FDs. This is the bigger design change the prior tickets repeatedly
flagged at `fd-utils.ts:840` but deferred; if pursued, re-validate that the producer-side
gates (the 4 shipped sites + the bi-directional table-reference gate + the guarded-activation
gate, if landed) are still needed or can be simplified. Heavier blast radius — sweep all
FD/key consumers.

Recommendation: **(A)** for a fast, consistent, sound close that matches the shipped
strategy; open a separate design ticket if (B)'s reader-side approach is preferred long-term.

## Validation

- The repro above → 2 rows, DISTINCT survives; the PK control → DISTINCT eliminated.
- Add a "site 7 (one-way determination FD)" repro + control to
  `test/fd-derived-key-bag-overclaim.spec.ts` (extend the existing site 1–6 suite), plus a
  hoisted-assertion variant (`not exists (… where b <> a + 1)`).
- Reconcile `check-derived-fds.spec.ts:275` ("TableReference exposes FD a → b") with the
  chosen fix — under (A) it must assert the gated outcome (or move to a PK-keyed endpoint).
- Sweep other one-way-FD consumers for regressions: `fd-propagation.spec.ts`,
  `rule-orderby-fd-pruning.spec.ts`, `lens-put-fanout.spec.ts`, `binding-extractor.spec.ts`,
  and the `property.spec.ts` "Key Soundness" differential (this is exactly the wrong-results
  class that differential catches — a `check (b = a + 1)` + projection + DISTINCT shape would
  strengthen it).
- Update `docs/optimizer.md`: the `col = <expr>` (single-col RHS) row in *Check-derived
  contributions* currently carries a "Known over-claim" note pointing at this ticket — replace
  it with the gated/fixed behavior once landed.
- Full `yarn workspace @quereus/quereus test` + `yarn lint`.
