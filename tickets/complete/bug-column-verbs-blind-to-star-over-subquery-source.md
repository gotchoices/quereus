description: Renaming or dropping a table column now sees columns that pass through a nested query in a FROM clause, so saved views keep working after a rename, a drop is refused while a rule still reads the column through such a query, and a CHECK no longer changes meaning when its nested query reads a like-named column from another table.
files:
  - packages/quereus/src/schema/rename/column-rename.ts
  - packages/quereus/test/schema/column-scope-body-spellings.spec.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic
  - packages/quereus/src/schema/schema-differ.ts
  - docs/sql-alter.md, docs/sql-ddl.md, docs/sql-alter-rename.md
----

# Column verbs: infer the output columns of a FROM-clause subquery source

## What landed

The scope walk shared by `ALTER TABLE … RENAME COLUMN` and `DROP COLUMN` (`schema/rename/column-rename.ts`) now gives an inline subquery source (`from (select …) s`) a qualifier and an askable column set:

- Each FROM source's own contents (subquery bodies, function-source arguments) are walked before the enclosing select's FROM frame is pushed, matching the planner, which builds each source on the enclosing context. The right side of a `join lateral` gets a frame built from its left side, matching the planner's `buildJoin`.
- A subquery source with no column list whose (already rewritten) body re-exposes the renamed column binds its alias to the rename target, like an exposing CTE. Otherwise it binds a derived key no real object key can equal.
- `ScopeFrame.sources: FrameSource[]` (`{ key, publishes(colLower) }`) replaces `realSources`. Real tables answer through the catalog callback; subquery sources answer from their column list or lazily from their body (`queryPublishesColumn`) against the scope captured when the source was bound. The bare-ref shadow scan and the `*` / `q.*` expansion in `bodyPublishesColumnNamed` both use it.
- A function source binds its qualifier (`alias ?? functionName`) to a derived key, so `f.x` is no longer mistaken for a real table named `f`. It is not askable (see the backlog ticket below).

Tests: the two subquery-source cells of `column-scope-body-spellings.spec.ts` now run on every arm; `41.3` cases 15b (CHECK through a subquery source), 15c (function-source qualifier), 15d (lateral, added in review); `41.10.2` drop through a subquery source.

## Review findings

Read the `ticket(implement): bug-column-verbs-blind-to-star-over-subquery-source` diff before the handoff.

**Correctness — checked, no defect found.** Confirmed against `planner/building/select.ts` that function sources and subquery sources are built on the enclosing context (so moving function-source args before the frame is right) and that only `join lateral` exposes the left side. Exercised with throwaway sqllogic (deleted): lateral right side reading an exposing left subquery source (`s.x`); a CTE consumed inside a subquery source; a subquery source aliased with the renamed table's own name reading another table (`select t.x from (select x from u) t` — previously would have been wrongly rewritten, now correctly left alone); a correlated `exists` over a subquery source; a star-over-subquery inside a CTE body; a recursive CTE whose anchor reads a subquery source; a CHECK whose subquery source pins the name with a column list (`s(v)`), across both rename and drop; drop refused under an assertion reading a lateral view. All behaved correctly. The `publishes` closures copy the scope stack array at bind time and never visit (no `changed` / `bareSeedHit` mutation), so the lazy evaluation is safe.

**Tests — one added, none cut.** The lateral branch of `visitFromSourceContents` is real scoping logic with no committed coverage, so added `41.3` case 15d (view with `join lateral (select x + 1 as y)` survives `rename column x`). Confirmed it fails (`Column not found: x`) with the lateral branch disabled, and passes in memory and store mode. The implementer's new cases each reproduce a distinct defect; the spec-file change removes pending plumbing rather than adding tests. Nothing to cut.

**Source hygiene — one fix.** Re-wrapped an over-long doc-comment line in `bodyPublishesColumnNamed`. Comments added by the change explain why (planner scoping, NUL-key trick), not what.

**Docs — checked.** `docs/sql-alter.md`, `docs/sql-ddl.md`, `docs/sql-alter-rename.md` describe the new behaviour and the remaining limit accurately; the schema-differ comment was updated for the renamed field.

**Major / filed.** Function sources and non-exposing CTE sources remain unaskable; filed by the implementer as `tickets/backlog/bug-column-verbs-capture-bare-ref-through-unaskable-source.md` (verified repro, severity/likelihood/tradeoffs present). Checked it: one site, two arms, correct anchor — no change needed.

**Tripwires (already parked by the implementer, reviewed and kept).** Re-inference cost of `queryPublishesColumn` — `NOTE:` at that function. Lateral body exposure of a left-side column — `NOTE:` on `visitFromSourceContents`.

**Noted, not filed.** The column walker never visits an `update` / `delete` inline subquery target (`targetSource`), unlike the table walker. Pre-existing and unchanged by this ticket, and no stored body kind (views, assertions, CHECK/DEFAULT) can carry a DML statement today, so it is unreachable. The contrived duplicate-output-name case named in the handoff is likewise left as is.

**Size.** `column-rename.ts` is 1,627 lines (`wc -l`); already tracked in `tickets/backlog/debt-oversized-source-files.md`.

**Validation.** `yarn workspace @quereus/quereus run lint` clean; `yarn test` all green (quereus 11,174 passing, 23 pending); store mode for `41.3` and `41.10.2` green after `tsc -b tsconfig.build.json`.
