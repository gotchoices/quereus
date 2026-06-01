description: Review the two view_info() ↔ dynamic-mutation truth-alignment fixes — default_for tag-default insertability recovery (Divergence 1) and the body-level outer-join conservative gate (Divergence 2).
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md
prereq:
----

# Review — view_info() ↔ dynamic-mutation truth alignment

Implemented both divergences from the plan ticket. Build, full quereus test
suite (4226 passing / 9 pending), and lint all pass. The work was deliberately
**minimal and surgical** — all changes live in `deriveViewInfo` + two small
helpers in `func/builtins/schema.ts`; no substrate (`planner/mutation/*`,
`update-lineage.ts`) was touched, matching the plan's "option (c) view-level
minimal fix" / "body-level gate" direction.

## What changed

**Divergence 1 — `default_for` tag-defaults now recover `is_insertable_into`.**
`deriveViewInfo` now imports `readDefaultFor` (`planner/mutation/mutation-tags.js`)
and, after the whole-spine `defaultable` walk, folds each view-level
`quereus.update.default_for.<col>` tag into the per-table `defaultable` map,
mirroring `resolveDefaultForColumn` (`single-source.ts`):
- base column of a reachable target (the common projected-away case) — added to
  every `targetId` whose `tableSchema.columns` has a name match;
- else a visible view-output column with base lineage — resolved via
  `baseSiteOf(rootLineage.get(attr.id))`;
- else (a typo / unresolvable name) **silently skipped** — the read-only surface
  keeps its never-throw posture (the rewrite raises `tag-target-not-found`, but
  here a throw would be caught by the per-view try/catch and collapse the whole
  row to all-`NO`).
New helper `addDefaultable(map, table, baseColumn)` (also refactors the existing
spine walk onto it — no behavior change there).

**Divergence 2 — outer-join bodies short-circuit to conservative.** New
predicate `hasNullExtendedLineage(nodes)` scans every collected body node's
`updateLineage` for a `null-extended` site; `deriveViewInfo` returns
`CONSERVATIVE_VIEW_INFO` immediately when found (placed right after
`collectBodyNodes`, before the target walk). This makes `view_info()` agree with
`propagate()`, which rejects LEFT/RIGHT/FULL outer joins wholesale today
(`collectInnerJoinSources`, `multi-source.ts:478`). The `baseSiteOf` doc comment
was updated to note its `null-extended` unwrap is now defensive only (the gate
clears such bodies before `baseSiteOf` is reached).

**Docs.** `docs/view-updateability.md` § Information Schema Surface gained an
explicit **Outer-join contract** paragraph (deliberate today-truth gate, to be
relaxed to per-side writability when outer-join write materialization lands) and
a confirming note that `default_for` is honored from view-level `with tags` DDL.

## How to validate / use cases

All in `test/logic/06.3.4-view-info.sqllogic` (run:
`yarn workspace @quereus/quereus run test --grep "06.3.4-view-info|93.4-view-mutation"`):

- **Divergence 1 rescue:** `dfi (id pk, name, created int not null)` + `dfi_v` =
  `select id, name from dfi with tags ("...default_for.created" = '999')` →
  `is_insertable_into = YES`, cross-checked by a real
  `insert into dfi_v (id, name) values (1,'x')` landing `created = 999`.
- **Negative control:** `dfi_v_notag` (same shape, no tag) → `NO` — isolates the
  tag as the sole cause.
- **Unresolvable-name control (added beyond the plan):** `dfi_v_typo` with
  `default_for.nope` → `NO`, proving the silent-skip path does not throw and does
  not spuriously rescue.
- **Divergence 2:** LEFT (`oj_left`), RIGHT (`oj_right`), FULL (`oj_full`) join
  views all report all-`NO`/`[]`. LEFT additionally cross-checked: `update
  oj_left set av='z' where aid=1` → `-- error: cannot write through view`.
- **Positive control preserved:** the inner-join `ms_jv` still reports
  `is_updatable: YES` with both targets — proves the gate is outer-join-specific.

## Known gaps / what to scrutinize (treat tests as a floor)

1. **Adjacent over-report is NOT fixed (intentionally parked).** Cross / comma /
   `> 2`-table inner-join bodies produce strict-`base` lineage (no
   `null-extended`), so `hasNullExtendedLineage` does not catch them and
   `view_info()` still over-reports them as writable (YES-when-NO), while
   `propagate()` rejects them. This is the *same dangerous class* as Divergence 2
   but needs an AST-shape check, not a lineage read. Parked in
   `tickets/backlog/view-info-non-inner-join-overreport.md`. A reviewer might
   reasonably want a regression test pinning the *current* (wrong) behavior so
   the parked fix has a target — I did not add one; consider whether that's worth
   a minor inline addition.
2. **RIGHT/FULL join test coverage is plan-only.** RIGHT/FULL joins are
   runtime-rejected at *emit* (`runtime/emit/join.ts:49`, "… JOIN is not
   supported yet"), but `view_info` only logically plans the body (`_buildPlan`,
   no emit) and CREATE VIEW only plans for arity — so those views create and
   introspect fine without executing. The RIGHT/FULL cases therefore have **no**
   mutation cross-check (a real DML through them would hit the runtime rejection,
   not the `propagate` "cannot write through view" path). Only LEFT has the
   mutation cross-check. Verify you agree that plan-only coverage is acceptable
   for RIGHT/FULL given the runtime ceiling.
3. **Divergence-1 multi-source base-column branch is broad.** For a (future /
   inner-join) multi-source view, the base-column branch adds the `default_for`
   column to *every* target table that has a column of that name, not a single
   resolved owner. `resolveDefaultForColumn` (single-source) resolves exactly one
   base. There is no multi-source `default_for` test today (and outer-join
   multi-source is gated out anyway), so this is untested surface area — flag if
   you want a same-named-column-across-two-bases test, though it only affects
   insertability of inner-join multi-source views, which `view_info` reports but
   the rewrite path for such inserts is `analyzeMultiSourceInsert`.
4. The gate is **body-level**, not per-side, by design (the plan ticket explains:
   the preserved side is also unwritable today, and a projected-away
   null-extended column would leave no root site to gate per-column). Confirm the
   doc's "today-truth, relax later" framing reads correctly.

## Plan-ticket TODO status

All six TODO items completed: D1 fold, D2 gate + predicate, `baseSiteOf` comment,
sqllogic extensions, doc § update, build/test/lint green.
