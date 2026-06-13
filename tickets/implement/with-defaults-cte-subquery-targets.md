----
description: Prove the new capability the `with defaults` re-home unlocks — the clause on CTE and subquery-in-FROM write targets — plus the residence doc note
prereq: with-defaults-clause-rehome
files: packages/quereus/test/logic/93.4-view-mutation.sqllogic (or a new sibling logic file), packages/quereus/test/logic/ (new coverage), docs/view-updateability.md
difficulty: medium
----

## Goal

The `with-defaults-clause-rehome` change moves the defaults clause onto core select, which means
**CTE bodies and subqueries-in-`from`** — both first-class write targets in this engine — can now
carry `with defaults (…)` for free. Today only the DDL sites (view / materialized view / maintained
table) had the clause and were tested. This ticket adds the missing write-through coverage for the
newly-reachable sites and documents the expanded residence.

This ticket is **additive** (new test files + a doc note) and carries no build risk on its own; it
depends only on the re-home having landed.

## What to cover

- **CTE write target consuming `with defaults`:** a `with t as (select … from base with defaults
  (col = expr)) …` shape where a write routed through `t` omits `col`, and assert the default fires
  (the omitted base column receives `expr`) exactly as it would through an equivalent view. Pair it
  with a negative: an explicitly-supplied `col` shadows the default (supplied-wins), matching the
  view semantics.
- **Subquery-in-FROM write target consuming `with defaults`:** the analogous shape with a
  `from (select … with defaults (…)) as s` source that is a write target. Same supplied-wins and
  omitted-fires assertions.
- **Routing parity:** confirm the entries route to their owning base via the same lineage machinery
  as the DDL sites (no new resolution path) — a `default-target-not-found` for a typo'd target still
  fires at write time, and a target naming a base-lineage view column resolves.
- **Inert read-only case:** a `with defaults` on a CTE/subquery that is only *read* (never a write
  target) is inert — no error, no effect. (Mirrors the rehome ticket's top-level-select inert case.)

Prefer a new dedicated logic file (e.g. `test/logic/93.6-with-defaults-core-select.sqllogic`) over
bloating 93.4, so the new-capability surface is self-documenting. Reuse the base-table + write-route
fixtures from 93.4-view-mutation.sqllogic.

## Edge cases & interactions

- Compound CTE body (`with t as (select … union select … with defaults (…))`) — the clause binds to
  the whole compound, same as a compound view body; a write through the compound CTE applies the
  default. (If compound-CTE write-through is not itself supported yet, assert the clause is inert /
  the existing non-writability diagnostic, and note the limitation — do not invent new write
  support here.)
- A subquery-in-FROM that is NOT updatable (e.g. aggregated) carrying `with defaults` — inert, no
  spurious write-through, no crash.

## TODO
- [ ] Add the new sqllogic coverage (CTE + subquery-in-FROM write targets; supplied-wins +
      omitted-fires + typo'd-target + inert read-only).
- [ ] docs/view-updateability.md: in the (now-renamed) defaults section, add a short note that the
      clause rides core select and is therefore available on CTE / subquery-in-FROM / lens-body
      write targets, not just the DDL sites — cross-reference the Authored-inverses residence note it
      now mirrors.
- [ ] `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log` — confirm green.
