description: Generalize the decomposition optional-member / EAV-pivot UPDATE to admit non-constant assigned values. v1 (shipped in view-write-decomposition-optional-update) admits only a constant (or null) value for an optional/EAV write, because the matched-UPDATE evaluates the value in the member's scope while the materialize-INSERT evaluates it over the anchor — so only a scope-independent (constant) value survives both branches. A value referencing any column (`set c = a`, `set c = c + 1`, an anchor column, a cross-member read) rejects `unsupported-decomposition-update`.
files: packages/quereus/src/planner/mutation/decomposition.ts (lowerMaterializedValue, buildOptionalMaterializeInsert, buildEavMaterializeInsert), packages/quereus/src/planner/mutation/outer-join.ts (the __vmupd_keys per-row capture substrate, for arbitrary values)
----

## Use case

A decomposition-backed logical table whose optional columnar / EAV-pivot column is updated with an expression rather than a literal:

```sql
-- anchor-resolvable value (the value lives on the anchor the materialize already scans):
update x.T set c = id + 100 where id = 7;     -- absent rows materialize c from the anchor's id
update x.E set p = id * 2   where id = 7;      -- EAV analogue

-- member self-reference (matched-update-only — an absent row has no prior value):
update x.T set c = c + 1 where id = 7;         -- only present rows have a c to increment
```

Today every one of these rejects `unsupported-decomposition-update` (the constant-only narrowing).
The view image stays sound (reject-don't-widen), but the expressible surface is narrower than
the outer-join non-preserved UPDATE dual, which already threads arbitrary values via capture.

## Why it's deferred

The matched-UPDATE base op runs `set <col> = <value>` in the **member's** row scope; the
materialize-INSERT runs `select …, <value>, … from <anchor>` in the **anchor's** scope. A
constant is identical in both. A column-referencing value is not:

- An **anchor-resolvable** value (`id + 100`, where every leaf lowers to an anchor base column)
  *is* expressible over the anchor scan the materialize already builds — but the matched-UPDATE
  side, scoped to the member, cannot see the anchor column without a correlated subquery
  (`set c = (select id + 100 from <anchor> where <anchorKey> = <member>.<memberKey>)`). The
  generalization is to lower an anchor-resolvable value to that correlated form on the
  matched-UPDATE side and to the plain anchor projection on the materialize side.
- A **member self-reference** (`c + 1`) is matched-update-only by nature (an absent row has no
  prior value to read), so it should route to the matched UPDATE alone and **suppress** the
  materialize INSERT — i.e. it is a present-rows-only value write, not a materialization.
- An **arbitrary** value (cross-member, subquery) needs the per-row capture substrate the
  outer-join consumer 1 path uses (`__vmupd_keys`), which the decomposition fan-out does not
  yet wire in.

## Expected behavior

- An anchor-resolvable value materializes correctly for absent rows and updates matched rows,
  the two branches agreeing row-for-row (the round-trip / PutGet oracle holds).
- A member-self-reference value updates present rows only and leaves absent rows absent (no
  spurious materialization), with a clear rule for the all-null-result delete interaction.
- An arbitrary (capture-needing) value either rides the shared capture substrate or stays
  rejected with a precise, scope-explaining diagnostic — never silently widens.

## Notes

- Decide whether to share the outer-join `__vmupd_keys` capture or to special-case the
  anchor-resolvable subset first (the latter is a smaller, self-contained increment that
  covers the common `set c = <anchor expr>` case without the full capture machinery).
- Keep the constant-only path as the fast lane; only fall to capture when a value actually
  references a column.
