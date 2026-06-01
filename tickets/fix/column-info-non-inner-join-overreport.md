description: `column_info(name)` over-reports per-column updateability for non-inner multi-table join bodies (cross / comma / >2-table) — the same YES-when-NO class as `view-info-non-inner-join-overreport`, but at column grain, and not detectable from `null-extended` lineage.
prereq: view-info-non-inner-join-overreport
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic
----

# column_info() over-reports non-inner-join multi-table bodies

`deriveColumnInfo` (`packages/quereus/src/func/builtins/schema.ts`) is the
column-granular companion to `deriveViewInfo` and shares its weakness for
non-inner multi-table join bodies.

`propagateMultiSource` / `collectJoinSources`
(`packages/quereus/src/planner/mutation/multi-source.ts`) accepts **only**
two-table inner equi-join bodies. Every other multi-table shape — cross join,
comma (implicit) join, `> 2` tables — is rejected with `unsupported-join`.

But those bodies produce strict-`base` update lineage (no `null-extended`
wrappers; only LEFT/RIGHT/FULL outer joins null-extend — see
`deriveJoinUpdateLineage`). So `deriveColumnInfo` reads a plain `base` site for
each passthrough column, resolves it to a producing `TableReferenceNode`, and
reports `is_updatable = 'YES'` with a `base_table`/`base_column` trace — while a
real mutation through the view is rejected wholesale. This is the **same
dangerous YES-when-NO class** the sibling `view-info-non-inner-join-overreport`
ticket fixes for the view-level surface; the `null-extended` outer-join gate
added in this review pass (`hasNullExtendedLineage`) does **not** catch it
(these shapes carry no null-extended lineage).

The fix needs the same mechanism the sibling ticket will introduce — an
AST/plan **shape check** (join type + arity, mirroring what `collectJoinSources`
accepts), not a lineage read. This ticket has a `prereq:` on
`view-info-non-inner-join-overreport` so that whatever shared shape-check helper
that ticket lands in `schema.ts` (or `multi-source.ts`) is available for
`deriveColumnInfo` to reuse — the same way `hasNullExtendedLineage` /
`buildTableRefsById` are shared between the two derivations today.

## Expected behavior

For any multi-table body the substrate's `propagate()` does not accept (cross /
comma / `> 2`-table joins), `column_info(name)` must report **every** output
column `is_updatable = 'NO'` with `null` `base_table`/`base_column` — agreeing
with `view_info()`'s conservative row and with what `propagate()` actually
accepts. The two-table inner equi-join positive case (`ms_jv` in
`06.3.5-column-info.sqllogic`) must keep reporting each column updatable with its
per-source trace.

sqllogic coverage must cross-check each new case against a real (accepted or
rejected) mutation through the view, mirroring the `oj_left` outer-join case
already in `06.3.5-column-info.sqllogic` (which pairs the all-`NO` expectation
with an `update … → error: cannot write through view`).
