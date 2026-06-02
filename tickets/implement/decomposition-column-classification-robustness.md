description: Two latent robustness gaps in the decomposition `classifyColumn` lineage-driven routing (flagged as out-of-scope by `decomposition-non-identity-columnar-mapping-coverage` and confirmed during its review). Both concern currently-unreachable states that classify silently rather than rejecting defensively.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/test/lens-put-fanout.spec.ts
----

`classifyColumn` (decomposition.ts ~line 143) routes a logical column off the threaded
`updateLineage` (primary) plus the advertisement (deferred-shape disambiguation). Two assumptions
in that routing are currently unguarded. Neither is reachable through shipped shapes today, so this
is hardening, not an active bug — but each is an implicit dependency that should be made explicit
(defensive reject + test) so a future change cannot silently regress it.

## (a) Identity-mapping lineage-resolution miss degrades to read-only silently

The first gate resolves an identity base column from the lineage:

```ts
if (col?.baseColumn !== undefined && col.baseTableId !== undefined && col.inverse === undefined) {
    const member = shape.memberByTableId.get(col.baseTableId);
    if (member) return { kind: 'member', ... };           // writable
}
// else fall through:
for (const member of shape.storage.members)
    if (member.columns.some(c => c.logicalColumn.toLowerCase() === name))
        return { kind: 'computed-mapping', member };       // read-only
```

The `member.columns` fallback matches by `logicalColumn` **name only** — it does not re-confirm the
basis is non-identity. So if an *identity* mapping's lineage fails to resolve (e.g. a
`memberByTableId` schema+name miss), the column silently degrades to `computed-mapping`
(read-only) instead of erroring. This is the **fail-safe** direction (a writable column wrongly
becomes read-only, never the reverse), which is why it is low-severity — but it masks a lineage bug
as a benign "read-only column".

**Want:** a test that an identity mapping the lineage fails to resolve does **not** silently become
read-only — it should surface a `no-base-lineage`-style diagnostic. (Constructing such a miss
without tripping an earlier advertisement-resolution validation is the non-trivial part; that
discovery is the bulk of the work.)

## (b) Self-decomposition makes `memberByTableId` ambiguous

`analyzeDecomposition` builds `memberByTableId` by matching each lineage `TableReferenceNode`'s
`(schema, table)` to a member. Two members over the **same** physical base table (self-
decomposition) would both match the same `TableReferenceNode` id, and the build loop's
`Map.set` resolves it last-write-wins — silently picking one member. This is currently unreachable
because the multi-source path rejects self-joins, but that rejection is an *implicit* guard sitting
outside this code.

**Want:** a defensive reject (a clear `unsupported`/`ambiguous-member` diagnostic) when two members
resolve to the same base `TableReferenceNode`, plus a test, so the assumption is enforced locally
rather than relying on the upstream self-join rejection.

## Notes

- These are the two items the implement/review of
  `decomposition-non-identity-columnar-mapping-coverage` explicitly deferred. Low priority; group
  them or split if one turns out larger than expected.
- A third, related diagnostic-accuracy item (WHERE-filter on a computed *anchor* column reported as
  a "non-anchor member") is tracked separately in
  fix/`misleading-non-anchor-diagnostic-on-computed-anchor-column`.
