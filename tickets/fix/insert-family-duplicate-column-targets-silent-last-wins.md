description: The UPDATE-side duplicate-assignment fix (view-update-conflicting-base-column-assignments-silent-last-wins) closed the silent last-wins hole for plain/view UPDATE, but the INSERT family has the same class of bug on two paths that never route through `building/update.ts buildUpdateStmt`: (1) `ON CONFLICT DO UPDATE SET b = 1, b = 2` and (2) an explicit duplicate INSERT column list `insert into t (a, a) values (1, 2)`. Both silently apply last-wins instead of rejecting.
prereq:
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/test/logic/01.6-update-extras.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## Background

The sibling ticket `view-update-conflicting-base-column-assignments-silent-last-wins`
made a duplicate SET target in an UPDATE reject unconditionally (no value-agreement
softening), with the authoritative backstop in `building/update.ts buildUpdateStmt`
(a name-based `Set<string>` over `stmt.assignments`) plus view-aware diagnostics on
the single-source and decomposition spines.

That backstop only guards statements re-planned through `buildUpdateStmt`. The INSERT
builder (`building/insert.ts`) does **not** route through it, so two INSERT-family
shapes retain the original silent last-wins behavior:

### 1. `ON CONFLICT DO UPDATE SET <col> = ..., <col> = ...`

`buildUpsertClause` (around `insert.ts:329-345`) builds the DO-UPDATE assignments into
a `Map<number, ScalarPlanNode>` keyed by resolved column index:

```ts
const assignments = new Map<number, ScalarPlanNode>();
for (const assign of clause.assignments) {
    const colIndex = tableSchema.columns.findIndex(c => c.name.toLowerCase() === assign.column.toLowerCase());
    ...
    assignments.set(colIndex, valueNode);   // <-- second target for the same col silently overwrites
}
```

So `insert into t values (1, 10) on conflict (id) do update set b = 1, b = 2`
silently applies `b = 2` with no diagnostic — exactly the bug the UPDATE ticket
eliminated, on a path it never covered.

### 2. Explicit duplicate INSERT column list

`insert.ts:471-489` maps `stmt.columns` to `targetColumns` with no duplicate check, so
`insert into t (a, a) values (1, 2)` produces two target slots for one base column.
The positional row-expansion then resolves it silently (last-wins or a confusing
count/shape outcome) rather than rejecting. PostgreSQL rejects this with
*"column \"a\" specified more than once"*.

## Expected behavior

Both shapes should reject **unconditionally** (no value-agreement softening — matching
the UPDATE-side decision and the undecidability rationale documented in
`docs/view-updateability.md`):

- `on conflict do update set b = 1, b = 2` → error naming the duplicated column.
- `insert into t (a, a) values (...)` → error naming the duplicated column.

Reuse the established message style where practical (the UPDATE backstop uses
`duplicate assignment to column '<col>' ...`). Keep messages substring-stable for the
`-- error:` sqllogic directives.

## Notes / scope

- Both fixes live in `building/insert.ts`. The DO-UPDATE-SET fix mirrors the
  `building/update.ts` backstop (a name-based `Set` over `clause.assignments` before
  the index resolution). The column-list fix is a `Set` over `stmt.columns`.
- Confirm the view/lens INSERT decomposition spines (multi-source / decomposition
  inserts) either route through the same guard or get an equivalent check — a view
  whose two columns lower to one base column on an INSERT is the INSERT analogue of
  the UPDATE collision the sibling ticket handled on the lowering spines.
- Add logic tests: a DO-UPDATE-SET duplicate (assert no last-wins — the row keeps its
  pre-conflict value for the column), and a duplicate INSERT column list. The sibling
  ticket's tests live in `01.6-update-extras.sqllogic` §8 and `93.4-view-mutation.sqllogic`;
  co-locate or add a focused INSERT section.
- Reconsider whether to add a `conflicting-assignment` style view-aware message for the
  INSERT-through-view case or rely on a generic backstop, mirroring the UPDATE layering.
