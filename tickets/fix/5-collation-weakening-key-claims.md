description: Suspected soundness gap — unique-key/FD claims may survive a collation-weakening passthrough (`b collate nocase` over a BINARY-unique `b`), where two BINARY-distinct values are equal under the output collation, so the claimed key does not hold for the output relation. Reproduce, scope the blast radius, and design the key-coarsening detection the migration pattern needs.
files:
  - packages/quereus/src/planner/analysis/scalar-invertibility.ts   # collate is a passthrough — lineage threads through it
  - packages/quereus/src/planner/util/fd-utils.ts                   # keysOf / isUnique reconciliation
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # backing PK derivation; create-fill duplicate guard
  - packages/quereus/test/property.spec.ts                          # Key Soundness net (does its zoo cover collation casts?)
  - docs/migration.md                                               # § Convergence hazards (the consumer of the detection)
----

# Collation-weakening casts vs. key claims

## Suspicion

`collate(x, 'NOCASE')` carries invertibility profile
`{ kind: 'passthrough', arg: 0 }`, so lineage — and plausibly FD/key
propagation through `Project` — treats the output column as the input column.
But a passthrough is identity **on values**, not on **equality semantics**:
over a source uniquely keyed on `b` with BINARY collation, the output of
`select b collate nocase as b from t` can contain `'Bob'` and `'bob'` — two
rows *equal under the output column's declared collation*. If `keysOf` /
`RelationType.keys` still claims `{b}` unique on that output, the claim is
unsound **relative to the output collation**, and the consumers of key facts
can misfire:

- **DISTINCT elimination** — `select distinct b collate nocase from t` with
  the key claimed ⇒ distinct dropped ⇒ duplicates (under NOCASE comparison)
  survive.
- **MV backing PK** — `create materialized view m as select b collate nocase
  as b, … from t` infers PK `{b}`; the backing btree keys with the output
  collation. Expected: the create-fill's duplicate-key guard fires loudly on
  colliding source data ("must be a set"). Verify it does — and that
  *steady-state maintenance* after a clean fill behaves sanely when a later
  source insert collides (the upsert will silently merge — is that reached, or
  does some earlier claim break first?).
- Join-elimination / order-by pruning / any other `keysOf` consumer.

It is possible the engine is already sound here (e.g. key propagation might
drop keys through any expression column, even passthrough; or the comparison
collation used by DISTINCT might be the source collation, making the claim
consistent). **The first job is to find out.**

## Reproduce

Seed `create table t (b text primary key)` (BINARY) with `'Bob'`,`'bob'`,
then probe each surface above with both plain reads and plan-shape
inspection (`query_plan()` properties / golden-plan diff) to see whether a
key is claimed and whether an optimization fires on it. Also probe the
declared-column route: an MV/view with an explicit NOCASE-collated output
column type, not just the `collate` expression.

## Then

- If unsound: the fix direction is that a key/FD survives a projection only
  when the output column's **comparison semantics** are at least as strong as
  the source's (BINARY → NOCASE weakens; NOCASE → NOCASE or NOCASE → BINARY
  is fine). Likely a guard at `Project` FD propagation keyed off declared
  collations; enumerate consumers that need re-verification. Output
  implement ticket(s).
- Either way, design the **key-coarsening detection** `docs/migration.md`
  § Convergence hazards specifies: at MV create, when the body's inferred
  backing key fails to functionally determine the source primary key under
  the *output* collation (the parallel-migration-table shape), emit a warning
  ("collisions will last-write-win until source rows are merged") rather than
  a rejection — the merge-on-coarsen behavior is often intended. Runtime
  collision telemetry is optional follow-up; park it in backlog if out of
  scope.
- Check whether the Key Soundness property net's query-shape zoo generates
  collation-bearing projections at all; if not, extending it is part of the
  fix ticket(s) you emit (the net should have caught this class).
