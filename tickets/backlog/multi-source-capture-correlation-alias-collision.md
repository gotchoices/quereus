description: A cross-source `set` value's correlated capture read-back (`capturedValueSubquery`) and the strip's owning-alias-stripped-to-bare refs use UNQUALIFIED owning-side column names; when the rewrite lands inside a user value subquery whose FROM has a same-named column, innermost-scope rules rebind them to the inner source — a silent wrong result. The multi-source lowered per-side statement needs a collision-proof correlation alias (the analog of single-source SELF_ALIAS) and qualified correlation refs.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts   # capturedValueSubquery (~2562): bare `<pk_j>` right operands; stripSideQualifier qualified-strip-to-bare branch
  - packages/quereus/src/planner/mutation/single-source.ts  # SELF_ALIAS pattern (rewriteViewUpdate/Delete) — the prior art
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

# Multi-source value-subquery correlation refs can rebind to inner FROM columns

## Problem

Two related name-capture hazards in the multi-source SET-value lowering, both
pre-existing and orthogonal to the bare-projection routing work:

1. **Capture read-back correlation.** A routed partner read lowers to
   `(select srcN from __vmupd_keys k where k.k<i>_0 = <pk0> …)` where `<pk0>` is a
   **bare** owning-side PK column name intended to correlate out to the lowered
   single-table UPDATE's target row. When the partner read sits inside a user value
   subquery (`set cval = (select … from t where … p.pv …)`), the capture subquery
   nests inside that subquery — and if `t` has a column named like the owning PK
   (e.g. `cid`), the bare ref binds to `t.cid` instead of the target row's. The
   per-row read-back silently keys on the wrong value.

2. **Owning-alias strip to bare.** `stripSideQualifier` rewrites an owning-side
   qualified ref (`c.cval`) to a bare `cval` at every nesting depth. Inside a nested
   value subquery whose FROM also has `cval`, the stripped ref rebinds locally
   instead of correlating to the UPDATE target row. (The single-source spine solved
   the identical problem with the synthesized `__vm_self` correlation alias and
   deep qualification — see docs/view-updateability.md, "The correlation name itself
   is chosen to be collision-proof".)

## Expected behavior

A correlation reference produced by the lowering must bind to the lowered statement's
target row regardless of what names the user's value subqueries introduce. The likely
shape mirrors single-source: give the lowered per-side UPDATE a synthesized
collision-proof alias and qualify both the capture read-back's PK operands and the
stripped owning-side refs with it (only when emitted inside a subquery operand, or
unconditionally if harmless). Ordinary non-colliding statements must lower
byte-identically or at least plan-identically.

## Repro sketch

View `select c.cid as cid, cval, p.pv as pv from c join p on p.pid = c.pref`;
`update v set cval = (select max(x) from t where x < p.pv)` — wrong-keyed read-back
when `t` has a `cid` column; and `set cval = (select max(x) from t where x < cval)`
binds the inner `t.cval` if present (may even be the user's intent under SQL rules —
the qualified-strip case needs care to distinguish user-authored owning refs, which
legitimately follow innermost-scope binding, from lowering-injected ones).
