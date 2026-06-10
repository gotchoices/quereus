description: First-class view insert-default construct — `create [materialized] view v [(cols)] as <body> insert defaults (col = expr, …)` parsed at all three DDL sites, carried as AST `Expression` values on ViewSchema/MaterializedViewSchema, consumed by the insert write-through rewrite and `view_info` with three-tier precedence (statement tag → clause → deprecated view-level tag). Reviewed and completed; two major findings filed as fix tickets.
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/src/planner/mutation/single-source.ts
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/schema/ddl-generator.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts
  - docs/view-updateability.md
  - docs/sql.md
----

# First-class view insert-default construct — complete

Implemented in the `packages/quereus` hunks of commit `0af303bd` (swept by the runner
into the store-rename review commit; the two change sets touch disjoint files). See the
implement handoff (preserved below the findings) for the full feature inventory: parser
clause at three DDL sites, schema threading through both create emitters +
`materializeView` + both `importCatalog` rehydration paths, three-pass precedence in
`rewriteViewInsert`, `deriveViewInfo` clause∪tag union, four stringify renderers, DDL
generator lift, and docs.

## Review findings

**Read first, fresh:** the full `0af303bd` quereus diff (all 25 source/test/doc files),
then the handoff. Every consumer chain was traced to its endpoints rather than trusted
from the summary.

### Checked and sound (no action)

- **Un-cloned schema AST in the rewrite** (handoff's top concern): `appendExprs` has
  exactly one consumption point — the VALUES rewrite at `single-source.ts:779`, which
  maps `cloneExpr` per row; non-VALUES sources are rejected before it. `cloneExpr` is a
  true deep structural clone (expressions + nested subqueries), so the schema-held node
  never enters a plan and per-row evaluation is independent (verified empirically:
  three-row insert with `r = random()` produced three distinct values). The pre-existing
  constant-FD pass pushes `fc.valueExpr` through the identical pattern. The *known
  residual* sharing in `cloneExpr` (CTE bodies / IUD-RETURNING subqueries) is already
  tracked in `fix/clone-expr-shared-subtrees-vs-inplace-rewriters` and its mutation
  channel (rename rewriters) does not run over insert plans.
- **Precedence passes**: pass 3 iterates the merged statement-over-view map, but its
  statement entries were appended in pass 1 so `isSupplied` skips them; `readDefaultFor`
  lowercases keys and pass 2 lowercases `d.column`, so the three passes and the
  `view_info` union set agree on casing. Verified by the 93.4 cases (statement-over-
  clause, clause-shadows-view-tag, view-tag-alone).
- **MV path**: MV write-through reaches the same `rewriteViewInsert` via `propagate()`
  with `MaterializedViewSchema` satisfying `MutableViewLike`; the field is threaded
  through `materializeView` and both import paths. `view_info` excludes MVs entirely
  (`getAllViews` only), so the clause∪tag union living solely in `deriveViewInfo` is
  complete; `multi-source.ts` / `decomposition.ts` have no `readDefaultFor` consumers —
  confirmed by reference search.
- **Shared comparator relaxation** (handoff gap 2): `column` is now positional only when
  numeric (loc) and compares case-insensitively when a string. String `column` fields in
  the AST are identifiers (UPDATE SET assignments, the new clause entries) — case-
  insensitive compare is consistent with `columnName`/`name`/`table` already in the set;
  `meaningfulKeys` and `normalize` use the same `isPositionalKey` predicate, so the two
  sides cannot disagree. Sound.
- **Parser backtrack**: `advance()` does have a non-cursor side effect — LPAREN/RPAREN
  `parenStack` maintenance — so the handoff's "no side effects beyond the cursor"
  justification was wrong; the code is nonetheless correct because the only rewound
  token is INSERT, which never touches the stack. Comment updated in place to pin the
  real invariant. Also verified: a stray `insert` after the body still errors as before,
  `insert defaults ()` (empty list) errors, quoted `"defaults"` does not false-trigger
  `peekKeyword`, duplicate columns rejected.
- **Tests**: 93.4 (write-through, precedence ×3, unknown-column error, MV), 06.3.4
  (insertability rescue + negative control + tag-form + typo-skip), 50-declarative
  (diff renders clause / apply re-parses / converged re-declare), declarative-
  equivalence, emit-roundtrip property arbitraries — all read and adequate as a
  starting point; gaps closed below.

### Found and fixed inline (minor)

- **`view-mv-ddl-persistence.spec.ts` pinned-fact gap**: the spec's
  `viewSchemaFromDDL`/`mvSchemaFromDDL` lifters did not carry `insertDefaults`, so a
  clause matrix entry would have silently dropped the clause and still passed. Lifters
  fixed; fixed-point matrix gains two clause entries (each kind); two new
  `importCatalog` tests pin clause rehydration + write-through on an imported view and
  MV (the manager.ts changes previously had no direct test). Partially compensates for
  `yarn test:store` not being run (per AGENTS.md it is reserved for store diagnosis/
  release) — the store path rides exactly this parse→generate→import fixed point.
- **Docs inaccuracy (pre-existing, repeated by the new text)**: step 5 and the tag table
  claimed the default expression "may reference any surviving column". Verified false
  for both the clause AND the tag it replaces (the expression is appended as a VALUES
  cell; a column ref fails at plan time with "Column not found"). Both docs sites
  corrected to "self-contained expression", and § View insert defaults now states the
  evaluation context explicitly; the unverifiable "resolves through the mutation-context
  envelope" sentence was dropped. `docs/sql.md` §2.8 bullet gains the same constraint.

### Found and filed (major → new tickets)

- **`fix/view-insert-defaults-declarative-drift-undetected`** — a clause-only change on
  a name-matched declarative view or MV diffs empty and `apply` silently keeps the old
  default (reproduced live). The deprecated tag WAS drift-detected via `tagsDrifted` →
  SET TAGS, so tag→clause migration loses declarative drift detection; MV `bodyHash`
  covers `stmt.select` only. Plain-view *body* drift is also undetected — a pre-existing
  broader hole documented in the same ticket so one fix can close both coherently.
- **`fix/view-insert-defaults-not-rewritten-on-source-rename`** — renaming the defaulted
  base column leaves `d.column` stale; the next insert through the view hard-fails with
  `tag-target-not-found` (reproduced live). Behavior-parity with the tag's identical
  blind spot, but a first-class construct should ride `propagateColumnRename` like the
  body does. MV-side coverage is delegated to the already-dispositioned
  `fix/mv-body-not-rewritten-on-source-rename` (noted there-in via this ticket).

### Explicitly not findings

- Error-handling/resource posture: no new exception paths are swallowed; the clause's
  unknown-column error is sited at write time and `view_info` keeps its never-throw
  posture (both pinned by tests). No new resources/cleanup surfaces. Type safety: no
  `any`, `ReadonlyArray` throughout, frozen-record conventions matched.
- The statement-level tag surviving is by design; the view-DDL tag's removal is the
  chained `remove-view-default-for-tag` (implement/, prereq on this slug — unblocked by
  this completion).

### Validation

`yarn build` exit 0; `yarn lint` (packages/quereus) exit 0; `yarn test` full workspace:
**5557 passing / 0 failing** in quereus (5551 pre-review + 6 review-added tests), all
other packages green (the `failingKv.iterate` stack line in sync output is a
deliberately-failing mock inside a passing test). `yarn test:store` not run, per
AGENTS.md reservation.

---

# Implement-stage handoff (preserved)

Trailing clause after the view body, before `with tags`, on both plain and materialized
views and on declarative `view` items:

```sql
create view dfi_v (id, name) as select id, name from dfi
  insert defaults (created = epoch_ms('now'));
```

- **AST**: `ViewInsertDefault { column: string; expr: Expression }`;
  `insertDefaults?: ReadonlyArray<ViewInsertDefault>` on `CreateViewStmt` and
  `CreateMaterializedViewStmt`. Values are first-class expressions with real `loc`.
- **Parser**: `parseInsertDefaultsClause` commits only once `DEFAULTS` follows `INSERT`
  (single-token backtrack otherwise); rejects duplicate column names. Wired at
  `createViewStatement`, `createMaterializedViewStatement`, and `declareViewItem`.
- **Schema threading**: field on `ViewSchema`/`MaterializedViewSchema`; through
  `CreateViewNode`/`CreateMaterializedViewNode`, both emitters, `materializeView`, and
  both `importCatalog` rehydration paths — store-backed persistence round-trips via
  `generateViewDDL`/`generateMaterializedViewDDL` → catalog DDL text → re-parse.
- **Consumers**: `rewriteViewInsert` applies omitted-insert defaults in three ordered
  passes per resolved base column: statement-level `default_for` tag → the clause → the
  deprecated view-level tag. `deriveViewInfo` unions clause and tag column names for the
  `defaultable` set.
- **Round-trip**: `insertDefaultsClauseToString` rendered by all four renderers; DDL
  generator lifts the schema field back to AST.
- **Semantics**: evaluated per omitted-insert row at write-through, step 5 of the
  insert-defaulting chain, ahead of the base column's declared `default`. Unknown name:
  hard sited diagnostic at write time; silently skipped by `view_info`.
- **Docs**: `docs/view-updateability.md` § View insert defaults; `docs/sql.md` §2.8/§2.9
  prose + examples + EBNF `insert_defaults_clause`.
