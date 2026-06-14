description: Extend the replicable-determinism requirement to cover custom collations — an embedder-registered collation used in a synced derivation body (ORDER BY / comparison / NOCASE-like) could case-fold or sort differently across peers' platforms, diverging derived bytes, yet the function-only replicable gate does not see it.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # where the function replicable gate lives
  - packages/quereus/src/util/comparison.ts                    # collation registry / comparators
prereq: replicable-determinism-class
----

# Replicable collation class

The `replicable-determinism-class` work validates that every **function** in a
materialized-view / derivation body is replicable when the backing host demands
it. Custom **collations** are a parallel divergence surface the function gate
does not cover.

Quereus's built-in collations (BINARY, NOCASE, RTRIM) are engine-implemented and
bit-identical across peers, so a body using only those is safe. But an embedder
may register a custom collation (e.g. a locale-aware ordering) via the
collation registry; if such a collation participates in a synced derivation
body — in an `order by`, a comparison, a UNIQUE/key under that collation — its
sort/fold behavior could differ across platforms and diverge derived bytes,
exactly the hazard the replicable class exists to prevent.

## Use case / expectation

When the resolved backing host requires replicable derivations, a body that
references a non-replicable custom collation should be rejected at create with a
sited error naming the collation (parallel to the non-replicable-function
reject), or the collation must be declarable `replicable` at registration so a
deliberate authoring assertion lets it through. Built-in collations qualify
automatically.

Out of scope until a sync-store host that demands replicable derivations exists
and a real custom-collation-in-derivation case is on the table. Captured here so
the function-only gate's known blind spot is not lost.
