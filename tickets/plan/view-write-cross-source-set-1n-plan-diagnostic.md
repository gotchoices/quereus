description: A cross-source `set` whose **owning** side joins many partner rows (the 1:many direction — e.g. a parent-side column reading a child column) lowers to a correlated scalar read of `__vmupd_keys` that can return multiple rows. Today it fails at **runtime** with the generic `Scalar subquery returned more than one row`; consider a **plan-time** diagnostic that names the cross-source ambiguity instead.
files: packages/quereus/src/planner/mutation/multi-source.ts (capturedValueSubquery, gateCrossSourceReads, decomposeUpdate), packages/quereus/src/runtime/emit/subquery.ts
----

## Context

`view-write-cross-source-set` admits `update v set a.x = b.y` by projecting the partner
base column `b.y` into the up-front `__vmupd_keys` capture under a `srcN` alias and
rewriting the reference to `(select srcN from __vmupd_keys k where k.k<owner>_0 = <a.pk0>
…)` — correlated by the **owning** side's PK.

This is well-defined (exactly one capture row per owning PK) **only when the owning side
joins at most one partner row**. The shipped tests all use the child-reads-parent
direction (an FK is many-to-one, so each child joins exactly one parent → 1 row). In the
**reverse** direction — the owning side is the parent-like side that joins *many* partners
(`update v set pv = cv` where one parent matches many children) — the capture carries one
`srcN` row per joined pair, so the correlated read returns multiple rows.

## Current behavior (verified)

The genuinely-ambiguous direction is **not** silent corruption: the scalar-subquery
emitter (`runtime/emit/subquery.ts`) raises `Scalar subquery returned more than one row`
(`StatusCode.ERROR`) at execution. So the feature is safe — it errors rather than picking
an arbitrary partner — but the diagnostic is generic and does not point the user at the
cross-source `set` or explain *why* it is ambiguous.

## Desired

A plan-time rejection (or at least a clearer, cross-source-specific runtime message) for
the 1:many owning direction: when the owning side is not provably at-most-one against the
partner the `srcN` reads, raise a structured `unsupported-join` / dedicated reason naming
the column and the ambiguity ("a cross-source `set` value is ambiguous when the assigned
side joins more than one partner row"). This needs join-cardinality reasoning (an FK /
unique-key analysis on the join equalities — the inverse of the FK-correlation check
`edgeCorrelated` already used for delete ordering), so it is non-trivial and deferred here
rather than fixed inline.

Acceptance: `update v set pv = cv` on a parent-reads-child view rejects at plan time with a
message that names the cross-source ambiguity (or, if plan-time cardinality proof is
deemed too costly, the runtime error is reworded to mention the cross-source value).
