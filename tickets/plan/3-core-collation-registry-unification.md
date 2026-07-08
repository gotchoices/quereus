description: The engine keeps two separate places that register text-sorting rules, and the low-level comparison code only consults the old deprecated one, so custom sort rules registered per-database can be silently ignored and fall back to plain byte order.
files:
  - packages/quereus/src/util/comparison.ts (deprecated global collation registry ~line 14; compareSqlValues fallback ~67–100; sqlValuesEqual duplicate)
  - packages/quereus/src/core/database.ts (per-database collation registration ~line 376)
----

## Problem

There are two collation (text-sorting rule) registries in the engine:

1. A **deprecated process-global** registry in `util/comparison.ts` (~line 14).
2. **Per-database** collation registrations in `core/database.ts` (~line 376).

The low-level `compareSqlValues` resolver in `util/comparison.ts` (~67–100) still
consults the deprecated global registry as its live fallback. Per-database
registrations are invisible to this util-layer resolver: when a name is not found,
it silently falls back to `BINARY` (raw byte comparison) and only emits a
debug-level log. So a collation registered on a specific database connection can be
ignored during comparison, and the user gets byte-order sorting with no visible
signal.

Additionally, `sqlValuesEqual` in `util/comparison.ts` duplicates
`compareSqlValuesFast` but with **divergent semantics** — it uses `===`, so
`5n === 5` is `false` where the fast comparator treats them equal — and carries a
stale doc comment. It is redundant and its divergence is a latent correctness trap.

## Why this needs a plan

Removing the deprecated global registry and making the util-layer resolver honor
per-database collations is a seam migration: `util/comparison.ts` is a low layer
that does not currently have a handle to a specific database's collation set, so
resolving per-database collations there requires threading that context (or moving
resolution to a layer that has it). That is a design decision, not a mechanical
edit — hence a plan ticket.

## Expected outcome (to be designed)

- A single source of truth for collation resolution. Per-database registrations
  must be honored wherever `compareSqlValues` is used; the deprecated global
  registry is retired or clearly demoted.
- When a collation name genuinely cannot be resolved and `BINARY` fallback is
  taken, that fallback is surfaced at least once per name (not debug-log-only), so
  silent wrong-order results become visible.
- `sqlValuesEqual` is deleted; callers use `compareSqlValuesFast` (or the agreed
  single equality function) so equality semantics are consistent (`5n` equals `5`).

## Direction / open questions to resolve in planning

- How does the util-layer comparator obtain the relevant database's collation set?
  Options: pass a resolver/context into the comparison entry points; move
  resolution up to a layer that holds the database; or attach the collation
  resolver to the comparison call sites that already have database context.
- Migration path for existing callers of the global registry (there is prior
  related work — see completed `unify-unique-enforcement-collation-resolver`).
- Whether the once-per-name fallback notice is a warning log, a diagnostic event,
  or a thrown error (behavior may differ for known BINARY/NOCASE/RTRIM vs an
  unknown user collation).
