description: Reject duplicate column targets in the INSERT family (ON CONFLICT DO UPDATE SET <col>=..,<col>=.. and an explicit duplicate INSERT column list `insert into t (a,a) ...`), closing the silent last-wins hole the UPDATE-side sibling ticket left uncovered. The fix + tests are already applied and green in the fix-stage commit; this stage verifies and hands to review.
prereq:
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/test/logic/47-upsert.sqllogic, packages/quereus/test/logic/01.5-insert-select.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/src/planner/building/update.ts, docs/view-updateability.md
----

## Status: implementation applied in the fix-stage commit

The fix-stage run reproduced both bugs, implemented the corrections, and verified
them green. Code + tests are committed with the fix-stage commit. This implement
ticket exists to run the full build/test gate and hand a clean diff to review.

## What was changed

Both fixes live in `packages/quereus/src/planner/building/insert.ts` and mirror the
UPDATE-side backstop in `building/update.ts` (a name-based `Set` that rejects
unconditionally — no value-agreement softening; see `docs/view-updateability.md`
§ Diagnostics for the undecidability rationale).

### 1. `ON CONFLICT DO UPDATE SET <col> = …, <col> = …`

In `buildUpsertClausePlans` the DO-UPDATE assignments were collected into a
`Map<number, ScalarPlanNode>` keyed by resolved column index, so a second target for
the same column silently overwrote the first (last-wins). This path never routes
through `buildUpdateStmt`, so it now carries its own name-based `seenTargets` set over
`clause.assignments`, throwing before index resolution:

```
duplicate assignment to column '<col>' in ON CONFLICT DO UPDATE on '<table>'
```

(reuses the `duplicate assignment to column '<col>'` substring the UPDATE backstop
uses, so the `-- error: duplicate assignment` directive matches both.)

### 2. Explicit duplicate INSERT column list

In `buildInsertStmt`, the explicit-columns branch (`if (stmt.columns && …)`) mapped
`stmt.columns` to `targetColumns` with no duplicate check, so `insert into t (a, a)
values (1, 2)` resolved silently via positional row-expansion. A `seenColumns` set
over `stmt.columns` now rejects up front:

```
column '<col>' specified more than once in INSERT into '<table>'
```

(case-insensitive; substring `specified more than once` matches PostgreSQL's wording
and is stable for the `-- error:` directives.)

### View/lens INSERT decomposition spines — covered by the column-list guard

Confirmed during the fix stage that the view INSERT spines all re-plan through
`buildInsertStmt` with an explicit `columns` list, so the new column-list guard is the
single authoritative backstop for the INSERT analogue of the UPDATE collision:

- **Single-source** (`mutation/single-source.ts rewriteViewInsert`): builds
  `finalColumns` = base columns for each target view column. Two view columns lowering
  to one base column (e.g. `select id, b, b as b2 from t`, insert into `(id, b, b2)`)
  produce a duplicate base column in `finalColumns` → caught by the guard, message
  names the *base* column. This is the INSERT dual of the multi-source UPDATE generic
  fallback — we deliberately rely on the generic backstop rather than synthesizing a
  view-aware "both target base column" message (the ticket explicitly offered this
  option; chosen for symmetry with the multi-source UPDATE side and minimal surface).
- **Multi-source join** (`view-mutation-builder.ts buildMultiSourceInsert` →
  `multi-source.ts analyzeMultiSourceInsert`): each side's `targetColumns` is
  `[key, …supplied base columns]`; a same-side two-view-columns-to-one-base-column
  collision lands a duplicate there → caught. (The shared join key exposed twice is
  rejected earlier with a dedicated `unsupported-join` diagnostic — distinct concern.)
- **Decomposition** (`buildDecompositionInsert` → `analyzeDecompositionInsert`): each
  member insert's `columns` likewise routes through the guard.

## Tests added (all green)

- `test/logic/47-upsert.sqllogic` (Error cases): DO-UPDATE-SET duplicate rejects, and
  the row keeps its pre-conflict value (asserts no last-wins).
- `test/logic/01.5-insert-select.sqllogic` §11: duplicate INSERT column list (direct
  and case-insensitive) rejects; table stays empty.
- `test/logic/93.4-view-mutation.sqllogic` (Conflicting-assignment section): INSERT
  through `cfl_dup` (`b`, `b as b2` → base `b`) rejects via the generic backstop; no
  row inserted — the INSERT dual of the multi-source UPDATE fallback already there.

## Verification done in fix stage

- `yarn build` (root) — clean.
- `node test-runner.mjs --grep "47-upsert|01.5-insert-select|93.4-view-mutation"` — 3 passing.
- Broader sweep `--grep "29.1|29.2|43.1|47.1|41-fk|01.6-update-extras|insert|conflict|upsert|view-mutation|view"` — 224 passing.
- `yarn lint` (quereus) — clean.

## TODO (implement stage)

- Run the full `yarn test` once from the repo root to confirm no wider regression
  (the fix stage ran targeted + broad-grep subsets, not the whole suite). Stream with
  `tee` per AGENTS.md; if a failure is plainly unrelated, flag via
  `tickets/.pre-existing-error.md` rather than chasing it here.
- Skim the final diff of `building/insert.ts` for the two guards (comments + message
  wording) and hand off to review with a note that the view-aware-message-vs-generic
  decision (item 2 above) is the one judgement call worth a reviewer's eye.
