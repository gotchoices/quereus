description: Review the INSERT-family duplicate-column-target rejection. Two new name-based guards in building/insert.ts close the silent last-wins hole for (a) `ON CONFLICT DO UPDATE SET <col>=..,<col>=..` and (b) an explicit duplicate INSERT column list `insert into t (a,a) ...`, plus the view-INSERT analogue that lowers two view columns to one base column. Build + full `yarn test` + lint all green. The one judgement call worth adversarial eyes is the view-aware-message-vs-generic-message decision (see § Judgement call).
prereq:
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/test/logic/47-upsert.sqllogic, packages/quereus/test/logic/01.5-insert-select.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What this closes

Sibling ticket `view-update-conflicting-base-column-assignments-silent-last-wins`
(already through review, now in `complete/`) hardened the UPDATE side against
assigning the same base column twice. This ticket closes the INSERT-family analogue:
two silent last-wins holes that the UPDATE work left uncovered.

Both fixes are in `packages/quereus/src/planner/building/insert.ts` and deliberately
mirror the UPDATE-side backstop in `building/update.ts` — a name-based `Set` that
rejects **unconditionally** (no value-agreement softening). The undecidability
rationale for "reject, don't try to prove the two values agree" lives in
`docs/view-updateability.md` § Diagnostics.

### Guard 1 — `ON CONFLICT DO UPDATE SET <col> = …, <col> = …`
`insert.ts:329-359` (`buildUpsertClausePlans`). The DO-UPDATE assignments are collected
into a `Map<number, ScalarPlanNode>` keyed by resolved column index — a second target
for the same column silently overwrote the first (last-wins). This path never routes
through `buildUpdateStmt`, so it now carries its own `seenTargets` set over
`clause.assignments`, throwing **before** index resolution:
```
duplicate assignment to column '<col>' in ON CONFLICT DO UPDATE on '<table>'
```
Reuses the `duplicate assignment to column` substring the UPDATE backstop uses, so a
single `-- error: duplicate assignment` directive matches both sides.

### Guard 2 — explicit duplicate INSERT column list
`insert.ts:484-503` (`buildInsertStmt`, explicit-columns branch). `stmt.columns` was
mapped to `targetColumns` with no duplicate check, so `insert into t (a, a) values
(1, 2)` resolved silently via positional row-expansion. A `seenColumns` set over
`stmt.columns` now rejects up front (case-insensitive; the message preserves the
user's original casing of the offending name):
```
column '<col>' specified more than once in INSERT into '<table>'
```
Substring `specified more than once` matches PostgreSQL's wording.

### View/lens INSERT analogue — folded into Guard 2
The view INSERT decomposition spines all re-plan through `buildInsertStmt` with an
explicit `columns` list, so Guard 2 is the single authoritative backstop for the INSERT
analogue of the multi-source UPDATE collision. When two view columns lower to one base
column (e.g. `select id, b, b as b2`, insert into `(id, b, b2)`), the rewritten column
list carries a duplicate **base** column → Guard 2 fires, naming the base column.
Spines confirmed to route through Guard 2 (during the fix stage):
- single-source `mutation/single-source.ts rewriteViewInsert` (`finalColumns`)
- multi-source join `view-mutation-builder.ts buildMultiSourceInsert` → `multi-source.ts analyzeMultiSourceInsert` (per-side `targetColumns`)
- decomposition `buildDecompositionInsert` → `analyzeDecompositionInsert` (per-member `columns`)

## Verification done this stage (implement gate)
- `yarn build` (root) — clean.
- `yarn test` (root, **full suite, all workspaces**) — green: quereus **4411 passing / 9 pending**,
  plus all sibling workspaces (sync/store/isolation/etc.) passing, 0 failing. `Done in 3m 5s`.
  (The sync workspace logs expected `Error: boom` / `batch write failed` lines — those are
  negative-path tests asserting error handling, not failures.)
- `yarn workspace @quereus/quereus run lint` — clean.

## Tests added (all green) — treat as a floor
- `test/logic/47-upsert.sqllogic` (Error cases): DO-UPDATE-SET duplicate rejects, and the
  conflict row keeps its **pre-conflict** value (`name` stays `'Updated'`, asserting no
  last-wins to `'one'`/`'two'`).
- `test/logic/01.5-insert-select.sqllogic` §11: duplicate INSERT column list — direct
  (`(a, a)`) and case-insensitive (`(a, b, A)`) — both reject; table stays empty.
- `test/logic/93.4-view-mutation.sqllogic` (Conflicting-assignment section): INSERT through
  `cfl_dup` (`b`, `b as b2` → base `b`) rejects via Guard 2; no row inserted.

## § Judgement call worth a reviewer's eye
For the **view INSERT** case, the error names the **base** column (`b`), not the view
column the user actually wrote (`b2`). The fix stage deliberately chose to lean on the
generic Guard-2 backstop rather than synthesize a view-aware "both target base column
'b'" message — for symmetry with the multi-source UPDATE side (which also uses its
generic backstop) and to minimize surface. The ticket explicitly offered the view-aware
message as an option and it was declined. Reviewer call: is base-column naming acceptable
UX for a user inserting through a view, or does it warrant a view-aware message? If the
latter, that is a new `fix/` ticket, not an inline tweak (it touches the view-spine
builders, not just `insert.ts`).

## Known gaps / honest floor for the reviewer
- **DO-UPDATE-SET case-insensitivity is untested.** Guard 1 lowercases (`assign.column.toLowerCase()`),
  but the 47-upsert test only exercises a same-casing duplicate (`name = 'one', name = 'two'`).
  A `name = .., NAME = ..` case-variant assertion would lock in the case-insensitive behavior.
  Low risk (code is plainly case-insensitive) but the directive isn't pinned by a test.
- **Multi-source / decomposition view INSERT collisions are untested.** Only the
  single-source `cfl_dup` spine has a behavioral test (93.4). The claim that the
  multi-source-join and decomposition spines also route through Guard 2 was confirmed by
  reading the spines in the fix stage, not by a green test. A reviewer wanting belt-and-
  suspenders coverage could add a join-view and a decomposition-view INSERT-collision case
  to 93.4 (or 93.x).
- **No test that a *legitimate* multi-column INSERT/upsert still works** sits adjacent to
  these new guards — existing suites cover the happy path broadly, but a reviewer skimming
  for false-positive risk (guard rejecting a valid distinct-column list) should confirm the
  guards only key on exact-name collision, never on distinct columns that merely share a prefix.

## Where to look first
`packages/quereus/src/planner/building/insert.ts` lines 329-359 (Guard 1) and 484-503
(Guard 2). Compare against the UPDATE-side backstop in `building/update.ts` for the
intended mirror. Both guards throw during planning/building, before any plan node is
constructed or any side effect runs.
