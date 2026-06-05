description: Cross-source `set` admission through an inner-join view — `update v set a.x = b.y` where the read column has `base` lineage. The partner value rides the existing `__vmupd_keys` capture as a `srcN` projection and is read back correlated by the owning side's PK. Inner-join only; computed-partner reads, outer-join cross-source, and decomposition cross-member `set` stay rejected.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What landed (implement summary)

`stripSideQualifier` previously threw `cross-source-assignment` whenever a multi-source
UPDATE's assigned value referenced a column owned by a side **other** than the column it
assigns. It now **captures and rewrites** such a reference (when the read column has `base`
lineage): `update v set a.x = b.y` is admitted by projecting the partner base column into
the up-front `__vmupd_keys` capture under a stable `srcN` alias and lowering the reference
to a correlated scalar read `(select srcN from __vmupd_keys k where k.k<owner>_0 = <a.pk0>
…)`, keyed by the owning side's PK. Because the capture materializes **before** any base op
fires (the same eager key materialization the both-sides update / multi-side delete use),
the read-back is the **pre-mutation** partner value — so `set a.x = b.y, b.y = NV` stores
the OLD `b.y` into `a.x`.

Core mechanism (`multi-source.ts`): new `CrossSourceValue` carrier + `registerCrossSource`
closure (dedupe by `<table>.<col>`, mint `srcN`); `stripSideQualifier` rewrites a partner
leaf via `capturedValueSubquery`; `gateCrossSourceReads` rejects a **computed** partner
read (`no-inverse`) using `viewColumnReadSides`; `buildMultiSourceKeyCapture` appends the
`srcN` projections after the per-side PK columns. Builder (`view-mutation-builder.ts`)
allocates `sourceValues`, threads it through `decomposeUpdate` → `buildIdentityCapture` →
`buildMultiSourceKeyCapture` (the capture already materializes for every multi-source
update, so a single-side cross-source update gets the extra `srcN` column for free).

## Review findings

**Method.** Read the implement diff (`f2a9d3c6`) first with fresh eyes, then the handoff.
Scrutinized the planner/mutation rewrite (SPP, DRY, type-safety, correlation correctness),
ran lint (clean) + the full quereus suite (green), and **directly exercised every gap the
implementer flagged as "honest / untested"** with standalone probes before disposition.

### Verified — the flagged gaps actually work (or fail safely)

The handoff honestly listed five "where to scrutinize" gaps. Each was probed:

- **Multiple distinct cross-source leaves sharing one `__vmupd_keys` keyRef (the DAG
  concern).** Probed both shapes: a two-leaf expression (`set cw = pv + pw`) and two
  single-leaf assignments (`set cv = pv, cw = pw`). **Both lower and execute correctly** —
  each leaf mints its own `srcN`, and the shared injected keyRef instance (a DAG) is
  tolerated by the optimizer/emitter exactly as ordinary shared CTE refs are. → **Minor:
  added a deterministic regression** to `93.4-view-mutation.sqllogic` (`ax_jv_x2`) locking
  both shapes.
- **Composite-PK owning side.** Probed `set v = pv` on a `(k1,k2)` PK owning side: the
  read-back conjoins one equality per PK column and identifies the right row. **Works.** →
  **Minor: added a regression** (`ax_xscpk_v`).
- **Self-join cross-source (alias-keyed owning side).** Probed `set sal = msal` on an
  employee/manager self-join: the read-back correlates on the assigned alias's PK and
  copies the manager's value. **Works.** → **Minor: added a regression** (`ax_xs_self`).
- **The 1:many ambiguous direction** (owning side joins many partners — `set pv = cv`).
  Verified it is **not** silent corruption: the scalar-subquery emitter raises
  `Scalar subquery returned more than one row`. Safe degradation, but a generic message.
  → **Major: filed `backlog/view-write-cross-source-set-1n-plan-diagnostic`** to consider a
  plan-time (cardinality-based) diagnostic or a cross-source-specific runtime message.
- **Int→text affinity** and **gate-is-top-level-only** (a computed partner column nested
  *inside a value subquery* is not gated): confirmed as documented limitations, both
  exotic and parity with the existing `guardTopLevelScope` top-level-only contract. Left as
  documented limitations (no new test); not correctness holes for the in-scope shape.

### Correctness review — no defects found

- **Gate vs. rewrite alignment.** `gateCrossSourceReads` keys off the *view column*'s read
  sides (`viewColumnReadSides`: a `base`/`inverse` site → its one owning side; a computed
  site → all base-leaf sides), while `stripSideQualifier` keys off the *substituted
  base-term* alias. For base columns these agree; an `inverse` partner column is admitted
  and correctly reconstructed (capture the base leaf, re-apply the forward transform on
  read — same structure as the tested `cv1 = pv + 1` flip). A same-side computed read stays
  admissible (preserves prior behavior); a cross-source computed read rejects `no-inverse`.
- **`capturedValueSubquery` reduce safety.** `requireKeyColumns` guarantees ≥1 PK column,
  so the `conds.reduce(combineAnd)` (no seed) never reduces an empty array.
- **`srcN` aliasing.** Sequential `src${len}` over the shared `sourceValues` keeps aliases
  unique within a statement; no collision with the `k<side>_<j>` key columns or base
  tables (the `__vmupd_keys` CTE exposes only the projected columns, qualified `k.srcN`).
- **Legacy path stays safe.** Absent the carrier (the unreachable-from-build
  `propagateMultiSource` path) `stripSideQualifier` still throws `cross-source-assignment` —
  no half-rewritten plan can dangle.
- **Tag interaction.** `target`/`exclude` restrict only which sides get base *ops*; a
  partner side is only *read* (its `srcN` rides the capture), so a read through an excluded
  side correctly raises no tag conflict.

### Tests

- **Added** (this review, `93.4-view-mutation.sqllogic`): multi-leaf DAG (`ax_jv_x2`),
  composite-PK owning (`ax_xscpk_v`), self-join cross-source (`ax_xs_self`).
- Implementer's property-spec laws (`PutGet/GetPut cross-source set`, `both-sides +
  cross-source pre-mutation precedence`, inverse-wrapped flip, computed/outer-join
  negatives) and sqllogic accept/reject pairs reviewed and judged sound.
- `yarn workspace @quereus/quereus lint` — clean.
- `node test-runner.mjs` (full quereus suite) — **4626 passing, 9 pending, 0 failing**.
- `test:store` not run — the change is planner/mutation-layer only (no storage path), and
  the store run is the slower release/store-diagnosis gate per AGENTS.md.

### Docs

`docs/view-updateability.md` reviewed against the new reality: the § Inner Join paragraph
and the "rejected at plan time" list both now describe cross-source `set` as supported for
`base` partner reads with the correct rejection boundaries (computed partner / outer-join /
decomposition cross-member). It is the only doc referencing cross-source; no stale text
remains. No further doc edits needed.

### Non-blocking process note — unrelated `manager.ts` change bundled in

The implement commit `f2a9d3c6` also carries an **unrelated** logic change to
`packages/quereus/src/schema/manager.ts` (`dropTable` reordered to `await` the VTab
module's `destroy` and **propagate** its rejection **before** any engine-side teardown, so
a module veto aborts the DROP atomically). The implementer flagged it as pre-existing in
the working tree; it is real (git's `core.autocrlf=true` masked it from `git show`'s patch
view — confirmed via blob comparison). It is **out of scope** for this ticket but **benign
and tested**: the full suite (including DROP paths) is green with it present. No separate
ticket filed — the change is already landed and reasonable; flagged here for traceability.

## Outcome

Implementation is correct and robust; every honestly-flagged gap was verified working or
failing safely. Minor findings (missing coverage of the DAG / composite-PK / self-join
cross-source paths) were **fixed inline** with new sqllogic regressions. One major item
(plan-time diagnostic for the 1:many ambiguous direction) was **filed to backlog**
(`view-write-cross-source-set-1n-plan-diagnostic`). Lint + full suite pass.
