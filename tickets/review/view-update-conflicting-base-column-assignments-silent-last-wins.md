description: Review the fix that rejects (instead of silently last-wins) an UPDATE whose SET list lands two assignments on the same base column — directly (`update t set b=1, b=2`) or through a view whose distinct columns lower to one base column. Enforced at the base UPDATE builder (authoritative backstop) plus view-aware diagnostics on the single-source and decomposition spines.
prereq:
files: packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/01.6-update-extras.sqllogic, docs/view-updateability.md
----

## What changed

A duplicate assignment to one base column was applied **silent last-wins** with no
diagnostic (runtime `updatedRow[idx] = value` in SET order overwrote the earlier
write). Fixed by rejecting unconditionally — value-agreement is NOT softened
(`set b=5, b2=5` still rejects).

### Enforcement layering (two levels, deliberately)

1. **Authoritative backstop — `building/update.ts buildUpdateStmt`.**
   A name-based `Set<string>` over `stmt.assignments` (the user SET list, *before*
   the appended generated-column assignments). On a repeated target name throws
   `QuereusError(`duplicate assignment to column '<col>' in UPDATE on '<table>'`,
   StatusCode.ERROR)`. Because every lowered view write (single-source lowering,
   each multi-source per-side, each decomposition per-member) is re-planned through
   this builder, this single gate catches **all** paths — including the direct base
   UPDATE the repro surfaced. Alias-agnostic (keys on `assign.column`), so it works
   identically for the lowered `SELF_ALIAS` statements.

2. **View-aware diagnostics — `single-source.ts rewriteViewUpdate` and
   `decomposition.ts decomposeUpdate`.** The base backstop sees only base names, so
   a view collision would report `b` twice. Each spine detects the collision during
   lowering (single-source: `Map<baseColumn, firstViewCol>`; decomposition:
   per-member `Map<basisColumn, firstViewCol>`) and raises a new
   `'conflicting-assignment'` diagnostic naming **both** view columns plus the shared
   base column, firing before (and reading better than) the generic backstop.

3. **Multi-source join spine (`multi-source.ts`)** is NOT given a dedicated check —
   it routes per-side via per-base UPDATE `BaseOp`s re-planned by `building/update.ts`,
   so the base backstop already covers a same-side collision there. Verified by test
   which message fires: the generic `duplicate assignment` (base names only), as the
   ticket anticipated.

`'conflicting-assignment'` was added to the `MutationDiagnosticReason` union and to
the documented reason union in `docs/view-updateability.md` (§ Diagnostics), with a
note on the unconditional-reject semantics and the layering.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (typecheck).
- `yarn workspace @quereus/quereus run test` — **4411 passing, 9 pending**.
- `yarn workspace @quereus/quereus run lint` — clean.

### Tests added (the floor — extend, don't trust as exhaustive)

`93.4-view-mutation.sqllogic` (new "Conflicting base-column assignments" section,
table `cfl_*`):
- inverse-vs-base: `select id, b, b+1 as bp` → `set b=5, bp=100` → `-- error: both target base column`; asserts the row is unchanged (no last-wins).
- duplicate rename: `select id, b, b as b2` → `set b=1, b2=2` → same error.
- same-value: `set b=5, b2=5` → same error (documents no-softening).
- multi-source join same-side: `note` + `note collate nocase as note2` on the child
  side → `-- error: duplicate assignment` (confirms the join spine uses the base
  backstop message, not the view-aware one).

`01.6-update-extras.sqllogic` (new section 8, table `dup_set`):
- direct base `update t set b=1, b=2` → `-- error: duplicate assignment`; asserts the
  row is unchanged.

## Known gaps / reviewer attention

- **`decomposition.ts` (lens/logical-table spine) has the view-aware check but NO
  dedicated logic test.** The 93.4 join tests exercise `multi-source.ts`
  (`JoinViewAnalysis`), which is a *different* `decomposeUpdate` than the one I
  edited in `decomposition.ts` (lens decomposition over logical tables). The lens
  path's per-member collision branch is covered transitively by the base backstop
  but its nicer view-aware message is unproven by a test. If a lens/logical-table
  fixture with two logical columns routing to one member basis column is cheap to
  set up, add it; otherwise confirm the backstop coverage is acceptable. Worth a
  reviewer's eye to confirm a logical-table collision is even reachable before the
  base backstop (it may be pre-empted by `isSharedKeyColumn` / `routeAssignment`
  rejections for the realistic shapes).
- The single-source view-aware message substring asserted in tests is "both target
  base column"; the base backstop substring is "duplicate assignment". If either
  message is reworded, the `-- error:` directives must be updated in lockstep.
- No check was added for a collision where one target is a generated column — by
  design (a generated column can't be SET, so it's excluded from the backstop and
  never collides with a user target). Reviewer may want to confirm there's no path
  that SETs a generated column AND a user column to the same index.
