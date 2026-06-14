description: Additive test coverage + doc clarification proving `with defaults (…)` rides CTE-name (active) and inline-subquery (inert) DML write targets. No engine code changed.
files:
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # new "with defaults × CTE/subquery write targets" block (11 cases, EOF)
  - docs/view-updateability.md                                # § View defaults (derived-target reach) + § CTEs multi-level (merge note)
  - packages/quereus/src/planner/mutation/single-source.ts    # collectAppendedDefaults / bodyDefaults (INSERT-only; VALUES-only append)
  - packages/quereus/src/planner/building/dml-target.ts        # resolveCteTarget / resolveSubqueryTarget set ephemeral selectAst
  - packages/quereus/src/planner/mutation/cte-flatten.ts       # mergeDefaults — multi-level chain merges, consumer wins
----

# Complete: `with defaults (…)` on CTE-name / inline-subquery DML write targets

Pure additive change — 11 sqllogic cases + two doc paragraphs proving the reachability of the
omitted-insert `with defaults (…)` clause across the derived DML write targets. No engine code
touched; the clause already rides for free on the body select AST (`SelectStmt.defaults`).

## The reachability matrix (verified)

| Target | INSERT | `with defaults` effect | Cases |
|---|---|---|---|
| CTE name (`with t as (…) insert into t …`) | supported | **active** | (1) omitted-fires, (2) supplied-wins, (3) projected-away, (4) typo-errors, (6) multi-level merge, (C) SELECT-source all-supplied |
| Inline subquery (`update/delete (select …) as v …`) | rejected | **inert** | (5) UPDATE ignores clause, (8) INSERT `Expected table name` |
| Any body-shape reject | — | clause never rescues | (7) aggregate, (A) set-op, (B) SELECT-source-needs-append |

## Review findings

**Implement-stage diff read first (commit `da5cc9c6`), then the handoff.** Adversarial pass over
test shapes, doc accuracy, and the engine code the matrix rests on (the latter read-only — no
engine change shipped, so the review is "do the additive tests + docs faithfully describe what the
code does").

### Checked — engine backs every matrix claim
- **CTE-name INSERT fires defaults.** `resolveCteTarget` (`dml-target.ts:42`) sets the ephemeral
  view-like `selectAst` to the (flattened) CTE body; `collectAppendedDefaults` →
  `bodyDefaults(view.selectAst)` (`single-source.ts:963`) reads the clause off it and appends each
  omitted base column. Matches cases (1)–(3).
- **Inline-subquery target is inert.** `bodyDefaults` is consulted *only* on the INSERT lowering;
  the UPDATE/DELETE rewrites never read it, and inline-subquery has no INSERT path
  (`insert into (` is a parser-level reject). Matches (5) and (8).
- **Multi-level merge, consumer wins.** `mergeDefaults` (`cte-flatten.ts:370`) seeds the map from
  the inner clause then overwrites with the consumer's by lowercased column name — consumer wins,
  inner-only columns survive. `composeBody` stores the merged list on the flattened body's
  `defaults`, which `bodyDefaults` then reads. Matches (6): `{a:10 (consumer), b:2 (inner)}`.
- **Body-shape reject regardless of clause.** Defaults are appended only after the body is proven
  decomposable; a set-op/aggregate body rejects before any append. Matches (7)/(A); VALUES-only
  append boundary (`single-source.ts:896`) matches (B), with (C) confirming a fully-supplied SELECT
  source still works.

### Checked — error strings (the implementer's flagged loose-substring risk, resolved)
Ran each `-- error:` case against the live engine and eyeballed the raw message:
- (A) `phase 1` ← `cannot write through common table expression 't': view body operator
  'SetOperation' is not updateable in phase 1` — the genuine set-op body-shape reject, not an
  accidental match. (`phase 1` is specific to the updateability rejects; acceptable as-is.)
- (4) `not a column` ← `… 'with defaults (nope = …)' names column 'nope', which is not a column of
  the view or its base table 'p4'` — proves the clause is actually consumed (typo fails loud).
- (7) `is not updateable in phase 1` ← `… view body operator 'Aggregate' is not updateable in phase 1`.
- (8) `Expected table name` ← `Expected table name. (at line 1, column 13)` — parser reject, no
  inline-INSERT path.
- (B) `VALUES source` ← `… supplying selection-predicate defaults requires a VALUES source in phase 1`.

### Checked — docs reflect the new reality
Read both edited paragraphs in `docs/view-updateability.md` against the verified behavior: the new
§ View defaults paragraph (derived-target reach: active on CTE-name INSERT, inert on inline
subquery, CTE name the only firing derived target, body-shape reject fires regardless) and the
§ CTEs multi-level merge sentence (`mergeDefaults`, consumer wins) are accurate and do not
contradict the existing § Tags / § View defaults / § Inline subquery text. Kept DRY (no separate
inline-subquery line — links to § View defaults).

### Edge/error/interaction coverage assessment
Happy path, supplied-wins, projected-away, typo-error, multi-level merge, three body-shape rejects,
and the SELECT-source append boundary (reject + works) are all covered. Genuinely-unreachable
combinations (inline-subquery INSERT) are reject-tested, not silently skipped.

### Minor observations — NOT fixed (rationale given), no inline change warranted
- **No DELETE inline-subquery `with defaults` case** (only UPDATE, case (5)). Vacuously inert —
  defaults are INSERT-only, and DELETE carries no column values to default. A DELETE case would
  assert nothing UPDATE doesn't. Left out by design, not oversight.
- **Case (A) uses the loose `phase 1` substring** rather than the full reject text. Confirmed above
  to match the genuine set-op reject and to be specific enough; consistent with the file's existing
  aggregate cases. No change.
- **Duplicate-column-in-clause on a CTE body** deliberately not added (same parser path covered at
  the view site, `df3_dup_v`). Optional belt-and-suspenders; not redundant enough to add.

### Major findings
**None.** No engine behavior diverges from the matrix; no feature regression surfaced; no new
fix/plan/backlog ticket spawned.

## Validation
- Targeted: `mocha … --grep "93.4-view-mutation"` → **1 passing**.
- Full: `yarn workspace @quereus/quereus test` → **6231 passing, 9 pending, 0 failing** (unchanged
  count — additions ride the existing per-file aggregate `it`).
- Lint: `yarn workspace @quereus/quereus lint` → **clean** (eslint + `tsc -p tsconfig.test.json`).
- No store-mode run — memory-vtab logic tests with no store-specific surface; deferred to CI per
  AGENTS.md (no `.pre-existing-error.md` filed; the suite is green at this SHA).
