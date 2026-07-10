description: The optimizer's misleading, unused rule "priority" numbers are gone; rule registration is now a readable ordered data table with a startup consistency check.
prereq:
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/registry.ts, packages/quereus/test/optimizer/side-effect-audit.spec.ts, packages/quereus/test/optimizer/pass-manager.spec.ts, packages/quereus/test/planner/framework.spec.ts, packages/quereus/src/planner/framework/README.md, packages/quereus/src/planner/analysis/README.md, docs/optimizer.md, docs/architecture.md, docs/runtime.md, docs/optimizer-rules.md, docs/optimizer-streaming.md, docs/optimizer-joins.md, docs/optimizer-parallel.md, docs/quickpick-design.md, docs/view-updateability.md
difficulty: medium
----

## What shipped

Two folded changes, done together (same ~900-line block):

1. **Deleted the `priority` field.** `RuleHandle.priority?: number` (+ its jsdoc) removed from `framework/registry.ts`. It was dead (nothing sorted by it — rule application iterates `pass.rules` in push order) *and* misleading (several numbers disagreed with actual registration order). Every `(priority N)` doc-comment across the planner tree + docs was rephrased to name the rule it orders against, dropping the number.

2. **Table-driven manifest.** The imperative `addRuleToPass(...)` wall in `optimizer.ts` became `RULE_MANIFEST` — an ordered `readonly RuleManifestEntry[]` (one entry per rule) plus a small `registerRulesToPasses` loop that walks it in array order and registers each handle. **Array order = registration order = execution order** is now the single, honest contract.

Manifest entry shape (`RuleManifestEntry` in `optimizer.ts`): `{ pass, id, nodeType, phase, fn, sideEffectMode }`. `nodeType` may be a `PlanNodeType[]` — an array fans `fn` across each type minting `${id}-${nodeType}` handles (the two fan-out rules: `grow-retrieve`, `monotonic-range-access`).

**Startup assertion** (in `registerRulesToPasses`, runs once at optimizer construction):
- Unknown target pass → `quereusError(INTERNAL)`.
- Duplicate rule id within a pass → `quereusError(INTERNAL)` (hard-fail, not the silent-skip `addRuleToPass` does).
- `validateSideEffectMode` still fires per handle (via `addRuleToPass`, unchanged).

## The load-bearing correctness proof

Registration order must be byte-for-byte preserved per pass (it *is* the plan-shape contract). Verified empirically, not just by eye:

- Before editing, dumped `pass.rules.map(r => r.id)` per pass on the original code → saved as baseline.
- After the manifest refactor, re-dumped and `diff`'d → **IDENTICAL** (all 4 rule-bearing passes, 61 handles, exact order).
- Full `yarn test` suite green (quereus core **6867 passing**, plus web/cli/sync/store packages) — **no plan-golden drift**, which is the real proof order was preserved.

Subtleties that were preserved (and are easy to break in a re-touch):
- **`lateral-top1-asof`** is a *Structural* rule but was historically registered *after* the three Physical rules, making it the **last** rule in the Structural pass. The flat manifest keeps it in that exact source position, so the per-pass subsequence is unchanged. (See the comment on that entry.)
- **Fan-out ids** `grow-retrieve-Filter…Window` (8) and `monotonic-range-access-IndexScan/IndexSeek/SeqScan` (3) are byte-identical; the separate `monotonic-range-access-filter` (lowercase, on `Filter`) stays a distinct explicit-id entry.
- **Twin-handle** `materialized-view-rewrite` (Project) + `materialized-view-rewrite-aggregate` (Aggregate) share one `fn`, kept as two entries.

## Scope the original ticket did NOT flag but was required

`test/optimizer/side-effect-audit.spec.ts` (the **OPT-003 static guard**) regex-parses `optimizer.ts` for `addRuleToPass(...)` calls to audit that every `'aware'` rule's source consults a side-effect signal. Converting registration to one manifest loop would have left it finding a single `addRuleToPass` call → the guard would break. **Rewrote the guard** to parse `RULE_MANIFEST` entries instead:
- New `manifestRegion()` (slices the `RULE_MANIFEST` array) + `extractRuleEntries()` (innermost `{...}` blocks naming `id:`), replacing `extractCallArgs`.
- Self-check now counts `sideEffectMode:` within the manifest region only.
- The 4 synthetic-fixture tests rewritten from `addRuleToPass(…)` form to `RULE_MANIFEST = [ … ]` form.
- Guard still green (15/15) and still audits all 27 `'aware'` rules.

## Validation / what to exercise (reviewer: tests here are a floor)

- **Order preservation** — the strongest check. Re-run the full suite; any `test/plan/` or `test/optimizer/` golden diff = order slipped. To re-derive the id-order dump: construct `new Optimizer()`, read `(opt as any).passManager.getPasses()`, map `pass.rules` → `r.id`.
- **`disabledRules` by id** — fan-out templated ids and twin-handle ids are unchanged, so `tuning.disabledRules` still targets them. Existing rule-disable specs (e.g. `rule-join-existence-pruning.spec.ts`) pass.
- **Side-effect guard** — `node … mocha … side-effect-audit.spec.ts` (15 passing).
- **Build/lint** — `yarn workspace @quereus/quereus run build` clean; `yarn workspace @quereus/quereus run lint` clean (eslint + `tsc -p tsconfig.test.json` — this is what catches the `priority` removals in test literals).

## Known gaps / honest flags

- **No direct unit test for the new startup assertion.** The dup-id / unknown-pass hard-fail is only exercised implicitly (the real corpus has no dups, so it never fires today). A reviewer may want a small spec that feeds a duplicate manifest entry and asserts `quereusError`. I did not add one.
- **Dup-id semantics changed only on the production path.** The hard-fail lives in `registerRulesToPasses`, not in `PassManager.addRuleToPass` (whose silent-skip is retained for its other callers — the `pass-manager.spec.ts` tests push directly to `pass.rules`, and the guard fixtures use unique ids). Verified the current corpus has **no** duplicate ids per pass, so nothing legitimately relied on the silent skip. `addRuleToPass`'s silent-skip is now effectively unreachable from production registration.
- **Doc sweep breadth.** The original ticket named framework/README, analysis/README, ~10 rule files, and docs/optimizer.md. In practice the priority-number prose was much wider — I also swept `docs/optimizer-rules.md`, `optimizer-streaming.md`, `optimizer-joins.md`, `optimizer-parallel.md`, `runtime.md`, `quickpick-design.md`, `view-updateability.md`, and updated the `addRuleToPass`→manifest "how to add a rule" examples in `optimizer.md` / `architecture.md`. Two subagents did the bulk rule-file + doc rephrasing (verified: zero rule-ordering `priority` refs remain in `src/planner` or `docs`, only unrelated uses like SQL columns and roadmap "priority"). `docs/review.html` (the archived review that spawned this ticket) intentionally left untouched.

## Tripwires (parked, not tickets)

- **Guard parser flat-entry assumption** — `NOTE:` at `extractRuleEntries` in `side-effect-audit.spec.ts`: the innermost-brace scan assumes manifest entries stay flat (no nested `{...}`). If an entry ever gains an inline object literal, extend the scan to track the entry's outer brace. Fails loud if broken (parse throws), not silent.
- **Manifest const rename** — `manifestRegion` keys on `RULE_MANIFEST … = [`. If the const is renamed/split into per-pass arrays, the guard falls back to scanning the whole file and then trips on the `RuleManifestEntry` interface's `id:` field → throws loudly. Acceptable (loud, not silent), but worth knowing.

## Out of scope (parked to backlog)

Machine-checked cross-rule ordering constraints (per-rule `after`/`before` edges naming other rule ids + a topo-sort assertion that manifest order satisfies them) — the real drift guard that would encode the ordering *rationale* the comments hold as prose. Filed as `tickets/backlog/debt-optimizer-rule-order-constraints.md`. This ticket's assertion is structural only (dup id / unknown pass).

## Review findings

- Observed that the OPT-003 side-effect static guard parses `optimizer.ts` textually; the manifest conversion required rewriting that guard's parser (done, 15/15 green). Reviewer should sanity-check the new `manifestRegion`/`extractRuleEntries` against the actual manifest once more.
- Noted a test gap: the new dup-id/unknown-pass startup assertion has no direct unit test (parked as a flag above, not filed — cheap to add if desired).
- Recorded two tripwires as `NOTE:`/prose at their sites (guard flat-entry assumption; manifest-const rename) — indexed here, analysis lives at the code sites.
