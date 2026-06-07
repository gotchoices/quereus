description: Design the semijoin / anti-semijoin access-path recovery for an `exists … as` flag that is still referenced but used ONLY as a pure boolean existence probe (`where hasP` / `where not hasP` at top level, nowhere else). Today such a flag is "demanded" so `join-existence-pruning` retains it, pinning the join to nested-loop and forfeiting the semi/anti-join access-path choice. This is a design task — needs demand-*shape* analysis, not the mechanical demand-*presence* check the base rule uses. Independent of `existence-flag-pruning-aggregate-anchored` (the other follow-on) except that both add an entrypoint to `rule-join-existence-pruning.ts`; if both implement tickets are live, sequence this one's eventual implement ticket after the aggregate one to avoid same-file churn.
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts, packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts, packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts, packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/nodes/join-node.ts (joinType 'semi' | 'anti', existence specs, extractEquiPairsFromCondition), packages/quereus/src/planner/util/ind-utils.ts (lookupCoveringFK, isRowPreservingPathToTable, tableSchemaOf), packages/quereus/src/runtime/emit/ (join emitter / existence-flag emission)
----

## Problem

The base rule `join-existence-pruning` drops a flag only when *nothing* demands
its attr id (a clean dead-column prune). The complementary shape it does **not**
handle: a flag that *is* demanded, but **only** as a pure boolean existence
probe — the classic semijoin / anti-semijoin pattern, where the flag is consumed
solely by a top-level `where hasP` (semijoin) or `where not hasP`
(anti-semijoin) and appears nowhere else (not selected, not in another
predicate, not in a sort/group/aggregate, not inside a subquery).

```sql
-- semijoin shape: keep child rows that HAVE a matching parent
select c.* from child c left join parent p on p.pk = c.fk exists right as hasP
  where hasP;

-- anti-semijoin shape: keep child rows that have NO matching parent
select c.* from child c left join parent p on p.pk = c.fk exists right as hasP
  where not hasP;
```

Because `hasP` is referenced, the demand gate retains the flag, which keeps
`hasExistenceColumns` true, which keeps the five flag-guarded join rules
disabled — so the join is pinned to a nested-loop that materializes a boolean
no consumer needs beyond `true`/`false`-as-a-filter. Semantically this is
exactly a `semi` / `anti` join, and rewriting it as one re-opens the
access-path choice (hash semi-join, IND-folding via the existing
`semi-join-fk-trivial` / `anti-join-fk-empty` rules, etc.).

This is a **pure optimization** — the nested-loop-plus-flag plan is correct
today, just slower than the semi/anti shape would allow. No correctness gap.

## Why this is a design task, not a mechanical mirror

The aggregate-anchored sibling (`existence-flag-pruning-aggregate-anchored`) was
a copy of an existing entrypoint because the analysis was unchanged — demand
*presence*. This one needs new analysis: demand **shape**. We must prove the
flag is used *only* as a top-level boolean filter (`where hasP` /
`where not hasP`), and as nothing else, before we can legally rewrite the
`left join … exists` into a `semi` / `anti` join — otherwise we'd drop a column
a downstream consumer reads. That proof, the rewrite construction, and the
interaction with the already-landed IND-folding rules are the design work.

## Existing pieces to build on / interact with

- **`ruleSubqueryDecorrelation`** (`rule-subquery-decorrelation.ts`, Structural
  priority 25) already produces `JoinNode` with `joinType: 'semi' | 'anti'`
  from correlated `EXISTS` / `NOT EXISTS`. The target rewrite should produce the
  *same* node shape so the downstream rules treat both origins uniformly.
- **`ruleSemiJoinFkTrivial`** (priority 26) and **`ruleAntiJoinFkEmpty`**
  fold a `semi` / `anti` join to `L` / `Filter(L, fk IS NOT NULL)` / `Empty`
  when an FK→PK IND covers the equi-condition and R is row-preserving. The new
  rewrite must emit a node these rules then fire on (correct `joinType`,
  `condition` as an AND-of-column-equalities, untouched `left` / `right`).
- The flag-guard list (`if (node.hasExistenceColumns) return null`) in
  join-elimination / fanout / physical-selection / merge-join / lateral-top1.
  After this rewrite the join no longer carries existence columns, so those
  re-enable too — confirm none of them now mis-fire on the semi/anti shape
  (several already early-return on non-inner/left/right joinTypes).

## Open design questions (resolve before emitting implement)

1. **Anchor + entrypoint.** Fire on the top-level `FilterNode` whose predicate
   is exactly `hasP` or `not hasP` (a single `ColumnReferenceNode`, or its
   `IS [NOT] TRUE` / `NOT` wrapper), walk down to the flag-bearing `JoinNode`?
   Or fire on the `JoinNode` and scan ancestors? The Filter anchor mirrors
   `ruleSubqueryDecorrelation` (also a `Filter` entrypoint) and gives direct
   access to the probe predicate — likely the right call, but settle it.

2. **"Used ONLY as a boolean probe" proof.** Need a demand-*shape* analysis:
   the flag's attr id must appear in exactly one place — the anchoring Filter's
   predicate, in a position that is purely `flag` / `not flag` (or
   `flag = true` / `flag = false` / `flag IS [NOT] TRUE` after
   normalization) — and nowhere else in the tree above the join (not in another
   conjunct of the same Filter, not in the Project, not in a Sort/Group/
   aggregate, not inside a subquery). Define the exact accepted predicate
   normal-forms and the rejection criteria. The existing
   `normalizePredicate` + `collectAttrIds` are the building blocks; the new
   logic is "appears exactly once, in probe position."

3. **left/right/inner → semi/anti mapping.** An `exists right as` flag on a
   `left` join means "did the right (non-preserved) side match." `where flag` ⇒
   `semi` join (keep left rows with a match); `where not flag` ⇒ `anti` join.
   Work out the full table for `exists left as` on a `right` join, and whether
   `inner`-join existence flags (always true) are even reachable / worth
   handling. The output node takes the *left* side's attributes only (SEMI/ANTI
   project left columns — see `buildJoinAttributes`); confirm the post-rewrite
   attribute set matches what the consuming Project expects, since the flag
   column disappears from the output.

4. **Multi-flag joins.** A join may carry several existence specs. If only one
   is a pure probe and others are genuinely selected, can we split (rewrite the
   probe into a semi/anti while retaining the join for the others)? Likely
   **no** — a semi/anti join collapses the right side and can't also emit other
   flags. Decide: only fire when the probe flag is the join's *sole* existence
   spec, and document the deferral for the mixed case.

5. **Residual ON-condition + non-equi predicates.** Semi/anti rewrite is only
   sound when the join condition is the existence predicate itself. If the ON
   clause carries extra residual conjuncts, the semi/anti join must carry them
   too (it can) — but confirm the downstream IND-folding rules' AND-of-equalities
   gate still behaves (they abstain on residuals, leaving a plain semi/anti join,
   which is still a win).

6. **Outer-side preservation / NULL semantics.** `left join … where not flag`
   is the textbook anti-join; `left join … where flag` is the textbook
   semi-join. Confirm there's no edge with the existence flag's own NULL/false
   distinction (the flag is `{true,false}`, never NULL — verify in the emitter)
   so `where not hasP` and `where hasP` partition the left rows exactly.

7. **Write-half safety.** The base rule's docstring notes a view-writable
   existence column is always SELECTed (so never a pure probe) — meaning this
   rewrite's "probe only" precondition already excludes the write path. Re-verify
   this holds (a flag used only in `where` is never the target of an
   UPDATE/INSERT-through-view routing Project) and document it, mirroring the
   base rule's "write-half safety is by construction" section.

## Edge cases the eventual implement ticket must enumerate

- `where hasP and <other predicate>` — flag is one conjunct among several; still
  a pure probe iff it's a standalone boolean conjunct. Decide whether to split
  the Filter (rewrite on the flag conjunct, retain the rest above the semi-join)
  or only fire on a sole-conjunct probe.
- `where hasP or <other>` — NOT a pure probe (the flag's truth doesn't partition
  rows); must NOT fire.
- Flag referenced in `where hasP` AND also selected — not a pure probe; retain.
- `exists left as` vs `exists right as`, on `left` / `right` joins — full
  mapping table with a result-equality test per cell.
- Post-rewrite cascade: semi → `semi-join-fk-trivial` folds to `L` (NOT NULL FK)
  or `Filter(L, fk IS NOT NULL)` (nullable); anti → `anti-join-fk-empty` folds
  to `Empty` (NOT NULL FK) — assert the full collapse on FK-covered shapes and a
  plain-semi/anti survivor on non-FK shapes.
- Result equality vs the rule-disabled (nested-loop + flag) baseline across all
  shapes — the rewrite is an optimization, rows must be byte-identical.

## Deliverable

Resolve questions 1–7 (research + pick-and-document, or route a genuine
no-defensible-default to `blocked/`), then emit an `implement/` ticket with the
settled entrypoint, the demand-shape predicate-acceptance spec, the
left/right/inner→semi/anti mapping table, the sole-vs-mixed-flag decision, and a
full `## Edge cases & interactions` section. Park anything out of scope (e.g.
extending probe detection to `case when hasP …` shapes) in `backlog/`.
