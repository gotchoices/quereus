description: An `x in (insert ... returning ...)` test used to work out its answer for the first row and reuse it for every row, so queries over more than one row returned wrong results. It now stores the values the insert returned and checks each row against them; the insert still runs exactly once.
architecture: docs/runtime.md#impure-subquery-emitters-full-drain--run-once
files:
  - packages/quereus/src/runtime/emit/subquery.ts   # emitIn: new helpers membershipKey / drainMembershipSet / membershipSetFor / probeMembership; impure branch (runImpure) and runSetProbe now share them
  - packages/quereus/src/runtime/types.ts           # new exported InMembershipSet; inSetProbes and executionMemo doc comments
  - packages/quereus/src/runtime/parallel-driver.ts # inSetProbes / executionMemo fork comments
  - packages/quereus/test/runtime/fork-contract.spec.ts # inSetProbes policy comment only
  - packages/quereus/test/logic/01.9-query-expr-dml.sqllogic # section 2: new multi-row cases
  - docs/runtime.md, docs/runtime-caching.md, docs/runtime-parallel.md
repro: verified
----

## What changed

`emitIn`'s impure branch (an `IN` whose right-hand side contains a write, e.g. `insert … returning`) used to store the three-valued *answer* for the first probe value in `rctx.executionMemo` and return it on every later call, whatever that call's `condition` was. It now stores the drained **membership set** (`{ tree, hasNull }`) in `rctx.inSetProbes` under its own per-emit-site symbol `Symbol('IN(impure)')`, and probes the set with each call's own condition. This is the same structure the uncorrelated set-probe branch (`runSetProbe`) already used.

Shared helpers in `subquery.ts` (above `emitIn`):

- `membershipKey(value, transform)`: NULL stays NULL, otherwise apply the probe/member key transform. Also replaced the inline `x === null ? null : key(x)` pattern in the streaming and value-list paths of `emitIn`. Those paths behave the same; only the expression moved into the helper.
- `drainMembershipSet(input, collation, memberKey)`: the drain loop taken out of `runSetProbe`. It reads every row with no early exit, which the full-drain rule for writes needs.
- `membershipSetFor(rctx, slot, …)`: get the set from `inSetProbes`, or drain `input` and store the result there.
- `probeMembership(set, conditionKey)`: hit → `true`; miss → `hasNull ? null : false`.

The two branches differ only in ordering, and that difference is intended:

- `runSetProbe` (pure source): key the condition first. For a NULL key, return NULL **without** building the set. Otherwise get or build the set and probe it. Behaviour is unchanged.
- `runImpure` (source with a write): get or build the set **first, unconditionally**, then key the condition and probe. This makes the write fire on the first evaluation even when that evaluation's probe is NULL. The old impure code also did this.

Scalar and `EXISTS` impure paths still use `executionMemo`, because their single answer does not depend on the outer row. The doc comments on `executionMemo` and `inSetProbes` (`types.ts`, `parallel-driver.ts`, `fork-contract.spec.ts`, `docs/runtime-parallel.md`) now say which emitter uses which slot. The `parallel-driver.ts` comment also says that a per-branch lazily created `inSetProbes` map would make impure `IN` fire its write once per branch. This is the same hazard `executionMemo` already carried, and it is dormant because `ParallelDriver` has no query consumers.

`InMembershipSet` is a new exported interface in `runtime/types.ts`. It is the value type of `inSetProbes`, which previously had the same shape written inline.

## Tests added (section 2 of `01.9-query-expr-dml.sqllogic`)

- Integer probe over two outer rows, `where i in (insert … values (1, 10) returning v)`: only id 1 is returned (before the fix, both were), and the write table has 1 row. This is the main reproduction.
- Text probe where the first outer row misses and the second hits: only id 2 is returned (before the fix, none were), and the write table has 1 row. This reproduces the opposite direction of the bug.
- Projection-position `i in (insert … (10), (null) returning v)` over outer values 10 and 20 gives `true` then `NULL`. This pins three-valued membership per row from a single drained set.
- Outer rows with `i` = NULL then 10 give `NULL` then `true`, and the write table has 1 row. This pins "build before the NULL short-circuit": the write fires even though the first probe is NULL.

I confirmed with `scheduler_program()` against the built `dist` that both the filter-position and projection-position shapes emit `IN(impure)`. Neither is rewritten into a semi join, so these tests exercise the changed emitter. I did not re-run the new tests against the pre-fix code; the ticket's own reproduction (`repro: verified`) covered the before-fix behaviour, and the first two cases are that reproduction.

## Validation run

- `yarn workspace @quereus/quereus test`: 11097 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: clean (exit 0). `tsc --noEmit -p packages/quereus/tsconfig.json`: clean.
- I did not run the store-backed leg (`yarn test:store`). The change is in the runtime emitter and does not touch storage, and section 2's tables are plain.

## Things a reviewer may want to check

- A correlated impure inner still runs once, with the first outer row's values; later rows probe that one run's result. This matches the existing scalar/`EXISTS` contract, and I documented it as one sentence in `docs/runtime.md`. It is not a change in this ticket.
- If two evaluations of the same impure `IN` site ran concurrently within one execution, both could miss the slot and drain twice. The old `executionMemo` path had the same window. Nothing in the runtime evaluates one site concurrently today (ParallelDriver is dormant), so I left it alone.
- An `IN` over a write that is never evaluated (zero outer rows) still never fires the write. The ticket marked this out of scope, and it is the same for all three impure emitters.
