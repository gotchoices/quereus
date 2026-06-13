----
description: Re-home the view `insert defaults (…)` clause as a core-select `with defaults (…)` clause, finishing the unification the `with inverse` work started
files: packages/quereus/src/parser/parser.ts (parseInsertDefaultsClause ~2764, parseInverseClause ~2802, call sites ~2639/2733/2907/3174/3709/3773), packages/quereus/src/parser/ast.ts (ViewInsertDefault, insertDefaults fields), packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/derivation.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/rename-rewriter.ts (renameTableInInsertDefaults / renameColumnInInsertDefaults), packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/create-view-node.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/runtime/emit/create-view.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/analysis/authored-inverse.ts (validation precedent), docs/view-updateability.md, docs/sql.md, docs/materialized-views.md, docs/schema.md, docs/architecture.md
----

## Motivation

The `insert defaults (col = expr, …)` clause is a write-direction annotation, but it lives at the
wrong grammatical altitude and under a misleading spelling:

- **It reads like a command.** `select id, name from dfi insert defaults (…)` visually parses as a
  statement boundary followed by an INSERT — especially confusable in this engine, where DML *is* a
  legal `QueryExpr` and `insert` can genuinely follow a relation expression.
- **It is DDL-only**, attached to `create view` / `create materialized view` / `create table …
  maintained as` / `alter table … set maintained as`. Its sibling `with inverse` lives on **core
  select**, which is exactly why every relation site gets inverses uniformly (plain views, CTEs,
  subqueries-in-`from`, lens bodies — see docs/view-updateability.md § Authored inverses). CTEs and
  from-subqueries are first-class write targets but cannot declare an insert default today.
- The two clauses were designed as siblings — the `with inverse` design rules say "the
  assignment-list shape deliberately mirrors the `insert defaults` clause" — but ended up with
  divergent residence, validation timing, rename-propagation machinery, and hash/round-trip
  plumbing.

## Decided design (settled with the developer — do not re-litigate)

**Spelling: `with defaults (col = expr, …)`** — a trailing clause of the core query expression.
The `insert` qualifier is deliberately dropped:

- "Default" in SQL already means *value supplied when none is given*; a base column's `default`
  clause is not spelled `insert default` either. This clause is the view-level analogue — literally
  step 5 of the insert-defaulting chain, one step above the base column's `default` at step 6
  (docs/view-updateability.md § Projection) — so the same word at two levels is the right symmetry.
- The unqualified name leaves room for a future `update v set col = default` resolving through the
  clause; a name with `insert` baked in would be wrong if that orthogonality lands.

**Placement and binding:**

- Trails the query expression (after `limit`/`offset`), before the DDL-level `with tags`. Two
  `with` clauses in sequence disambiguate on the keyword following `with`.
- Binds to the **whole** compound (like a trailing `order by`), matching today's view-level
  semantics. Entries route to their owning base by the same lineage machinery as every other
  write-through decision. A parenthesized leg carrying its own clause is a possible future
  refinement, not in scope.
- The clause lives on the select AST, not the DDL statements — so `create view`, `create
  materialized view`, the `maintained as` table form, and `set maintained as` all get it through
  the body with **no per-statement clause slot**, and CTE / subquery-in-`from` / lens-body sites
  gain it for free (new capability).

**Parser:** commit on `WITH` + contextual `DEFAULTS` — the exact two-token-commit-and-rewind
pattern of `parseInverseClause` (parser.ts ~2802), including the safe-rewind property (the rewound
token is `WITH`, which never touches the parenStack). `DEFAULTS` stays contextual; no new reserved
word. The old `insert defaults` spelling and `parseInsertDefaultsClause` are **removed outright**
(no backward compatibility per project rules); a stray `insert` after a body falls back to the
pre-existing downstream syntax error.

**Semantics are unchanged.** Entry shape `(col = expr)`, named base-column (or base-lineage view
column) targets, self-contained expressions (no inserted-row references — the rewrite appends them
as VALUES cells), position in the defaulting chain, and the MV transparency to row-time backing
maintenance all carry over verbatim. This ticket moves the clause; it does not change what it does.

## Consolidation that falls out

- **Storage:** `TableDerivation.insertDefaults` and the `ViewSchema` slot fold into the stored body
  AST (`selectAst`); `bodyHash` / `viewDefinitionToCanonicalString` cover the clause automatically
  instead of itemizing it (docs/schema.md notes the current separate itemization).
- **Rename propagation:** `renameTableInInsertDefaults` / `renameColumnInInsertDefaults`
  (schema/rename-rewriter.ts) consolidate into the body rewrite walk, sharing the target-rewrite
  path the `with inverse` clause already rides (targets are base columns in both).
- **DDL rendering:** `generateMaintainedTableDDL` / `generateMaterializedViewDDL` and the
  declarative renderers drop their separate clause slot; the body stringify carries it.
- **`set maintained as`** loses its explicit clause parameter — the body brings its own defaults.

## Open questions for this plan stage

- **Validation timing.** Today the target is resolved (and a typo rejected) at *write time*, not at
  create (docs/sql.md). `with inverse` validates position-independently at build time
  (planner/analysis/authored-inverse.ts) and that posture is strictly better — but confirm it is
  achievable for plain-view bodies (which may not be fully planned at create) before committing to
  parity; otherwise keep write-time resolution and say so in the docs.
- **Where the clause is inert vs rejected.** Decide the posture for a `values (…)` body (read-only
  — inert metadata like an unused `with inverse`, or rejected?), a DML-position `QueryExpr`
  (`insert … returning … with defaults (…)` is meaningless — reject at parse or build), and a bare
  top-level `select … with defaults (…)` statement.
- **Catalog migration.** Store catalogs persist canonical DDL containing the old spelling; the
  project's no-backward-compat rule applies, but the plan should state explicitly that old
  persisted catalogs will not re-parse (acceptable; transient-schema posture) rather than leave it
  implicit.

## Edge cases & interactions (seed list for the implement ticket)

- Compound body: clause after the last leg binds to the whole expression; a clause attempted
  mid-compound (before `union`) must error cleanly, not bind to the leg.
- `with defaults` followed by `with tags` (and adjacent to a result-column `with inverse`) — all
  three in one `create view`, round-tripped byte-stable through `ast-stringify` and the
  emit-roundtrip property suite.
- CTE and subquery-in-`from` write targets consuming the clause (new capability — needs new
  sqllogic coverage; today only the DDL sites are tested).
- MV surfaces: `bodyHash` change detection in the declarative differ (a defaults-only edit must
  still schedule rebuild/re-attach), `materialized_view_modified` on rename-driven clause rewrites,
  canonical-DDL fixed point (live-create → persist → reopen → re-persist byte-identical).
- `view_info` / `column_info` insert-coverage reporting now reads the clause from the body AST —
  including the never-throw skip posture for an entry naming a nonexistent column.
- Duplicate-target rejection inside the clause and interaction with an authored-inverse put
  targeting the same base column (today `conflicting-assignment` at the supplied/default seam —
  preserve).
- Existing tests spelling `insert defaults` (19 files, e.g. test/logic/93.4-view-mutation.sqllogic,
  50-declarative-schema.sqllogic, 51.7-maintained-table-attach-detach.sqllogic,
  declarative-equivalence.spec.ts, emit-roundtrip*.spec.ts, schema-differ.spec.ts) migrate to the
  new spelling.
- Docs: view-updateability.md § View insert defaults (rename the section), sql.md §2.8/§2.9 + MV
  DDL grammar, materialized-views.md DDL sections (clause-order line included), schema.md (bodyHash
  itemization, rename events), architecture.md line ~117.
