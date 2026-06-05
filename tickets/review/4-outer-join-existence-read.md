<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-05T05:25:04.884Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\4-outer-join-existence-read.review.2026-06-05T05-25-04-883Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Review the read-only front half of the outer-join existence column — the `exists [<side>] as <name>` join clause (parser/AST/stringify), the `existence` UpdateSite, the JoinNode-native `{true,false}` NOT NULL match-flag attribute with its `key → flag` FD, and the read-only static surfaces. No write semantics (writes reject). Build + full quereus test suite (4692 passing) + lint all green.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, docs/view-updateability.md, docs/sql.md
----

## What shipped

The read-only front half of the Dataphor `include rowexists` feature: an outer
join's match-existence exposed as a first-class clean `{true,false}` NOT NULL
boolean column, **derived at the combinator** (not stored, not a predicate
re-evaluation). Reads work; **all writes of the column reject** (the write half is
the companion `outer-join-existence-column`).

### Syntax (join-anchored, additive grammar)

```sql
from A left join B on B.aid = A.id exists as hasB                 -- side resolved → right
from A full join B on B.aid = A.id exists left as aEx, exists right as bEx
```

The `exists [left|right] as <name>` clause parses **after a complete `on`/`using`
predicate**. The flag is referenced by its `as` name in the projection / anywhere
the join scope is visible (e.g. `select c.cc, hasB from … exists as hasB`). NOTE:
the parent ticket's fixture wrote `exists right as hasP` inside the SELECT list —
that is shorthand; the real grammar is join-anchored (projection-position sugar is
explicitly deferred).

Resolution/rejection (in the parser, where the join type is known):
- `exists as` → the unique non-preserved side of `left`/`right`.
- explicit side **required** for `full` (both sides null-extend).
- `inner`/`cross`, and the **preserved** side of `left`/`right`, are **rejected**
  (no null-extension ⇒ a constant-`true` flag).
- one-token lookahead after `exists` (an `as`/side token, never `(`) disambiguates
  from the `exists (<subquery>)` predicate; the comma form continues only when the
  post-comma token is another `exists`, so a real new-FROM-source comma is left
  for `tableSourceList`.

The parser **resolves and stores** the side, so stringify always emits the
explicit side and `parse(stringify(ast)) ≡ ast` (string round-trip stable from the
2nd parse; `exists as f` → `exists right as f`).

### Mechanism (JoinNode-native flag attribute — the recommended path)

- **plan-node.ts**: `UpdateSite` gains a 4th kind `existence` carrying a
  `RelationalComponentRef` (`{kind:'join-side', table, side}` — generalized so
  `set-operator-membership-columns` can add a set-branch variant) + the join guard.
- **join-node.ts / join-utils.ts**: `ExistenceColumnSpec[]` (pre-minted stable
  attr ids) threads through the ctor / `getChildren` (unchanged — flags aren't
  child nodes) / `withChildren` / `getLogicalAttributes` / `buildAttributes` /
  `getType`. The flag column is appended **after both sides**, boolean NOT NULL,
  **never** part of any key (`combineJoinKeys` only sees side columns).
- **FDs (Invariants 1–2)**: `computePhysical` passes the full output column count
  (incl. flags) to the existing `propagateJoinFds`/`withKeyFds`, so `key → flag`
  falls out for every preserved key and the flag is never a determinant. Each flag
  gets a `{true,false}` enum `domainConstraint`.
- **update-lineage.ts**: `deriveJoinUpdateLineage` registers an `existence` site
  per flag; `resolveBaseSite`/`composeUpdateSite` handle the new kind
  (read-only, no base); `identityBaseColumn`/`viewColumnsFromUpdateLineage` map it
  to a non-base column.
- **runtime/emit/join.ts**: appends the **actual null-extension bit** per flag
  (matched → all flags true; null-extended → the non-preserved side's flag false).
  This is the bit the outer-join emitter already computes — NOT a re-evaluation of
  the ON predicate (proven sound by a test using `… on p.pp = c.pr or p.pp is null`).
- **schema.ts** (`column_info`): the existence column reports `is_updatable='NO'`,
  `base_table`/`base_column` = `null` (automatic — `baseSiteOf(existence)=undefined`).

### Optimizer guards (the load-bearing soundness decision — review closely)

The logical `JoinNode` carrying flags **stays the nested-loop join** so the
appended flag column is never dropped. These rules bail when
`node.hasExistenceColumns`: `rule-join-physical-selection`,
`rule-monotonic-merge-join`, `rule-fanout-lookup-join`, `rule-join-elimination`
(critical: a live flag's attr id is **not** in the non-preserved side's id set, so
`usesRight` can't see the dependency — elimination would be unsound), and
`rule-lateral-top1-asof` (defensive). Rules verified safe **without** a guard:
greedy-commute / quickpick (inner/cross only — flags only ever on outer joins);
predicate-inference branch-injection (inner/cross, rebuilds via `withChildren`
which preserves `existence`); empty-relation-folding (returns an `EmptyRelationNode`
from `node.getAttributes()`/`getType()`, which already include the flag).

## How to validate

- `yarn workspace @quereus/quereus test` — 4692 passing, 0 failing (ran clean).
- `yarn workspace @quereus/quereus lint` — exit 0.
- Targeted: `… mocha … property.spec.ts --grep "existence column"` (8 tests) and
  `--grep "Key Soundness"` (corpus query added), and `emit-roundtrip.spec.ts`.

### Test coverage (the floor, not the ceiling)

In `property.spec.ts` (`describe('Outer-join existence column (read half)')`):
read agreement (flag ⇔ non-preserved presence, row-by-row); clean boolean
(never NULL, always in `{true,false}`); **soundness** (`… or p.pp is null` proves
the flag tracks actual match, not predicate re-eval); FD/Key-soundness (keys & isSet
unchanged vs no-flag join, `key → flag` present, flag never in a key, enum domain,
NOT NULL); lineage (flag is an `existence` site, non-writable); write-rejects
(UPDATE → `no-inverse`, INSERT rejects, bases untouched); `column_info` (NO/null);
grammar rejections. Plus a flag-bearing query added to the shared Key Soundness
corpus (Tier-1 result + Tier-2 isolated-node walk). `emit-roundtrip.spec.ts`:
round-trips for `exists as`, explicit right, full both-side, and reject cases.

## Known gaps / things for the reviewer to probe (treat tests as a floor)

- **Dead-column elimination of an UNUSED flag is NOT implemented.** The ticket's
  TODO wanted an unselected flag to be pruned so it doesn't retain the
  non-preserved side (semijoin-probe). Correctness is fine (an unused flag is just
  computed and ignored), but the optimization — and the join-elimination it would
  re-enable — is deferred. No test asserts pruning. Consider whether this needs a
  follow-up ticket.
- **Existence joins forgo hash/merge/fanout selection** (kept nested-loop by the
  guards). A documented perf limitation, not a correctness issue. An alternative
  (threading flags through the physical join nodes + their emitters) was rejected
  here as out-of-scope for a read half — confirm that trade-off is acceptable.
- **Emit only realizes LEFT.** `exists left/right as` on a `full`/`right` join
  parses + stringifies, but the runtime can't execute full/right joins at all
  (pre-existing `runtime/emit/join.ts` throws `RIGHT/FULL JOIN is not supported`).
  So full-join existence is grammar-/round-trip-only today. Verify this boundary is
  acceptable (it mirrors the existing engine limit).
- **`RelationalComponentRef.table` is best-effort** = the non-preserved side's
  relational plan-node id (may be an AliasNode, not the underlying
  TableReferenceNode). Unused in the read half; the write half must refine it.
- **Write-reject reason is the generic `no-inverse`** ("computed/read-only"), not an
  existence-specific diagnostic. Clear enough for now; the write half may want a
  dedicated reason.
- **`view_info`** was not given a dedicated existence test (logically unaffected —
  the flag contributes no base site, so per-side insertable/deletable facts stand).
  Worth a reviewer spot-check.
- **`composeUpdateSite(existence, …)` ignores an outer invertible transform** (e.g.
  a view `select not hasP as nf`) — returns the existence site unchanged. Correct
  for the read half (read-only either way) but the lineage doesn't record the
  transform; revisit if the write half needs it.

## Out of scope (deferred, by design)

Projection-position sugar `exists(<alias>) as`; all write semantics
(existence-flip ⇒ insert/delete) — both belong to `outer-join-existence-column`.
