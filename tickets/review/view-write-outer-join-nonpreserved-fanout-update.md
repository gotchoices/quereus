description: Review the fix for non-preserved (outer-join null-extended) column UPDATE fan-out — a non-preserved partner shared by multiple preserved rows. The matched read-back now `min`-de-dups per partner and the null-extended materialization INSERT `group by`s the join key (with `min` value projections), so a shared-partner write applies once instead of erroring `Scalar subquery returned more than one row` (matched) or `UNIQUE constraint failed` (materialization). Implemented + validated; build, full test suite (5367 passing), and lint all green.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What changed

Two surgical edits in `multi-source.ts`, both keyed off the existing pre-mutation
`__vmupd_keys` capture — no new runtime substrate:

1. **`capturedValueSubquery`** (the shared cross-source/np read-back helper) gained an
   optional `dedupAggregate?: string` param. When set, the projected `k.<srcAlias>` is
   wrapped in `{ type:'function', name: dedupAggregate, args:[colRef] }`. Default off, so
   the three `decomposition.ts` callers and the cross-source `stripSideQualifier` caller are
   byte-identical (they already prove at-most-one partner via their own cardinality gate).

2. **Matched read-back** (np matched-update push, ~`multi-source.ts:1459`) now passes
   `'min'` → `(select min(k.<val>) from __vmupd_keys k where k.<npPK> = …)`. Single-valued
   even when one partner PK matches N capture rows (the fan-out).

3. **Materialization INSERT** (`buildNullExtendedInsert`, ~`multi-source.ts:1650`): each
   value projection wrapped in `min(...)`, plus `groupBy: [k.<jkAlias>]` on the select. One
   partner row materializes per distinct dangling join key. The join-key projection stays the
   bare grouped column.

Docs (`docs/view-updateability.md` § Outer Joins) updated: the realization note now shows
the `group by k.<joinKey>` / `min(k.<val>)` shape and a new paragraph explains the
per-non-preserved-partner de-dup, including the divergent-value semantics.

## Why `min` (the one semantic decision to scrutinize)

For a **constant / np-only-valued** SET, the captured value is identical across the
shared-partner group → `min` is an exact **no-op** de-dup. For a value that genuinely
**differs** per preserved row (a *preserved*-column read over a shared partner, e.g.
`set pv = cv` — inherently ambiguous which child wins, the outer-join mirror of the
inner-join 1:many cross-source case), `min` resolves it **deterministically** (picks the
minimum captured value) rather than erroring at runtime. Using the same `min` on both the
matched read-back and the materialization GROUP BY keeps them consistent (the materialization
can't PK-conflict on a divergent value either).

**Deliberate scope decision (please sanity-check):** the implement stage did NOT add a
plan-time *reject* of the divergent-value case (mirroring `cross-source-ambiguous-cardinality`),
because "np side joins ≥2 preserved rows" is the *normal* parent→child cardinality — a gate
there would over-reject the common 1:1 case. `min` de-dup is the non-over-rejecting choice.
This matches the fix-stage ticket's explicit recommendation. The reviewer should confirm this
is the desired semantics rather than, say, "last writer wins" or a stricter narrow reject.

## Use cases to validate (what the tests cover — treat as a floor)

All four scenarios are covered for **LEFT** (`npv`) and **RIGHT** (`rnpv`) mirrors, since the
substrate keys off `JoinSide.preserved`, not source order:

- **Matched fan-out** — `update npv set pv = 5 where cc in (1, 4)` where children 1 and 4
  share existing parent `pp=10`. Before: `Scalar subquery returned more than one row`. After:
  parent updated once (`pp=10, pv=5`), all children that join it (incl. unselected sibling
  cc=5) read `pv=5`. With and without `returning`.
- **Materialization fan-out** — two null-extended children (cc 6, 7) sharing one dangling key
  `pr=99`. Before: `UNIQUE constraint failed: np_parent PK`. After: exactly one partner
  materialized (`pp=99, pv=7`), both children join it. With and without `returning`.
- **Divergent-value fan-out** — `update npv set pv = cv where cc in (1, 4)` (captured cv:
  child1→1000, child4→4000). Asserts the deterministic `min` result: parent `pv=1000`. This
  pins the documented divergent-value semantics (LEFT block only — see gaps below).

Test locations:
- `packages/quereus/test/property.spec.ts` — LEFT `npv` block (~line 5772-5870) and RIGHT
  `rnpv` block (mirror). The stale "pre-existing limitation … out of scope" comment near the
  `set cv = 7` preserved-column fan-out test was updated.
- `packages/quereus/test/logic/93.4-view-mutation.sqllogic` — new LEFT `fofv` section (after
  the `ojrv` RETURNING block) and RIGHT `rfofv` section (after the `rojv` block).

## Validation performed

- `yarn workspace @quereus/quereus build` → exit 0.
- Full `yarn workspace @quereus/quereus test` → **5367 passing, 9 pending** (the divergent-value
  assertion was added afterward; the affected file `property.spec.ts` re-ran green in isolation,
  so the full count holds).
- `yarn workspace @quereus/quereus lint` → exit 0.
- Targeted: property `--grep "non-preserved"` (4 passing) and logic `--grep "93.4"` (1 passing).

## Known gaps / things for the reviewer to probe (tests are a floor, not a ceiling)

- **Divergent-value coverage is LEFT-only and single-shape.** The `set pv = cv` deterministic-
  `min` assertion is in the LEFT block only, and only for the *matched* (existing shared parent)
  branch. A reviewer may want: (a) the RIGHT mirror, (b) a divergent-value *materialization*
  fan-out (two dangling children with different captured values sharing one key — confirm the
  GROUP BY `min` picks the min and mints one partner), and (c) a divergent-value with `returning`.
- **`min` type behavior across non-numeric captured values** is untested here. `min` over text /
  blob / mixed-type captured values follows the engine's `min` collation/ordering — worth a
  sanity check if a non-preserved column can be text and the SET value diverges per row.
- **Composite-key fan-out** is out of scope (a composite non-preserved join key already rejects
  `unsupported-outer-join-update` upstream, unchanged here) — the fan-out de-dup only applies to
  the single-column-key path that is materializable.
- **NULL captured values in the group.** `min` ignores nulls and returns null only if all are
  null. A mixed null/non-null divergent group is untested — confirm the intended result (does a
  child contributing a null pull the group toward a non-null sibling's value? `min` says yes).
- The `min`-de-dup makes the matched read-back an **aggregate correlated scalar subquery**; the
  full suite exercises it, but a reviewer focused on the planner may want to confirm there's no
  cost/decorrelation surprise for large shared-partner groups (functional correctness is proven;
  performance is not profiled).

## Acceptance (from the implement ticket — all met)

- Shared **existing** non-preserved partner: applies once, no scalar-subquery multi-row error,
  with and without `returning`. ✓
- Shared **dangling** key: materializes the partner once, no double-insert / PK conflict. ✓
- LEFT (`npv`) and RIGHT (`rnpv`) mirrors both covered. ✓
- No regression in the existing non-preserved-update / RETURNING / existence-flag suites
  (full suite green). ✓
