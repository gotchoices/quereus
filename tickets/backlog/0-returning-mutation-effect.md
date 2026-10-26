description: Add a `mutation_effect()` function usable in `returning` that tells the caller what each write did to each row — inserted, updated, deleted, or changed but no longer visible through the view — so callers can see the true effect of writes through views.
architecture: docs/view-updateability.md#returning-clauses
files: packages/quereus/src/func/builtins/mutation.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/sql-dml.md, docs/view-updateability.md, docs/functions.md
----
## Why

`returning` exists so the caller knows what a statement changed. Through a view, a write can change a row so that it no longer shows in the view. Examples: an update that falsifies the view's `where`, a set-operation flag flip that leaves a row in no branch, or clearing an outer-join existence flag. An insert can also land a row the view filters out. Today single-source update `returning` silently reports the NEW image of a pushed-out row, so the caller can't tell. Relational theory (Date / McGoveran) would call such a row a delete *from the view*. We keep returning the NEW image, because it is what the caller wrote, and label the effect explicitly.

## Specification (decided)

A nullary built-in, `mutation_effect()`, valid only inside a `returning` clause; elsewhere it errors, like `mutation_ordinal()`. It returns one text value per returned row, describing the change **relative to the statement's target**, the view or table the statement names:

| value | meaning |
|---|---|
| `'insert'` | the row was not in the target before and is now |
| `'update'` | the row was in the target before and after |
| `'delete'` | the row was in the target and is gone |
| `'exit'` | the write changed the row but its NEW image no longer shows in the view |
| `'hidden'` | the row was inserted but its NEW image does not show in the view |

- Decided: a **single** column, not separate action and visibility columns.
- Decided: an insert that resolves to modifying an existing row reports `'update'`. That covers `or replace` overwriting a row and `on conflict do update` (upsert). Same as Postgres.
- On a base-table target only `'insert'`, `'update'` and `'delete'` can occur, so tables and views stay interchangeable.
- "Shows in the view" means the NEW image satisfies the view body: its filter, its join match, set-operation membership (any branch flag true), and so on. For a nested view chain, judge against the **outermost** target the statement named.
- Callers filter by aliasing it: `with m as (update v … returning *, mutation_effect() as fx) select * from m where fx <> 'exit'`.

## Cost rule (hard requirement)

All cost is paid only when the statement's `returning` **references `mutation_effect()`**. A statement without `returning`, or with a `returning` that doesn't call it, must plan and run exactly as today, with no extra predicate evaluation, capture column, or per-row runtime-context write. Verify by inspection plus a plan-shape check (e.g. a query_plan / plan test) that the visibility test is absent when the function isn't referenced. Wherever possible resolve the value at plan time:

- a delete is always `'delete'`;
- an update of a base table is always `'update'`;
- an insert into a base table with no conflict clause that can update is always `'insert'`.

These should compile to a constant, with no runtime hook.

## Recommended mechanism (plan stage to confirm)

- Prefer **plan-time rewriting** over a runtime-context value. The builder that rewrites `returning`, when it sees `mutation_effect()`, substitutes an ordinary expression.
  - **Single-source view:** `case when <view predicate rewritten in NEW base terms> then 'update' else 'exit' end`, or `'insert'` / `'hidden'` for insert. The predicate is the body's selection lowered the same way `rewriteViewReturning` lowers view columns. A body whose visibility is not expressible as a row predicate over NEW (e.g. a `distinct` / aggregate body, if any such body is writable) needs a stated fallback.
  - **Join-view update:** the after-write re-query already joins the post-mutation body, and adds the view's filter only when needed. A row restricted out of the re-query is today simply dropped. Decide whether that drop is a silent "exit" bug to fix here: the update contract returns pushed-out rows on the single-source path. The two paths must agree.
  - **Join-view delete:** constant `'delete'`.
- Upsert / `or replace` on the base insert path needs a per-row signal of which branch fired. Read it off the insert executor only when the function is referenced. Check how the base `ReturningNode` is fed for the do-update branch today.
- Where the runtime-context route is unavoidable, follow the `mutation_ordinal()` pattern: a custom emitter reading a `RuntimeContext` field. The field must be set only when the plan says the function is used.
- The function must not be constant-folded into a wrong value. Nullary functions are not folded today (const-pass `classifyNode`), but a plan-time rewrite sidesteps this anyway.

## Edge cases & interactions

- A view chain (view over view): visibility against the outermost named target.
- An update whose NEW image still satisfies the filter on some sides but loses its join partner (join views).
- A computed view column inside the visibility predicate.
- `returning mutation_effect()` alone, with no other columns.
- Use inside a subquery within `returning`: decide whether to allow it or reject it.
- Use outside `returning` (select list, `where`, default, check): clear error.
- Materialized-view write-through: visibility against the MV's body.
- Statement as a DML-in-CTE source.
- Determinism: deterministic given the statement, so it is safe in any context that requires determinism.

## Docs

docs/sql-dml.md (`returning` section), docs/functions.md (built-in list), docs/view-updateability.md § `returning` Clauses. That section should state the effect contract and that pushed-out rows are reported with NEW image plus `'exit'`.

## TODO

- Confirm plan-time rewrite feasibility per path and the upsert signal; settle the join-update pushed-out discrepancy; write implement ticket(s). Sibling tickets view-returning-join-insert, view-returning-decomposition, view-returning-existence-flag-write and view-returning-set-op-writes each populate the function for their own paths.
