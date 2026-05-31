description: COMPLETE — Fixed `ruleGroupByFdSimplification` collapsing a constant-pinned multi-column GROUP BY to a scalar (empty-GROUP-BY) aggregate, which emitted one spurious all-NULL `count=0` row over empty input instead of zero rows. One-line guard added so the rule never empties the GROUP BY; sqllogic regression added (and extended in review with a mixed constant+free case). Reviewed adversarially; build + lint + full logic suite observed green (4100 passing), and a plan dump confirms the partial-drop optimization still fires.
files: packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts, packages/quereus/test/logic/25.4-groupby-fd-constant-empty.sqllogic
----

# Complete: constant-pinned multi-column GROUP BY must not collapse to a scalar aggregate

## Summary of the landed change

### The fix (one guard)
`packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts`
(committed at `009caaa9`), added at line 134 — after `keptGroupBy` is built
(loop 118–125) and **before** picker-MIN synthesis:

```ts
// Never collapse a grouped aggregate to a scalar (empty-GROUP-BY) aggregate:
// that would emit one row over an empty input instead of zero. This happens
// when every grouping column is constant-pinned (e.g. `where a = 0 and k = 6`),
// so FD propagation gives each an empty-determinant FD (`{} → col`) and
// `minimalCover` satisfies them all from `{}`, draining the cover. Removing the
// last group key changes the query's cardinality contract, which is never sound.
// Keep at least one grouping column.
if (keptGroupBy.length === 0) return null;
```

### Regression test
`packages/quereus/test/logic/25.4-groupby-fd-constant-empty.sqllogic` — committed
at `009caaa9` with 5 cases, then **extended in this review pass** with a 6th
(mixed constant-pinned + free column over empty input). Cases:
1. multi-col constant-pinned, empty → `[]` (the repro)
2. multi-col constant-pinned, non-empty → one row
3. single-col control → `[]`
4. partial-drop (`group by id,name`, id=PK) → `name` dropped, `id` kept
5. partial-drop shape over empty match → `[]`
6. **(added in review)** mixed: constant-pinned `a` dropped + free `b` kept,
   over empty match → `[]`

## Review findings

### What was checked
- **The implement diff was read first, with fresh eyes** (`git show 009caaa9`),
  before the handoff summary. Both changed files were read in full; the on-disk
  rule file was confirmed byte-identical to the committed HEAD version.
- Adversarial static analysis of the guard across SPP / correctness / soundness
  / over-trigger / placement / resource-cleanup angles.
- Soundness of the surrounding rule for the constant-FD (`{} → col`) drop path,
  including the mixed constant+free case.
- The regression test's case set, expected values (re-derived from SQL
  semantics + seed data), and coverage.
- **Plan-dump verification** that the optimization still fires where it should
  and bails where it must (the implementer's one explicitly-open item).
- **lint + build + full logic suite**, run and observed green.

### Correctness / soundness — confirmed
- **Guard is reachable and necessary.** With ≥2 bare-column candidates (early
  return at line 61) all dropped: `cover.size`=0 ≠ `candidateSet.size` (≥2), so
  the line-103 guard passes through; `dropped.size`≥2>0, so line 109 passes.
  Control would otherwise reach picker synthesis and construct an empty-GROUP-BY
  `AggregateNode`. The new guard is exactly what intercepts this.
- **Condition is exact.** `keptGroupBy` accumulates every `groupBy[i]` that is
  not a dropped candidate (non-column GROUP BY expressions and kept candidate
  columns). It is empty **iff** every GROUP BY item is a dropped candidate —
  precisely the scalar-collapse case, nothing more.
- **No over-trigger — confirmed both statically and by plan dump.** The guard
  fires only when `keptGroupBy.length === 0`. The plan dumps show:
  - partial-drop (`group by id, name`): rewrites to
    `Aggregate … group by id → min(name), count(*)` — rule **fires**, `id`
    survives, `name` re-emitted as a picker.
  - all-constant-pinned empty (`where a=0 and k=6 group by a, k`): stays
    `Aggregate … group by a, k → count(*), sum(b)` (annotated
    `[emptyResultGuaranteed]`) — guard **fires**, GROUP BY not collapsed.
  - mixed (`where a=0 group by a, b`): rewrites to
    `Aggregate … group by b → min(a), count(*)` — rule **fires**, constant `a`
    dropped, free `b` survives.
- **Mixed constant+free drop stays sound.** `a` is constant over the whole
  relation, so `MIN(a)` faithfully recovers it per group while `b` gates row
  production → zero rows over empty input. The guard is the only missing piece;
  the rest of the rule is unaffected and remains sound.
- **Clean disposition.** The function is pure up to line 134 (only local maps /
  arrays built); `return null` aborts the rewrite with no side effects. No new
  imports; no other lines touched. The single guard sits naturally in the
  existing bail-out chain (DRY / modular).

### Test review
- Cases are SQL-semantics-dictated, so a green run cannot produce a false pass
  from optimizer quirks — it fails only if the engine returns wrong rows.
  Expected values re-derived from seed data are correct, including the non-empty
  case: rows are `(id2:a3,b4,k2)` and `(id3:a7,b1,k9)`, so `where a=7 and k=9`
  hits only id3 → `{"a":7,"k":9,"c":1,"s":1}`.
- **Implementer correctly fixed a bug in the fix-stage ticket's example:** the
  fix ticket suggested the non-empty probe `a=3 and k=9`, which matches *no* row
  (id2 has a3 but k2). The landed test uses `a=7 and k=9`, matching id3. Using
  the ticket's value verbatim would have made case 2 a vacuous `[]`.

### Findings & disposition
- **Minor — coverage gap (FIXED inline this pass).** The committed test lacked
  the *mixed constant-pinned + free* column over **empty** input — the one shape
  that combines "rule fires / drops a subset" with "empty input → zero rows."
  Added as case 6 (`select a, b, count(*) as c from t where a = 0 group by a, b;`
  → `[]`) and confirmed green. This is the case whose plan dump proved the
  partial-drop path stays alive.
- **No major findings.** No new fix/plan/backlog tickets filed — the fix is
  minimal, precise, and verified sound.
- **Bail vs retain-one:** the `return null` bail (over the strictly-better
  "retain one dropped candidate as the group key" optimization) is the correct
  low-risk choice; the partial path only helps a degenerate query shape (every
  group column equality-pinned). Left as-is, as the fix ticket recommended.
- **`residualRowMatchesKey`** in `database-materialized-views.ts` was correctly
  left untouched — a sound invariant that becomes a harmless no-op for the MV
  consumer now that the rule never empties GROUP BY.

### Validation performed (observed)
- `yarn workspace @quereus/quereus run build` — **exit 0, clean.**
- `yarn workspace @quereus/quereus run lint` — **exit 0, clean.**
- Full logic suite (`mocha test/logic.spec.ts`) — **exit 0**, **4099 passing**
  pre-edit, **4100 passing** after adding case 6 (one new expectation), 9
  pending, **0 failing**.
- Plan dumps (via `db.getDebugPlan`) captured for the three representative
  shapes above — all match the expected fire / bail behavior.
- Note: this session intermittently buffered/delayed tool-result *display*
  (the actions executed; results arrived late, matching the implementer's
  experience). All results recorded here were ultimately observed directly —
  none are fabricated. `tickets/.pre-existing-error.md` was not written: no test
  failure was encountered.

## Outcome
The reported bug — a constant-pinned multi-column `group by` emitting one
spurious all-NULL `count=0` row over empty input — is fixed by a precise,
statically- and dynamically-verified guard, with SQL-semantics-dictated
regression coverage (including the mixed partial-drop-over-empty case). Build,
lint, and the full logic suite are green, and plan dumps confirm the
partial-drop optimization still fires while the all-columns-dropped collapse is
correctly prevented.
