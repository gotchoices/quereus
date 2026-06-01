description: `view_info()` over-reports updateability for non-inner multi-table join bodies (cross / comma / >2-table) — the same YES-when-NO class as the outer-join divergence, but not detectable from `null-extended` lineage.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic
----

# view_info() over-reports non-inner-join multi-table bodies

`propagateMultiSource` / `collectJoinSources`
(`packages/quereus/src/planner/mutation/multi-source.ts`) accepts **only**
two-table inner equi-join bodies. Every other multi-table shape — cross join,
comma (implicit) join, `> 2` tables — is rejected with `unsupported-join`.

But those bodies produce strict-`base` update lineage (no `null-extended`
wrappers; only LEFT/RIGHT/FULL outer joins null-extend — see
`deriveJoinUpdateLineage`). So `deriveViewInfo` (`func/builtins/schema.ts`)
treats them like a writable inner join: it lists every base in
`effective_targets` and reports `is_updatable = 'YES'` (and possibly
`is_insertable_into` / `is_deletable`), while a real mutation through the view is
rejected. This is the same dangerous YES-when-NO class as the outer-join
divergence fixed by `view-info-dynamic-truth-alignment`, but the null-extended
gate added there does **not** catch it (these shapes carry no null-extended
lineage).

Discovered while implementing `view-info-dynamic-truth-alignment`; deliberately
left out of that pass because the fix needs a different mechanism — an AST/plan
shape check (join type + arity, mirroring what `collectJoinSources` accepts),
not a lineage read. The two-table inner-equi-join positive case (`ms_jv`) must
keep reporting writable.

## Expected behavior

`view_info()` should report the conservative all-`NO` / `'[]'` row for any
multi-table body the substrate's `propagate()` does not accept (cross / comma /
`> 2`-table joins), and continue reporting the two-table inner equi-join shape as
updatable. The surface must agree with what `propagate()` actually accepts, with
sqllogic coverage cross-checking each case against a real (accepted or rejected)
mutation through the view.
