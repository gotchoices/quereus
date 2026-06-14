
---

## Appetite check (2026-06-13, human sign-off): BUILD IT — regular columns are the preferred surface

Greenlit. The dev confirmed this is the regular-projected-columns approach their
6.4 redirect asked for (`'red' as kind`, ordinary columns that feed the
predicate), as opposed to the `exists`-pseudo-column spelling — and explicitly
prefers regular columns over `exists` pseudo-columns. So:

- **Build the flag-less predicate-honest write path** (INSERT / DELETE / UPDATE-
  of-data via the existing sat-checker / FD branch-consistency pipeline). This is
  the "Predicates Rule" idiom applied to plain set-op bodies, not the shelved
  product-coordinate novelty.
- **Coexist-vs-unify steer:** regular columns are the **preferred** surface going
  forward. Do **not** retire the shipped `exists`-membership write path (6.1)
  preemptively — let the two coexist while the regular-column path proves out
  (they share the `__vmupd_keys` Halloween-safe capture and per-branch recursive
  `propagate`, so unification stays open). Whether/when to deprecate the
  `exists`-pseudo-column spelling in favor of regular columns is a deliberate
  follow-up once this lands, not part of this ticket. Weight the design toward
  regular-columns-primary.
- The plan pass still owns: confirming the FD framework emits a constant FD from
  a **projected literal** (not only a `where col=const` predicate) — load-bearing
  for insert default recovery — and the non-literal / `unknown`-σ honest-fan-out
  characterization already noted.
