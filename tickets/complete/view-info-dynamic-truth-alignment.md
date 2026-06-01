description: COMPLETE — aligned `view_info()` static surface with dynamic-mutation truth on two divergences: `default_for` tag-default insertability recovery (D1) and the outer-join conservative gate (D2). Reviewed and shipped.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md
----

# view_info() ↔ dynamic-mutation truth alignment

Two surgical, view-level fixes in `deriveViewInfo` (`func/builtins/schema.ts`)
that make the static `view_info()` surface agree with what `propagate()`
actually accepts at mutation time. No substrate (`planner/mutation/*`,
`update-lineage.ts`) was touched.

**Divergence 1 — `default_for` recovers `is_insertable_into`.** The `tag-default`
provenance is never threaded onto `PhysicalProperties` (consumed only in the
rewrite), so the view body is planned without its own tags and the defaultable
walk missed them. `deriveViewInfo` now folds each view-level
`quereus.update.default_for.<col>` tag into the per-table `defaultable` map,
mirroring `resolveDefaultForColumn` (`single-source.ts`): base column of a
reachable target first, else a base-lineage view-output column, else silently
skipped (a read-only surface keeps its never-throw posture). New helpers
`addDefaultable` and the `readDefaultFor` import.

**Divergence 2 — outer-join bodies short-circuit to conservative.** New predicate
`hasNullExtendedLineage` scans every collected body node's `updateLineage` for a
`null-extended` site (the signature of LEFT/RIGHT/FULL joins —
`deriveJoinUpdateLineage`); `deriveViewInfo` returns `CONSERVATIVE_VIEW_INFO`
immediately when found, agreeing with `propagate()`'s wholesale outer-join
rejection (`collectInnerJoinSources`). Inner/cross/semi/anti never null-extend,
so the multi-source positive case (`ms_jv`) is untouched. `baseSiteOf`'s
`null-extended` unwrap is now defensive-only (documented).

**Docs.** `docs/view-updateability.md` § Information Schema Surface gained an
explicit **Outer-join contract** paragraph and a note that `default_for` is
honored from view-level `with tags` DDL.

## Review findings

**Method.** Read the implement diff (`7365d82b`) with fresh eyes before the
handoff; traced both divergences against the substrate they mirror
(`update-lineage.ts`, `multi-source.ts`, `single-source.ts`); ran build, lint,
and the full quereus suite.

**Validation (all green).**
- `yarn workspace @quereus/quereus run build` → exit 0.
- `yarn workspace @quereus/quereus run lint` → exit 0.
- Targeted `--grep "06.3.4-view-info|93.4-view-mutation"` → 2 passing.
- Full suite → **4226 passing / 9 pending** (matches the handoff; no regressions).

**Correctness — verified, no bugs found.**
- *D2 gate is exact.* `deriveJoinUpdateLineage` (`update-lineage.ts:243`) wraps
  the non-preserved side `null-extended` for `left`/`right`/`full` **only**;
  `inner`/`cross`/`semi`/`anti` never null-extend. `collectInnerJoinSources`
  (`multi-source.ts:462`) rejects every non-inner join. So gating on any
  `null-extended` site agrees precisely with `propagate()`. No inner-join body is
  ever over-gated (NO-when-YES) — the `ms_jv` positive control confirms it still
  reports `is_updatable: YES`. The spine-walk (not root-only) correctly catches
  projected-away null-extended columns on the `JoinNode`'s own lineage.
- *D1 fold mirrors the rewrite.* Resolution order (base-column-of-target →
  base-lineage view output → skip) matches `resolveDefaultForColumn`. The
  silent-skip (vs the rewrite's `tag-target-not-found` throw) is the correct
  choice for a read-only surface: a throw would be swallowed by the per-view
  try/catch and collapse the row to all-`NO`. The `dfi_v_typo` negative control
  proves no throw and no spurious rescue; the real `insert into dfi_v` landing
  `created = 999` proves the dynamic path agrees.
- *Logical-plan altitude is right.* `view_info` uses `_buildPlan` (logical tree),
  which preserves the operator structure that threads `updateLineage`; `physical`
  properties are computed on logical nodes (the whole feature, and `ms_jv`,
  depend on it). Correct level for both the gate and the fold.

**Disposition of the four handoff-flagged gaps — no new majors, one already
parked:**
1. *Cross / comma / >2-table inner-join over-report* — a real YES-when-NO class,
   but **pre-existing** (this ticket only added the outer-join gate, not a
   join-arity gate) and correctly parked in
   `backlog/view-info-non-inner-join-overreport.md`, which specifies the expected
   behavior and the AST-shape mechanism the fix needs. **Declined** the handoff's
   suggestion to add a regression test pinning the *current wrong* behavior:
   pinning known-incorrect output is an anti-pattern that would force a churny
   edit when the parked fix lands; the backlog ticket already encodes the target.
2. *RIGHT/FULL plan-only coverage (no mutation cross-check)* — **accepted.**
   `view_info` introspects the logical plan; plan-level test coverage is the
   correct altitude. RIGHT/FULL emit-rejection (`runtime/emit/join.ts`) is
   orthogonal — a DML through such a view would hit the runtime ceiling, not the
   `propagate` path, so a mutation cross-check there would test a different
   subsystem. LEFT's mutation cross-check is sufficient to pin the
   surface↔`propagate` agreement.
3. *D1 multi-source base-column branch broadness* — for a multi-source view the
   base-column branch adds the `default_for` column to **every** target whose
   schema has a same-named column, not a single resolved owner. **Untested latent
   inaccuracy in an unsupported corner**: single-source (the only real/tested
   `default_for` path) has exactly one target so it is exact; multi-source
   `default_for` has no support today and outer-join multi-source is gated out.
   Left as-is (changing it would invent multi-source semantics that are otherwise
   undefined). Flagged here so the parked multi-source `default_for` work, if it
   lands, narrows this to a single resolved base.
4. *Body-level (not per-side) gate* — **confirmed correct by design**: the
   preserved side is also unwritable today, and a projected-away null-extended
   column leaves no per-column root site to gate. The doc's "today-truth, relax to
   per-side when outer-join write materialization lands" framing reads accurately.

**Docs.** `docs/view-updateability.md` is the authoritative surface doc and was
updated (Outer-join contract + `default_for` note). `lens.md` / `architecture.md`
reference it only generally (their `default_for` mentions are lens-semantics, not
the `view_info()` surface) — no update needed. Every file the change touches was
read and confirmed to reflect the new reality.

**Categories with nothing to report:** SPP / DRY (the `addDefaultable` extraction
de-duplicates the spine walk and the fold cleanly), resource cleanup (re-plan-on-
read, no held state), type safety (no `any`, no lint findings), error handling
(never-throw posture preserved and tested). All clean.

## Follow-on work

- `backlog/view-info-non-inner-join-overreport.md` — the adjacent non-inner-join
  over-report class (filed during implement, confirmed in review).
