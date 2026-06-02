description: Reject (don't silently last-wins) an UPDATE whose SET list lands two assignments on the same base column — directly (`update t set b=1, b=2`) or via a view whose distinct columns lower to one base column (`update v set b=5, bp=100` on `select id, b, b+1 as bp`). Enforce at the base UPDATE builder (authoritative backstop for direct + all lowered statements) plus view-aware diagnostics on the single-source and multi-source spines for a message that names the colliding view columns.
prereq:
files: packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/01.6-update-extras.sqllogic, docs/view-updateability.md
effort: medium
----

## Problem (reproduced)

A duplicate assignment to one base column is applied **silent last-wins** with no
diagnostic. The runtime UPDATE emitter
(`runtime/emit/update.ts` `run()` → `updatedRow[assignmentTargetIndices[i]] = value`
in SET-list order) overwrites an earlier assignment with a later one to the same
column index. Confirmed by a throwaway repro spec (deleted) — all three shapes
silently last-win:

| SQL | Stored `b` | Expected |
|---|---|---|
| view: `select id, b, b+1 as bp` → `update v set b=5, bp=100 where id=1` | `99` (b=5 dropped) | **error** |
| view: `select id, b, b as b2` → `update v set b=1, b2=2 where id=1` | `2` (b=1 dropped) | **error** |
| base: `update t set b=1, b=2 where id=1` | `2` (b=1 dropped) | **error** |

**Key finding — the base path does NOT reject either.** The ticket asked whether
the parser/builder already rejects a directly-written duplicate; it does not
(`building/update.ts` maps `stmt.assignments` verbatim, no duplicate check). So
this is one bug class with two surfaces: direct base UPDATE and view-lowered
UPDATE. The view paths (`single-source.rewriteViewUpdate`,
`decomposition.decomposeUpdate`) each map view-column assignments to base-column
assignments **independently**, so two view columns sharing one base column emit
two assignments to that column and the runtime last-wins.

The inverse feature (`b+1 as bp` writable) only *widened* the surface; the
duplicate-rename (`b, b as b2`) and direct-base shapes are pre-existing.

## Decision: reject unconditionally, at two levels

**Semantics: reject whenever two SET targets resolve to the same base column,
regardless of whether the assigned values agree** (`set b=5, bp=6` still rejects;
`set b=5, b2=5` still rejects). This matches SQL's general intolerance of
assigning a column twice in one UPDATE (PostgreSQL: "multiple assignments to same
column"). The value-agreement softening is rejected — value-equality of arbitrary
expressions is undecidable and not worth the complexity.

**Two enforcement points (deliberately, not redundantly):**

1. **Authoritative backstop — base UPDATE builder** (`building/update.ts`).
   A name-based duplicate check over `stmt.assignments` (the explicit user SET
   list, *before* the appended generated-column assignments — a generated column
   can't be SET so it never collides with a user target). This is the single
   place that catches **all** paths: direct base UPDATE, the single-source lowered
   statement, and each multi-source per-member lowered statement. Throw a
   `QuereusError(StatusCode.ERROR)` — e.g. `duplicate assignment to column 'b' in
   UPDATE on 't'`.

2. **View-aware diagnostics — single-source + multi-source spines.** The base
   backstop sees only base column names, so a view collision would report `b`
   twice — unhelpful when the user wrote `b` and `bp`. Detect the collision *in
   the lowering* and raise a structured `raiseMutationDiagnostic({ reason:
   'conflicting-assignment', … })` naming **both view columns** and the shared base
   column, so it fires before (and reads better than) the generic backstop.

This is DRY where it matters (one authoritative semantic gate) with a UX layer on
top, and it closes the direct-base silent-corruption hole the repro surfaced
rather than leaving it latent next to the view fix.

## Implementation notes

### `mutation-diagnostic.ts`
- Add `'conflicting-assignment'` to the `MutationDiagnosticReason` union with a
  one-line comment (two SET targets lower to the same base column).

### `building/update.ts` (base backstop)
- In `buildUpdateStmt`, before/while mapping `stmt.assignments` (around lines
  124–138), track seen target column names (`assign.column.toLowerCase()`). On a
  repeat, throw `QuereusError('duplicate assignment to column '<col>' in UPDATE on
  '<table>'', StatusCode.ERROR)`. Do **not** include the appended generated-column
  assignments (lines 144–154) in the check.
- Note: a lowered view UPDATE carries `stmt.alias = SELF_ALIAS`; the duplicate
  check is alias-agnostic (it keys on `assign.column`), so it works for both.

### `single-source.ts` `rewriteViewUpdate` (lines ~781–801)
- While mapping assignments, capture each resolved base column (`site.baseColumn`
  or `requireBaseColumn(vc)`) together with the originating view-column spelling
  (`asg.column`). Keep a `Map<string, string>` (baseColumn lower → first view
  column spelling). On a repeat, `raiseMutationDiagnostic({ reason:
  'conflicting-assignment', table: view.name, column: <baseColumn>, message:
  `cannot write through view '<view>': columns '<firstViewCol>' and '<asg.column>'
  both target base column '<baseColumn>'; an UPDATE cannot assign one column
  twice` })`.

### `decomposition.ts` `decomposeUpdate` (lines ~646–656)
- In the `perMember` accumulation loop, after `routeAssignment` returns
  `{ relationId, basisColumn, value }`, track seen `basisColumn` **per member**
  (`Map<relationId, Map<basisColumn lower, viewColumnSpelling>>`). On a repeat
  within a member, raise the same `conflicting-assignment` diagnostic naming both
  view columns (`asg.column`) and the base column. (Cross-member collisions are
  impossible — distinct members are distinct tables; the shared-key path is
  already rejected upstream in `routeAssignment` via `isSharedKeyColumn`.)
- Note the multi-source join spine (`multi-source.ts`) routes per-side via the
  per-base UPDATE `BaseOp`; those lowered statements are re-planned by
  `building/update.ts`, so the base backstop already covers a same-side collision
  there even without a dedicated check. Add the explicit view-aware check only if
  it's cheap to share with the single-source helper; otherwise the backstop
  suffices for the join spine and `decomposeUpdate` gets the nicer message. Verify
  with a join-view collision test which message fires and document it.

### `docs/view-updateability.md` (§ Diagnostics, lines ~837–848)
- Add `conflicting-assignment` to the documented `reason` union.
- Add a short note under the diagnostics section: an UPDATE that assigns the same
  base column twice — directly, or via two view columns that lower to one base
  column — is rejected unconditionally (no value-agreement softening), enforced at
  the base builder and surfaced view-aware by the propagation spines.

### Tests
- **`93.4-view-mutation.sqllogic`** — add a `conflicting-assignment` section:
  - inverse-vs-base collision rejects:
    `create view … as select id, b, b+1 as bp from …; update … set b=5, bp=100 …`
    → `-- error: both target base column` (match the chosen message substring).
  - duplicate-rename collision rejects:
    `select id, b, b as b2 …; update … set b=1, b2=2 …` → `-- error:` (same).
  - same-value collision still rejects (documents the chosen semantics):
    `select id, b, b as b2 …; update … set b=5, b2=5 …` → `-- error:`.
  - a join-view same-side collision (two columns owned by the same base) to pin
    which message the multi-source spine emits.
- **Base path** — add to `01.6-update-extras.sqllogic` (or wherever base-UPDATE
  negatives live): `update t set b=1, b=2 …` → `-- error: duplicate assignment`.
  Pick the error-substring to match the thrown message.
- Use the `-- error: <substring>` directive (see `93.2-view-mutation-pending.sqllogic`).

## TODO

- [ ] Add `'conflicting-assignment'` reason to `mutation-diagnostic.ts` union.
- [ ] Base backstop: duplicate-target check in `building/update.ts buildUpdateStmt`
      over `stmt.assignments` (exclude generated), throwing `QuereusError`.
- [ ] Single-source: collision detection + `conflicting-assignment` diagnostic in
      `rewriteViewUpdate`.
- [ ] Multi-source: per-member collision detection in `decomposeUpdate` (and
      confirm join-spine coverage via the base backstop / a shared check).
- [ ] Doc: add reason to union + semantics note in `docs/view-updateability.md`.
- [ ] Tests: 93.4 view collisions (inverse-vs-base, duplicate-rename, same-value,
      join-side) + base-path direct duplicate in 01.6.
- [ ] `yarn workspace @quereus/quereus test` green; `yarn lint`/`typecheck` clean.
- [ ] Sanity: no existing logic test relied on duplicate-SET last-wins (grep at
      fix time found none in `test/logic`).
