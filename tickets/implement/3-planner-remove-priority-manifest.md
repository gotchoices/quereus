description: Optimizer rules carry a "priority" number that looks like it sets run order but is ignored by the code that actually runs — remove it and rewrite the rule-registration block as a readable data table.
prereq:
files: packages/quereus/src/planner/framework/registry.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/README.md, packages/quereus/docs/optimizer.md
difficulty: medium
----

## Decision (settled — do not re-open)

**Remove `priority` entirely.** Registration order is the real, deliberate execution contract; `priority` is dead, and worse, *actively misleading*:

- The only code that ever consumed `priority` for ordering was the dead `RuleRegistry` path, already deleted by the completed ticket `1-planner-delete-dead-rule-registry`. Nothing reads `priority` today.
- Rule application iterates `pass.rules` in push (registration) order — `framework/pass.ts:587` (`for (const rule of pass.rules)`), never consulting `priority`.
- The `priority` numbers **disagree** with actual registration order in several places (e.g. in `optimizer.ts` a rule at `priority: 17` is registered *after* one at `priority: 19`; multiple `priority: 22` rules are registered after `priority: 23` rules). A reader trusting the numbers would be misled about real order. The code author already knew this: `optimizer.ts:109` ("Pass rules fire in REGISTRATION order (not by `priority`)") and `optimizer.ts:405-406` ("this placement ... is what realizes the ordering; the priority value is documentation").

Because the numbers already contradict execution, "make it real by sorting" is rejected: sorting `pass.rules` by `priority` would reorder those inverted rules and risk correctness regressions, for zero benefit. And "assert priorities non-decreasing within a pass" is impossible without renumbering dozens of arbitrary values — the numbers carry no independent meaning worth preserving.

The honest contract after this change: **manifest array order = registration order = execution order, single source of truth.**

## Scope

Two folded changes, done together (they touch the same ~900-line block, so splitting would double-churn it):

### 1. Delete the `priority` field

- Remove `priority?: number` and its jsdoc from `RuleHandle` (`framework/registry.ts:58-59`).
- Delete every `priority: N,` line from `registerRulesToPasses` in `optimizer.ts` (~40 occurrences).
- Repoint every doc-comment that cites a magic priority number to name the **rule it orders against** instead. These live in `optimizer.ts` inline comments **and** in ~10 rule files and two READMEs — sweep the whole planner tree, not just `optimizer.ts`. Known sites (non-exhaustive; grep to confirm):
  - `framework/README.md:8,42`
  - `packages/quereus/src/planner/analysis/README.md:41`
  - `rules/subquery/rule-anti-join-fk-empty.ts:29`
  - `rules/sort/rule-orderby-fd-pruning.ts:48`
  - `rules/cache/rule-scalar-cse.ts:13`
  - `rules/cache/rule-materialized-view-rewrite.ts:17`
  - `rules/join/rule-inner-join-existence-recovery.ts:102`
  - `rules/join/rule-fanout-batched-outer.ts:12`
  - `rules/predicate/rule-filter-contradiction.ts:23`
  - `rules/join/rule-join-elimination.ts:322`
  - all `(priority N)` mentions inside `optimizer.ts` comments
  - `packages/quereus/docs/optimizer.md` if it documents `priority` (grep — current sweep found no hit, but re-check after edits)

  Rephrase pattern: `// runs after predicate-pushdown (priority 20)` → `// runs after predicate-pushdown` (the ordering fact is the rule name + the manifest position, not the number).

### 2. Table-driven manifest for `registerRulesToPasses`

Convert the imperative `addRuleToPass(...)` wall in `optimizer.ts:100-966` into a data manifest — an ordered array (or per-pass ordered arrays) of rule descriptors — plus a small loop that registers them. Goal: the ordering contract becomes **inspectable as data**, and drift is caught by a startup assertion.

Manifest entry shape (adapt as needed) — carries everything a `RuleHandle` needs **minus** `priority`, plus the target pass:

```ts
interface RuleManifestEntry {
  pass: PassId;
  id: string;                    // or idTemplate for fan-out (see edge cases)
  nodeType: PlanNodeType | PlanNodeType[];  // array → one fn fanned across types
  phase: RulePhase;
  fn: RuleFn;
  sideEffectMode: SideEffectMode;
  // ordering rationale stays as a comment on the entry, migrated from the
  // old inline comments (numbers stripped, rule-name references kept)
}
```

Registration loop iterates the manifest **in array order** and calls `addRuleToPass` — preserving today's exact per-pass order (this is the load-bearing correctness invariant; see edge cases).

**Startup assertion** (run once, at manifest-registration time): the ordering invariant is structural well-formedness, since with `priority` gone the array order *is* the order and there is no separate numeric intent to cross-check. Assert:
- No duplicate rule `id` within a pass. (Today `addRuleToPass` *silently skips* dup ids at `pass.ts:315-318` — a real duplicate is an author bug that should hard-fail, not be swallowed. First verify no legitimate registration relies on that silent skip; if one does, that is a latent defect to surface, not paper over.)
- Every entry's `pass` resolves to a registered pass.
- `sideEffectMode` still validated per entry (keep `validateSideEffectMode`; do not bypass it).

Keep the assertion cheap and synchronous — it runs at optimizer construction, not per-optimize.

## Edge cases & interactions

- **Registration order must be byte-for-byte preserved per pass.** Execution = registration order; any reordering silently changes query plans. The manifest array order must exactly reproduce today's `addRuleToPass` call sequence within each of `Structural`, `Physical`, `PostOptimization`. Verify by capturing the ordered rule-id list per pass before and after (e.g. log `pass.rules.map(r => r.id)`), and diffing — they must be identical.
- **Fan-out rule (`grow-retrieve`).** One `fn` (`ruleGrowRetrieve`) is registered across `relationalNodeTypes` (Filter, Project, Sort, LimitOffset, Aggregate, Distinct, Join, Window) with per-type ids `grow-retrieve-<nodeType>` (`optimizer.ts:145-175`). The manifest must support one entry expanding to N handles with distinct templated ids, registered in the same nodeType order. **Preserve the exact id string format** — `disabledRules` tuning and tests may reference these ids.
- **Twin-handle rule (`materialized-view-rewrite`).** Same `fn` (`ruleMaterializedViewRewrite`) registered twice: once on `Project` (id `materialized-view-rewrite`) and once on `Aggregate` (id `materialized-view-rewrite-aggregate`), `optimizer.ts:113-141`. Manifest must allow two distinct entries sharing an `fn`. Do not collapse them.
- **Rule ids are a public-ish contract.** `context.tuning.disabledRules` matches rule ids by string (`pass.ts:589`); optimizer/plan tests reference ids. **No id may change** — including the fan-out templates. A rename silently breaks rule-disable controls and tests.
- **Custom-execute passes have no rules.** `ConstantFolding` and `Materialization` run via `execute` (`pass.ts:108-126,155+`) and register zero rules — the manifest covers only rule-registering passes. Don't emit empty entries for them.
- **`sideEffectMode` gate stays live.** Every entry still declares `safe`/`aware`; `validateSideEffectMode` must still fire (via `addRuleToPass`, which already calls it). Don't let the manifest path skip validation.
- **Duplicate-id semantics change from silent-skip to hard-fail.** Confirm the current corpus has no intentional duplicate (grep ids); flip to assertion only after confirming. Note the behavior change in the review handoff.
- **Plan-golden drift = order regression.** `test/plan/` and `test/optimizer/` goldens encode plan shapes that depend on rule firing order. A green run of the full suite is the proof that order was preserved; any golden diff means the manifest order slipped and must be fixed (not re-baselined).

## Out of scope (parked)

Machine-checked cross-rule ordering constraints (per-rule `after`/`before` edges naming other rule ids, with a topo-sort assertion that the manifest order satisfies the declared dependencies) — a real drift guard that would encode the ordering *rationale* the comments currently hold as prose. Deferred to backlog `debt-optimizer-rule-order-constraints` to keep this ticket sized. This ticket's assertion is structural only.

## TODO

- [ ] Delete `priority` field + jsdoc from `RuleHandle` (`framework/registry.ts`).
- [ ] Capture baseline: log/dump ordered `pass.rules.map(r => r.id)` per pass on current code — save for the after-diff.
- [ ] Grep planner tree + docs for existing duplicate rule ids per pass; confirm none rely on `addRuleToPass` silent-skip.
- [ ] Design `RuleManifestEntry` type + manifest array(s), migrating each `addRuleToPass` call in `optimizer.ts` order, dropping `priority`, keeping rationale comments (numbers stripped).
- [ ] Handle fan-out (`grow-retrieve`) and twin-handle (`materialized-view-rewrite`) entries with exact id preservation.
- [ ] Registration loop over manifest → `addRuleToPass`, array order preserved per pass.
- [ ] Startup assertion: dup-id-per-pass, unknown-pass; keep `validateSideEffectMode`.
- [ ] Sweep all `(priority N)` / `priority N` doc-comment references across `planner/` + READMEs; rephrase to rule-name ordering. Re-grep `docs/optimizer.md`.
- [ ] Re-capture ordered rule-id list per pass; diff against baseline — must be identical.
- [ ] `yarn workspace @quereus/quereus run build` clean.
- [ ] `yarn test` (streamed via `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`) — full suite green, no plan-golden drift.
- [ ] `yarn workspace @quereus/quereus run lint` clean (catches signature drift + test-file type errors).
