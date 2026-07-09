---
description: Grouping operations (GROUP BY, window partitions, two join strategies) used to ignore text-sorting rules an application taught the database, so rows the application considered equal landed in different groups; they now use the application's rule, and a rule that cannot group raises a clear error instead of guessing.
files:
  - packages/quereus/src/types/logical-type.ts            # new KeyNormalizer / KeyNormalizerResolver types
  - packages/quereus/src/core/database.ts                 # new getKeyNormalizerResolver(); _getCollationNormalizer fallback removed
  - packages/quereus/src/core/database-internal.ts        # getKeyNormalizerResolver() on the internal facade
  - packages/quereus/src/runtime/emission-context.ts      # new resolveKeyNormalizer(), records the collation dependency
  - packages/quereus/src/runtime/emit/hash-aggregate.ts   # converted call site
  - packages/quereus/src/runtime/emit/window.ts           # converted call site
  - packages/quereus/src/runtime/emit/bloom-join.ts       # converted call site
  - packages/quereus/src/runtime/emit/asof-scan.ts        # converted call site
  - packages/quereus/src/util/key-serializer.ts           # resolveKeyNormalizer re-documented as builtins-only
  - packages/quereus/src/index.ts                         # exports the two new types
  - packages/quereus-isolation/src/isolated-table.ts      # stale NOTE refreshed (comment only)
  - packages/quereus/test/collation-key-normalizer.spec.ts        # new spec (11 tests)
  - packages/quereus/test/collation-normalizer.spec.ts             # fallback assertion flipped; resolver tests added
  - packages/quereus/test/mv-custom-collation-maintenance.spec.ts  # previously-unreachable aggregate-residual case now covered
  - packages/quereus/test/materialized-view-replicable.spec.ts     # MYLOCALE now registered with a normalizer (see below)
  - docs/sql.md                                            # "Grouping caveat — hash keys" rewritten
  - docs/plugins.md                                        # normalizer requirement now covers grouping, not only indexes
difficulty: medium
---

# Row-grouping key normalizers resolve against the database's collation registry

## What changed

Four emitters that bucket rows by a serialized text key — the **hash** aggregate
(`GROUP BY`), window `PARTITION BY`, the bloom/hash join, and `AS OF` partitioning — were
calling `util/key-serializer.ts#resolveKeyNormalizer`, which knows only the *built-in*
meanings of `BINARY` / `NOCASE` / `RTRIM` and silently returns the identity normalizer for
anything else. So a collation registered with `db.registerCollation` governed `where`,
`order by`, and `distinct` but not `group by`: the same column in the same connection had
two different notions of equality.

All four now call `EmissionContext.resolveKeyNormalizer()`, which records the collation as
a plan dependency (so re-registering the collation invalidates cached plans, exactly as
`resolveCollation()` already did) and delegates the lookup to a new
`Database.getKeyNormalizerResolver()`. That resolver mirrors `getCollationResolver()`:
lazily bound once for stable identity, reads the live registry, no `checkOpen()`, and
**no silent fallback**.

Resolution rules:

| input | result |
| --- | --- |
| `undefined` or `BINARY` | identity normalizer (fast path; `BINARY` cannot be overridden) |
| registered collation *with* a normalizer | that normalizer |
| registered collation with **no** normalizer | throws `collation X has no key normalizer; grouping and hash-join keys require one — pass { normalizer } to registerCollation` |
| unregistered name | throws `no such collation sequence: X` |

`Database._getCollationNormalizer()` lost its `BUILTIN_NORMALIZERS[upper]` fallback. That
fallback was itself a small bug: an embedder who re-registers `NOCASE` with a custom
comparator and no normalizer got the built-in lowercase normalizer, which does not
partition strings the way the new comparator does — grouping would be confidently wrong
rather than loudly broken. The built-ins are seeded *with* their normalizers in
`registerDefaultCollations()`, so a fresh database loses nothing. The raw accessor now
just reads `collations.get(name)?.normalizer`; `getKeyNormalizerResolver()` owns the
throwing (and distinguishes "unregistered" from "no normalizer").

`util/key-serializer.ts#resolveKeyNormalizer` is intentionally left as-is, re-documented
as the builtins-only lookup (the analog of `builtinCollationResolver`) with a `NOTE:`
naming its two remaining callers — `quereus-store`'s key encoder and
`quereus-isolation/src/isolated-table.ts` — neither of which has a `Database` threaded to
the call site. Both are covered by their own tickets. The stale `NOTE:` in
`isolated-table.ts` (which claimed the engine's hash sites share the divergence) was
refreshed.

## Verification / use cases

Baseline reproduction from the fix ticket, now asserted in
`test/collation-key-normalizer.spec.ts`. Every case registers a length-only `NOCASE`
override (`(a,b) => a.length - b.length`, normalizer `s => 'x'.repeat(s.length)`), which
is the only way to reach a custom comparator today because column DDL still rejects
unknown collation names.

| query | before | after |
| --- | --- | --- |
| `select id from src where k = 'bb'` | `[1, 2]` ✅ | unchanged |
| `select distinct k from src` | `[{k:'aa'}]` ✅ | unchanged |
| `select k, sum(v) from src group by k` | two groups ❌ | one group, `s = 15` |
| `select id, sum(v) over (partition by k)` | `10`, `5` ❌ | both rows `15` |

New spec covers, in order:

- hash aggregate collapses collation-equal group keys (plan asserted to contain `HASHAGGREGATE`);
- streaming aggregate gives the same answer (plan asserted to contain `STREAMAGGREGATE`,
  reached by pre-sorting the source on the group key) — which aggregate the optimizer picks
  is invisible to the user, so the two must agree;
- window `PARTITION BY` puts collation-equal rows in one partition;
- bloom join matches collation-equal keys (plan asserted via `query_plan(...) where properties like '%bloom%'`);
- `AS OF` scan partitions on a collation-equal key (plan asserted to contain `ASOFSCAN`);
- a comparator-only collation used as a `GROUP BY` key raises, naming `CMPONLY`
  (reached through an expression-level `group by k collate cmponly`, since column DDL
  refuses the name);
- a built-in overridden without a normalizer raises the same way, naming `NOCASE`;
- `BINARY` / `NOCASE` / `RTRIM` on a fresh database group exactly as before.

`test/collation-normalizer.spec.ts`: the "falls back to the built-in normalizer" assertion
was flipped (raw accessor → `undefined`, resolver throws), and a
`Database.getKeyNormalizerResolver` block was added covering identity fast path, built-in
lookup, stable identity + live-registry reads, unknown name, and comparator-only.

`test/mv-custom-collation-maintenance.spec.ts`: the header note claiming the
aggregate-residual (`residual-recompute`) maintenance arm was unreachable through SQL is
gone; it is now covered end-to-end. `insert (1,'aa',10)` then `insert (2,'bb',5)` into an
aggregate maintained table binds group key `'bb'`, and the key-filtered residual recomputes
a row keyed `'aa'` — collation-equal, byte-different. A byte comparison would drop that row
and leave the backing sum stale.

## Deliberate behavior change worth a reviewer's eye

`test/materialized-view-replicable.spec.ts` registered `MYLOCALE` **without** a normalizer,
with a comment asserting that a comparator-only collation "suffices" for the
replicable-collation gate tests. That is no longer true for the one gate test whose body is
`group by c collate MYLOCALE`: materialized-view creation emits the body **before** running
the replicable gate, so the new normalizer resolver now raises `no key normalizer` first,
pre-empting the gate's `cannot be materialized` message. I gave `MYLOCALE` an identity
normalizer (its comparator is exact byte order, so identity is the correct partition) —
`replicable` is orthogonal to the normalizer, and all four gate tests now reach the gate and
assert what they claim to. Both errors are correct; only which one wins changed. If a
reviewer prefers the gate to run before emission, that is a separate ordering change.

## Known gaps (treat the tests as a floor)

- **`RTRIM` was the one built-in whose normalizer disagreed with a naive `trimEnd`** — that
  agreement is covered by the pre-existing probe-set test in `collation-normalizer.spec.ts`,
  not by anything new here. No new corpus was added.
- **No test forces the merge (non-hash) `AS OF` strategy under a custom collation.** The
  partitioned case selects the hash strategy, which is the one that buckets. The merge
  strategy compares with `partitionCollations` (already database-resolved), so it was never
  wrong — but that is reasoned, not asserted.
- **No test asserts plan invalidation** after re-registering a collation mid-session. The
  dependency is recorded the same way `resolveCollation()` records it, and
  `getKeyNormalizerResolver()`'s stable-identity + live-read contract is unit-tested, but
  the end-to-end "re-register, re-run, get the new grouping" path is untested. Note that
  `registerCollation`'s own `NOTE:` says registration is not retroactive for comparators
  built at index/plan-construction time, so the expected behavior here is not obvious.
- **`DISTINCT` and the streaming aggregate were already correct** and are unchanged; the
  streaming-aggregate test only pins that the two aggregates agree.
- **`quereus-store` and `quereus-isolation` still bucket with the builtins-only lookup.**
  Out of scope by ticket; the store caveat in `docs/sql.md` is unchanged and still accurate.

## Validation run

- `yarn test` — all green (6687 + 180 + 86 + 443 + 65 + 31 + 34 + 128 passing across workspaces).
- `yarn lint` — clean.
- `yarn build` — clean.
- `yarn test:store` not run (not required by the ticket; no store code changed).
