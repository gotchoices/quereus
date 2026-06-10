description: Direction B approved — preserve true determination FDs on non-keyed producers and make the FD readers provenance-aware, replacing the producer-side single↔single drop gate (`foldSingleSingleGated`) so honest consumers (ORDER BY pruning, GROUP BY simplification, derived keys above DISTINCT/GROUP BY) regain the facts.
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/property.spec.ts
----

## Decision record (2026-06-10)

The `fd-*-key-bag-overclaim` family fixed a wrong-results class (a determination
FD from a CHECK / hoisted assertion / filter predicate read as a phantom key over
a narrow projection of a non-keyed table) with **direction A**: producer-side
gating (`foldSingleSingleGated`) that *drops* any single↔single FD whose
endpoints are both non-keys. Sound, but an under-claim — the true determination
FD vanishes from `physical.fds` for every consumer.

Human decision: **proceed with direction B** — keep all true FDs on the producer
and make the *readers* sound instead — provided there is no significant perf
downside (assessed: none expected — FDs are plan-time-only metadata, closure is
polynomial over small FD sets, and the change adds back only the handful of
previously-dropped determinations per CHECK/filter; no runtime cost).

## The core design problem: provenance that survives transforms

The readers cannot distinguish "closure covers all columns via uniqueness-bearing
FDs" from "via determination FDs" without knowing which kind each FD is. The
trap is already pinned in the `foldSingleSingleGated` comment: the existing
`valueEquality` marker does NOT survive `shiftFds` / `projectFds`, so any
marker-gated read resurfaces the over-claim through a join or projection.
Direction B therefore requires a **durable provenance field** on
`FunctionalDependency` — e.g. `kind: 'unique' | 'determination'` — that every FD
transform (`shiftFds`, `projectFds`, join merges, `addFd` dedup, guarded-FD
activation) preserves verbatim. Declared PK/UNIQUE-derived `K → rest` FDs and
the `∅ → all_cols` singleton are `'unique'`; CHECK/assertion/filter-equality
determinations are `'determination'`. Absence of the field should be impossible
after the migration (don't leave a third implicit state).

## Reader-side soundness rule (sketch — validate in plan)

A determinant `K` with `closure(K) = all_cols` is a genuine key iff uniqueness
is actually reachable, not merely coverage:

- the relation is a set (`isSet`) — then closure-covering K IS a key (two rows
  agreeing on K would agree on everything = duplicate, impossible in a set);
  this is what restores derived keys above DISTINCT / GROUP BY; or
- some `'unique'` FD `U → Y` has `U ⊆ closure(K)` — at most one row per U ⇒ at
  most one row per K.

A bag whose closure path is determination-only derives **no** key — exactly the
phantom-key bug, now refused at the reader. Apply the rule in
`deriveKeysFromFds`, `isUnique`'s closure branch, `hasAnyKey`, and audit every
other `isSuperkey` call site (FilterNode covered-key detection, join FD
propagation, binding/change-scope analysis, lens prover's
`proveEffectiveKeyUnique`) for which semantics — coverage vs uniqueness — each
actually needs. Some call sites legitimately want pure coverage; split the
helper rather than overloading one predicate.

## Gate disposition

`foldSingleSingleGated` is **replaced**, not coexisted-with: if the producer
gate stays, the FDs are still dropped and B's gains never materialize. The
sibling tickets' regression tests (`fd-derived-key-bag-overclaim`,
`fd-check-assertion-key-bag-overclaim`, `fd-oneway-determination-key-bag-overclaim`,
`fd-guarded-activation-key-bag-overclaim`) stay green as the proof the reader
rule subsumes the gate. `activateGuardedFds` in `filter.ts` needs the same
re-examination (its inline gate exists for the same reason).

## Expectations / tests

- All four `fd-*-key-bag-overclaim` regression fingerprints stay green (the
  DISTINCT-preservation wrong-results cases).
- Property suite "Key Soundness" (tier 1 + tier 2) stays green — it is the
  soundness net for exactly this surface.
- New positive coverage now becomes possible and should be added: over a
  non-keyed table with `check (b = a + 1)` — (a) `order by a, b` prunes `b`;
  (b) `group by a, b` simplifies to `group by a`; (c) `select distinct a, b`
  output carries derived key `{a}` (visible via `query_plan()` / `keysOf`).
- Perf: no bench regression (`yarn bench --baseline`); FD sets grow only by the
  previously-dropped determinations.

## Out of scope (future stage-setting, do not implement here)

Once the FD surface is honest and provenance-typed, additional producers become
safe to add later: determinations from computed projection terms
(`select a, a+1 as b` ⇒ `{a}→{b}`), lens computed columns, and NDV/cardinality
estimation reading determinations (`ndv(a,b) = ndv(a)`). Park follow-ups in
backlog as they crystallize.
