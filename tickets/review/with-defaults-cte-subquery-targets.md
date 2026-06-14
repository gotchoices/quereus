description: Review the additive test coverage + doc clarification proving `with defaults (…)` rides CTE-name (active) and inline-subquery (inert) DML write targets. No engine code changed — review the test shapes for correctness/completeness and the doc wording for accuracy.
files:
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # new "with defaults × CTE/subquery write targets" block (appended at EOF)
  - docs/view-updateability.md                                # § View defaults (derived-target reach) + § CTEs multi-level (merge note)
  - packages/quereus/src/planner/mutation/single-source.ts    # READ-ONLY: collectAppendedDefaults / bodyDefaults (INSERT-only; VALUES-only append at :896)
  - packages/quereus/src/planner/building/dml-target.ts        # READ-ONLY: resolveCteTarget / resolveSubqueryTarget set ephemeral selectAst
  - packages/quereus/src/planner/mutation/cte-flatten.ts       # READ-ONLY: mergeDefaults — multi-level chain merges, consumer wins
difficulty: easy
----

# Review: `with defaults (…)` on CTE-name / inline-subquery DML write targets

## What landed (pure additive — no engine change)

1. **Test block** appended at the end of `packages/quereus/test/logic/93.4-view-mutation.sqllogic`
   under a banner `with defaults (…) × CTE-name / inline-subquery DML write targets`. Eleven
   cases, named (1)–(8) and (A)–(C), matching the ticket's empirically-confirmed expected
   outputs verbatim (table names kept as `p1`–`p8` / `q1`–`q3` / `q2src` / `q3src` —
   grep-confirmed collision-free against the rest of the file).

2. **Doc clarification** in `docs/view-updateability.md`:
   - § View defaults — a new paragraph stating the derived-target reach: **active on a
     CTE-name INSERT target**, **inert on an inline-subquery target** (UPDATE/DELETE ignore
     it, inline INSERT rejected), so the CTE name is the only derived target that fires
     defaults; and that a body-shape reject fires regardless of the clause.
   - § Common Table Expressions (multi-level CTE body paragraph) — a sentence noting a
     per-level `with defaults` **merges** through the flattener (`mergeDefaults`,
     `cte-flatten.ts`), consumer winning on a column collision, linking back to § View defaults.
   - Kept DRY: no separate § Inline subquery line (the § View defaults paragraph links to it).

## The reachability matrix (the load-bearing claim under review)

| Target | INSERT | `with defaults` effect | Cases |
|---|---|---|---|
| CTE name (`with t as (…) insert into t …`) | supported | **active** | (1) omitted-fires, (2) supplied-wins, (3) projected-away, (4) typo-errors, (6) multi-level merge |
| Inline subquery (`update/delete (select …) as v …`) | rejected | **inert** | (5) UPDATE ignores clause, (8) INSERT still `Expected table name` |

There is **no inline-subquery INSERT path** by design, so there is no supplied-wins/omitted-fires
test against an inline subquery — that case is unreachable, not omitted by oversight.

## Validation performed (treat as a floor, not a ceiling)

- Targeted: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/logic.spec.ts" --grep "93.4-view-mutation"` → **1 passing**.
- Full: `yarn workspace @quereus/quereus test` → **6231 passing, 9 pending, 0 failing**
  (passing count unchanged — the additions ride the existing per-file aggregate `it`).
- `yarn workspace @quereus/quereus lint` → **clean** (eslint + `tsc -p tsconfig.test.json`).
- No store-mode run (`yarn test:store`) — these are memory-vtab logic tests with no
  store-specific surface; deferred to CI per AGENTS.md.

## Known gaps / things worth an adversarial look

- **Case (A) error string is the loose substring `phase 1`** (not the full
  `is not updateable in phase 1` the aggregate cases use). The harness matches case-insensitive
  substring (`logic.spec.ts:605`), so `phase 1` passes against whatever the set-op INSERT reject
  actually raises. Worth confirming the real message is the intended set-op body-shape reject and
  that `phase 1` isn't accidentally matching unrelated text. (It was the ticket's empirically
  confirmed string; I used it verbatim but did not eyeball the full raw message.)
- **Error-block structure dependency.** For the `-- error:` cases the harness runs all but the
  LAST `;`-split statement as setup and expects only the last to throw. Each error case here is
  arranged so the failing statement is last and all setup succeeds — verify that holds for (4),
  (7), (8), (A), (B) if you reorder anything.
- **Duplicate-column-in-clause on a CTE body** was deliberately NOT added (ticket called it
  optional belt-and-suspenders — same parser path already covered at the view site, df3_dup_v).
  Add it if you want the redundancy.
- **`with defaults` placement after `group by`** in case (7) (`… group by g with defaults (g = 9)`)
  exercises the clause parsing at the tail of an aggregate spine; it parses and reaches the
  body-shape reject as expected, but is an unusual clause position worth a sanity glance.
- Doc edits are prose-only; no claim was walked back (the feature tickets already fixed the old
  over-claims) — verify the new paragraphs don't contradict the existing § Tags / § View defaults text.

## Disposition

Minor wording or an extra test case → fix inline. Anything that suggests the engine behavior
differs from the matrix above (e.g. an inline-subquery INSERT that *doesn't* reject, or a CTE
INSERT default that *doesn't* fire) → that is a feature regression, spawn a fix/ ticket rather
than patching the test to match. Then move to complete/ with a `## Review findings` section.
