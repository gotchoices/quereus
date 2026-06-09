description: A DISTINCT over a narrow projection of a table whose IMPLICATION-form CHECK emits a *one-way* guarded determination FD `{a}→{b} [g]` returns WRONG results once the filter activates the guard. `check (status <> 'active' or b = a + 1)` makes `recognizeGuardedBody` emit the one-way guarded FD `{a}→{b} [g]` (single-column-expression RHS branch — NOT tagged `valueEquality`, no equiv pair). `FilterNode.activateGuardedFds` strips the guard when the predicate entails it, but the bi-directional gate added by `fd-guarded-activation-key-bag-overclaim` only gates `valueEquality`-tagged single↔single FDs, so the one-way `{a}→{b}` activates UNGATED. A subsequent key-dropping projection (`select distinct a, b`) makes `closure({a}) = {a,b} =` all output columns, `isUnique`'s proper-subset closure branch (`fd-utils.ts:840`) reports `{a}` unique, `keysOf` returns it, and `rule-distinct-elimination` drops the REQUIRED DISTINCT — leaking duplicate rows. This is the **guard-activation analogue** of the open `fd-oneway-determination-key-bag-overclaim` ticket (which covers the same one-way shape at the unguarded `TableReferenceNode` site). Same bag-as-set over-claim class as `fd-derived-key-bag-overclaim`, `fd-check-assertion-key-bag-overclaim`, and `fd-guarded-activation-key-bag-overclaim` (which sealed only the *bi-directional* guard-activation producer). Confirmed during the `fd-guarded-activation-key-bag-overclaim` IMPLEMENT stage with a throwaway spec (3 rows instead of 2; DISTINCT eliminated). PRE-EXISTING: before the bi-directional gate landed, `activateGuardedFds` stripped ALL guarded FDs unconditionally, so this one-way activation has always over-claimed — the bi-directional fix simply did not (and was not scoped to) close it.
prereq: fd-oneway-determination-key-bag-overclaim
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/conditional-fds.spec.ts, docs/optimizer.md
----

## Confirmed bug (wrong results)

```sql
create table t (id integer primary key, a integer, b integer, status text,
    check (status <> 'active' or b = a + 1));
insert into t values (1, 1, 2, 'active'), (2, 1, 2, 'active'), (3, 3, 4, 'active');

select distinct a, b from t where status = 'active';
--   RETURNS 3 rows: (1,2), (1,2), (3,4)   -- DISTINCT eliminated
--   CORRECT answer is 2 rows: (1,2), (3,4) -- the duplicate (1,2) must dedup
```

Reproduced during the `fd-guarded-activation-key-bag-overclaim` IMPLEMENT stage with a
throwaway spec (`_tmp_oneway_probe.spec.ts`, then deleted): `findNodes(plan,
DistinctNode).length === 0` (DISTINCT eliminated) and the query returns 3 rows.

`id` (the PK) only exists so the rows have distinct *full* tuples (Quereus' implicit
all-columns key forbids two identical rows); the PK is projected away by `select a, b`,
so the only output-covering key claim is the phantom `{a}`.

### Mechanism (verified)

`check (status <> 'active' or b = a + 1)` is an implication-form CHECK:
`handleImplication` recognizes the guard `status = 'active'` and calls
`recognizeGuardedBody(body = b = a + 1, guard)` (`check-extraction.ts`). Because the RHS
`a + 1` is a single-column **expression** (not a bare column), the
`if (lIdx !== undefined && rIdx !== undefined)` value-equality branch is skipped; the
`if (lIdx !== undefined)` branch emits the **one-way** guarded FD
`{determinants:[a], dependents:[b], guard}` with **no** `valueEquality` tag (that tag is
set only on the `col = col` mirror pair) and no equiv pair.

`FilterNode.computePhysical` → `activateGuardedFds` (`filter.ts`): when the predicate
`status = 'active'` entails the guard, the FD is `stripGuard`-ed to an unconditional
`{a}→{b}`. The gate added by `fd-guarded-activation-key-bag-overclaim` only fires for
`fd.valueEquality === true` single↔single FDs, so this one-way FD bypasses the gate and
folds unconditionally.

`select distinct a, b` projects to the 2-column `(a, b)` output. `projectFds` carries the
ungated `{a}→{b}` across; on the narrow output `closure({a}) = {a,b} =` all cols, so
`isUnique`'s proper-subset closure branch (`fd-utils.ts:840`) returns true, `keysOf`
reports `{a}` as a key, and `rule-distinct-elimination` (eliminate iff
`keysOf(source).length > 0`) drops the DISTINCT. But `{a}` is **not** unique among the
rows (`a = 1` repeats), so the duplicate `(1, 2)` leaks.

## Expected behavior

`select distinct a, b from t where status = 'active'` must return 2 rows — the DISTINCT
must survive whenever neither endpoint of the activated one-way determination FD is a
genuine key. The control (an endpoint that IS a real key) must still eliminate the
DISTINCT:

```sql
-- control: a is the PK ⇒ {a} is a genuine key ⇒ a→b is sound ⇒ DISTINCT eliminated
create table tp (a integer primary key, b integer, status text,
    check (status <> 'active' or b = a + 1));
insert into tp values (1, 2, 'active'), (3, 4, 'active'), (5, 6, 'active');
select distinct a, b from tp where status = 'active';   -- DISTINCT correctly eliminated
```

## Fix direction (for the implement stage — not prescriptive)

This is the guard-activation twin of `fd-oneway-determination-key-bag-overclaim`'s
TableReference hole, and shares its completeness tradeoff and test sweep — handle the two
**together** (a single gate-broadening decision should cover both sites). Hence the
`prereq:` on that ticket: land its design decision first, then mirror it here.

**Recommended (matches the sibling's option A): broaden `activateGuardedFds`'s gate to
every activated single↔single FD.** The bi-directional fix already isolated the EC lift
behind the `valueEquality` marker, so the change is local and small: gate **all**
single↔single activated FDs on endpoint-superkey-ness against the filter's input keys
(drop the FD when neither endpoint is a superkey), and lift the EC **only** when
`fd.valueEquality === true`. Concretely, in `filter.ts` `activateGuardedFds`, move the
`isSuperkey` gate out from under the `fd.valueEquality === true` guard so it applies to
every `determinants.length === 1 && dependents.length === 1` activated FD, keeping the
`activatedEquivPairs.push` inside the `valueEquality` branch.

**Cost / tradeoff (same as the sibling ticket):** this *drops* a true one-way guarded FD
`{a}→{b}` on a non-keyed table after activation (an under-claim — always sound, but loses
the FD for any consumer that legitimately used it when NOT projected narrowly, e.g.
ordering/cache reasoning), and similarly drops the activated `{a}→{b}` for a 2-column table
with a single partial UNIQUE index on `a` (where `a` IS genuinely unique under the guard —
a completeness loss because `isSuperkey` probes `sourceFds` with guarded FDs skipped).
Both are sound; weigh against the reader-side option (B) below.

**Alternative (the sibling's option B): fix the reader.** A one-way `{a}→{b}` is a true,
useful FD; the deeper defect is that `isUnique`/`deriveKeysFromFds` (`fd-utils.ts:840`)
treat a non-unique determinant whose closure covers all output columns as a *key*. A
reader-side guard (only treat a closure-covering determinant as a key when the determinant
set is itself independently unique) closes ALL sites — the 4 derived sites, both
TableReference sites, AND both guard-activation sites — at once, and would let the
producer-side gates be simplified or removed. Heavier blast radius; sweep all FD/key
consumers. If the sibling ticket chooses (B), this ticket likely collapses into it.

## Validation

- The repro above → 2 rows, DISTINCT survives; the PK control → DISTINCT eliminated.
- Add a "site 8 (one-way guard activation)" repro + control to
  `test/fd-derived-key-bag-overclaim.spec.ts` (extend the existing site 1–7 suite).
- Confirm the bi-directional site-7 tests still pass (the `valueEquality` EC lift must be
  unchanged) and the `conditional-fds.spec.ts` activation test still asserts the EC.
- Sweep one-way-FD consumers for regressions: `fd-propagation.spec.ts`,
  `rule-orderby-fd-pruning.spec.ts`, `binding-extractor.spec.ts`, and the
  `property.spec.ts` "Key Soundness" differential (this is exactly the wrong-results class
  it catches — a guarded `check (… or b = a + 1)` + filter + projection + DISTINCT shape
  would strengthen it).
- Update `docs/optimizer.md`: the `FilterNode` row's guard-activation paragraph currently
  describes only the bi-directional gate; extend it to note one-way guarded determination
  FDs are gated too (once landed).
- Full `yarn workspace @quereus/quereus test` + `yarn lint`.
