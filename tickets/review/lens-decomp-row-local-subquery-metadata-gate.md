description: |
  Hardened the lens decomposition per-op constraint gate against subquery-bearing row-local CHECKs.
  The `writeRowColumns` AST walker under-collected a correlated bare write-row ref that appears only
  *inside* a subquery (it assumed such refs resolve against the subquery's own FROM), but the prover
  classifies ANY scalar CHECK over reconstructible columns — subqueries included — as
  `enforced-row-local`. On a decomposition that under-collection threaded the CHECK onto a member op
  whose target lacks the column → `<col> isn't a column` build crash. Fix: `collectLensRowLocalConstraints`
  now attaches prover-supplied `referencedWriteRowColumns` metadata (source CHECK's referenced logical
  columns mapped to basis columns); `constraintsForOp` prefers it over the walk for the row-local class.
  Row-local only — FK / set-level keep the (correct) walk. Plus a trivial DRY consolidation of the
  duplicated `collectColumnRefNames`. Build + 4982 tests + lint all green.
files:
  - packages/quereus/src/schema/table.ts                              # RowConstraintSchema: new optional referencedWriteRowColumns field (~L455)
  - packages/quereus/src/schema/lens-prover.ts                        # collectColumnRefNames now exported (~L1421)
  - packages/quereus/src/schema/lens-compiler.ts                      # local collectColumnRefNames duplicate removed; imports the prover's (~L15, ~L1570)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # rowLocalReferencedBasisColumns helper + metadata attach (~L88-140)
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # constraintsForOp prefers metadata (~L893); walker/gate doc comments updated (~L869, ~L917)
  - packages/quereus/test/lens-put-fanout.spec.ts                     # 3 subquery-CHECK regressions + setupSubqueryCheck helper (~L1658+)
  - docs/lens.md                                                      # § Enforcement by constraint class: per-class write-row-column derivation (~L286)
----

# Harden lens decomposition constraint-gate against subquery-bearing row-local CHECKs — for review

## The bug (now fixed)

The per-op resolvability gate (`constraintsForOp` + the `writeRowColumns` AST walker in
`view-mutation-builder.ts`) decides which lens-synthesized constraint rides which base op of a
decomposition fan-out: a constraint rides an op iff every **write-row** column it references resolves
on that op's target table.

`writeRowColumns` collected (a) any `NEW.*`/`OLD.*`-qualified column anywhere, plus (b) any **bare**
column **not** inside a subquery — deliberately ignoring bare subquery-internal refs on the assumption
they resolve against the subquery's own FROM, and that the only class carrying bare refs
(`enforced-row-local`) is subquery-free. **That invariant is false:** `classifyCheckConstraint`
(`lens-prover.ts`) classifies *every* scalar CHECK over reconstructible columns as
`enforced-row-local`, subqueries included, and Quereus supports subqueries in CHECKs (auto-deferred to
commit). So a CHECK like `check (exists (select 1 from peer where peer.k = somecol))` — `somecol` a bare
write-row column appearing only inside the subquery — was under-collected, threaded onto a member op
lacking `somecol`, and crashed at plan-build with `somecol isn't a column` (loud build-time
`QuereusError`, never silent corruption — hence "hardening", not "emergency").

## What shipped

Prover-supplied **metadata** instead of teaching the walker about correlation:

- **`RowConstraintSchema.referencedWriteRowColumns?: readonly string[]`** (`table.ts`) — a dedicated,
  optional, transient field (chose this over JSON-in-`tags`, which is the only string-array-shaped
  alternative and is janky). Set only on lens row-local constraints; never persisted, never compared by
  the differ.
- **`collectLensRowLocalConstraints`** (`lens-enforcement.ts`) — new `rowLocalReferencedBasisColumns`
  helper enumerates the source CHECK's column refs via `collectColumnRefNames`, maps each through the
  slot's `logicalToBasisColumnMap`, keeps only mapped names (lowercased basis), and attaches them. This
  mirrors the prover's own row-local classifier: a logical column of the table (the correlated
  write-row ref) is included; a foreign subquery ref (`peer.k`) maps to nothing and is excluded.
- **`constraintsForOp`** (`view-mutation-builder.ts`) — `const refs = c.referencedWriteRowColumns ??
  writeRowColumns(c.expr);`. Row-local uses metadata; FK / set-level (which leave it undefined) keep
  the walk (their `NEW.*`/`OLD.*` refs the walker collects unambiguously anywhere).
- **`collectColumnRefNames`** exported from `lens-prover.ts`; the byte-identical duplicate in
  `lens-compiler.ts` deleted and imported from there (trivial DRY win — the file already imported from
  `lens-prover.js`).
- Doc comments at the walker + gate + the docs/lens.md gating paragraph updated to record the per-class
  split (row-local = metadata, FK/set-level = walk) and why.

Scope held tight: **row-local only**. FK / set-level walk untouched; `rewriteToBasisTerms` untouched.

## Use cases for testing / validation

Three regressions in `test/lens-put-fanout.spec.ts` via a new `setupSubqueryCheck(db, checkSql)`
helper, on the surrogate `Doc_core`(title)/`Doc_body`(body)/`Doc_meta`(note, optional) decomposition,
with an `Allowed` basis allow-list the subquery probes:

| Test | CHECK | Operation | Expected | Mechanism |
|---|---|---|---|---|
| single-member builds + runs | `exists(select 1 from Allowed where Allowed.name = title)` | `set title='ok', note='n1'` (→ Doc_core **and** Doc_meta) | PASSES, both persist | metadata `{title}` gates onto Doc_core only; pre-fix empty set rode Doc_meta → crash |
| single-member enforces | same | `set title='nope', note='n2'` | ABORTs (deferred subquery CHECK at commit), both unchanged | CHECK rides the column-owning member and fires |
| cross-member deferred | `exists(... where Allowed.name = title and Allowed.kind = note)` | `set title='zzz', note='zzz'` | PASSES, violation persists | metadata `{title,note}` resolves on neither member → rides none → deferred (matches INSERT path) |

**Non-vacuity verified:** I temporarily reverted the gate to `const refs = writeRowColumns(c.expr)`
and re-ran — test 1 crashes `Column not found: title`, test 2 gets that crash instead of the CHECK
ABORT, test 3 crashes. All three are genuine regressions of the fix; restored after.

**Validation run:** `yarn workspace @quereus/quereus build` (clean), `test` (**4982 passing, 9
pending**), `lint` (clean). The 9 pending are pre-existing.

## Known gaps / boundaries (reviewer: please weigh)

- **The headline fix is the GATE; the subquery REWRITE is a separate, untouched concern with its own
  boundary.** `rewriteToBasisTerms` does **not** descend into subqueries (it calls `transformExpr`
  without a `descend` arg), so a correlated write-row ref *inside* a subquery keeps its **logical**
  name in the built constraint. That is fine only when logical name == basis name. A subquery row-local
  CHECK correlating a column whose logical and basis spellings **differ** (e.g. `docKey`→`doc_key`)
  would now be gated correctly onto the owning member by this fix, but would then **still fail at
  build** — in the rewrite, with a *logical*-name "not a column" error, not the gate's fault. The
  ticket explicitly scoped `rewriteToBasisTerms` out ("do not modify it"). **My tests deliberately use
  same-named columns (`title`/`note`) to isolate the gate.** If the reviewer thinks the rewrite gap
  warrants its own follow-up, it's a clean separate `fix/` ticket — flagging it rather than silently
  leaving the broader subquery-CHECK story half-done.
- **Over-collection on name collision is intentional and untested.** A subquery ref qualified to
  another table whose column name equals a logical column (`peer.title` where `title` is logical) is
  qualifier-stripped by `collectColumnRefNames` and falsely mapped → an extra basis name. This only
  ever makes the gate *defer* a constraint it might have threaded (the safe direction; the gate's bias
  is already conservative). Documented in the `rowLocalReferencedBasisColumns` comment. No dedicated
  test (the cross-member test implicitly exercises a qualified inner ref).
- **Single-source (non-decomposition) lenses** now also carry the metadata, but their single base op
  holds all basis columns, so the gate is a no-op there — behavior byte-identical (full suite confirms
  no regression).
- **Differ invisibility confirmed by reading, not just reasoning:** `schema-differ.ts` compares
  `AST.TableConstraint` via `constraintBodyToCanonicalString` / `tableConstraintsToString` (name / type
  / expr / operations / onConflict / tags / FK clause only) and never sees transient lens
  `RowConstraintSchema` objects (built at write-plan time, never persisted). The new field is invisible
  to it on both counts.
- **Treat the tests as a floor.** They pin the single-member-enforce, single-member-build-safe, and
  cross-member-defer outcomes on one fixture shape. Not pinned: a subquery row-local CHECK on a
  *single-source* lens (no-op path, but untested as such); an `in (subquery)` correlated shape (vs the
  `exists` shape tested); interaction with a *child-FK* subquery on the same decomposition (the FK
  class still uses the walk — believed correct, but no mixed-class fixture exists).
