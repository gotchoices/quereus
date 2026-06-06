description: Harden the shipped decomposition optional-member / EAV-pivot UPDATE materialization against three untested corners surfaced in review of view-write-decomposition-optional-update. None is a known live bug — the view image is sound across the property oracles — but each is an unexercised path or an undefended structural assumption that a future advertisement shape could trip.
files: packages/quereus/src/planner/mutation/decomposition.ts (buildOptionalMaterializeInsert, buildEavMaterializeInsert, singleKeyColumn), packages/quereus/test/property.spec.ts (columnar/EAV PutGet + GetPut), packages/quereus/test/lens-put-fanout.spec.ts
----

## Context

`view-write-decomposition-optional-update` ships the optional/EAV value-write materialization
(matched UPDATE / `on conflict do nothing` materialize INSERT / all-null DELETE). The view-image
soundness is backed by the extended PutGet property tests (columnar numRuns 100, EAV numRuns 80)
and deterministic branch pins. Three corners remain unexercised or undefended:

### 1. Conflict-target = member PK assumption (robustness)

The materialize INSERT targets `on conflict (<memberKey>) do nothing` (columnar) /
`on conflict (<entity>, <attr>) do nothing` (EAV), assuming the shared stitch key is the
member's **declared PK or a unique constraint**. The runtime `do nothing` only fires on a
detected PK/UNIQUE violation (`dml-executor.ts` `matchUpsertClause` → `processInsertRow`); if the
stitch key is **not** a declared unique, no conflict is raised and the materialize would
**double-insert** instead of ceding the matched rows to the UPDATE.

A non-unique stitch key already makes the read-side join multiply rows, so such an advertisement
is structurally unsound independent of this path — but nothing asserts it. Add a plan-time guard
(or document the invariant at advertisement resolution) that the materialize conflict target
resolves to a declared unique/PK on the member, raising `unsupported-decomposition-key` (or a new
precise reason) rather than relying on the read-join soundness to hold implicitly.

### 2. Surrogate-keyed optional member UPDATE (test gap)

`buildOptionalMaterializeInsert` threads `singleKeyColumn(anchor)` → `singleKeyColumn(member)`
(distinct spellings under a surrogate). The only surrogate coverage today is mandatory members +
INSERT; an **optional** member under a **surrogate** shared key is not exercised through the
UPDATE materialize/delete path. Add a surrogate-split advertisement with an optional member and
pin matched-update / absent-materialize / all-null-delete (the surrogate anchor key must thread
into the member key column correctly).

### 3. GetPut over the new optional ops (oracle floor)

The columnar property test's GetPut writes only the mandatory writable columns (a, b); it never
writes `c` back, so the materialize/delete branches are not covered by a GetPut idempotence
check. The PutGet oracle covers post-state, but a GetPut that re-puts `c` (including the
lingering-all-null-row → subsequent-op sequence, which review reasoned is observationally
equivalent to absence) would harden the floor against a representational divergence the
single-op deterministic tests cannot catch.

## Expected outcome

- A non-unique stitch key is rejected at plan/deploy time, not silently double-inserted.
- The surrogate + optional-member UPDATE path is pinned by a test.
- A GetPut over `c` (with a multi-op sequence that creates then re-reads a materialized /
  deleted / lingering-all-null component row) confirms idempotence.
