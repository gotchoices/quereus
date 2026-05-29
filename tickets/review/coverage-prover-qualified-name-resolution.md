description: Review the qualifier-aware AST column resolution in the coverage prover that removed the over-broad name-collision guard, letting 1:1 join-body MVs whose lookup key reuses a UC column name prove `Covers`.
prereq:
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/planner/analysis/predicate-shape.ts, packages/quereus/test/covering-structure.spec.ts, docs/optimizer.md, docs/materialized-views.md
----

## What changed

The coverage prover read the body's `ORDER BY` / `WHERE` from the **body AST** and
resolved every column by **bare name** (`columnIndexFromExpr` ignores any
`alias.`/`table.` qualifier). For join bodies that was unsafe, so the multi-source
work had added a conservative **name-collision guard** in `proveJoinOneToOne` that
rejected (`shape`) any join whose lookup side reused a UC (or UC-predicate) column
name. Sound, but over-broad: it killed valid 1:1 join MVs whose natural lookup key
shares a name with a UC column (the FK/lookup-key-is-also-constraint case).

This change makes the AST resolution **qualifier-aware** and removes the guard.

### Mechanism

- **`predicate-shape.ts`** — added the `ColumnIndexResolver` type
  (`(expr) => number | undefined`); documented that `columnIndexFromExpr` is the
  bare-name (qualifier-ignoring) realization.

- **`partial-unique-extraction.ts`** — threaded a `ColumnIndexResolver` through
  every recognizer (`recognizeGuardClauses` / `recognizeClause` / `recognizeRange`
  / `recognizeBetween` / `recognizeIn` / `recognizeOr`) in place of the raw
  `columnIndexMap`. `extractPartialUniqueGuardedFds` builds the default bare-name
  resolver (single-table partial-index predicates are qualifier-free, so behavior
  is identical). `recognizeConjunctiveClauses(expr, tableSchema, resolve?)` gained
  an **optional** resolver; default is bare-name against `tableSchema`. The
  NOT-NULL / numeric gates still key off `tableSchema` — sound because only the
  indices the resolver yields are ever gated.

- **`coverage-prover.ts`**:
  - New `makeBodyColumnResolver(selectAst, baseTable, lookupNames)` builds the
    qualifier-aware resolver. **Qualified** `alias.col` → a `T` column only when
    `alias ∈` the FROM-clause qualifiers that denote `T` (alias, or table name
    when unaliased — collected by `collectBaseTableQualifiers`, walking nested
    joins). **Unqualified** `col` → a `T` column only when `T` has it *and* no
    lookup-side column shares the name (`lookupNames`, from the join frame).
    Anything else → `undefined` (= "not a resolvable `T` column").
  - `bodyOrderByColumns` and the body-`WHERE` arm of `provePredicateAlignment` now
    use the resolver. `uc.predicate` still resolves bare-name (it is a constraint
    on `T`).
  - `proveJoinOneToOne` → renamed `proveJoinNoFanout`; the name-collision guard
    (and its `collectColumnNames` / `uc` / `baseAttrToCol` dependencies) is gone.
    `lookupColumnNames` is now a standalone helper, called once in `proveCoverage`
    and shared by the resolver.
  - Module + function docs and `docs/optimizer.md` / `docs/materialized-views.md`
    updated (the latter moved this ticket from "remaining follow-up" to delivered).

### Soundness argument (the load-bearing claim to scrutinize)

A lookup-side term resolves to `undefined`, which propagates to a **full
rejection**, never a partial/silent acceptance:
- `ORDER BY` term → `undefined` ⇒ `bodyOrderByColumns` returns `undefined` ⇒
  `ordering-mismatch`.
- `WHERE` conjunct → `undefined` ⇒ `recognizeClause` returns `undefined` ⇒
  `recognizeGuardClauses` returns `undefined` for the whole predicate (one bad
  conjunct drops all) ⇒ `predicate-entailment`. **Verify this "all-or-nothing"
  invariant holds for every shape** (`=`, range, `IS [NOT] NULL`, `NOT col`, `IN`,
  `BETWEEN`, `OR`): a lookup column must never be silently *dropped* from a
  conjunction, which would understate the body's restriction and risk a false
  `Covers`.

## Use cases / validation

Direct prover tests live in `test/covering-structure.spec.ts` (run:
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
"packages/quereus/test/covering-structure.spec.ts" "packages/quereus/test/optimizer/conditional-fds.spec.ts"`).

Acceptance cases (all passing):
- **Positive (the ticket example):** `line_items l LEFT JOIN products p ON
  l.sku = p.sku ORDER BY l.oid, l.sku` now **covers** — `products.sku` (PK,
  unique ⇒ no fan-out) reuses the UC column `sku`, but `l.sku`/`p.sku` stay
  distinct. (Was `shape` under the guard.)
- **`ordering-mismatch`:** the same body with `ORDER BY l.oid, p.sku` (lookup-side
  `sku`) — rejected for the *right* reason, not `shape`.
- **`predicate-entailment`:** the same body with `WHERE p.sku is null` (anti-join,
  LEFT join survives) — rejected for the *right* reason, not `shape`.

Regression floor (all green in the full suite, `yarn test` from `packages/quereus`,
3821 passing / 0 failing):
- Single-source positive/negative-per-reason suites (resolver now applies there
  too and reduces to bare-name — confirm no behavior drift).
- Multi-source soundness: fanout, T-on-dropping-side, self-join, INNER no-FK,
  nullable-FK, same-side-equality-in-ON, lookup-WHERE-cannot-sneak-through.
- `conditional-fds.spec.ts` (the partial-UNIQUE recognizers, now resolver-driven)
  — full pass, confirming the threading didn't change FD extraction.

Also run: `yarn typecheck` (clean), `yarn lint` (clean).

## Known gaps / where to look hard

- **Conservative on derived/function FROM sources.** `collectBaseTableQualifiers`
  only adds plain `TableSource` qualifiers that denote `T`. A body exposing `T`
  through a subquery/TVF source (`from (select * from t) foo … order by foo.x`)
  would have `foo` resolve to `undefined` ⇒ rejection. This is **sound** (only a
  completeness loss) and no test exercises it — partly because it's unclear such a
  shape even reaches the resolver (the shape walk binds `T` to a bare
  `TableReferenceNode`; a subquery source may fail the shape walk first). Reviewer:
  decide whether that shape is reachable and whether a backlog ticket is warranted
  for it. Not in this ticket's scope.
- **Unqualified-ambiguity check trusts join-frame names.** The ambiguity guard for
  bare `col` uses `lookupNames` derived from `topJoin.getAttributes()`. If a
  lookup column were renamed so its frame name diverges from its source name, the
  guard could miss — but a genuinely ambiguous *unqualified* reference would have
  been a plan-time error, so this is defense-in-depth, not the primary guarantee
  (the primary guarantee is qualifier matching).
- **Schema qualifier on a column ref is not separately validated.** The resolver
  keys on `expr.table` only (ignores `expr.schema`), matching the prior
  `columnIndexFromExpr` blind spot but strictly more precise. Cross-schema
  same-name pathological cases aren't specifically tested.
- **The two new negative tests are mildly optimizer-dependent** (they assume the
  optimizer keeps the LEFT join for an ORDER-BY-only body and for the `p.sku is
  null` anti-join). They pass today; if a future optimizer change null-rejects or
  eliminates those joins the reasons could shift to `shape`. Consider whether to
  harden them (e.g. accept "not `shape`") vs. assert the exact reason.

## Acceptance (from the implement ticket — all met)

- A join body sorting/filtering on a UC-named column qualified to `T` covers; the
  same name qualified to the lookup side is rejected as `ordering-mismatch` /
  `predicate-entailment`, not `shape`. ✔
- `line_items ⋈ products on l.sku = p.sku` proves `Covers`. ✔
- The former "negative shape: …reuses that column name" test is updated to the new
  covering outcome (now a positive test). ✔
- No regression in single-source or multi-source soundness suites. ✔
