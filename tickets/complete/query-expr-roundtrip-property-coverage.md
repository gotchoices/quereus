---
description: Extended the AST-level emit-roundtrip property suite (`emit-roundtrip-property.spec.ts`) so `queryExprArb` (SELECT | VALUES) drives every QueryExpr-accepting AST site — `SubqueryExpr.query`, `InExpr.subquery`, `ExistsExpr.subquery`, `SelectStmt.compound[].select`, `SubquerySource.subquery`, and `CommonTableExpr.query`. A silent emitter drop at any one of those dispatches now surfaces structurally on the next test run rather than only via the `.sqllogic` execution corpus. Prereq `dml-in-expression-position` landed (in `complete/`); no in-flight dependencies.
files:
  - packages/quereus/test/emit-roundtrip-property.spec.ts
---

## What landed

Six wrapper arbitraries in `emit-roundtrip-property.spec.ts` — each
embeds `queryExprArb` at a distinct QueryExpr-accepting AST site,
re-uses the existing `checkRoundTrip` / `assertAstEquivalent` plumbing,
and runs at `numRuns: 100` per arbitrary:

| Wrapper                 | Site driven                               | Emitter dispatch            |
| ----------------------- | ----------------------------------------- | --------------------------- |
| `subqueryInColumnArb`   | `SubqueryExpr.query` in scalar column     | ast-stringify.ts:216        |
| `inSubqueryArb`         | `InExpr.subquery` (both polarities)       | ast-stringify.ts:227        |
| `existsSubqueryArb`     | `ExistsExpr.subquery`                     | ast-stringify.ts:219        |
| `compoundSelectArb`     | `SelectStmt.compound[].select` × 5 ops    | ast-stringify.ts:425        |
| `subquerySourceArb`     | `SubquerySource.subquery` (FROM)          | ast-stringify.ts:478        |
| `cteSelectArb`          | `CommonTableExpr.query`                   | ast-stringify.ts:450        |

CREATE VIEW (`createViewArb`) was already covered upstream; no DML
positions were widened — those are the prereq's domain and the planner
gates them out at several of these sites.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `node packages/quereus/test-runner.mjs --grep "QueryExpr at every accepting site"`
  — 6 passing.
- `node packages/quereus/test-runner.mjs` (full quereus suite) — 3680
  passing, 9 pending, no failures (one above the implement-stage 3679;
  the delta is the new SubquerySource case).

`yarn test:store` not run — change is confined to a pure parser↔stringifier
property test that does not touch any vtab/store code path.

## Review findings

Approach: read the implement-stage diff
(`git show 49e397337f8e017396b314a0d32e8e08676241ed`) cold, then walked
every QueryExpr-accepting AST site in `parser/ast.ts`, mapped each to its
emitter dispatch in `emit/ast-stringify.ts`, and verified the parser-side
re-build for each shape. Then re-ran the implement summary's "Known
gaps" list to disposition each.

### Coverage gap closed inline (minor)

- **`SubquerySource.subquery` (FROM-clause subquery) was missing.** The
  ticket title and the new `describe` block both say "at every accepting
  site," and the implementer's enumeration listed five sites — but
  `SubquerySource.subquery` (ast.ts:396) routes through a sixth
  `astToString` dispatch (`fromClauseToString` case `'subquerySource'`,
  ast-stringify.ts:475-486) and was not covered by either the new suite
  or any pre-existing arbitrary. Closed by adding `subquerySourceArb`
  and the matching `it()` ("SubquerySource.subquery in FROM round-trips
  structurally"). Verified by running the full quereus suite.

### Cross-checked, no finding

- **Parser-side branch coverage for each new wrapper.** Confirmed each
  QueryExpr-accepting site genuinely accepts both legs of `queryExprArb`
  on the parser side: SubqueryExpr via `checkSubqueryStart` +
  `parseQueryExpr` (parser.ts:1752-1760); InExpr (both polarities) via
  the comparison loop's NOT-IN and IN branches calling `parseQueryExpr`
  (parser.ts:1253-1271, 1371-1382); ExistsExpr via
  `parseQueryExpr` (parser.ts:1583); compound-leg via the SELECT/VALUES
  dispatch at parser.ts:648-663; SubquerySource via the
  SELECT/VALUES/WITH/INSERT/UPDATE/DELETE lookahead at parser.ts:863-872;
  CommonTableExpr via `parseQueryExpr` inside the WITH parser. All five
  (now six) wrappers re-parse the emitter output back to the same AST
  shape they generated.
- **InExpr negated/non-negated branch shapes.** The implementer's
  generator emits `UnaryExpr(NOT, InExpr)` when `negated === true`, mirroring
  the parser output for `c NOT IN (...)`. Traced `NOT c IN (...)` through
  `notExpression` → `isNull` → `equality` → `comparison`: the prefix-NOT
  also lands on `UnaryExpr(NOT, InExpr)`, so the stringifier's `not c in
  (...)` re-parses to the same shape. The comment in the file is correct.
- **Unary-NOT parens around InExpr body.** `unaryBodyNeedsParens`
  (ast-stringify.ts:278-280) returns true only for binary bodies, so the
  `UnaryExpr(NOT, InExpr)` shape emits as `not c in (...)` without an
  extra paren — which is what the parser expects. Verified by test run.
- **Compound-leg VALUES support.** Parser supports a bare VALUES on
  every compound op (UNION, UNION ALL, INTERSECT, EXCEPT, DIFF) — see
  parser.ts:651-653 calling `valuesStatementWithOptionalCompound` with
  `isCompoundSubquery: true`. The generator's full `compoundOpArb` set
  matches this surface.
- **Comparator handling of new sites.** `SubquerySource.alias` already
  in `CASE_INSENSITIVE_STRING_KEYS`; no comparator-side change needed.
  `subquerySource` is a plain object with a discriminator, so the
  default `astEquivalent` path applies.
- **No other QueryExpr-accepting sites.** Walked every `: QueryExpr`
  occurrence in `parser/ast.ts`. Remaining sites:
  `CreateViewStmt.subquery` (already covered by `createViewArb`),
  `InsertStmt.source` (DML; out of scope per the prereq's framing and
  Known gap #1 below).

### Implementer's known gaps — disposition

1. **DML at these sites.** The implementer asked the reviewer to
   confirm scope and either file a follow-up or document the deferral.
   *Disposition:* not filing. The prereq `dml-in-expression-position`
   already landed and is the natural home for that coverage; if a
   follow-up is wanted it should live alongside that body of work, not
   as a standalone ticket here. Re-using `insertArb`/`updateArb`/
   `deleteArb` in the QueryExpr position would also require a RETURNING
   clause and a planner-gating audit per site — non-trivial scope.
2. **`materializationHint` silent drop.** Verified the bug: parser
   populates the field (parser.ts:301-316), emitter never emits the
   keyword (no `material` token anywhere in
   `emit/ast-stringify.ts`). *Disposition:* filed
   `tickets/backlog/known/4-cte-materialization-hint-emitter-drop.md`
   with both viable fix shapes (emit the keyword vs. codify the drop)
   plus the broader "is round-trip fidelity the default?" policy question.
3. **CTE column-list survival.** Not filed. The existing
   `emit-roundtrip.spec.ts` already exercises one canonical case, and
   the arity-coupling-to-VALUES issue is the same as
   `createViewArb`'s — both would need a column-arity-aware generator
   pair. Lower priority than #2 above.
4. **Compound chains of length > 1.** Not filed. The implementer
   correctly noted this exercises parser right-recursion, not the
   emitter dispatch in scope. A future generator could chain
   `compound: { op, select: <wrapper-producing-its-own-compound> }`
   but the marginal coverage over a single compound link is small
   relative to a multi-site fan-out like this ticket.
5. **Wrapper SELECTs are minimal.** Not filed. Same reasoning —
   interaction shapes (correlated refs, outer ORDER BY / LIMIT around
   an embedded form) are a different test concern.

### Smell checks beyond the implementer's list

- **Comparator drift.** Walked `assertAstEquivalent` /
  `DEFAULT_EQUIVALENCES` / `CASE_INSENSITIVE_STRING_KEYS` /
  `FALSE_DEFAULT_FIELDS` for any field that the new wrappers might
  accidentally trip. None — the new arbitraries only stitch existing
  node types together, no new field surface.
- **Determinism.** Each arbitrary is seedable (`fc.tuple` of pure
  arbitraries → `.map`), `numRuns: 100` matches the existing
  CREATE-VIEW arbitrary precedent. No shrinking issues observed on
  any of the six runs.
- **Test isolation.** New `describe` block sits in its own scope; no
  mutation of shared arbitraries (`queryExprArb`, `simpleSelectArb`,
  `valuesStmtArb`, `identArb`). Existing CREATE VIEW property test
  re-confirmed green in the full-suite run.
- **Docs.** Skimmed `docs/architecture.md`, `docs/sql.md`,
  `docs/runtime.md`, `docs/types.md` for any contract the new tests
  might tighten or contradict. None — these tests verify the existing
  AST-level round-trip contract that's already documented at the top
  of `emit-roundtrip-property.spec.ts` and `emit-roundtrip-comparator.ts`.
  No doc updates needed.
- **AGENTS.md project rules.** Lowercase SQL keywords throughout
  (`select`, `from`, `where`, etc. — the new wrappers operate on AST
  nodes, so no SQL strings are produced inline; verified the stringifier
  output via the running tests). No ESM/import issues; no `any`; no
  unused vars.
- **Pre-existing test failures.** None — full suite is green at
  3680 passing / 0 failing.

### Out-of-scope by ticket framing

- DML in QueryExpr positions (see #1 above).
- The `materializationHint` emit fix itself (filed as a follow-up at
  `tickets/backlog/known/4-cte-materialization-hint-emitter-drop.md`).
- Multi-link compound chains, correlated-outer interactions, column-list
  arity-coupled generators.
