description: COMPLETE — membership-gated delete / data-update fan-out through an `except` / `intersect` subtree operand of a nested flagged set-op. The fan gates each leaf touch on the captured subtree-membership boundary flag (one conjunct per non-union boundary descended) so it reaches only genuine subtree members; the prior containment (reject all non-union subtree fan-out) is replaced by correct support, leaving only a flag-less non-union boundary deferred.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What landed

The fan-out recursion (`fanBranchDataUpdate` / `fanBranchDelete` in `set-op.ts`) previously
identified a leaf's affected rows purely by "data tuple ∈ `__vmupd_keys`", sound only when a
leaf's rows ⊆ the subtree's rows (union / union all). For `except` / `intersect` a leaf can hold
a row the subtree EXCLUDES; when an outer operand makes such a row visible it entered the capture
and the naive recursion would corrupt base rows. This ticket implements the **membership-gated**
fan instead of rejecting.

### Mechanism

- **`gateFlags: readonly string[]`** threaded down `fanBranchDataUpdate` / `fanBranchDelete`
  (default `[]` at top level). Descending a nested branch: a union / union all subtree passes
  `gateFlags` unchanged (leaf ⊆ subtree); an `except` / `intersect` subtree appends
  `branch.flag.name` (the OUTER compound's boundary flag for that side). At each LEAF the
  accumulated flags are AND-ed into the member-exists predicate as fresh
  `{ type:'column', name:flag, table:'k' }` conjuncts (`buildMemberExists(analysis, branch, gateFlags)`).
- The boundary flags are view output columns, captured in `__vmupd_keys` (`buildSetOpCapture`
  projects ALL `viewColNames`, including surfaced inner flags), so `k.<flag>` resolves.
- **Conjunction at every non-union boundary** (verified for the 3-level
  `A union[inA,inS1] (B except[inB,inS2] (C intersect[inC,inD] D))`).
- **`gateFlagForNonUnionSubtree`** returns `branch.flag.name`, or rejects (naming
  `set-op-membership-nested-except`) only when the non-union boundary is **flag-less** — the
  lone remaining deferral.
- **Static surfaces** (`isSetOpBranchWritable` → `isSetOpBodyWritable` / `isOperandWritable`):
  thread per-side boundary-flag presence as `hasGatingFlag`; a non-union subtree operand is
  writable IFF its side carries a boundary flag. `schema.ts` (`deriveViewInfo` / `column_info`)
  needed no structural change — both surfaces are driven by `isSetOpBranchWritable`. A flagged
  except/intersect nested view reports `is_updatable`/`is_deletable` = YES, `is_insertable_into`
  = NO.

### Why it is sound

For a binary `B except C` the capture holds only members (B\C); fanning to both leaves is sound
(C gets harmless no-ops). Gating the nested fan on the boundary flag restricts the capture to
members at that level, so the nested fan behaves exactly like the proven binary fan. A union
boundary needs no gate because leaf-presence already implies subtree membership; only non-union
boundaries (except/intersect) require the explicit conjunct. The ONE shared up-front capture is
unchanged (Halloween-safety preserved); only the member-exists predicate gains conjuncts.

## Review findings

### Diff read with fresh eyes (before the handoff)

Re-derived the soundness independently rather than trusting the summary. Key verifications:

- **Boundary flag is genuinely in the capture.** `buildSetOpCapture` projects every
  `analysis.viewColNames` (data columns + own flags + surfaced inner flags), so each
  accumulated `k.<flag>` — including the deep `inS2` surfaced inner flag — resolves to a real
  captured column. Bare-boolean predicate usage (`... AND k.inSub`) matches the established
  `where not k.<flag>` membership-insert convention; the probe yields true/false (never NULL).
- **Single boundary flag per level is exactly right.** For `intersect`, gating both leaves on
  the one outer flag is correct (members are in both leaves; non-members filtered). For
  `except`, the right (subtracted) leaf is auto-protected — a member is never on the right, so
  its flag reads false there. The conjunction across levels is what prevents a deeper non-union
  level from being wrongly touched (3-level case). Confirmed the "union subtree passes gateFlags
  unchanged" rule is sound even when a union subtree sits on the right of an ancestor except: the
  accumulated ancestor flag already excludes that membership, and a union leaf's presence implies
  union membership.
- **`compound!.op` / `branch.flag` non-null assumptions** are guarded by `branch.isNested`
  (which requires a non-diff compound) and by `gateFlagForNonUnionSubtree`'s flag-less reject.

### Aspect scrutiny

- **DRY** — MINOR, FIXED. The `innerGate` accumulation block was duplicated verbatim in
  `fanBranchDataUpdate` and `fanBranchDelete`. Extracted `accumulateInnerGate(view, branch,
  gateFlags)` shared by both fan paths so they cannot drift.
- **SPP / modular / maintainable** — clean; small single-purpose functions, gate logic
  centralized.
- **Type safety** — no `any`; `readonly string[]` threaded; fresh `ColumnExpr` nodes per call
  (gate reused across leaves, no shared mutable AST).
- **Resource cleanup / performance** — single up-front capture preserved; gate only adds WHERE
  conjuncts. No new captures, no Halloween regression.
- **Error handling** — flag-less boundary raises a clear, greppable diagnostic naming
  `set-op-membership-nested-except`.

### Tests (run, must pass)

- **Coverage gaps from the handoff — MINOR, FIXED by adding two tests:**
  - `set <subtreeFlag> = false` dropping a **genuine** except member from the subtree only (the
    handoff covered only the no-op-on-non-member case): asserts the member leaves B, A
    (left operand) untouched by the right-side flip.
  - **Depth value-composition** (`set x = x + 1`) through a gated except subtree: confirms the
    cloned-per-leaf SET value composes with the membership gate (member increments in A+B;
    non-member increments A only, B/C untouched).
- Existing repro / dual / intersect-variant / flag-less-deferred / 3-level-mix tests all
  re-verified green. The describe block now has **20 passing** (was 18).

### Static surface honesty (read every touched file + the ones it should touch)

- Confirmed `deriveViewInfo` (`view_info`) and the `column_info` builder in `schema.ts` are both
  driven by `isSetOpBranchWritable`, which now threads boundary-flag presence recursively — so
  no schema.ts structural change was required, as claimed. New gated tests assert
  YES/YES/NO for a flagged except subtree and all-NO for a flag-less one.
- `docs/view-updateability.md` re-read end-to-end against the new reality; the implement-stage
  doc edits are accurate (gate mechanism, conjunction-per-non-union-boundary, flag-less
  deferral, static-surface agreement). No stale except/intersect "deferred" language remains.

### Accepted deferrals / non-findings (explicit, with reasons)

- **Flag-less non-union boundary stays deferred** — deliberate, documented policy; rejection
  diagnostic is clear and tested. Synthesizing the probe from leaf flags (`inB AND NOT inC`) is a
  documented future enhancement, out of scope. NOT filing a ticket — it is a clean,
  intentional boundary, not a defect.
- **Renamed-leg-column data value not remapped** — pre-existing v1 caveat, orthogonal to the
  gate (the gate only touches WHERE), unchanged here.
- **`column_info` own subtree-flag reports `is_updatable = YES`** — honesty posture unchanged
  from the prior `nestable-flagged-set-ops` ticket (accurate for `= false`, optimistic for the
  still-deferred `= true` insert); not regressed here.

### Major findings

None. No new fix/plan/backlog tickets filed — the one remaining deferral is an accepted,
documented policy boundary rather than a defect.

## Validation performed

- `yarn workspace @quereus/quereus run lint` → exit 0, clean (after the DRY refactor).
- Targeted nested-subtree property tests → **20 passing** (added 2).
- `node packages/quereus/test-runner.mjs` (full quereus suite) → **5335 passing, 9 pending,
  0 failing**.
- `yarn test:store` (LevelDB path) not run — the change is in the planner/mutation decomposition
  layer (storage-agnostic), out of this ticket's scope; a release-prep pass may confirm.
