description: `keysOf` derives a spurious unique key from an all-columns-covering FD over a relation that is NOT a set, so the optimizer reads a bag as a set. Confirmed pre-existing on clean HEAD via an injective projection (`select distinct -c_real1, c_real1 from t1` drops its DISTINCT and returns duplicates). Same root cause as the fanning-join over-claim (`4-join-fanning-isset-overclaim`), but reached through a different FD source, so that ticket's join-local fix does not cover it.
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/test/fuzz.spec.ts, packages/quereus/test/lens-fd-contribution.spec.ts
----

## The bug

`keysOf` (`fd-utils.ts`) step 3 (`deriveKeysFromFds`) treats **any** FD whose determinant's
closure covers all columns as proof that the determinant is a unique key. That inference holds
**only in a set**: `X → all_cols` proves rows agreeing on `X` are identical, which makes `X` unique
**iff the relation has no duplicate rows**. In a bag it is unsound. Unlike step 4 (the all-columns
fallback, gated on `isSet`), step 3 is **not** gated, so a bag with an all-covering determination FD
is read as keyed.

## Reproduction (confirmed on clean HEAD — no join, no MV)

```sql
create table t1 (c_text0 text not null primary key, c_real1 real);   -- c_real1 NOT unique, nullable
insert into t1 values ('a', 1.5), ('b', 1.5), ('c', 2.0);

select distinct (- t1.c_real1) as col0, t1.c_real1 as col1 from t1;
```

- Expected: 2 rows (`distinct` of `[(-1.5,1.5),(-1.5,1.5),(-2.0,2.0)]`).
- Actual on clean HEAD: **3 rows** — the `DistinctNode` is eliminated (`findNodes(plan, DistinctNode)`
  is empty).

`ProjectNode.computePhysical` emits a bidirectional FD `{col0} ↔ {col1}` for the injective pair
(`-c_real1` is injective in `c_real1`, both projected — `project-node.ts` injectivePairs, ~lines
216–243). Each direction covers all output columns, so `deriveKeysFromFds` returns `[col0]` and
`[col1]` as keys. But `c_real1` is not unique, so neither derived column is unique — the projection
is a bag, and `Project.getType().isSet` is correctly `false`. `rule-distinct-elimination`
(`keysOf(source).length > 0`) then drops a required DISTINCT.

The fast-check differential `Optimizer Equivalence › distinct elimination produces identical
results` (`test/fuzz.spec.ts`) hits this **intermittently** (random seed; observed seed
`608451939`): `Row count mismatch: 3 (full) vs 2 (restricted) when disabling rules
[distinct-elimination]`.

## Relationship to `4-join-fanning-isset-overclaim`

Same root cause (`deriveKeysFromFds` unsound over a non-set), different FD source:

| | source of the all-covering FD | fixed by |
|---|---|---|
| ticket 4 (fanning join) | a side's PK key FD surviving a fanning join, projected to cover all output cols | drop the unpreserved side's key FDs in `propagateJoinFds` |
| this ticket (injective) | a `ProjectNode` injective bidirectional FD over a non-unique source column | NOT covered by ticket 4 |

There is also a **LEFT/RIGHT-outer analogue** noted in ticket 4: `propagateJoinFds`' `'left'`/`'right'`
cases do `withKeyFds(leftFds.slice())`, unconditionally keeping the preserved side's key FDs even
when an outer join fans that side out — another path to the same bag-read-as-set. Fold it in here.

## The design tension to resolve (why the obvious gate is wrong)

The clean-looking fix — gate `deriveKeysFromFds` (step 3) on `getType().isSet`, like step 4 — is
**unsound to apply blindly** because `isSet` is a *logical, build-time* flag that cannot see
*physical-only* keyed sets. The `lens-fd-contribution.spec.ts` `end-to-end optimizer behavior` test
relies on `select distinct email, label from u where email is not null` being recognised as a set
purely from a physical guarded FD (its `getType().isSet` is `false`); gating step 3 on `isSet` drops
that real key and wrongly retains the DISTINCT. So any fix must distinguish:

- a **genuine uniqueness-bearing** all-covering FD (a declared/enforced unique key, e.g. the
  `email` guarded key) — keep deriving the key; from
- an **incidental determination** all-covering FD that does not assert uniqueness (the injective
  bidirectional pair; a fanning side's projected key FD) — must not yield a key.

The FD representation does not currently carry that distinction, which is why ticket 4 fixes it at
the *producer* (the join, where fan-out is known) rather than at the *reader* (`keysOf`). Candidate
directions to research for this ticket:

- **Producer-side, mirroring ticket 4:** make `ProjectNode` not emit an injective bidirectional FD
  as key-bearing when the underlying source column is not unique (preserve it as a one-directional
  determination if still useful), and close the LEFT/RIGHT-outer fan-out gap in `propagateJoinFds`.
  Keeps `keysOf` untouched; whack-a-mole but each step is local and sound.
- **Reader-side, done properly:** make a reliable set-ness signal available to `keysOf` (e.g. derive
  `isSet` from the surviving source key at `computePhysical` time, or carry a physical set-ness bit),
  then gate step 3 on it. Bigger change; fixes the whole class at once but must not regress the
  email physical-only-set case.

Pick after weighing blast radius; the deep correctness oracle is the existing fuzz differential.

## TODO

- Add a deterministic regression for the injective repro (DISTINCT retained + 2-row result), so the
  flaky fuzz seed is pinned by a stable test.
- Implement the chosen fix; keep `lens-fd-contribution.spec.ts` (email physical-only-set DISTINCT
  elimination) green.
- Close the LEFT/RIGHT-outer fanning FD analogue from ticket 4.
- Run full `yarn test` (the fuzz differential must stop intermittently failing) + plan goldens + lint.
