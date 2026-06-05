description: Read-only front half of the Dataphor `include rowexists` feature — the `exists [<side>] as <name>` outer-join existence column, derived at the combinator as a clean `{true,false}` NOT NULL boolean. Parser/AST/stringify, JoinNode-native flag attribute with `key → flag` FD, `existence` UpdateSite (read-only), and the five optimizer guards that keep a flag-bearing join nested-loop. All writes reject (the write half is `outer-join-existence-column`). Reviewed and shipped.
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, docs/view-updateability.md, docs/sql.md
----

## What shipped

The read-only front half of the outer-join existence column. An outer join's
match-existence is exposed as a first-class clean `{true,false}` NOT NULL boolean
column **derived at the combinator** (not stored, not a predicate re-evaluation):

```sql
from A left join B on B.aid = A.id exists as hasB                 -- side resolved → right
from A full join B on B.aid = A.id exists left as aEx, exists right as bEx
```

- **Grammar** (parser.ts): join-anchored `exists [left|right] as <name>` after a
  complete `on`/`using` predicate. One-token lookahead (`as`/side token, never `(`)
  disambiguates from the `exists (<subquery>)` predicate; the comma form continues
  only before another `exists`. The side is resolved & stored, so stringify always
  emits it explicitly and `parse(stringify(ast))` is stable from the 2nd parse.
  `inner`/`cross` and the *preserved* side of `left`/`right` are rejected;
  explicit side required for `full`.
- **Mechanism** (join-node.ts / join-utils.ts): `ExistenceColumnSpec[]` with
  pre-minted stable attr ids threads through ctor / `withChildren` / attribute &
  type builders. The flag is appended after both sides, boolean NOT NULL, never in
  any key. FDs: `withKeyFds` over the full output width yields `key → flag` for
  every preserved key (flag never a determinant); each flag gets a `{true,false}`
  enum domain.
- **Lineage** (update-lineage.ts / plan-node.ts): new `existence` `UpdateSite`
  kind carrying a `RelationalComponentRef` + join guard; read-only (no base column).
- **Runtime** (runtime/emit/join.ts): appends the *actual* null-extension bit
  (matched → all flags true; null-extended → the non-preserved side's flag false) —
  the bit the outer-join emitter already computes, never an ON re-evaluation.
- **Optimizer guards**: five rules bail on `hasExistenceColumns`
  (`rule-join-physical-selection`, `rule-monotonic-merge-join`,
  `rule-join-elimination`, `rule-fanout-lookup-join`, `rule-lateral-top1-asof`) so
  the flag-bearing join stays nested-loop and the appended column is never dropped.

## Validation

- `yarn workspace @quereus/quereus test` — **4693 passing, 0 failing, 9 pending**.
- `yarn workspace @quereus/quereus lint` — exit 0.

## Review findings

Adversarial pass over the implement diff (commit `52d5ed0c`), read with fresh eyes
before the handoff summary. The implementation is sound, well-decomposed, and
honestly documented; the handoff's self-listed gaps were verified to be genuine
deferrals (not defects), not glossed-over bugs.

**Checked — correctness:**
- **Runtime flag emission** (`emit/join.ts`): `matchedFlags`/`unmatchedFlags`
  pre-computed once; matched rows append all-true, null-extended `postRow` appends
  `side === 'left'` (→ false for the only legal `right`-side flag on a LEFT join).
  Row width stays consistent with `getAttributes()` (left + right + flags). The
  soundness property test (`… on p.pp = c.pr or p.pp is null`) confirms the flag is
  the combinator bit, not a predicate re-eval. **Correct.**
- **FD / key invariants** (`join-utils.ts`): keys computed pre-flag (indices into
  side columns stay valid), flag appended after; `key → flag` FD present, flag
  never a determinant nor inside a claimed key, `{true,false}` enum domain, `isSet`
  unchanged vs the no-flag join. Verified against the property tests. **Correct.**
- **Parser disambiguation / rejection** (`parser.ts`): `atExistenceClause()`
  lookahead never absorbs an `exists (` predicate; the `, exists`-only continuation
  leaves a genuine new-FROM comma for `tableSourceList`; side resolution rejects
  inner/cross/preserved-side/ambiguous-full. **Correct.**
- **Optimizer guards**: all five `hasExistenceColumns` guards present. The
  un-guarded join rules are safe by construction and were re-verified:
  `greedy-commute` / `quickpick` / `key-inference` are inner/cross-only;
  `fanout-batched-outer` only flips an already-formed `FanOutLookupJoinNode` (which
  the guarded `fanout-lookup-join` rule never forms from a flag-bearing join);
  branch-injection rebuilds via `withChildren` (preserves `existence`);
  empty-relation-folding reads `getAttributes()`/`getType()` (include the flag).
  **Sound.**
- **`componentTable: Number(this.left.id)`** (`join-node.ts`): probed the handoff's
  "best-effort" caveat — `PlanNode.id` is `` `${nextId++}` `` (a numeric string), so
  this is a valid number, **not** NaN. The caveat is only about AliasNode-vs-
  TableReferenceNode identity, relevant to the write half. **Fine for the read half.**
- **Docs**: `docs/sql.md` and `docs/view-updateability.md` accurately describe the
  read-half, read-only nature, grammar, and disambiguation; the cross-doc anchor
  `view-updateability.md#existence-columns-on-outer-joins-read-half` resolves to a
  real heading. **Up to date.**

**Found & fixed inline (minor):**
- The implement commit accidentally swept in a transient harness lock file,
  `.claude/scheduled_tasks.lock` (per-session pid/lock), which was tracked and not
  gitignored. Untracked it (`git rm --cached`, working file preserved) and added a
  narrow `.gitignore` entry. `.claude/settings.json` remains correctly tracked.

**Filed as new ticket (deferred non-trivial optimization, not a defect):**
- `tickets/backlog/prune-unused-existence-flag.md` — when a flag is *unused*, the
  five guards still pin the join to nested-loop and block join-elimination purely to
  compute a discarded column. A dead-column pruning pass should drop the unused flag
  and re-enable the standard join optimizations. Correctness is unaffected today;
  sequenced after the write half (`outer-join-existence-column`).

**Verified-deferred (owned by the write half / documented limitations — no action):**
- All write paths reject (`update`→`no-inverse`, `insert` rejects, bases untouched)
  — by design; write semantics belong to `outer-join-existence-column`.
- Existence joins forgo hash/merge/fanout selection (kept nested-loop) — documented
  perf limitation, not a correctness issue.
- `full`/`right` existence is grammar-/round-trip-only because the runtime already
  throws `RIGHT/FULL JOIN is not supported` (pre-existing engine limit).
- `composeUpdateSite(existence, …)` ignores an outer invertible transform — correct
  for a read-only column; the write half may need to record the transform.

**Empty categories:**
- No correctness bugs found. No major findings requiring a fix/plan ticket. No
  pre-existing test failures surfaced (suite green at this SHA).

## Out of scope (deferred, by design)

Projection-position sugar `exists(<alias>) as`; all write semantics
(existence-flip ⇒ insert/delete) — both belong to `outer-join-existence-column`.
Dead-flag pruning — `prune-unused-existence-flag` (backlog).
