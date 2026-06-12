description: count(*) (and other aggregates without an explicit returnType) derive REAL nullable — count should be INTEGER not-null; the strict declared-shape check on maintained tables now surfaces this quirk directly to authors.
files:
  - packages/quereus/src/func/registration.ts        # createAggregateFunction defaults returnType to REAL nullable
  - packages/quereus/src/func/builtins/aggregate.ts  # countStarFunc / countFunc omit returnType
difficulty: easy
----

# Aggregate return-type fidelity (count(*) is REAL nullable)

`createAggregateFunction` defaults `returnType` to `REAL, nullable: true` when
the registration omits it, and `count(*)` / `count(x)` omit it. So a body like

```sql
select w, count(*) as n from words group by w
```

derives `n` as `REAL` nullable, although count always returns a non-null
integer.

This was a latent cosmetic quirk until the maintained-table declared-shape
forms landed: `create table … maintained as` and `alter table … set maintained
as` require the declared shape to match the derived shape **verbatim** (types
and nullability exact, both directions), so an author materializing a count
must today declare the column as `n real null` — pinned, with a comment, in
`test/logic/51.7-maintained-table-attach-detach.sqllogic` § 5 (the aggregate
attach case). Column-info introspection and type-driven host bindings see the
same wrong type.

## Expected behavior

- `count(*)` and `count(x)` report `INTEGER` (or the engine's integer logical
  type) and `nullable: false` — count of an empty group is 0, never null.
- Audit the other builtin aggregates registered without an explicit
  `returnType` (sum/avg/min/max/total/group_concat, window-function variants
  in builtin-window-functions.ts): each should declare the type it actually
  returns (e.g. `avg` REAL nullable is correct; `min`/`max` follow the
  argument type via `inferReturnType`; `sum` is nullable by SQL semantics).
- Update the 51.7 aggregate-attach case (and any other pinned expectation) to
  the corrected derived shape — the strict shape check makes those tests the
  regression net for this change.
