description: A DISTINCT after a Filter that ACTIVATES an implication-form CHECK's guarded determination FD returns WRONG results. `FilterNode.computePhysical` activates a guarded FD `{a}→{b} [guard=g]` by stripping its guard (`activateGuardedFds` → `stripGuard`) the moment the filter predicate entails `g`, but it does NOT re-gate the now-unguarded bi-directional value-equality pair `{a}↔{b}` against the filter's real keys. The filter's existing endpoint-superkey gate (ticket `fd-derived-key-bag-overclaim`, site 4) covers only predicate-derived FDs (`extractEqualityFds` output), not FDs inherited/activated from the source. So the activated `{a}↔{b}` flows up unguarded; a subsequent key-dropping projection (`select distinct a, b`) makes `{a}` an all-columns-covering FD on the narrow output, `deriveKeysFromFds` reads it as a unique key, and `rule-distinct-elimination` drops the REQUIRED DISTINCT — leaking duplicate rows. Confirmed during the `fd-check-assertion-key-bag-overclaim` implement stage (that ticket flagged this path as an untested adjacent concern and asked the implementer to verify; it reproduces).
prereq:
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts
----

## Confirmed bug (wrong results)

```sql
create table t (id integer primary key, a integer, b integer, status text,
    check (status <> 'active' or a = b));
insert into t values (1, 5, 5, 'active'), (2, 5, 5, 'active'), (3, 7, 7, 'active');

select distinct a, b from t where status = 'active';
--   RETURNS 3 rows: (5,5), (5,5), (7,7)
--   CORRECT answer is 2 rows: (5,5), (7,7)   -- the duplicate (5,5) must dedup
```

Reproduced with a throwaway spec during the `fd-check-assertion-key-bag-overclaim`
implement stage: `findNodes(plan, DistinctNode).length === 0` (DISTINCT eliminated)
and the query returns 3 rows instead of 2.

### Mechanism (verified)

The implication-form CHECK `status <> 'active' or a = b` is recognized by
`handleImplication` / `recognizeGuardedBody` (`check-extraction.ts:269-440`) as the
guarded body `a = b` under guard `status = 'active'`, emitting the **guarded** FDs
`{a}→{b} [guard]` and `{b}→{a} [guard]`. These guarded FDs are correctly inert at the
`TableReferenceNode`: `computeClosure` / `deriveKeysFromFds` skip any FD with a `guard`
(`fd-utils.ts:45,586`), and the `fd-check-assertion-key-bag-overclaim` table-reference
gate deliberately passes guarded FDs through unchanged (they never participate in key
derivation until Filter activation). So nothing over-claims at the base table.

The over-claim appears at the **Filter**. For `where status = 'active'`,
`FilterNode.computePhysical` (`filter.ts:93-101`) calls `activateGuardedFds`, whose
`predicateImpliesGuard` finds the `eq-literal {status,'active'}` guard entailed and
replaces each guarded FD with its unconditional twin via `stripGuard`
(`filter.ts:239-261`, `fd-utils.ts:463-466`). The result is unguarded `{a}→{b}` and
`{b}→{a}` on the Filter's output — **with no endpoint-superkey gate applied**. The
filter's shipped gate (`filter.ts:114-126`) only filters `predFds` (the FDs
`extractEqualityFds` pulls from the filter's *own* `status='active'` predicate, which
here are just `∅→status` + a binding); the activated/inherited FDs bypass it entirely.

`select distinct a, b` then projects to the 2-column `(a, b)` output. `projectFds`
carries the unguarded `{a}→{b}` across; on the narrow output `closure({a}) = {a,b} =`
all cols, so `deriveKeysFromFds` reads `{a}` as a unique key, `keysOf` reports the body
as a set, and `rule-distinct-elimination` drops the DISTINCT. But `{a}` is **not**
unique among the filtered rows — `id` is the PK and `(id=1,a=5,b=5,active)`,
`(id=2,a=5,b=5,active)` are two distinct rows that collapse to the same `(a,b)=(5,5)`.
Hence the leaked duplicate.

This is the SAME reader (`keysOf` → `deriveKeysFromFds`) and the SAME bag-as-set
over-claim class as tickets `fd-derived-key-bag-overclaim` (four producer sites + the
filter consumption gate) and `fd-check-assertion-key-bag-overclaim` (the
TableReference CHECK / assertion-hoist consumption gate). The remaining unsealed
producer is **guard activation** in the Filter.

## Expected behavior

`select distinct a, b from t where status = 'active'` must return 2 rows — the DISTINCT
must survive whenever neither activated endpoint (`a` / `b`) is a genuine key of the
filter's input. The control (an endpoint that IS a real key) must still eliminate the
DISTINCT:

```sql
-- control: a is the PK, so {a} is a genuine key ⇒ {a}↔{b} is sound ⇒ DISTINCT eliminated
create table tg (a integer primary key, b integer, status text,
    check (status <> 'active' or a = b));
insert into tg values (1, 1, 'active'), (2, 2, 'active'), (3, 3, 'active');
select distinct a, b from tg where status = 'active';   -- DISTINCT correctly eliminated, 3 rows
```

## Fix direction (for the implement stage — not prescriptive)

Mirror the four shipped gates and the table-reference gate at the **activation site**:
when `activateGuardedFds` strips a guard off a bi-directional single↔single
determination FD `{a}↔{b}`, fold the unconditional twin only when one endpoint is a
superkey of the filter's **input** keys (the source FDs as they stand *before* the
predicate-derived equality FDs are added — the same `inputFds`/`colCount` probe the
filter site already computes at `filter.ts:114-115`). The hard part is distinguishing
the over-claiming bi-pair from a legitimate one-way activated FD (e.g. a guarded body
`b = a + 1` activates to a sound one-way `a → b`): the table-reference gate used the
producer's `equivPairs` as the authoritative value-equality marker, but `recognizeGuardedBody`
(`check-extraction.ts:390-440`) does **not** emit equiv pairs for guarded bodies. So the
activation gate must detect the bi-pair structurally — e.g. "both `{a}→{b}` and
`{b}→{a}` are present in the activated set with the same (now-stripped) guard
identity" (the mirror-FD signal the table-reference ticket noted as the equivalent
fallback), or thread a value-equality marker through the guard. Keep any EC the
activation implies sound/unconditional (ECs are not read by `keysOf`).

Also re-examine the `isUnique` closure branch (`fd-utils.ts:840`,
`colSet.size < columnCount && isSuperkey(...)`) once the activation gate lands — it is
the soundness-critical reader that turned the leaked FD into an eliminated DISTINCT, and
the `fd-check-assertion-key-bag-overclaim` ticket also flagged it as untested. Confirm
it needs no change beyond the producer-side gate (the four prior sites + the
table-reference + this activation gate should all keep their over-claims out of the FD
set, leaving the closure reader sound by construction).

## Validation

- The repro above → 2 rows, DISTINCT survives; the PK control → DISTINCT eliminated.
- Add these as a "site 7 (guarded activation)" repro + control to
  `test/fd-derived-key-bag-overclaim.spec.ts` (extend the existing suite, matching
  sites 4–6).
- Confirm the existing guard-activation tests still pass (a legitimate one-way activated
  FD must NOT be dropped) — sweep `fd-propagation.spec.ts`, `check-derived-fds.spec.ts`,
  partial-unique guard-activation tests, and the `property.spec.ts` Key Soundness
  differential (this is exactly the wrong-results class that differential catches; a
  guarded-implication + filter + DISTINCT shape would strengthen it).
- Full `yarn workspace @quereus/quereus test` + lint.
