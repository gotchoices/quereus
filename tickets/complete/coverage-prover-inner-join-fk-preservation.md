description: Coverage prover admits INNER/CROSS-equi join bodies as covering a single-table UNIQUE on T when a NOT-NULL FK→PK from T to the lookup table proves the inner join loses no T rows (extends the LEFT/RIGHT outer-join admit path). Reviewed and completed.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/src/planner/util/ind-utils.ts, docs/materialized-views.md, docs/optimizer.md
----

## What landed

`proveCoverage` (`planner/analysis/coverage-prover.ts`) now admits an
**INNER (or CROSS-with-equi) join** body as covering `unique(...)` on base table
`T` when `T`'s rows are provably retained by enforced referential integrity, in
addition to the prior LEFT/RIGHT row-preservation path. The no-row-loss test in
the shape walk became an explicit two-path check:

- **(a) row preservation** — `T` on the preserving side of an outer join.
- **(b) referential integrity** (`innerJoinRetainsConstrainedTable`) — an
  `inner`/`cross` join whose equi-pairs are a **NOT-NULL FK from `T` to the lookup
  table's PK**, over a lookup side exposing the parent's full row set. Uses
  `lookupCoveringFK` (`ind-utils.ts`) + `!match.nullable`.

Supporting private helpers: `pureColumnEquiConjunctCount` (was
`isPureColumnEquiCondition`), `pureJoinEquiAttrPairs`, `resolveFullScanTableRef`,
`findConstrainedTableRef`. The no-fan-out gate and name-collision guard are
unchanged; a NOT-NULL FK→PK join satisfies the fan-out gate automatically. All
prior LEFT/RIGHT/single-source behavior is preserved.

The covering link on a join-bodied MV is **informational** this release:
row-time maintenance rejects any multi-source body
(`database-materialized-views.ts:1156`, `tableRefs.length > 1`), so it cannot
drive a row-time ABORT. The RI assumption is load-bearing for any future
enforcement consumer.

## Review findings

**Scope of review.** Read the full implement diff (coverage-prover.ts, the two
docs, the spec) with fresh eyes, then traced every dependency: `lookupCoveringFK`
+ `isRowPreservingPathToTable` (`ind-utils.ts`), the physical scan node shapes
(`table-access-nodes.ts`) and how `rule-select-access-path` emits them, join node
shapes + `extractEquiPairsFromCondition` (`join-node.ts`,
`bloom-join-node.ts`, `merge-join-node.ts`), `rule-join-physical-selection`
(when a logical `JoinNode` survives), and the row-time eligibility gate. Ran the
multi-source suite (18 passing), the full quereus suite, and lint.

**Soundness — the three flagged focus areas (all confirmed sound):**

1. *RI-trust decision (no `pragma foreign_keys` gate).* **Accepted.** Identical
   to the inclusion-dependency trust the INNER branch of `rule-join-elimination`
   and the whole `ind-utils.ts` module already make; admitting the same shape in
   the prover adds no new global assumption. A creation-time pragma check would be
   illusory (the pragma can toggle later); belt-and-suspenders would have to live
   at enforcement time. The covering link on a join MV is informational anyway
   (verified: `database-materialized-views.ts:1156` rejects multi-source bodies
   from row-time maintenance), so the assumption is not load-bearing for current
   correctness. No change. No follow-up ticket — the decision is correct as-is.

2. *`resolveFullScanTableRef` completeness (the only place a false `Covers` could
   originate from a row-reduced lookup side).* **Confirmed sound.** Traced the
   access-path rule: a `SeqScan`/`IndexScan` in the standard path is built with
   the default full-scan `FilterInfo` carrying **empty `constraints`** (a true
   full scan). Row reduction surfaces only as (i) an `IndexSeek`/`IndexScan` with
   `rangeBoundedOn` set — both rejected — or (ii) a surviving `FilterNode` above
   the scan, rejected by the walk. Empirically confirmed: a `where c.<col> = …`
   on the lookup table yields `predicate-entailment`/`shape`, never a false cover.
   The `RetrieveNode`-with-hidden-`moduleCtx`-filter concern matches existing
   `isRowPreservingPathToTable` practice (access selection replaces `RetrieveNode`
   with a physical leaf), so it introduces no new exposure. The `rangeBoundedOn`
   guard is conservative defense-in-depth.

3. *Equi-pair → base-column mapping.* **Confirmed sound.** The dual-orientation
   `tAttrToCol`/`lookupAttrToCol` lookup handles T-on-left and T-on-right; a pair
   referencing a third source fails both orientations ⇒ reject. Composite/permuted
   FK pairs are rejected by `lookupCoveringFK`'s positional alignment (verified by
   the composite-FK positive test and re-reading the alignment loop).

**Minor finding — FIXED INLINE (defense-in-depth):** the logical-`JoinNode` branch
of `pureJoinEquiAttrPairs` accepted any pure AND-of-column-equalities via
`isPureColumnEquiCondition`, but `extractEquiPairsFromCondition` **silently drops**
a column equality whose operands sit on the *same* side (e.g. `c.grp1 = c.grp2` —
a single-relation filter that restricts the join's row set). With the FK pair
still matched, that produced a latent false `Covers` path. It was not currently
exploitable — predicate pushdown hoists such conjuncts below the join into a
`FilterNode` that `resolveFullScanTableRef` rejects — but the soundness then
rested on an *external* optimizer invariant rather than a local check, contrary to
the module's "a false `Covers` is unsound ⇒ be conservative" bar. Fixed by
renaming the helper to `pureColumnEquiConjunctCount` (returns the conjunct count)
and rejecting in `pureJoinEquiAttrPairs` unless the extracted cross-side pair
count equals the conjunct count. Added a regression test (negative shape:
same-side equality in the ON clause). Legitimate single + composite FK joins are
unaffected (count == pairs).

**Tests.** Implement-stage tests (2 positive, 2 negative, 1 eager-link) cover the
happy path, the two key negatives (nullable FK, non-FK unique key), and the link
stamping. Added one regression test for the minor finding above. Full suite:
**3819 passing, 0 failing, 9 pending** (the 9 pending are pre-existing). Lint
clean. No `.pre-existing-error.md`.

**Docs.** `materialized-views.md` and `optimizer.md` updated by the implementer to
describe the two-path no-row-loss obligation and mark inner/cross FK→PK covering
as delivered; re-read both against the code — accurate. No stale "inner/cross
deferred" references remain anywhere (only full-outer stays deferred, correctly).
The renamed helper is internal; no doc named it. No doc change needed for the fix.

**Empty categories.** No **major** findings ⇒ no new fix/plan/backlog tickets
filed. The only finding was the minor defense-in-depth hardening above, fixed in
this pass.
