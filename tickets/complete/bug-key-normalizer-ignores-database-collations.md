----
description: Grouping operations (GROUP BY, window partitions, two join strategies) used to ignore text-sorting rules an application taught the database, so rows the application considered equal landed in different groups; they now use the application's rule, and a rule that cannot group raises a clear error instead of guessing.
files:
  - packages/quereus/src/types/logical-type.ts            # new KeyNormalizer / KeyNormalizerResolver types
  - packages/quereus/src/core/database.ts                 # new getKeyNormalizerResolver(); _getCollationNormalizer fallback removed
  - packages/quereus/src/core/database-internal.ts        # getKeyNormalizerResolver() on the internal facade
  - packages/quereus/src/runtime/emission-context.ts      # new resolveKeyNormalizer(), records the collation dependency
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # review: new hashKeyCollationName() + strict text-capability test
  - packages/quereus/src/runtime/emit/hash-aggregate.ts   # converted call site
  - packages/quereus/src/runtime/emit/window.ts           # converted call site
  - packages/quereus/src/runtime/emit/bloom-join.ts       # converted call site
  - packages/quereus/src/runtime/emit/asof-scan.ts        # converted call site
  - packages/quereus/src/util/key-serializer.ts           # resolveKeyNormalizer re-documented as builtins-only
  - packages/quereus/src/index.ts                         # exports the two new types
  - packages/quereus-isolation/src/isolated-table.ts      # stale NOTE refreshed (comment only)
  - packages/quereus/test/collation-key-normalizer.spec.ts        # new spec (21 tests)
  - packages/quereus/test/collation-normalizer.spec.ts             # fallback assertion flipped; resolver tests added
  - packages/quereus/test/mv-custom-collation-maintenance.spec.ts  # previously-unreachable aggregate-residual case now covered
  - packages/quereus/test/materialized-view-replicable.spec.ts     # MYLOCALE now registered with a normalizer
  - docs/sql.md                                            # "Grouping caveat — hash keys" rewritten
  - docs/plugins.md                                        # normalizer requirement now covers grouping, not only indexes
  - docs/window-functions.md                               # review: partitioning normalizer source corrected
difficulty: medium
----

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
a plan dependency and delegates the lookup to a new `Database.getKeyNormalizerResolver()`.
That resolver mirrors `getCollationResolver()`: lazily bound once for stable identity,
reads the live registry, no `checkOpen()`, and **no silent fallback**.

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
`registerDefaultCollations()`, so a fresh database loses nothing.

Added during review: a key whose operand types **can never hold text** never consults its
collation, so it does not need a normalizer. `hashKeyCollationName()` (in
`planner/analysis/comparison-collation.ts`) drops such an inert collation name before the
resolver sees it. Without it, `group by n` over `n integer collate nocase` raised — see
*Review findings*.

`util/key-serializer.ts#resolveKeyNormalizer` is intentionally left as-is, re-documented as
the builtins-only lookup (the analog of `builtinCollationResolver`) with a `NOTE:` naming
its two remaining callers — `quereus-store`'s key encoder and
`quereus-isolation/src/isolated-table.ts` — neither of which has a `Database` threaded to
the call site. Both are now tracked by their own tickets.

## Verification / use cases

Baseline reproduction from the fix ticket, asserted in
`test/collation-key-normalizer.spec.ts`. Every case registers a length-only `NOCASE`
override (`(a,b) => a.length - b.length`, normalizer `s => 'x'.repeat(s.length)`), which is
the only way to reach a custom comparator today because column DDL still rejects unknown
collation names.

| query | before | after |
| --- | --- | --- |
| `select id from src where k = 'bb'` | `[1, 2]` ✅ | unchanged |
| `select distinct k from src` | `[{k:'aa'}]` ✅ | unchanged |
| `select k, sum(v) from src group by k` | two groups ❌ | one group, `s = 15` |
| `select id, sum(v) over (partition by k)` | `10`, `5` ❌ | both rows `15` |

The spec covers, in order:

- hash aggregate collapses collation-equal group keys (plan asserted to contain `HASHAGGREGATE`);
- streaming aggregate gives the same answer (plan asserted to contain `STREAMAGGREGATE`) —
  which aggregate the optimizer picks is invisible to the user, so the two must agree;
- window `PARTITION BY` puts collation-equal rows in one partition;
- bloom join matches collation-equal keys (plan asserted via `query_plan(...) where properties like '%bloom%'`);
- `AS OF` scan partitions on a collation-equal key (plan asserted to contain `ASOFSCAN`);
- a comparator-only collation used as a `GROUP BY` key raises, naming `CMPONLY`;
- a built-in overridden without a normalizer raises the same way, naming `NOCASE`;
- **(review)** an inert collation over an `INTEGER` / `BLOB` key does *not* raise, for
  `GROUP BY`, window `PARTITION BY`, and the bloom join;
- **(review)** a `TEXT` key alongside an inert `INTEGER` one still raises;
- **(review)** a `JSON` key still normalizes (its value can be a text string) and still
  raises under a comparator-only collation; an `ANY` key likewise;
- **(review)** re-registering a collation changes the grouping of a statement prepared afterward;
- `BINARY` / `NOCASE` / `RTRIM` on a fresh database group exactly as before.

`test/collation-normalizer.spec.ts`: the "falls back to the built-in normalizer" assertion
was flipped (raw accessor → `undefined`, resolver throws), and a
`Database.getKeyNormalizerResolver` block was added covering identity fast path, built-in
lookup, stable identity + live-registry reads, unknown name, and comparator-only.

`test/mv-custom-collation-maintenance.spec.ts`: the header note claiming the
aggregate-residual (`residual-recompute`) maintenance arm was unreachable through SQL is
gone; it is now covered end-to-end.

## Deliberate behavior change worth knowing about

`test/materialized-view-replicable.spec.ts` registered `MYLOCALE` **without** a normalizer.
That is no longer viable for the one gate test whose body is `group by c collate MYLOCALE`:
materialized-view creation emits the body **before** running the replicable gate, so the new
resolver raises `no key normalizer` first, pre-empting the gate's `cannot be materialized`
message. `MYLOCALE` was given an identity normalizer (its comparator is exact byte order, so
identity is the correct partition). Both errors are correct; only which one wins changed. If
the gate should run before emission, that is a separate ordering change.

## Review findings

Reviewed the implement-stage diff (`4f30a31c`) fresh before reading the handoff, then
ran `yarn lint`, `yarn build`, `yarn test`, and a set of throwaway probe specs exercising
the new error path against non-text, JSON, `ANY`, and re-registration cases.

### Checked and clean

- **Coverage of the conversion is complete.** Grepped every `serializeKey` /
  `serializeRowKey` / `serializeKeyNullGrouping` caller in `packages/quereus/src`: the four
  converted emitters are the only engine sites that bucket by a serialized string key.
  `DISTINCT` (`emit/distinct.ts`), set operations, and the streaming aggregate compare with
  comparators and were never affected.
- **The `BINARY` fast path's precondition holds.** `registerCollation` rejects `BINARY`
  (`MisuseError`), so the exact-name fast path in both `EmissionContext.resolveKeyNormalizer`
  and `Database.getKeyNormalizerResolver` cannot be bypassed. Lowercase `binary` misses the
  fast path but resolves correctly through the registry (`normalizeCollationName` uppercases).
- **Removing the `BUILTIN_NORMALIZERS` fallback is safe.** `_getCollationNormalizer` has no
  callers outside `getKeyNormalizerResolver` and its own tests; the built-ins are seeded with
  their normalizers in `registerDefaultCollations()`.
- **`effectiveCollationOfTypes` returns a normalized (uppercase) name** and `'BINARY'` when
  no operand contributes, so the two join emitters hit the fast path for ordinary keys.
- **Docs.** `docs/sql.md`, `docs/plugins.md` (including its new anchor), `docs/schema.md`, and
  `docs/design-isolation-layer.md` were each read against the new reality. The store caveats in
  `schema.md` / `sql.md` remain accurate — no store code changed.

### Found and fixed in this pass

- **False rejection on keys that can never hold text** (`comparison-collation.ts`,
  four emit sites). `group by n` over `n integer collate nocase`, with `NOCASE` overridden
  comparator-only, raised `collation NOCASE has no key normalizer` — as did a bloom join on
  two such integer columns, and a window `PARTITION BY` on one. A normalizer is only ever
  applied to a *string* value (`appendValue` tags numerics, blobs, and JSON objects without
  consulting it), so the collation is inert on such a key and the error was spurious: a query
  that worked before this ticket now failed. Reproduced against `create table t (n integer
  collate nocase)`, which DDL accepts. Fixed by resolving the name through a new
  `hashKeyCollationName(collationName, operandTypes)`, which returns `undefined` — hence the
  identity normalizer — when no operand type can hold text. Both sides of a join key are
  checked, since build and probe share one normalizer array.
- **A JSON key must keep its normalizer.** The obvious way to write the above gate is to
  reuse the existing `isNonTextualLogicalType`, which tests `physicalType !== TEXT`. That
  classifies `JSON` (physical `OBJECT`) as non-textual — but `JSON_TYPE.parse` passes a JSON
  scalar string straight through, so `'"Bob"'` stores the ordinary string `Bob`. Using it
  would have made `group by j collate nocase` return two groups where it previously returned
  one: a silent wrong answer, the exact bug this ticket set out to fix, reintroduced for JSON
  columns. Caught by probe before landing. The gate instead uses an allow-list over the
  physical representation (`INTEGER`, `REAL`, `BLOB`, `BOOLEAN` are provably never strings),
  mirroring `columnCanHoldText` in `quereus-store/src/common/store-table.ts`. Pinned by four
  new tests (JSON normalizes; JSON under a comparator-only collation still raises; `ANY`
  likewise; `BLOB` stays inert). `isNonTextualLogicalType` itself was left alone — correcting
  it is `bug-json-columns-classified-as-non-textual`'s job, and this gate no longer depends
  on it.
- **The handoff's "both are covered by their own tickets" was half true.** The store's key
  encoder has `bug-store-key-encoder-ignores-database-collations` in `tickets/fix/`. The
  isolation layer's `isolated-table.ts` site had no ticket. Filed
  `fix/bug-isolation-overlay-key-ignores-database-collations` (see below) and corrected the
  `NOTE:` in both `isolated-table.ts` and `key-serializer.ts` to name the two tickets.
- **The handoff overstated plan invalidation.** It said recording the collation dependency
  means "re-registering the collation invalidates cached plans". It does not: the recorded
  dependency only feeds `validateCapturedSchemaObjects()`, which throws if the collation was
  *dropped* and otherwise merely logs a warning. Nothing invalidates. This is pre-existing
  parity with `resolveCollation()`, not a new defect — re-registration is picked up because
  each `eval` re-prepares, which is now pinned by a test. The `NOTE:` on `registerCollation`
  was extended to say so and to cover normalizers, not just comparators.
- **Stale doc.** `docs/window-functions.md` still described PARTITION BY normalizers as coming
  from `util/key-serializer.ts`. Corrected to name `EmissionContext.resolveKeyNormalizer()`.

### Filed as a new ticket (major)

- `fix/bug-isolation-overlay-key-ignores-database-collations` — the isolation layer's
  secondary-index merge builds its modified-primary-key set with the built-ins-only lookup,
  so a primary-key rewrite to a collation-equal, byte-different value fails to shadow the
  underlying row and a scan inside the transaction can return it twice. Reachable today, and
  not limited to comparator-only collations: a custom collation *with* a normalizer is
  ignored there too. Predates this ticket; acknowledged in a call-site `NOTE:`; out of scope
  here because no `Database` is threaded to that call site.

### Recorded as tripwires, not tickets

- **Plan-cache invalidation on collation re-registration.** Fine now — there is no plan cache
  on the path, and each `eval` re-prepares. If one lands, a re-registered collation whose
  *normalizer* changed must invalidate dependent plans, and `validateCapturedSchemaObjects`
  only warns on identity change. Parked in the existing `NOTE:` on
  `Database.registerCollation` (`core/database.ts` ~1318), which already owned the adjacent
  "registration is not retroactive" caveat; extended there to cover normalizers.

### Known gaps left in place

- **No test forces the merge (non-hash) `AS OF` strategy under a custom collation.** The
  partitioned case selects the hash strategy, which is the one that buckets. The merge
  strategy compares with `partitionCollations`, already database-resolved, so it was never
  wrong — reasoned, not asserted. Not worth a ticket: the code path takes no normalizer.
- **`RTRIM`'s normalizer/comparator agreement** rests on the pre-existing probe-set test in
  `collation-normalizer.spec.ts`; no new corpus was added.
- **`quereus-store` and `quereus-isolation` still bucket with the builtins-only lookup.** Both
  now have tickets. The store caveat in `docs/sql.md` is unchanged and still accurate.
- **Whether the optimizer should avoid hash strategies for a collation with no normalizer**
  (falling back to a comparator-based plan instead of raising) was considered and rejected as
  out of scope. Probing showed both the hash and streaming aggregate raise today, so the error
  is at least consistent rather than plan-dependent. Raising beats silently wrong grouping.

## Validation run

- `yarn test` — all green, zero failures (6697 + 180 + 86 + 443 + 65 + 31 + 34 + 128 across
  workspaces; `packages/quereus` up from 6687 at handoff, +10 review tests).
- `yarn lint` — clean.
- `yarn build` — clean.
- `yarn test:store` not run (no store code changed).
