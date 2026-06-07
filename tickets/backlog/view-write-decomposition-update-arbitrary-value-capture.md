description: Admit an **arbitrary** assigned value (cross-member read, embedded subquery, or a mixed anchor+self expression) in a decomposition optional-columnar / EAV-pivot UPDATE by sharing the outer-join `__vmupd_keys` per-row capture substrate. The anchor-resolvable and member-self-reference subsets ship in `view-write-decomposition-optional-update-nonconstant-value` via an upsert / matched-update-only special-case; this is the remaining case that genuinely needs a captured-identity substrate, currently rejected `unsupported-decomposition-update`.
files: packages/quereus/src/planner/mutation/decomposition.ts (lowerMaterializedValue classifier — the `arbitrary` reject branch), packages/quereus/src/planner/mutation/multi-source.ts (MS_UPDATE_KEYS_CTE, buildMultiSourceKeyCapture, CrossSourceValue, capturedValueSubquery — the capture substrate to share), packages/quereus/src/planner/building/view-mutation-builder.ts (the builder that wires the capture for multi-source)
----

## Use case

A decomposition-backed logical table whose optional / EAV column is updated with a value the
single-special-case increment cannot express over the anchor scan alone:

```sql
-- cross-member read (c on T_c, b on T_b — different members):
update x.T set c = b + 1 where id = 7;

-- mixed anchor + member self (needs the anchor part as a per-leaf correlated read):
update x.T set c = c + a where id = 7;

-- embedded subquery value:
update x.T set c = (select max(v) from other) where id = 7;

-- EAV self-reference (the value column substitutes to a correlated subquery in the get body):
update x.E set p = p + 1 where id = 7;
```

Today each rejects `unsupported-decomposition-update` (precise, scope-explaining), after the
anchor-resolvable / self-reference cases were admitted.

## Why it's deferred

The matched-UPDATE base op runs in the **member's** row scope; the materialize-INSERT runs over
the **anchor**. A value that is neither anchor-resolvable (expressible over the anchor scan) nor
a pure member self-reference (present-rows-only) is not expressible in either branch directly —
it needs the per-row capture the outer-join non-preserved UPDATE already uses: every affected
view row's base identities + the partner base values it reads are materialized **once** into the
`__vmupd_keys` set (before any base op fires), and each lowered base op reads the captured value
back via a correlated scalar read keyed by the owning side's PK (`multi-source.ts`
§ `CrossSourceValue` / `capturedValueSubquery`). The decomposition fan-out emits plain AST
`BaseOp[]` and does not yet wire this capture in.

## Expected behavior

- An arbitrary value materializes/updates the optional or EAV member correctly across matched
  and absent rows, the branches agreeing row-for-row against the captured pre-mutation values
  (the PutGet / round-trip oracle holds), including a both-sides write that rewrites a value the
  other branch reads.
- Anything still genuinely inexpressible stays rejected with a precise diagnostic — never a
  silent widen of the view image.

## Notes

- Decide whether to reuse `multi-source.ts`' capture machinery directly (the `BaseOp[]` model
  would need to carry an up-front capture relation, as the multi-source builder does) or to
  generalize the decomposition fan-out to the same plan-node substrate the multi-source path
  uses. The decomposition fan-out is currently pure-AST `BaseOp[]`; the capture is plan-node, so
  this likely entails routing the decomposition non-constant UPDATE through (or alongside) the
  builder rather than `propagate`.
- Prereq landed: the anchor-resolvable / self-reference special-cases. This ticket only needs to
  re-classify the `arbitrary` branch onto the capture and remove its reject.
