description: Reject (instead of silently last-wins) an UPDATE whose SET list lands two assignments on the same base column — directly (`update t set b=1, b=2`) or through a view whose distinct columns lower to one base column. Enforced at the base UPDATE builder (authoritative backstop) plus view-aware diagnostics on the single-source and decomposition spines. Reviewed and completed.
files: packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/01.6-update-extras.sqllogic, docs/view-updateability.md
----

## What shipped

A duplicate assignment to one base column was previously applied **silent last-wins**
(`updatedRow[idx] = value` in SET order overwrote the earlier write, no diagnostic).
Now rejected unconditionally — value-agreement is NOT softened (`set b=5, b2=5` still
rejects, since expression equality is undecidable).

Enforcement is layered:

1. **Authoritative backstop — `building/update.ts buildUpdateStmt`.** A name-based
   `Set<string>` over `stmt.assignments` (the user SET list, before the appended
   generated-column assignments). Repeated target name throws
   `QuereusError("duplicate assignment to column '<col>' in UPDATE on '<table>'")`.
   Every lowered view write (single-source lowering, multi-source per-side,
   decomposition per-member) is re-planned through this builder, so this single gate
   catches all paths, including the direct base UPDATE the repro surfaced.

2. **View-aware diagnostics — `single-source.ts rewriteViewUpdate` and
   `decomposition.ts decomposeUpdate`.** Each spine detects the collision during
   lowering and raises a new `conflicting-assignment` diagnostic naming both view
   columns plus the shared base column — firing before, and reading better than, the
   generic backstop (which sees only base names).

3. **Multi-source join spine** has no dedicated check — it routes per-side through
   per-base UPDATE `BaseOp`s re-planned by `building/update.ts`, so the base backstop
   covers a same-side collision (verified by test: the generic `duplicate assignment`
   message fires, as intended).

`conflicting-assignment` was added to the `MutationDiagnosticReason` union and to the
documented reason union in `docs/view-updateability.md` (§ Diagnostics), with the
unconditional-reject semantics and layering written up.

## Review findings

Reviewed the implement-stage diff (`7d7022d8`) with fresh eyes before the handoff
summary, then re-derived the layering against the source.

### Checked and clean

- **Backstop correctness (`building/update.ts`).** The `seenTargets` set runs over
  `stmt.assignments` *before* the generated-column assignments are `push`ed (those are
  appended later, after the map). Keyed on `assign.column.toLowerCase()`, alias-agnostic
  — works identically for the lowered `SELF_ALIAS`/synthesised-correlation statements.
  Confirms the implementer's "no generated-column false collision" claim: generated
  columns can't be user-SET (rejected earlier) and never appear in `stmt.assignments`.
- **View-aware message routing.** `raiseMutationDiagnostic` surfaces the `message`
  field verbatim on `Error.message` (via `ViewMutationError`). The single-source
  message contains the substring `both target base column` and the backstop contains
  `duplicate assignment`; the sqllogic runner matches `-- error:` as a **case-insensitive
  substring** (`logic.spec.ts:601`), so the directives are correct and message-stable.
- **Ordering.** The single-source / decomposition view-aware checks raise during
  lowering, before the lowered statement is re-planned through the backstop — so the
  friendlier message wins, no double-throw, and the lowered statement is never built.
- **No false positives.** The collision maps only record on actual assignment; a view
  exposing two columns over one base column without SETting both is unaffected.
- **Build / lint / tests** all green at HEAD: `yarn workspace @quereus/quereus run build`
  clean, `lint` clean, `test` = **4411 passing, 9 pending**.

### Major — filed as new fix ticket

- **`insert-family-duplicate-column-targets-silent-last-wins`** (new, `tickets/fix/`).
  The same silent last-wins class survives on two INSERT-family paths that never route
  through `buildUpdateStmt`:
  - `ON CONFLICT DO UPDATE SET b = 1, b = 2` — `buildUpsertClause`
    (`insert.ts:329-345`) builds assignments into a `Map<number, ...>` keyed by column
    index; the second target silently overwrites via `Map.set`, no diagnostic.
  - explicit duplicate INSERT column list `insert into t (a, a) values (...)` —
    `insert.ts:471-489` maps `stmt.columns` to target slots with no duplicate guard.
  Out of the original UPDATE/view scope, real bugs, each needing its own fix + tests.

### Minor — accepted gap, documented (no fix needed)

- **`decomposition.ts` (lens/logical-table spine) per-member collision check has no
  dedicated logic test.** The check is a correct defensive guard that runs during
  lowering (so it would fire before the per-member statement re-plans through the base
  backstop). Whether a logical-table shape with two logical columns identity-routing to
  one member basis column is actually *constructible* (vs. pre-empted by
  `isSharedKeyColumn` / `routeAssignment`'s optional/EAV/computed/unbacked rejections)
  is genuinely uncertain and would take a non-trivial lens fixture to settle.
  Correctness is guaranteed regardless: if reachable, the view-aware message fires; if
  not, the code is harmless well-commented defense. Not worth burning budget to prove
  reachability — left as-is with this note. The 93.4 join tests exercise
  `multi-source.ts` (`JoinViewAnalysis`), a *different* `decomposeUpdate` than the lens
  path edited here.

### Disposition summary

- Minor findings fixed inline: none required (implementation was correct as shipped).
- Major findings: 1 filed (`insert-family-duplicate-column-targets-silent-last-wins`).
- No changes made to the implement-stage code during review — the UPDATE-side fix is
  correct, tested, and documented; the gap is a sibling statement family, not a defect
  in this work.
