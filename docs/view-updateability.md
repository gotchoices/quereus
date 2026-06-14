# View Updateability

Quereus treats views, CTEs, and subqueries-in-`from` uniformly: any relation expression that can be written as a `select` can also be the target of an `insert`, `update`, or `delete`. The engine derives the required base-table operations from the relation's predicate, its functional-dependency surface, and the per-operator semantics described below. There is no `with check option`, no `instead of` trigger surface, and no view-level flag declaring updateability. A relation is updateable iff a deterministic decomposition exists at plan time; if it does not, the mutation surfaces a structured diagnostic naming the operator and column that obstructed propagation.

## Overview

### View-body forms

A view body is any relation-producing `QueryExpr` except DML:

- **`SELECT`**: the canonical case. Updateability is FD-driven per the rules below.
- **`VALUES (…), …`**: a literal row set. The body has no base-table lineage, so the FD walker reaches no `TableReferenceNode`; the view is read-only. Insert / update / delete against a `VALUES`-bodied view raises the standard "no recoverable base operation" diagnostic.
- **`INSERT/UPDATE/DELETE … RETURNING`**: **rejected at view-creation time.** A view body re-evaluates on every reference; a DML body would re-drive the write per read, which is incoherent with view semantics. Mutations belong in the statement that *references* the view, not in the view body.

### Capabilities at a glance

The supported write-through shapes:

- **Single-source projection-and-filter** views — `insert` / `update` / `delete` route to the base table, with constant-FD defaults from equality selection predicates, base-column defaults, identity/rename/invertible projection lineage, `OR`-clause conflict resolution, RETURNING, and per-statement mutation-context threading.
- **n-way (≥2) key-preserving inner-join** bodies — `update` / `delete` / `insert` write-through, including **composite-PK sides** and **self-joins** (one base table under two or more distinct aliases). Each output column routes to its owning base table (by its producing scan, so a self-join's aliases stay distinct); rows are identified by an up-front base-PK key capture built over the planned join body (one capture column per side per PK column); an insert mints or threads the shared join key through a per-row surrogate envelope (a single-column shared key — a composite shared-key insert stays deferred).
- **n-way decomposition** bodies (the [lens layer](lens.md)) — fan-out write-through over a module-advertised decomposition.
- **Materialized-view names** — DML routes through this same substrate to the MV's source, and the row-time maintenance hook syncs the backing within the statement ([Materialized Views § Write boundary](materialized-views.md#write-boundary-write-through)).

The shapes still rejected at plan time (with a structured diagnostic) are listed under [Current limitations](#current-limitations).

## Philosophy: Predicates Rule

A mutation against a relation is a predicate over base-table state. The engine finds the smallest set of base-table operations whose post-state satisfies that predicate.

- **Insert** = "make this row exist in the relation"
- **Update** = "for rows matching this predicate, change these columns to these values"
- **Delete** = "make these rows not exist in the relation"

For n-ary operators (union, intersect, except, join), the default policy is **fan out to every branch whose own predicate is consistent with the mutation's row-identifying predicate**. The user controls fan-out by adding predicates (narrowing the rows to a single branch) or by writing a per-row **presence/membership column** (the outer-join existence column, the set-op membership columns) that states the routing explicitly. The engine never silently drops one of several consistent branches.

The classical view-update ambiguity (Bancilhon–Spyratos) only arises when one chooses to suppress effects on some branches. Quereus does not suppress: a mutation routed to *every* satisfying branch is unambiguous by construction. The cost is that mutations can produce more base-table operations than a one-branch policy would, but this is the honest reading of the predicate.

## The Update Site Model

Every relational `PlanNode` carries an `updateLineage` field mapping each output attribute to one of:

- **`base`** — the column traces to a base-table column through a chain of invertible transformations. The chain is recorded so the engine can compose a setter expression on the base column.
- **`computed`** — the column is the output of a non-invertible expression over inputs; it is read-only. Reads pass through; writes against this column are rejected with a diagnostic naming the originating expression.
- **`null-extended`** — the column is potentially null-extended by an outer join; updates require materialization of the missing side (see [Outer Joins](#outer-joins)).
- **`existence`** — an outer-join `exists … as` match flag (a clean `{true,false}` boolean derived at the combinator). It has no base column and is **writable through an *effect*, not a base mapping**: a flag-flip inserts/deletes the named relational component (see [Existence columns](#existence-columns-on-outer-joins)).

Lineage is computed in a single pass that mirrors the optimizer's physical-property pass, reusing the functional-dependency framework (see [Optimizer § Functional Dependency Tracking](optimizer.md#functional-dependency-tracking)) to thread per-column provenance through every operator. Equivalence classes propagate writeability: if `a.x` and `b.y` belong to the same EC, a write to either reaches both bases. Constant FDs (`∅ → c = v`) supply default values without authorial intervention.

> **Surface authority.** `updateLineage` is computed in `computePhysical`, so it is available on the **logical** operator tree (Project / Filter / Join / TableReference) the substrate walks. It survives optimization through the pass-through boundary nodes (access scans, Retrieve, Alias) but **not** through operators that rewrite structure (physical `HashJoin` / `MergeJoin`, aggregates, set-ops, Sort/Limit/Distinct). EXPLAIN / `query_plan()` therefore shows full lineage for single-source projection-filter shapes and on every TableReference; a join's optimized top node shows degraded (`computed`) lineage. The logical operator tree is authoritative — both the forward FD walk and the backward propagation read it before those structure-rewriting operators apply, which is precisely why a shape the forward walk cannot thread is also one the backward walk cannot consume.

## Mutation Propagation

A mutation statement is built like a query: parser → planner → optimizer. After the relation tree is finalized, a **propagation pass** walks the tree from the user-visible top-level relation down to base-table references, emitting a list of base-table operations.

```
UserMutation(M)
   ├─ relation R
   └─ propagate(R, M) → list of BaseOp
```

Each operator contributes its per-operator semantics (described below). Propagation terminates at `TableReferenceNode`s, each of which receives a fully-resolved per-base operation. The complete list of base operations executes atomically within the statement's transaction. If any operation fails (constraint, conflict resolution, store error), the entire statement aborts under the prevailing conflict-resolution mode.

The single entry point `propagate(ctx, view, req)` classifies the body and routes it: a decomposition-backed logical table (a module advertisement, no override) goes to the advertisement-driven fan-out; a single-table body to the single-source spine; a join body to the multi-source walk. All three share **one** plan-node backward-walk consumer that plans the body once and reads its threaded `updateLineage` for column→base routing — none re-walks the projection AST.

### Identifying Predicates

Updates and deletes carry a **row-identifying predicate** built from base-table primary keys traced through the lineage. For a relation whose lineage proves `(b1.pk, b2.pk, ...)` is a superkey at the top, the row-identifying predicate is the equality on those PKs. The propagation pass uses this predicate to bind the per-base operations to specific underlying rows.

Inserts carry an **existence predicate** constructed from the inserted column values: `c1 = v1 ∧ c2 = v2 ∧ ...`. The predicate is symbolic — values may be expressions, parameters, mutation-context bindings, or `default`. It drives branch dispatch at every n-ary operator and supplies values for missing columns via equivalence-class lookup.

### Branch Consistency

When propagation reaches an n-ary operator, it evaluates each branch's accumulated predicate (the conjunction of every selection on the path from this operator to a base table) against the mutation's predicate using the same predicate-normalizer and FD/EC pipeline the optimizer uses:

- **Provably consistent**: the mutation fans out to that branch.
- **Provably inconsistent**: the branch is skipped.
- **Unknown**: the branch is included. The engine prefers honest fan-out over silent suppression.

## Per-Operator Semantics

The rules below apply identically to view bodies, to a **CTE-name DML target** (a leading `with t as (…)` written as `update t` / `insert into t` / `delete from t`), and to an **inline subquery DML target** (`update (select …) as v set …` / `delete from (select …) as v where …`) — all route the body through the same predicate-driven substrate via an ephemeral view-like adapter (see [§ Common Table Expressions and the CTE-name DML target](#common-table-expressions-and-the-cte-name-dml-target) and [§ Inline subquery DML target](#inline-subquery-dml-target)).

### Projection

**Updates** pass through unchanged: assignments are rewritten against the underlying columns named by the projection.

**Inserts** must supply values for every base-table column for which the insert's value list does not. Sources are consulted in order:

1. The insert's value list (after applying the inverse of any scalar transformation in the projection).
2. **Constant FD** — a column constrained to a constant by an upstream selection predicate (the relation carries the FD `∅ → c = v`) takes that constant.
3. **FD reconstruction** — a column functionally determined by other surviving / supplied columns is reconstructed symbolically from the FD's right-hand side.
4. **EC propagation** — a column in an equivalence class with a supplied column or a constant takes the EC representative's value.
5. The view's declared insert default — a `with defaults (col = expr, …)` clause entry (a self-contained expression — see § [View defaults](#view-defaults)).
6. The base column's declared `default` — including a **generated default** (sequence, surrogate allocator, clock read), which resolves through the mutation-context envelope (§ [Mutation Context](#mutation-context)) at per-row cadence and, when the column is a shared join key, threads the one captured value through every branch of the decomposition.
7. For nullable columns, `null`.

If a `not null` column has no value after this chain, the insert is rejected with a structured diagnostic naming the column.

The constant-FD step (#2) is the mechanism by which `where`-clause constants become defaults. It applies whether the constrained column is projected away or survives:

```sql
create view GreenMen as select * from Men where Color = 'green';
insert into GreenMen (Name) values ('Bob');   -- Color defaults to 'green'

create view AdultsBare as select Name, Age from Adults where Country = 'US';
insert into AdultsBare values ('Bob', 30);    -- Country defaults to 'US' (projected away)
```

Both cases reduce to the same rule: the selection predicate contributes a constant FD to the relation; the propagation pass reads that FD when filling missing values. Equality-with-constant is the simplest producer of such an FD, but any predicate the optimizer's predicate-normalizer reduces to a constant binding contributes the same way — `where year >= 2026 and year <= 2026`, `where status in ('A')`, and `where coalesce(flag, false) = true and flag is not null` all qualify. Columns dropped by the projection but functionally determined by surviving columns need no default at all, by the same mechanism.

**Deletes** pass through unchanged.

### Selection (σ)

The selection's predicate is conjoined with the mutation's predicate at every step:

- **Updates** propagate to the child with `parent_predicate ∧ user_predicate`. An update whose assignment would carry a row outside the selection's predicate is not blocked — it succeeds in the base, and the row ceases to be visible through the relation. This is the literal reading: the user wrote a base-level update through a windowed view; the engine performs that update.
- **Inserts** conjoin the selection's predicate into the existence predicate. If the inserted values contradict the selection (provable at plan time via constant folding and EC), the engine rejects with a diagnostic. If they satisfy the predicate, the row is inserted into the base and is visible through the relation. If satisfiability is unknown at plan time, the insert proceeds; visibility is decided by base data. Constant bindings produced by the selection (e.g. `where color = 'green'` ⇒ FD `∅ → color = 'green'`) are picked up by the projection's insert defaulting rule, so omitting the constrained column is permitted and the value is supplied automatically.
- **Deletes** propagate to the child with `parent_predicate ∧ user_predicate`.

#### The encapsulation guard

A **top-level** reference in the user `where`, the `set` target columns *and* assigned values, or the `returning` clause must name a column the **view** exposes — resolved against the view's output column set, not the base table's. A name that is not a view column raises the structured `unknown-view-column` diagnostic; it does **not** silently resolve against the underlying base table. This closes an encapsulation leak: without the guard, a base column the view *projects away* would pass through the view→base remap unmapped and re-bind in the base scope, so it would be writable / filterable / returnable through the view despite never being part of the view's image.

```sql
create view sv as select id, shown from t3;          -- exposes only (id, shown)
update sv set shown = 'X' where secret = 'classified';   -- error: unknown-view-column
update sv set secret = 'leaked' where id = 1;            -- error: unknown-view-column (set target)
update sv set shown = secret where id = 1;               -- error: unknown-view-column (set value reads a hidden column)
insert into sv (id, shown) values (3, 'g') returning id, secret;  -- error: unknown-view-column
```

The scope is keyed off the **view's output names**, so a renamed column's only legal reference is its view spelling: for `select label as note …`, `note` is accepted and the base spelling `label` is rejected. A **computed** view column is still a view column — it passes this guard and a write to it surfaces the `no-inverse` diagnostic (the column exists; it is just not writable), so the guard never shadows `no-inverse`. The single-source spine and the multi-source join path share the guard. Scope is **top-level only**: a reference nested inside a `subquery` / `exists` / `in`-subquery operand is validated by the scope-aware descent below.

#### View columns nested inside a predicate / assigned-value subquery

A view-column reference inside a `subquery` / `exists` / `in`-subquery operand of the user predicate (or a `set` value) is rewritten to its base-term lineage just like a top-level reference, by a shared scope-aware descent. The descent is **scope-aware**: a reference is substituted only when it is genuinely correlated to the outer view row — qualified by the view name, or unqualified and *not* shadowed by a column some source local to the subquery introduces. A base-alias-qualified reference, or a name a subquery-local source defines (`… in (select note from src)` where `src.note` exists), is left untouched. When the subquery's source columns cannot be resolved statically (a `select *` subquery source, a table-valued function, an embedded data-modifying subquery), the descent cannot prove a nested reference is correlated and rejects it with the structured `unsupported-subquery-correlation` diagnostic rather than risk a silent mis-bind.

Deciding *whether* to substitute is only half the problem; the substituted base *term* must also be correlation-qualified, **deeply**. An unqualified base ref emitted inside a subquery operand would re-bind, by ordinary innermost-scope SQL rules, to a same-named source the subquery's own FROM introduces — not to the outer mutation target row. So the descent qualifies the substituted term with the lowered target's correlation name, and does so at every nesting level: a computed column's base-term lineage can itself contain a correlated scalar subquery (`note = (select x from oth where fk = id)`) whose own correlation `id` lives one level down, and that nested `id` must be qualified too. The qualifier walks the whole replacement, mirroring the shadow-set logic the view-column descent uses — at each nested `select`, an unqualified ref is qualified **only if** it is a base-table column and not shadowed by that subquery's FROM. A genuinely-local column is left alone; an unresolvable nested FROM is **rejected** rather than risk an over- or under-qualify silent wrong write.

The correlation name itself is chosen to be collision-proof. For an UPDATE/DELETE whose subquery FROM names the **same base table** as the target, a bare base-table-name qualifier would bind to the innermost local copy, de-correlating the subquery. So the lowered UPDATE/DELETE target carries a synthesized collision-proof correlation alias (`__vm_self`), and substituted subquery-descent base terms are qualified with that alias instead of the bare table name. INSERT base statements have no target-row scan a subquery can correlate to, so they keep the base-table-name qualifier. An ordinary non-view UPDATE/DELETE never sets the alias, so its behavior is byte-identical.

### Inner Join

An **n-way (≥2) inner equi-join body** — composite-PK sides and **self-joins** included — decomposes through the multi-source walk. The body is planned **once**; each output column is routed to its owning base table by that planned body's `updateLineage`, keyed by the column's **producing scan** (so a self-join's two aliases of one table stay distinct, even though they share a table name) — EC propagation makes column membership precise even for equi-join columns. Source enumeration maps each AST alias to its planned `TableReferenceNode` by resolving the alias-qualified key column through the join's combined scope, not by table name (the self-join discriminator). **Rows are identified by an up-front base-PK key capture built directly over the planned join body** — the derived backward walk, not a re-planned AST body: `π_{k<side>_<j>}( σ_{idPred}( JoinNode ) )` is built as plan nodes layered on the already-planned `JoinNode` (one capture column per side per PK column — composite keys flatten to `k<side>_0, k<side>_1, …`), materialized **once before any base op fires** into `__vmupd_keys`, and *every* per-side op reads its identifying values back from that set via a correlated EXISTS (`exists (select 1 from __vmupd_keys k where k.k<side>_0 = <pk0> [and k.k<side>_1 = <pk1> …])`). The capture reconstructs the row-identifying predicate even when a side's PK is hidden by the projection, and being mutation-order-independent it lets a both-sides update's FK-parent op run without rewriting a predicate column out from under the FK-child op (the **eager key materialization** the delete rule below relies on). Per-side base ops are ordered by an **FK topological sort** over the n sides (FK-parent before FK-child, source order within an FK-equivalence class; a self-join's mutual edges fall back to alias-declaration order). Each base op's SET/value clause is still lowered to AST so the ordinary base-table builders — and all their constraint / conflict / FK machinery — are reused verbatim; only row identification rides the planned tree.

**Updates** route per-column to the side that owns each column. A `set` clause assigning columns from both sides produces two child operations executed atomically. The row-identifying predicate for each child is the projection of the join's row-identifying predicate onto that child's key columns. Both **identity / rename** and **invertible** (`c.cv + 1`) base columns are writable: a write `set cv1 = w` lowers the assigned value through the site's inverse to the base value (`update jchild set cv = w - 1`), and the view reads it back through the forward transform. A `computed` / outer-join `null-extended` site stays read-only (`no-inverse`).

A `set` **value** may read a column owned by a *different* side than the column it assigns (`update v set a.x = b.y` — a per-row value sourced from the partner row, which a single-table SET cannot otherwise express). When the read column has `base` lineage, the partner base column is projected into the up-front `__vmupd_keys` capture under a stable `srcN` alias (alongside the per-side PK columns) and the reference is rewritten to a correlated scalar read of it — `set a.x = (select src0 from __vmupd_keys k where k.k<ownerSide>_0 = __vm_self.<a.pk0> …)` — keyed by the *owning* side's PK so each lowered single-table `update a` row reads its joined row's value. The PK operand is qualified with the lowered per-side UPDATE's **collision-proof correlation alias** `__vm_self` (synthesised onto the per-side target via `alias`, exactly as the single-source spine does — § "View columns nested inside a predicate / assigned-value subquery"): when this read-back nests inside a *user* value subquery whose own FROM introduces a column named like the owning PK (`set cval = (select max(x) from t where x < pv)` with `t` carrying a `cid`), a bare `<a.pk0>` would re-bind to that inner column by innermost-scope rules and key the read-back on the wrong value, so `__vm_self.<pk>` binds the outer target row instead (composite keys qualify every conjunct). Because the capture materializes **before** any base op fires (the same eager key materialization), the read-back is the **pre-mutation** partner value — robust against a both-sides update (`set a.x = b.y, b.y = …`) that also rewrites the read column. A cross-source value is well-defined only when the **assigned side joins at most one partner row**: the capture carries one `srcN` row per joined owner/partner pair, so the correlated read-back is single-valued exactly in that direction. The proof is **partner-side uniqueness** — the join must pin a *unique key* of the partner table (its PRIMARY KEY, a non-partial UNIQUE constraint, or a non-partial UNIQUE index); the canonical FK-child-reads-parent direction satisfies it because the FK references the parent's PK, which the join equates. The **reverse** 1:many direction (the assigned side joins *many* partners — `update v set p.x = c.y` where one parent matches many children) is rejected at **plan time** with `cross-source-ambiguous-cardinality`, naming the ambiguity, rather than failing at runtime with `Scalar subquery returned more than one row`. A **multi-hop** cross-source `set` (owner and partner not directly joined) pins no partner column and is conservatively rejected (a transitive value-determinacy proof is a possible follow-up); a *partial* unique key (carrying a predicate) does not bound the rows outside its scope, so it does not count toward the proof. A scalar expression over a partner column (`set x = b.y + 1`) is admitted when **every** cross-source leaf has `base` lineage (the leaf is captured; the expression and any owning-site inverse apply on read); a read of a `computed` (non-base) partner column is rejected (`no-inverse`) **at the top level only** — the gate (`gateCrossSourceReads`) walks top-level refs, so the same computed partner read from inside a nested value subquery is *admitted*: its lineage substitutes and each base leaf rides the per-leaf capture, which is value-correct (every leaf captured pre-mutation, the computed scalar applied on read). The two depths disagree on acceptance but neither yields a wrong result; the top-level reject is over-conservative for a pure read (`no-inverse` genuinely applies only to a computed column as an *assignment target*). A future unification should admit the top-level read via the same per-leaf capture, after auditing the mixed owning/partner-leaf-under-owning-inverse interaction. A same-side read keeps the ordinary owning-qualifier strip (no capture). The partner column need not be projected **qualified**: a join-view body may legally project a partner-side column **unqualified** when the name is unambiguous across the sides (`select c.cid as cid, cval, pv from c join p …` — `pv` lives only on `p`), so its base-term lineage leaf arrives bare. Bare lineage leaves are **side-alias-qualified at the moment the view-column substitution injects them** — resolved to their owning side by **unique column ownership** (the *same* rule join-condition operands use) and qualified with that side's *alias* — mirroring the single-source correlation-qualification of substituted terms (the scope-aware deep qualify of § "View columns nested inside a predicate / assigned-value subquery"). Every *injected lineage leaf* reaching the qualifier strip is therefore alias-qualified, and the strip is **qualifier-driven but alias-scope-aware**: an owning-alias ref strips to the lowered target's `__vm_self`-qualified form for the lowered single-table UPDATE (**not bare** — a bare *renamed*-owning ref nested in a value subquery whose FROM carries the **base** column name would otherwise re-bind locally, e.g. `c.realval as cval` read in `(select max(x) from t where x < cval)` where `t` has a `realval`; the `__vm_self` correlation alias binds the target row regardless, mirroring the single-source qualification); a partner-alias ref rides the identical `srcN` capture (so `a.av` and a bare-projected `av` reading the same partner column share one capture column) — at **any nesting depth**, since an *injected* qualified leaf carries a side alias a value subquery's own FROM would not reuse and so cannot re-bind. The strip is qualifier-driven only for those collision-free injected leaves; a *user-authored* qualified reference whose qualifier collides with a side alias (or a side's table name) but is **shadowed by an inner value-subquery's own FROM alias** binds, by innermost-scope SQL rules, to that inner source — so the strip leaves it local (it threads an accumulating FROM-alias shadow set per nesting depth, the alias-only analog of the view-column descent's column-name shadowing, and checks shadowing *before* the side-qualifier sets). This covers the converse of the bare-projection case: a partner-alias collision (`update v set cval = (select max(p.score) from points p …)` where side `p` is unrelated to the inner `points p`) stays local instead of mis-routing `p.score` through the `parent` capture; an owning-alias collision (`from things c` shadowing owning alias `c`) is not stripped to bare; a table-name collision (`from aux parent` shadowing a side's table name `parent`) shadows on the inner alias. Whether a nested *reference* is substituted at all remains the scope-aware shadowing decision of the view-column descent: an inner-scope-shadowed name binds locally, and an unprovable scope (a `select *` / TVF subquery source) rejects with `unsupported-subquery-correlation`. A bare leaf reaching the strip is consequently only ever a user-authored local/unknown name — left untouched, binding locally or failing loudly at build (never silently resolved against the view sides, which would read a concealed partner base column through the view). Only a name owned by **two or more** sides resists the injection-qualification — and that body projection is already rejected as ambiguous at body planning, before decomposition; a name on *no* side is a lineage-internal correlated/local name and correctly stays bare. Cross-source `set` through an **outer** join is deferred with the outer-join body, and cross-source (cross-member) `set` in the decomposition fan-out stays rejected (`cross-source-assignment`).

**Inserts** require values for both sides' `not null`-without-default columns and must satisfy the join predicate. Each supplied view column routes to its owning side by `updateLineage`; the shared join key (read from the single `a.col = b.col` ON predicate) is **directly supplied** when a view column maps to it, otherwise **minted** at the envelope (§ [Mutation Context](#mutation-context)). The two child inserts execute FK-parent before FK-child where the dependency is provable. A `not null` base column with neither a supplied value nor a declared default raises `no-default`; a computed target column raises `no-inverse`. The shared key must be exposed by **at most one** view column — a body projecting both sides of the equi-join key is over-specified for an insert (it could not honor divergent supplied values) and raises `unsupported-join`. Insert through an *invertible* column is rejected (`no-inverse`): the envelope writes supplied values verbatim, with no hook to apply the inverse.

**Deletes** are inherently ambiguous — removing the joined row requires deleting from at least one side. Routing is **predicate / FK truth only** (the routing tags were removed; routing is expressed per-row by a writable presence column where a non-default side is wanted):

- The candidate sides are the **preserved** side(s) (an inner join is all-preserved).
- If a declared foreign key proves the FK-many (child) side, that single side is chosen — the common FK-style default: it deletes the child, leaving the parent in place. The FK resolves the ambiguity, so this is *not* a fan-out.
- Otherwise the deletion side is ambiguous and the **lenient default fans out to every candidate side** (the predicate-honest "make this joined row not exist").

To realize a *non-default* deletion side explicitly — e.g. delete the FK-**parent** instead of the child — expose the side as a per-row **existence column** on an outer join (`… left join parent … exists right as hasP`) and write the routing directly: `update v set hasP = false where …` deletes the matched parent for the targeted rows (§ [Existence columns](#existence-columns-on-outer-joins)).

The lenient multi-side fan-out deletes the joined row's contribution from *every* candidate side, reusing the same eager key materialization as the both-sides update: each affected view row's base-PK identities are captured once, before any base op fires, and *each* per-side delete addresses rows through that captured set — so the first side's delete cannot empty the join out from under the second side's identifying subquery. A single-side delete reads the same capture (projecting just its one side's PK). Because each base delete is a **predicate-scan** over the live table (not a key-addressed delete that errors on a missing key), a row another side's FK action removed first is a natural **no-op**, never a double-delete error.

**Fan-out ordering is ON-DELETE-aware:** the two base deletes are ordered by ON DELETE action so the side whose removal *clears the other's reference* runs first — a `set null` / `set default` inbound action, or a `cascade` that does not recurse into a `restrict` child. This rescues the order-sensitive asymmetric mutual-FK shape (`restrict` + `set null`): deleting the `set null`-inbound side first clears the other side's reference, so the `restrict`-inbound side's delete then no-ops. A mutual FK whose edges **cannot be satisfied in any order** under immediate enforcement — `restrict`+`restrict`, or `restrict`+`cascade` where the cascade recurses into the `restrict` — is rejected at **plan time** with `mutual-fk-restrict-delete`, **but only when the join provably correlates at least one mutual FK edge** (its cross-side equalities force a child's FK column(s) equal to the parent's referenced column(s), so the joined rows *necessarily* cross-reference and a RESTRICT necessarily fires). A join on **non-FK columns**, where the rows are not proven to cross-reference, is not rejected up front: it falls back to the fixed `[0, 1]` order and defers to the **runtime** RESTRICT pre-check on the actual data — so a delete whose FK columns are NULL (MATCH SIMPLE: no FK match) succeeds rather than being over-rejected. When the reject fires, the resolution is to break the cycle outside the view (null out the referencing column first, or restructure the offending ON DELETE action). A `deferrable initially deferred` declaration does not help — RESTRICT is enforced immediately regardless. This analysis depends on **immediate** FK enforcement plus the transitive RESTRICT pre-walk (`runtime/foreign-key-actions.ts`).

> This plan-time ON-DELETE / mutual-FK analysis is **two-side only**. An n-way (>2) delete fan-out orders its chosen sides by the **reverse** FK topological sort (FK-child before FK-parent — the FK-safe delete direction, so a referencing row is removed before the row it references rather than tripping the parent's inbound RESTRICT) and defers any mutual-FK cycle wholesale to the **runtime** RESTRICT pre-check on the actual data — the plan-time `mutual-fk-restrict-delete` reject is not generalized past two sides (a deliberate scope boundary; see the inner-join substrate).

### Outer Joins

Outer joins introduce **null-extended** lineage on the non-preserved side(s). For left, right, and full outer joins, every output column from a non-preserved side is annotated with the join predicate as a *guard*: the column is real iff the guard holds.

**Updates on the preserved side** propagate unchanged.

**Updates on a non-preserved-side column** split into two cases:

- *Row is non-null-extended in the matched view row* (guard holds): the propagation is a normal update on the non-preserved base, with row-identifying predicate built from the projected portion of the joined row's identifying predicate.
- *Row is null-extended* (guard fails — the non-preserved side had no matching row): the update is rewritten as an **insert** on the non-preserved side. Values for the join-predicate columns come from the preserved side via EC; values for non-`set` columns come from defaults or the view's `with defaults` clause; values for `set` columns come from the user's assignment. If the resulting insert lacks a `not null`-without-default value, the entire propagation fails with a diagnostic.

**Inserts** through an outer-joined view follow the join's structural intent. An insert with values for both sides produces inserts on both sides under the join predicate. An insert with values only for the preserved side produces a single preserved-side insert (the resulting row is null-extended through the view). An insert with values only for the non-preserved side requires the join predicate to be satisfiable against an existing preserved row; otherwise it is rejected.

**Deletes** route to the preserved side by default — this is the only way for the joined row to disappear from the view; deleting from the non-preserved side merely null-extends it, leaving the row visible. Tags override.

`full outer join` is handled as a generalization: every side is both preserved and non-preserved depending on the matched/unmatched status of each row.

> **Shipped (LEFT & RIGHT):** the multi-source substrate admits **LEFT** and **RIGHT** outer-join bodies (RIGHT is the exact per-side mirror of LEFT — the right operand preserved) and wires preserved-side update passthrough, delete-to-the-preserved-side (an unmatched/null-extended row is deletable too), insert routing (both-side under the minted shared key, preserved-only producing a null-extended row, and a non-preserved side as a presence-gated optional member of the envelope fan-out), **and the non-preserved-side UPDATE** (the per-row matched-update / null-extended-insert materialization — `view-write-optional-member-transitions`). The static `view_info` / `column_info` surfaces report these per-side: every base column — preserved or non-preserved — is `is_updatable = 'YES'` (the non-preserved side is updatable because a preserved anchor pins each row's identity), and the view is `is_insertable_into` / `is_deletable`.
>
> **Insert — the per-row conditional key thread (no dangling FK).** A both-side insert mints one shared key per produced row and threads it into every active side's join column. But the non-preserved (FK-parent) side is *presence-gated*: for a row that supplies only nulls for it, its insert is dropped — so the preserved (FK-**child**) side must **not** thread the minted key into that row's FK column, or the child would reference a key with no partner row (a dangling FK: an `_fk_*` CHECK fails at deferred-constraint commit under `pragma foreign_keys = on`; a latent spooky-join otherwise). The fan-out therefore threads an FK-child side's key column **conditionally per row** — `<joinKey> = case when <partner-present> then <key> else null end`, where `<partner-present>` is the AND, over each presence-gated FK-parent partner the side references, of that partner's presence predicate (the OR of its supplied columns being non-null — the same per-row gate that drops the partner's insert). When every referenced partner is absent for a row, the key column projects **null** (the correct "no partner" marker) and the preserved row reads back cleanly null-extended; a row that does supply the partner threads the real minted key and the parent materializes. A parent/anchor side whose key is its own referenced PK declares no such FK, so its key stays **unconditional** (nulling a NOT NULL PK would be wrong — that side simply inserts and the optional child does not materialize). Each row routes independently, so a multi-row VALUES/SELECT source mixing null and non-null partner values is handled correctly (no statement-level decision). The gate fires **only for the engine-minted key**: a *supplied* key (the join column exposed as a writable view column) is threaded verbatim, because the user's explicit value may reference a **pre-existing** parent the insert never touches — nulling it would silently discard the key and orphan the child, and FK enforcement is the correct validator of a genuinely dangling supplied reference. A single shared-key column spanning **two or more** presence-gated optional parents (`cc.pr references p1(pp) references p2(qq)`, both LEFT-joined and supplied) is **rejected at plan time** with `unsupported-decomposition-key` (`view-write-outer-insert-shared-key-multi-parent-orphan`): one key value cannot satisfy two FK constraints for a row that supplies only one parent — the AND-gate would null the whole key, silently losing the supplied value while the present parent still materializes (an orphan). Detected statically as `keyGate.groups.length >= 2`; the n-way generalization (per-parent key columns) is named future work.
>
> **How the non-preserved-side UPDATE is realized (no new runtime substrate).** Both branches ride the existing up-front `__vmupd_keys` capture, materialized **pre-mutation** over the planned join body (§ Multi-Base-Table Mutations): the capture projects the non-preserved side's PK (null for a null-extended row — the partition discriminator), the EC join key from the preserved side, and the assigned value(s). The **matched** branch is an ordinary per-side UPDATE keyed on that PK (a null captured PK never equals a real one, so a null-extended row is naturally excluded) whose SET reads the captured value back. The **null-extended** branch is a single `insert into <np> (<joinKey>, <set cols…>) select k.<joinKey>, min(k.<val…>) from __vmupd_keys k where <np PK> is null and <joinKey> is not null group by k.<joinKey>` — an insert-from-the-captured-partition that sets the non-preserved join column to the captured preserved-side key (so the preserved row joins the freshly materialized row), the `set` columns to their captured values, and everything else to base defaults. A null-extended row whose preserved-side join key is itself **null** has no key to seed a joinable row, so its update is a no-op (the documented boundary). A NOT NULL non-preserved column the create branch cannot supply rejects at plan time with `null-extended-create-conflict`.
>
> **Both branches de-dup per non-preserved partner (`fan-out`).** When one non-preserved partner is shared by **several** preserved rows (the normal parent→child cardinality — a parent joined by many children), an UPDATE of a non-preserved column that touches more than one of those rows would, naively, read or write that one partner once **per** preserved row. The matched read-back therefore wraps the captured value in **`min`** — `set <col> = (select min(k.<val>) from __vmupd_keys k where k.<np PK> = …)` — so the correlated scalar stays single-valued even though the shared partner's PK matches N capture rows (otherwise `Scalar subquery returned more than one row`). The materialization INSERT **`group by` the captured join key** and projects each value as `min(k.<val>)`, so one partner row materializes per distinct dangling key (otherwise N rows projecting the same key double-insert the partner PK → `UNIQUE constraint failed`). For a constant / non-preserved-only SET the captured value is identical across the shared-partner group, so `min` is an exact **no-op** de-dup; for a value that genuinely **differs** per preserved row (a *preserved*-column read over a shared partner, e.g. `set pv = cv` — inherently ambiguous which child wins) the same `min` **resolves it deterministically** rather than erroring at runtime, and keeps the matched read-back and the materialization consistent (neither can PK-conflict on a divergent value). The substrate keys off `JoinSide.preserved`, not source order, so LEFT and RIGHT behave identically. Each assigned non-preserved column carries its **own** `min` (an independent read-back subquery / aggregate projection), so a *divergent* multi-column SET resolves each column independently — the partner row reflects the per-column minimum, which need not all originate in one preserved row. This only matters in the already-arbitrary divergent case (a constant / np-only SET is identical across the group regardless), where "which child wins" is undefined by construction; a single winning row would require correlating every column to one discriminator (e.g. the min preserved PK) and is named future work.
>
> **Boundaries (reject at plan time, data-independent).** The materialization insert threads a **single** non-preserved join column, so a **composite** join key (the non-preserved side equated on more than one column) rejects `unsupported-outer-join-update` — the matched branch alone would be expressible, but a single-column insert cannot re-join a null-extended row (the conservative precedent of `null-extended-create-conflict`). **RETURNING** through a non-preserved-side update rejects `returning-through-view`: the post-mutation re-query identifies rows by the captured non-preserved PK, which a freshly materialized null-extended row no longer matches (captured NULL vs the minted key), so it would return a silent partial set — deferred until the re-query keys off the stable preserved-side identity (`view-write-outer-join-nonpreserved-returning`).
>
> **RIGHT — admitted; FULL — not yet:** the Quereus runtime now **executes** `right join` and `full join` `select`s (the nested-loop emitter in `runtime/emit/join.ts` buffers the left side and drives from the right for RIGHT, adding a trailing unmatched-left pass for FULL; read coverage in `test/logic/90.5-unsupported-join-types.sqllogic` and `test/logic/90.5.1-right-full-join-read.sqllogic`). **RIGHT is now admitted into write-through recognition** (`view-write-right-join-readmit`): its preserved / non-preserved classification is the exact **mirror** of LEFT — the right operand of a `right` join is preserved, the left is null-extended — so the multi-source substrate routes it symmetrically (it keys off `JoinSide.preserved`, not source order) and the static `view_info` / `column_info` surfaces report the per-side LEFT-mirror shape: preserved columns `is_updatable = 'YES'`, the non-preserved column `is_updatable = 'YES'` too (the preserved anchor pins each row's identity for the matched-update / null-extended-insert materialization), and `is_insertable_into` / `is_deletable = 'YES'`. **FULL stays conservative all-`NO`**: every side is null-extended per row, so there is no preserved anchor to key the materialization off — a non-preserved update there rejects `unsupported-outer-join-update` and the surfaces self-conservatize. FULL write-through (synthesizing a preserved anchor for a fully null-extended body) is a separable future concern, not covered by this ticket.
>
> **Still deferred (LEFT):** a non-preserved-**only** insert (no preserved row to attach to) rejects `null-extended-create-conflict`. (The **decomposition optional-member / EAV UPDATE** dual — null→non-null materializes a component, non-null→all-null deletes it — is the decomposition analogue and is now **shipped** as anchor-keyed base ops in `decomposition.ts`; see [Decomposition fan-out](lens.md#the-default-mapper) § UPDATE. A non-constant optional/EAV value is now also supported in two self-contained shapes — **anchor-resolvable** (`set c = a + 1`, collapsed into one `do update` upsert) and **member self-reference** (`set c = c + 1`, `set c = coalesce(c, 0) + 1`, a matched UPDATE for present rows plus a null-substituted, runtime-non-empty-filtered materialize INSERT for absent rows). For the self-reference shape the materialize INSERT **and its two soundness gates** (unassigned-value-column widen, missing-NOT-NULL) are emitted only when that null-substituted non-empty filter is **statically live**: a null-propagating self whose filter folds **constant-false** at plan time (`set c = c + 1` with no non-null constant sibling) provably materializes no absent row, so the INSERT and both gates are skipped and the update degrades to present-rows-only — it never trips the widen gate (a null→non-null self, or a value the planner cannot fold — a parameter, or a **non-deterministic** leaf like `random()` / a volatile UDF, which a single plan-time fold cannot soundly prove dead — stays live and runs the gates). An **arbitrary** optional-**columnar** value — a subquery, a cross-member column, or a value mixing anchor + self leaves (`set c = b + 1`, `set c = c + a`, `set c = (select …)`) — is now also supported via the **single-identity (anchor-key) per-row capture**: each affected row's value is materialized **once** over the planned get body (which null-extends an absent optional member, so the captured value already encodes per-row presence) into the multi-source `__vmupd_keys` substrate, the matched UPDATE reads it back keyed by the member key and a filtered materialize INSERT keyed by the anchor key (gated on a **runtime** non-null, since a data-dependent captured value cannot be folded), and capturing pre-mutation makes a both-sides write (`set c = b + 1, b = b + 100`) read `c` from the pre-mutation `b`. An **arbitrary EAV** value (subquery / cross-member / mixed, and any EAV self-reference, which lowers to a subquery since an EAV value column projects as a correlated subquery) rides the **same** capture, per attribute: the matched UPDATE reads the captured value back by the **entity** column, a non-null-filtered materialize INSERT by the **anchor** key (`on conflict (entity, attr) do nothing`). A captured null on a matched triple writes `val = null` (reads identically to absent through the get-side subquery — a benign physical divergence from the explicit `set p = null` delete); a captured null on an absent entity materializes no phantom triple. Only a shared-key identity write stays rejected with `unsupported-decomposition-update`.)

#### Existence columns on outer joins

The `exists [<side>] as <name>` join clause (Dataphor `include rowexists`) manifests
an outer join's match-existence as a first-class boolean column — reading it tells
you whether the non-preserved `side` matched the current row. See
[`sql.md` § Existence columns](sql.md#existence-columns-on-outer-joins) for the
grammar. Two properties make the flag sound:

- **Derived at the combinator, not stored.** The flag is the join operator's own
  per-row null-extension bit (`runtime/emit/join.ts`), *not* a constant column
  inside the operand (a null-extended `true` would read back as `{true,NULL}`,
  re-introducing the very `IS NOT NULL` test the column replaces) and *not* a
  re-evaluation of the `ON` predicate over the joined row (unsound for predicates
  satisfiable on a null-extended row, e.g. `p.pp = c.pr or p.pp is null`). The
  result is a clean `{true,false}` **NOT NULL** column.
- **FD ramifications (Invariants 1–2).** When the join output is keyed (a 1:1
  outer join's preserved PK), the forward FD walk emits `key → flag` (so DISTINCT /
  ORDER-BY / join-elimination still reason about the flag), and the flag is **never**
  claimed as part of a key.

The flag is modelled as an extra output **attribute of the `JoinNode`** (not a
`ProjectNode` expression — that could only see join *outputs* and would have to
re-derive the match from nullability, the unsound path), carrying a new
`existence` `UpdateSite` (kind `existence`, with a `RelationalComponentRef`
component + the join-predicate guard). A **live** (demanded) flag-bearing
`JoinNode` stays the nested-loop join (the join-physical-selection / merge /
fanout / elimination rules bail on it) so the appended flag column is never
dropped by a physical rewrite — the limitation (existence joins forgo hash/merge
selection, and a flag-bearing join cannot be eliminated) applies only **while the
flag is demanded**. An **unused** flag — one no ancestor reads — is removed by the
demand-gated existence-pruning rule (Structural / priority 22), which has two
anchors: `join-existence-pruning` on the nearest enclosing Project, and
`join-existence-pruning-aggregate` on an enclosing Aggregate (for a flag-bearing
join under a `count(*)` / `group by` with no Project). Either anchor walks the
pass-through chain to the join (the same demand analysis `join-elimination` uses)
and rebuilds the `JoinNode` without that `ExistenceColumnSpec`. Once the last spec
is dropped the join is flag-free, `hasExistenceColumns` flips `false`, and the
five guarded rules re-enable automatically — the join can then be eliminated or
pick a hash/merge variant like any other (a pure optimization; the write half is
unaffected because a writable flag is always SELECTed by its view's projection,
which keeps it demanded and retained — and a routing Project, never an Aggregate,
is what carries a view's write-side flag reference).

A **probe-only** flag — one demanded *solely* as a top-level boolean test in a
`where` clause (`where <flag>` / `where not <flag>`) and nowhere else — is the
demand-SHAPE complement of the unused case: the demand-PRESENCE gate retains it
(it *is* read), but the `semijoin-existence-recovery` rule (Structural / priority
23) recognizes that the only use is an existence probe and rewrites the
`left join … exists right as` to the equivalent **semi** (`where flag`) or
**anti** (`where not flag`) join — re-opening hash/merge selection and the FK
IND-folding cascade the live flag otherwise forfeits. This is **write-safe by the
same construction**: a flag writable through a view is always SELECTed by its
routing Project, so it is demanded outside the probe and recovery abstains (the
rewrite drops the right columns and the flag, so it requires the consuming
Project to reference neither). The write path therefore never reaches the
rewrite. See `docs/optimizer.md` § `ruleSemijoinExistenceRecovery`.

**Writing the flag (the write half).** The existence column is the explicit, per-row
control surface for the non-preserved side's existence — *writing* the flag **is** the
guard. It reuses the non-preserved-side UPDATE substrate (the up-front `__vmupd_keys`
capture, the null-extended materialization INSERT, the captured-key DELETE — § Outer
Joins — Updates), specialized to insert-or-delete:

- **`update v set hasB = true`** — over a **null-extended** row, materialize the side:
  the null-extended-INSERT branch (no assigned columns ⇒ the EC join key + base
  defaults). Over a **matched** row it is a no-op. An undefaulted `not null` column the
  create branch cannot supply rejects `null-extended-create-conflict`.
- **`update v set hasB = false`** — over a **matched** row, delete the side: a base
  DELETE keyed on the captured non-preserved PK (a null-extended row's captured PK is
  null, so the same captured-key EXISTS naturally excludes it ⇒ a no-op there). The
  preserved side is untouched, so the row reads back null-extended.
- **Composition.** `set y = 5, hasB = true` over a null-extended row inserts the side
  with `y = 5` (the same-side `set` folds into the materialization INSERT — the explicit
  `hasB` trigger for the same insert the non-preserved-column UPDATE infers). `set y = 5,
  hasB = false` is a **contradiction** (delete the side *and* write its column) and
  rejects `conflicting-assignment`.
- **Insert-through.** `hasB` participates in INSERT routing as a directive (never
  stored): `insert into v (…, hasB) values (…, true)` activates the non-preserved side
  (both-side insert / B-with-defaults), `… , false` forces preserved-only (the
  null-extended insert). A `false` directive contradicting a supplied non-preserved
  column rejects `conflicting-assignment`.

Only a **boolean literal** (`true`/`false` — or the numeric `1`/`0` spelling) is admitted
— a per-row branch on a non-literal value is deferred (`unsupported-outer-join-update`),
and on an INSERT the directive must be **uniform** across every VALUES row (a per-row mix
defers). RETURNING through an existence write rejects `returning-through-view` (the
captured-identity re-query cannot recover a materialized/deleted non-preserved row — the
non-preserved-column UPDATE's boundary). The static surfaces report the flag
`is_updatable = 'YES'` with `base_table` / `base_column` = `null` (writable through an
*effect*, mapping to no base column). The routing stays **component-generic** (no
hard-coded join side) so the set-operation membership-column work
(`set-operator-membership-columns`) extends the same site.

> [!NOTE]
> **Two boundaries inherited from the materialization substrate.** Because the flag drives
> the *component* (not a private per-row row), the write is an effect on shared base state:
> - **Null join key ⇒ `hasB = true` is a silent no-op.** A null-extended row whose
>   preserved-side join key is itself `null` has no key to seed a joinable row from, so the
>   materialization INSERT (`<join key> is not null` guarded) drops it — the flag reads back
>   `false` after a write of `true`. The write is *dropped, not rejected* (matching the
>   non-preserved-column UPDATE's create branch).
> - **A shared non-preserved row is shared.** `hasB = false` over one preserved row deletes
>   the matched non-preserved row outright; every *other* preserved row that joined the same
>   row also reads back null-extended. The flag controls component existence, not a
>   per-preserved-row link.

### Set-operation membership columns

The vertical (row) analogue of the outer-join existence column: the
`<setop> exists <branch> as <name>` clause manifests a set operation's **branch
membership** as a first-class boolean column — reading it tells you which immediate
operand of the binary combinator the result tuple came from. See
[`sql.md` § Set-operation membership columns](sql.md#set-operation-membership-columns)
for the grammar. The same two soundness properties as the join existence column hold:

- **Derived at the combinator, not stored.** The flag is computed at the
  `SetOperationNode` by a **per-branch semijoin probe** over the operand *data*
  relations (`inA ≡ tuple ∈ A`, `inB ≡ tuple ∈ B`; `runtime/emit/set-operation.ts`),
  **never** a constant column stored inside a branch. A stored `inA` would re-enter the
  union's schema and **dedup**, perturbing set identity (the vertical analogue of the
  join's null-extended `{true, NULL}` symptom). The probe runs *after* the set
  operation, so dedup still operates on data columns only and the result is a clean
  `{true,false}` **NOT NULL** column. The derivation is uniform across all four
  operators: `union` / `union all` may be in either branch (both probes informative);
  `except` (`A except B`) yields `inLeft = true, inRight = false` by construction;
  `intersect` yields all flags `true`. For `union all` the probe is against a **set**,
  so the flag is the boolean "present ≥ once" (bag multiplicity collapses — a documented
  limit; a count variant is deferred).
- **FD ramifications (Invariants 1–2).** A **distinct** `union` / `intersect` / `except`
  is keyed on its all-columns (data) combination, so the forward FD walk emits
  `key → flag` (the flag is functionally determined by the data tuple it probes), and the
  flag is **never** claimed as part of a key. A `union all` (a **bag**) makes **no
  `key → flag` claim** — there is no data-column key to determine the flag from.
  `except` / `intersect` additionally carry the trivially-determined flags as constant
  bindings (`inRight = false`, all-true).

The flag is modelled as an extra output **attribute of the `SetOperationNode`** (not a
`ProjectNode` expression — that could only see set-op *outputs*, never the per-branch
data relations the probe needs), carrying an `existence` `UpdateSite` whose
`RelationalComponentRef` is a `set-op-branch` (the owning node + the immediate operand).
**Writable through an effect** (`resolveBaseSite` resolves a `set-op-branch` component
`writable: true` with no base column, `column_info` reports `is_updatable = 'YES'` / null
base, and a write drives a per-branch insert/delete — see § Set-operation membership
writes). The routing is **component-generic** (the same `existence` site the join
existence column uses), so the write half extends it without forking. An **unused** flag
is a semijoin probe and is *in principle* dead-column-eliminable — it ought not force a
branch to be retained or probed when no other column needs it. The analogous **join**
existence-flag pruning (`prune-unused-existence-flag`, the `join-existence-pruning` rule)
has landed, but the set-op membership analogue does not yet exist: the membership runner is
selected whenever the node carries any flag, so an unused flag on a `union all` currently
forces the buffering runner instead of the streaming one (correctness is unaffected; the
set-op sibling prune is deferred).

**Nestable flagged set-ops (read half).** An operand of a `SetOperationNode` may itself be
a (flagged) `SetOperationNode` — `A union[inA,inSub] (B union[inB,inC] C)`. Alignment, the
union schema, dedup, and set identity are all on **data columns only**: the outer arity
check compares each operand's recursive *data arity* (the left-most non-set-op leaf's column
count — flags are always appended after data at every depth), so an inner operand's surfaced
flags never inflate the check, and an inner flag never enters the outer's data-column set /
dedup / claimed keys (Key-Soundness Inv. 1–2 hold at every depth). An inner operand's flag
columns are **surfaced** as readable columns of the outer view under the defined projection
rule

```
[ data columns ] ++ [ L's flag attrs ] ++ [ R's flag attrs ] ++ [ M's own flag attrs ]
```

— data taken verbatim from the left child (ids preserved), each operand's flag attributes
threaded with their inner spec ids, then this node's own appended flags. A node surfaces
flags when it has its own membership flags **or** either operand does (so a flag-less outer
over a flagged operand — `A union (B∪[inB,inC] C)` — still surfaces `inB,inC`). The runtime
read half buffers each operand's full row and emits each output row under the same rule: a
surfaced inner flag reads as `tuple ∈ <that operand's data relation>` row-by-row at every
depth, defaulting **false** when the output row is absent from the operand (sound — an output
row not present in an operand is in none of that operand's nested branches, so every such
flag probe is false; verified for all four outer operators). The **write** half landed as
`nestable-flagged-set-ops`: a **union / union all** subtree operand is recursively writable for
data-column UPDATE / DELETE / `set <subtreeFlag> = false` fan-out, and the ambiguous subtree
inserts are deferred to `set-op-membership-nested` (see § Set-operation membership writes →
Nested / subtree operands). A **flagged `except` / `intersect` subtree operand** is now writable
for the same fan-out via a **membership gate** (`set-op-membership-nested-except`): the fan AND-s
the captured subtree-membership boundary flag into each leaf member-exists, so it reaches only
genuine subtree members; a **flag-less** non-union boundary stays deferred. The static surfaces
agree — they report a nested union or flagged-except/intersect body `is_updatable` /
`is_deletable` = `YES`, `is_insertable_into` = `NO`, a surfaced inner flag non-updatable, and a
view with a flag-less `except` / `intersect` subtree operand all-`NO`.

**Parenthesized LEFT-compound operand (read/plan, `set-op-leftwrap-arity`).** A `SetOperationNode`
operand on the **left** is, in SQL, a parenthesized compound — `(A∪B) union[…] (C∪D)` — which the
parser lifts into a `select * from (A∪B) as values_N` passthrough wrapper so the SELECT-level
`compound` slot can host the outer operator. The build path (`planner/building/select-compound.ts`)
**unwraps** that pure wrapper (`unwrapPassthroughSubquery`, shared with the write path) so the
operand plan **is** the inner compound — a first-class subtree operand the recursive `dataArity` /
`flagCount` machinery above already handles. Without the unwrap, building the wrapper as a `select *`
`ProjectNode` over the inner `SetOperationNode` would count the inner's surfaced flag columns as
**data** columns, and the outer arity check (`leftData !== rightData`) would throw `SET operation
column count mismatch` — so a flagged **parallel-sibling** view (flagged compounds on *both* sides)
could not even be planned. With the unwrap, such a view plans and reads under the same sum layout
`[data] ++ [L flags] ++ [R flags] ++ [own flags]`, where the two siblings contribute distinct flag
columns (e.g. `(A∪[inA,inB]B) union[inLsub,inRsub] (C∪[inC,inD]D)` reads `id, x, inA, inB, inC, inD,
inLsub, inRsub`). The unwrap is recursive (it peels every pure-passthrough layer of a deeper left
nest) and **shape-guarded** — only an exact `select *` over a single unaliased subquery source with
no `where` / `group by` / `having` / `distinct` / `order by` / `limit` / `offset` / own `compound` is
unwrapped; a projecting or filtering derived table (`select x from (A∪B) v`) stays an opaque
relation. This is the **sum** surface (distinct flag names → distinct columns). Two siblings that
**reuse** the same flag names (the **product** model — reused names merging into shared coordinate
columns) are out of scope and currently rejected at create (the duplicate names collide in the set-op
output scope); that merge is the **shelved** `set-op-product-coordinate-model` (backlog) — a projected
attribute records a row's *origin* (the sum model), not `tuple ∈ <union of like-named leaves>` (a probe
semantic a stored value cannot express), so the sum model is the honest scope and the merge is built only
if a use case needs writable membership over a non-literal σ-guard. Writes through the left
wrapper landed as `set-op-leftwrap-write` (see § Set-operation membership writes → Parenthesized LEFT
subtree operand): the write path unwraps the same pure wrapper, so the LEFT subtree fans out for the
unambiguous operations exactly as the right subtree does.

### Set-operation membership writes

The first set-op view writability in the engine (`planner/mutation/set-op.ts`). A
membership column **is** the branch presence, so *writing* it drives the branch's
existence — the explicit, per-row control surface that replaces the never-built
`quereus.update.*` routing-tag dispatch for set-ops (`union-branch` / `delete_via`,
removed by `remove-update-routing-tag-surface`). Scope is `union` / `union all` /
`except` / `intersect` membership writes, with data-column UPDATE fan-out, DELETE fan-out,
and `set <subtreeFlag> = false` recursing through a **nested / subtree operand** at any
depth (`nestable-flagged-set-ops`) — on **either** side, including a parenthesized LEFT
compound operand (`set-op-leftwrap-write`). A **union / union all** subtree fans freely; a **flagged
`except` / `intersect`** subtree fans **membership-gated** on its captured boundary flag
(`set-op-membership-nested-except`), and only a **flag-less** non-union boundary stays deferred.
The genuinely ambiguous inserts into a multi-leaf
subtree — `set <subtreeFlag> = true`, a surfaced-inner-flag write, and insert-through
routing into a subtree side — have no single deterministic target leaf (product-coordinate
addressing) and are deferred to `set-op-membership-nested`.

A set-op view body is **not** routed through the single-source/join spines — `propagate`
rejects a `SetOperationNode` body. Instead `building/view-mutation-builder.ts` intercepts a
membership body (`buildSetOpMutation`) and decomposes it into per-branch base ops over an
**up-front, Halloween-safe capture**: the affected view rows — their data columns **and**
their membership-probe flags — are materialized **once** (`Project(Filter_{userWhere}
(SetOperationNode))`) into the same context-backed `__vmupd_keys` relation the multi-source
path uses, *before* any branch op fires. Each branch op then reads that immutable capture,
so a branch insert/delete can never perturb the affected set out from under a sibling op
(the DML executor drains its source lazily, so referencing the view directly would be
Halloween-unsafe). The capture rides the existing `ViewMutationNode.identityCapture` side
input + void/drain runtime path — no new runtime substrate.

**A branch is itself a view body.** Each operand (`select … from B`) is a **single-source**
view body, so each per-branch op is lowered to an AST `BaseOp`
against a **synthetic branch view-like** and run back through `propagate` — reusing the
spines verbatim (the branch's own σ predicate, column renames, and base routing are honored
by its own spine; `no-default` / computed-column rejections fall out of the recursion). A
**multi-source** branch/leg — one whose FROM is a join or comma-join (`isJoinBody`) — is
explicitly **rejected** (a clean `unsupported-set-op` reject, both static and dynamic) pending
the `set-op-write-multisource-leg-compose` unlock: routing it back through `propagate` would
reach the multi-source spine, whose own `__vmupd_keys` identity capture collides with the
outer set-op capture (the internal `k.k0_0 isn't a column` error). A
branch that bottoms out in a base table emits one base op; a branch that is itself a
`SetOperationNode` (a **subtree operand**) **recurses here** for the
unambiguous fan-out — a data-column UPDATE, a DELETE, and a `set <subtreeFlag> = false` drop
fan out to every member leaf, sharing the ONE up-front capture (the recursion rebuilds the same
frozen-data-tuple correlation against each inner branch, never a second capture; see § Nested /
subtree operands). A **union** subtree fans freely; a **flagged `except` / `intersect`** subtree
fans gated on its captured boundary flag (`set-op-membership-nested-except`), a flag-less one is
deferred. Inserting into a subtree is `set-op-membership-nested`.

**Per-operator membership-write semantics** (uniform across operators because the probe
flags already encode each operator's branch truth):

- **`union` / `union all`** — `inA` / `inB` independent. `set inA = true` ⇒ insert into A,
  `= false` ⇒ delete from A; symmetrically for B. **Both false** ⇒ the row leaves the view
  (deleted from every branch it was in).
- **`except`** (`A except B`) — a visible row is `inLeft = true, inRight = false`.
  `set inRight = true` ⇒ insert into B, pushing the row **out** of the view (the explicit
  form of the removed `delete_via = 'right_insert'`); `set inLeft = false` ⇒ delete from A
  (the row leaves the view).
- **`intersect`** — reads are trivially all-true, so membership columns are **write-useful
  only**: `set inB = false` ⇒ delete from B, dropping the row from the intersect.

**The probe makes a redundant flip a clean no-op.** A `set <flag> = true` inserts only the
captured rows **absent** from that branch (`where not k.<flag>`), so writing `true` over a
row already present is a no-op — and the per-operator semantics fold in for free (`except`'s
always-false right flag inserts every visible row; `intersect`'s always-true flags insert
none). A `set <flag> = false` deletes the matching branch row only for captured rows
present there (a NULL-safe full-data-tuple `exists` correlation against `__vmupd_keys`; set
operations treat `NULL = NULL` as equal, and the engine has no `IS NOT DISTINCT FROM`).

**Data-column writes & deletes fan out via the probe.** `update U set <dataCol> = v where
…` fans an update to **every branch the row is a member of** (the full-tuple `exists`
correlation restricts each branch update to its resident rows — a non-member branch matches
none, so no explicit flag gate is needed, and a branch need not even declare a flag for
fan-out). `delete from U where …` fans a delete to every member branch the same way.

**Composition & rejection.** A same-statement data assignment folds into a `true` flip's
inserted projection (`set x = 5, inB = true` over an A-only row inserts B with `x = 5` and
aligns A). `set x = 5, inB = false` is **rejected** (`conflicting-assignment`) — a write
cannot both delete a branch and write a column that fans out to it. A membership value must
be a **boolean literal** (`true`/`false`, or the `1`/`0` spellings); a non-literal per-row
branch is deferred. **Insert-through** (`insert into U (id, x, inA, inB) values (…, true,
false)`) routes by the supplied flags — a true flag activates its branch, a false flag omits
it — over a VALUES source (the flags are a uniform per-statement routing directive). A
flag-less ambiguous multi-branch insert is rejected. RETURNING through a set-op membership
write is not yet recoverable (rejected).

**Nested / subtree operands** (`nestable-flagged-set-ops`). An operand of an outer set-op
may itself be a (possibly flagged) `SetOperationNode` — `A union[inA,inSub] (B union[inB,inC]
C)`. Such a **subtree operand** is recursively writable for the unambiguous fan-out
operations: a data-column UPDATE fan-out, a DELETE fan-out, and `set <subtreeFlag> = false`
(a delete fan-out into the subtree's leaves) all recurse through the subtree to its member
leaves, **sharing the single up-front capture**. The recursion is sound because nesting
preserves the data columns at every depth (the `SetOperationNode` arity check is data-only),
so "touch the leaf rows whose data tuple ∈ `__vmupd_keys`" is the same frozen-capture
correlation rebuilt against each inner branch. For a **union / union all** subtree a
leaf's rows ⊆ the subtree's, so the capture selects exactly the resident leaf rows to touch,
no second capture is introduced, and Halloween-safety is preserved at depth. A **flag-less
union subtree operand** (`A union[inA,inSub] (B union C)`) is writable through the same recursion
(it need not declare inner flags to fan out).

**Membership-gated `except` / `intersect` subtree fan-out** (`set-op-membership-nested-except`).
For an `except` / `intersect` subtree a leaf is NOT a subset of the subtree (a row in both `B`
and `C` is absent from `B except C`), so a blind fan-out would touch leaf rows the subtree
excludes — rows whose `inSub` probe reads false — silently corrupting base rows the view never
exposed as subtree members. The fix **gates** the fan on the captured **subtree-membership
boundary flag**: the `exists <branch> as <flag>` the OUTER compound declares for the subtree's
side (`inSub`) is a view output column, so it sits in the capture, and AND-ing `k.<flag>` into
each leaf's member-exists restricts the fan to genuine members. This restores the proven binary
behavior at depth — for a binary `B except C` the capture holds only members (B\C), so fanning
to both leaves is sound (C gets harmless no-ops); gating the nested fan on `k.inSub` makes it
behave identically. The gate **accumulates one conjunct per non-union boundary descended**: in
`A union[inA,inS1] (B except[inB,inS2] (C intersect[inC,inD] D))` a member of `B except (C∩D)`
that is in C-only (not D) has `inS1=true` but `inS2=false`; gating only on `inS1` would wrongly
touch C, while gating on `inS1 AND inS2` correctly skips C/D. A **union** boundary contributes
nothing (a union leaf ⊆ its subtree, so leaf-presence already implies membership). The lone
remaining deferral is a **flag-less non-union boundary** (`A union[inA] (B except C)` — no
`inSub`): it surfaces no boundary probe to gate on, so the dynamic write and the static surfaces
both reject it (`set-op-membership-nested-except`); synthesizing the probe from leaf flags
(`inB AND NOT inC`) is a possible future enhancement.

The genuinely ambiguous inserts into a subtree
are **deferred** to `set-op-membership-nested` (product-coordinate "which leaf?" addressing)
with clean diagnostics: `set <subtreeFlag> = true` (insert into a multi-leaf subtree), a
**surfaced-inner-flag** write (`set inB = …` through the outer view — addressing a branch
*inside* the operand), and **insert-through** whose active routing flag is a subtree side.
Each diagnostic names `set-op-membership-nested` and is neither the misleading
`SetOperation … not updateable` message nor `unknown-view-column` (a surfaced inner flag IS a
view column).

**Parenthesized LEFT subtree operand** (`set-op-leftwrap-write`). A subtree operand can sit on the
**left**, where SQL spells it as a parenthesized compound — `(A∪B) union[…] (C∪D)`, the
*parallel-sibling* shape — which the parser lifts into a `select * from (A∪B) as values_N`
passthrough wrapper so the SELECT-level `compound` slot can host the outer operator (§ Parenthesized
LEFT-compound operand). The write path **unwraps** that pure wrapper (`buildBranch` →
`unwrapPassthroughSubquery`, the same predicate the read/plan path uses) so the wrapped left operand
is a first-class subtree operand — its data-column names, `isNested`, and fan-out recursion all derive
from the inner compound, exactly as the (always-direct) right compound operand. The result is full
symmetry: the unambiguous fan-out (data UPDATE / DELETE / `set <subtreeFlag> = false`) reaches the
LEFT subtree's leaves at any depth — a `delete from P1 where id = 2` over `(A∪B) union[inL,inR] (C∪D)`
fans into A and B, and `set inL = false` drops the row from the left subtree's resident leaves only
(the right subtree keeps it). A union LEFT subtree fans freely; a flagged `except` / `intersect` LEFT
subtree fans **membership-gated** on the boundary flag the outer compound declares for the left side
(`set-op-membership-nested-except`), a flag-less non-union one stays deferred. The branch's data-column
names come from its **left-most leaf** (a left-spine nest's own left leg is itself wrapped, so a single
projection read would see the wrapper's `*`; the write path descends to the real leaf). The ambiguous
inserts into the LEFT subtree (`set <subtreeFlag> = true`, a surfaced left-subtree inner-flag write,
insert-through routing into the left subtree side) stay deferred to `set-op-membership-nested`, and the
static surfaces walk **both** operands so `is_insertable_into` reports `NO` and the surfaced left-inner
flags report `is_updatable = NO`. The orthogonal **product** model (two siblings *reusing* flag names,
merging into shared coordinate columns) is the **shelved** `set-op-product-coordinate-model` (backlog):
projected attributes express the **sum** model (origin tags), not the **merge** (`tuple ∈ <union of
like-named leaves>`), so the merge ships only on a use case needing writable membership over a non-literal
σ-guard.

**Flag-less predicate-honest writes (the preferred surface, `set-op-flagless-predicate-honest-writes`).**
A flag-less set-op body whose legs carry *regular projected columns* — plain base columns plus literal
**discriminators** (`'red' as kind`, `'A' as src`) — is writable WITHOUT any `exists … as <flag>` membership
column. It is the **preferred** write surface over the `exists`-membership path above (the two coexist; no
unification this pass), reusing the SAME substrate verbatim: the up-front Halloween-safe capture, the
per-branch recursive `propagate` lowering, the member-exists correlation, and the data/delete fan helpers
(shared through `buildSetOpMutation`, parameterized by the per-shape write builder). The ONE difference is
the **per-leg branch oracle**: instead of a runtime membership-probe flag, a leg's eligibility is decided at
PLAN time by `checkSatisfiability` (`analysis/sat-checker.ts`) over the leg's σ-derived constant facts ∧ its
literal-discriminator bindings ∧ the mutation's predicate — `unsat ⇒ skip the leg`, `sat`/`unknown ⇒ include
it` (honest fan-out over silent suppression; the checker never emits a false `unsat`, so a real target leg is
never dropped). INSERT routes a VALUES row to every consistent leg (a literal-discriminator design routes to
exactly one); DELETE / data-UPDATE fan to every consistent leg; `intersect` fans inserts/deletes to every leg
and `except` writes the left operand only. The literal discriminators are **read-only** — a `set kind = …`
surfaces `no-inverse` (a projected literal has no base inverse).

The discriminator routing does **not** "fall out of the FD framework for free": a pure-literal projection
(`'red' as kind`) emits **no constant FD** today — `ProjectNode.computePhysical` only *forwards* the child's
existing bindings through the source→output column map, and a literal has no source attribute to forward. So
the oracle closes the gap with the localized **Option B**: it reads each leg's literal projections directly
from the leg AST (peeling Cast/Collate) and synthesizes the discriminator `ConstantBinding`s itself, feeding
them to the checker alongside the leg's *planned* physical bindings — which DO carry the σ-on-projected
constant (`where color='red'` forwarded to a `color`-projecting output column). That σ-derived half — and the
omitted-base-column insert recovery it drives — IS pre-existing (the same single-source `where`-constant
insert-defaulting the GreenMen view uses); only the routing discriminator needed the localized synthesis. No
hot-path (`ProjectNode.computePhysical`) change was made; the optimizer-wide projected-literal-constant-FD
enhancement (Option A) is a separate deferred concern. **v1 limitations:** VALUES-source inserts only (a
SELECT/DML source's per-row routing is deferred); RETURNING is rejected; a `union all` view with duplicate /
overlapping data tuples fans a delete/data-update to all copies (bag identity); a leg discriminating purely
by a non-literal σ (`where f(color)`) routes by include-on-unknown but cannot recover its omitted base
columns on insert; a deep / mixed `intersect`/`except` chain is not flattened (it stays on the existing
reject); an INSERT that **omits a discriminator** is consistent with every leg that discriminator would have
excluded, so it routes to all of them — when two such legs share a base table this surfaces as a clean PK
conflict (a leg discriminating by a non-`=` range σ on a *projected* column is now **honored by the
oracle** — its σ conjuncts (`where x < 5`, `between`, …) are fed to `checkSatisfiability` alongside the
mutation predicate, so an INSERT whose supplied value provably violates the range makes that leg `unsat`
⇒ skipped, with no phantom base row, `set-op-flagless-range-sigma-oracle`; a σ on a **non-projected**
column (`where f(color)`) still resolves to no in-scope accumulator and routes include-on-unknown);
a leg whose body is a **multi-source (join) body** is now explicitly **rejected** (`isWritableLeafLeg`
gates on `isJoinBody`), so the static surfaces report all-`NO` and the dynamic write falls out of the
flag-less route into the single-source spine's clean `cannot write through view` reject — no longer the
internal `k.k0_0 isn't a column` error the un-composed nested capture used to hit (`set-op-write-multisource-leg-reject`).
Composing the nested capture to actually *support* a join leg is the separate `set-op-write-multisource-leg-compose` unlock.

**v1 limitations (documented).** Identification is by the full data tuple, so a `union all`
view with **duplicate data tuples** in a branch fans a delete/data-write to *all* copies of
that tuple (the count variant is deferred). A data-fan-out value that *references* a data
column requires the operand legs to use matching column names (a leg rename of a
referenced column is not yet remapped); literal values are unaffected. A branch leg must
be a plain (optionally renamed) base-column projection — a `select *` or computed leg
column in a writable branch is rejected. **Static-surface partial on a subtree flag:** an own
subtree flag (`inSub`) carries an `existence` site, so `column_info` reports it
`is_updatable = YES` — accurate for its `= false` delete (which works) but optimistic for the
deferred `= true` insert; the dynamic write still rejects the latter cleanly.

**Static surfaces gate on branch writability.** `view_info` / `column_info` for a
membership body now mirror the **non-decomposable join shape gate**: they confirm the
membership shape *and* that both operands are themselves branch-writable before reporting
writable, via an AST-only probe (`isSetOpBranchWritable`) that is the static shadow of the
dynamic write's pre-write rejections — an outer `LIMIT`/`OFFSET` (the body is not
decomposable, a write would escape the window), a non-SELECT right operand, a `select *`
leg, a computed leg, or legs whose plain-column counts disagree. A body that fails the probe
reports the conservative shape (`view_info` all-`NO`, every `column_info` row
`is_updatable = 'NO'` with null base), agreeing with the dynamic write's reject instead of
over-claiming writable from the membership flag's presence alone. The probe is now
**recursive** (`nestable-flagged-set-ops`): an operand is branch-writable iff it is a
plain-column leaf OR a (recursively) branch-writable set-op body, so a
nested union view reports `is_updatable` / `is_deletable` = `YES` (data + delete fan-out
genuinely recurse through the subtree). A **flagged `except` / `intersect` subtree operand is
branch-writable** (`set-op-membership-nested-except`): the probe threads each operand's
**boundary-flag presence** (the `exists <branch> as <flag>` the parent compound declares for
that side) and admits a non-union subtree IFF its side carries a boundary flag to gate the fan
on — so a flagged except/intersect view reports `is_updatable` / `is_deletable` = `YES`, while a
**flag-less** non-union boundary stays non-writable (the conservative all-`NO` shape), agreeing
with the dynamic reject. The probe **unwraps a parenthesized LEFT compound operand** before
classifying it (`set-op-leftwrap-write`), so a parallel-sibling view reports its left subtree's
writability identically to the right. `is_insertable_into` is gated **off** to `NO` whenever **either**
operand is a subtree (`setOpHasSubtreeOperand`, which now walks the unwrapped left too) — a
conservative, honest under-claim, since inserting into a multi-leaf subtree is deferred to
`set-op-membership-nested`. Per-column, a **surfaced inner flag** reports `is_updatable = 'NO'` (writing it is deferred),
while data columns and own flags report `YES`. The surfaced-inner enumeration
(`surfacedInnerFlagNames`) mirrors the plan's recursive `[L flags] ++ [R flags] ++ [own flags]`
attribute layout across **BOTH legs** of every subtree operand (unwrapping each left-compound
`select * from (compound)` wrapper) — descending left, then right, then appending the node's own
flags. So `column_info` reports every surfaced inner flag `is_updatable = NO` in agreement with the
dynamic `set-op-membership-nested` reject, for a flag declared on **either leg** of a left- OR
right-side subtree operand **at any depth** (`set-op-subtree-leftleg-flag-surface`) — not just a
subtree's own / right-leg flags. The enumeration lands element-for-element on the plan-derived
`analysis.surfacedInnerFlagNames` (the `viewColNames` slice between the data columns and this body's
own flags), so the static surface never drifts from the dynamic write.

> **Implemented surface vs. the design below.** Binary set-op write-through is realized
> through the **membership columns** above (`set-op-membership-write`): the explicit
> per-row branch control surface. The predicate-honest fan-out + `quereus.update.*`
> routing-tag dispatch once described in the four subsections that follow (`delete_via`,
> `target`, `right_insert`, branch-consistency inference) was the **original aspirational
> design** — it was never built (no parser syntax, no consumer), and the routing-tag
> surface has been **removed** (`remove-update-routing-tag-surface`). The runtime
> membership probe is the branch oracle in its place; for set-ops without membership
> columns, write-through still rejects (`unsupported-set-op`). The subsections are kept for
> the per-operator semantic intent, which the membership-write rules above realize — read
> any `delete_via` / `target` mention there as its membership-column equivalent.

### Union All

```sql
create view v as
  (select x, isDog from y where isDog) union all
  (select x, isDog from y where not isDog);
```

- `update v set name = 'Rex' where isDog` narrows to the first branch.
- `update v set isDog = true where ...` is consistent with the first branch and inconsistent with the second; routes to the first only.
- `update v set name = 'X' where ...` is consistent with both branches (the assignment does not touch a branch-discriminating column); routes to both. Both target the same base table; both row-identifying predicates resolve to the same `y.pk`, producing one base update per row.
- `insert into v (x, isDog) values (1, true)` is provably inconsistent with the second branch; routes to the first.
- `insert into v (x) values (1)` lacks an `isDog` value. The first branch's predicate `isDog` supplies `isDog = true` via EC; the second's `not isDog` supplies `isDog = false`. Two distinct rows are inserted — the predicate-honest reading: the user said "make this row exist in v"; both branches contribute a row that does.

When same-table fan-out produces multiple operations against the same row, they are merged into a single base operation if their effects are identical, and reported as a conflict otherwise under the prevailing `or` resolution.

### Union (distinct)

Identical to `union all` for propagation. Duplicate elimination is a read-side concern; mutations operate on the underlying multiset.

### Intersect

A view row exists iff present in every branch. By predicate honesty:

- **Inserts** fan out to every branch (otherwise the row does not appear in the view).
- **Updates** fan out to every branch (the row exists on each side and must be kept aligned).
- **Deletes** fan out to every branch by default — the predicate-honest reading of "this fact is no longer true" is "remove from every relation that asserts it". A membership column narrows it to one branch (`set inB = false` drops the row from B only).

### Except

A view row exists iff present in the left and absent from the right.

- **Inserts** insert into the left; if the row is also present in the right (provable via the existence predicate against right's relation), delete from the right.
- **Updates** propagate to the left only.
- **Deletes** delete from the left by default. A membership write `set inRight = true` switches to inserting into the right, achieving the same view-level effect through the opposite base-level change (the explicit replacement for the removed `delete_via = 'right_insert'`).

### Distinct

Lineage passthrough. Mutations apply to all base rows that collapse to the affected view row (consistent with predicate-honest fan-out).

### Sort, Limit, Offset

Pure passthrough. `order by` and `limit` do not affect propagation unless the mutation itself carries `order by` / `limit`, in which case they participate in row-identifying-predicate construction.

### Common Table Expressions and the CTE-name DML target

A leading `with t as (…)` makes the **CTE name a real DML write target**: `update t …`, `insert into t …`, and `delete from t …` route the CTE body through the *same* view-mutation substrate a named view uses, via an **ephemeral view-like adapter** (`MutableViewLike.ephemeral`). There is no grammar change — a CTE name already parses as a bare identifier; the gap was purely resolution. The three DML builders intercept the target against the statement's own `withClause` (`resolveCteTarget`, `planner/building/dml-target.ts`) *ahead* of the `getView` / `getMaintainedTable` / `buildTableReference` schema dispatch, and a match short-circuits to `buildViewMutation` with the ephemeral adapter.

The equivalence to a named view is the acceptance bar: a CTE body that is structurally a single-source projection-and-filter produces a **byte-identical base-op plan** to `create view t as (…)` followed by the same DML against `t`. Multi-source (join) CTE bodies compose through the same join substrate as a join view.

**Resolution order — a CTE name *shadows* a same-named schema table / view / MV** as a write target, matching read semantics (a CTE shadows a base table in `from`). The `resolveCteTarget` check therefore runs first; the shadow is silent (no warning), consistent with read-side shadowing. A **schema-qualified** target (`update main.t`) is never a bare CTE reference, so it dispatches to the schema object even when a same-named CTE is in scope.

**The target CTE's own name — and every sibling defined at or after it — is shadowed out of its own body.** A non-recursive CTE cannot reference itself, so within its body a same-named `from` source is the *outer* object — the real base table (exactly SQL's CTE scoping). The same definition-order rule extends to *later* siblings: a non-recursive CTE is visible only to siblings defined after it, so the target's body sees only its **prior** siblings — a later sibling is out of scope and a same-named `from` in the body binds the real object (`with x as (select … from fwd), fwd as (…) update x …` writes through to the real `fwd`, not the later `fwd` CTE). The re-plan context is therefore the target's **prior-sibling prefix** (`contextForCteTarget`), mirroring `buildCommonTableExpr`, which builds each body against the prior siblings only. This makes the load-bearing shadow case `with base as (select id, color from base) update base set color = 'x'` write through to the **real** `base` table (the lowered base op resolves via the schema manager, never CTEs). **Prior** sibling CTEs stay in scope, so a prior-sibling read in the body resolves.

**Self-reference in the user predicate (Halloween) is a write, not a reject — split context + eager capture.** A *user-clause* self-read of the target name (`with t as (…) update t set … where id in (select id from t)`) resolves the self-read `from t` against an **eager up-front capture** of the whole CTE body and produces a Halloween-safe positive write — matching the inline-subquery / view self-reference behavior. The body and the user predicate want **opposite** treatment of the target name, so the substrate threads **two** contexts (`view-mutation-builder.ts`, gated to an ephemeral CTE-name target + a single-source UPDATE/DELETE that actually self-reads — `needsSelfCapture`; absent a self-read the plan is byte-identical to before):

- **`ctxBody`** — the **prior-sibling-prefix** context (`contextForCteTarget`, target **and** later siblings excluded). `analyzeView` plans the body and `buildCteSelfCapture` builds the capture source under it, so the body's own `from base` reaches the **real** base table (the shadow case above is preserved, *including* combined with a self-read, and *including* a later sibling that shadows the same real table).
- **`ctxSelfRead`** — `ctxBody` with the target name **re-added** to `cteNodes`, resolving to a context-backed key relation over the capture (minted by `makeMultiSourceKeyRef`, keyed under the CTE name rather than `__vmupd_keys`). It drives the view-column descend (`makeViewColumnDescend`) **and** the lowered base op's re-plan, so `from t` binds to the frozen snapshot.

The capture is the FULL body relation (every view column, **unfiltered** — a self-read names the whole CTE, exactly a materialized CTE), built like the set-op capture minus the user-WHERE filter. It rides `ViewMutationNode.identityCapture`, which the emitter materializes **once before any base op runs** — so the base op's `select id from t` reads the pre-mutation snapshot, Halloween-safe by construction (the key-mutating `set id = id + 10 where id in (select id from t)` mutates every captured row deterministically). No new runtime substrate is needed. Two scope-transform enablers make it sound: a FROM source whose name is in `cteNodes` resolves its columns (a clean shadowing local source) rather than tainting the scope (so `from t`'s bare columns are left local), and a **view-name-qualified** self-read (`select t.id from t`) is left local when `t` is a shadowed FROM alias (an *alias-shadow* set threaded parallel to the column-name shadow set) — so `t.id` binds to the capture, never a de-correlated `__vm_self`-qualified base term. Because the re-plan target is schema-qualified (`main.base` via the schema manager) while the predicate's unqualified `from base` resolves through `cteNodes`, the same name reaches two resolution paths without conflict.

**Recursive CTE targets are rejected** with a structured `recursive-cte` diagnostic (never a generic table-not-found miss). The reject gates on the *actual* recursive shape (`with recursive` keyword **and** a compound self-referential body — `isRecursiveCte`), not merely the keyword: a `with recursive` clause whose *target* member is a plain non-self-referential body is still writable.

**Non-decomposable CTE bodies** (aggregate / `distinct` / `limit` / `group by` / window) raise the **same** structured diagnostic the equivalent view body raises (`unsupported-aggregate` / `unsupported-distinct` / `unsupported-limit` / …), reached through the new target kind — the reject is body-shape-driven, identical across the view and CTE target kinds.

**Multi-level CTE body — transparent inlining.** A target whose body is a single-source projection-and-filter that reads *another* (prior) sibling CTE — `with a as (select id, color from ml), t as (select * from a) update t …` — is **AST-flattened** down to its terminal base table before the substrate runs (`planner/mutation/cte-flatten.ts`). The flattener collapses the linear single-source chain by *pure syntactic composition* — substituting each consumer reference with the inner CTE's defining expression and conjoining the inner's `where` — so the produced body is byte-equivalent to collapsing the whole chain into one CTE body (`select id, color from ml`). Every downstream consumer (`analyzeView`, `classifyViewBody`, the INSERT/UPDATE/DELETE rewriters, RETURNING, the self-read capture) then runs unchanged on a genuine single base-table body. The flattener does **no** lineage/inverse reasoning: a computed/invertible column (`v + 1 as vp`) inlined through several levels still has its inverse recovered by the planner that re-plans the flat body, so `set vp = 9` lowers to `v = 8`. Filters conjoin in chain order, projections narrow, and a `(p, q)` column rename composes through. The consumer-rewrite descent into nested subquery operands is **alias-shadow-scope-aware** (it reuses scope-transform's `transformAliasScopedQuery`, the same FROM-alias shadow threading the self-read capture uses): a subquery nested in the consumer that re-binds the inner source name as a *local* FROM alias (`… where exists (select 1 from other x where x.col …)` over an inner source named `x`) makes that `x.col` local to the nested scope (innermost-scope SQL rules), so it is **not** rewritten to the inner CTE's defining term — a genuine `x.col` correlation that does *not* re-bind the name is still substituted. (The consumer body's own single FROM source *is* the inner name and is precisely what is substituted away, so the alias set begins empty and only a *nested* re-bind ever shadows.) The target's own name is shadowed out of its body (the load-bearing `with base as (select … from base) …` case stays terminal — its same-named source is the real table), and only PRIOR siblings inline (definition-order visibility). A **non-updateable intermediate** in the chain (aggregate / `distinct` / `limit` / set-op / join) rejects with *that intermediate's* body-shape reason — identical to the diagnostic a single-level CTE of that shape (or the collapsed body) raises; a non-updateable *consumer* (the target body itself) is carried through and rejected by the final `analyzeView`. The inline-subquery target inlines identically (`with t as (…) update (select … from t) as v …` — [§ Inline subquery DML target](#inline-subquery-dml-target)). A `with defaults (…)` clause carried on each level of the chain **merges** through the flattener (`mergeDefaults`, `cte-flatten.ts`) into the collapsed body, with the **consumer winning** on a column-name collision (see [§ View defaults](#view-defaults)).

**v1 boundaries** (documented, deferred):

- **INSERT-source self-read** — `with t as (…) insert into t … select … from t` keeps its current behavior: the target name is shadowed out of the INSERT source's scope (no eager-capture path — that path is gated to UPDATE/DELETE), so `from t` is a table-not-found miss. Not silently wrong; routing an INSERT-source self-read through the capture is a possible follow-up.
- **Join-bodied (multi-source) CTE self-read** — the eager-capture path is gated to single-source bodies, so a self-read through a join-bodied CTE target still reaches the multi-source descend's `unsupported-subquery-correlation` reject (no silent-wrong plan).
- **Set-op-bodied / compound CTE target** — reaches the existing set-op reject off `selectAst` (structured, no crash).
- **User-clause read of a later-defined sibling** — the body re-plan and the user `where` / `set` / `returning` descend share *one* re-plan context in v1 (`contextForCteTarget`), so stripping later siblings from the body also strips them from the user clauses. Per strict SQL the UPDATE/DELETE user clause is main-query scope and *should* see later siblings; in v1 a user-clause read of a later sibling instead resolves to a real same-named table (deterministic, explainable) or errors table-not-found — never silently the wrong relation. The motivating case has no such reference, and the faithful fix (a separate user-clause context retaining full sibling visibility) would thread a second context through `propagate` / single-source / multi-source — disproportionate, deferred.

**Plan-cache invalidation.** An ephemeral target records *no* schema dependency (and skips the view reserved-tag validation): there is no schema object to depend on, and the CTE body is part of the statement, re-planned from its own AST every run. So a CTE-target DML is never wrongly cached against a later `create view t`.

### Inline subquery DML target

A parenthesized subquery is a real **inline DML write target** for UPDATE and DELETE: `update (select …) as v set …` and `delete from (select …) as v where …` route the subquery body through the *same* view-mutation substrate a named view / CTE target uses, via the same **ephemeral view-like adapter** (`MutableViewLike.ephemeral`). A subquery in `from` is structurally an inlined CTE (§ above), so the routing is identical; this target kind adds only the grammar + AST + stringify to reach it (`resolveSubqueryTarget`, `planner/building/dml-target.ts`). The three substrate guarantees carry over unchanged: a single-source projection-and-filter body produces a **byte-identical base-op plan** to the equivalent named view / CTE; a join body composes through the same multi-source substrate; and non-decomposable bodies raise the **same** body-shape diagnostics, reached through the new target kind.

**Grammar.** The target is detected by a leading `(` followed by a relation-producing keyword (`select` / `values` / `with` / a DML keyword) — the same lookahead a FROM subquery uses — and parsed by the shared `subquerySource` production. For DELETE the `(` check runs *after* the optional leading `FROM`, so `delete from (select …) as v` and `delete (select …) as v` both parse.

**The alias is mandatory.** Unlike a FROM subquery (which synthesizes a default alias when none is written), a write-target alias is user-meaningful — the `where` references the body's columns through it (`v.col`) — so the bare form `update (select …) set …` is a clear parse error (`requires an alias`), never a silently-generated alias. An optional `as v(a,b)` rename list renames the body's output columns; the renamed names are what `where` reference (the body's own projection names are hidden). SET targets, as everywhere, are bare column names (`set color = …`, not `set v.color = …` — qualified SET targets are not SQL).

**AST encoding.** `UpdateStmt` / `DeleteStmt` keep `table: IdentifierExpr` for the ordinary named/CTE case; an inline target rides a parallel `targetSource?: SubquerySource`, with `table` filled by a synthetic placeholder identifier equal to the alias (so the generic `stmt.table.name` reads — diagnostics, the committed-schema guard — stay total) and `alias` carrying the same correlation name. The inline-target resolution runs *before* the CTE / schema dispatch, so the synthetic `table.name` is never re-resolved as a same-named CTE or schema object.

**Halloween / self-reference is a write, not a reject.** `update (select id, color from base) as v set color = 'x' where v.id in (select id from base)` writes through: the inner `from base` reads the **real** base table (an inline subquery has no own-name to shadow out of its body), so the predicate resolves and the captured affected-row set is mutated under the substrate's eager-capture discipline. The CTE-name target reaches the **same** positive-write behavior for a self-read of its *own* name (`with t as (…) update t … where id in (select id from t)`) via the split context + eager capture described in [§ Common Table Expressions](#common-table-expressions-and-the-cte-name-dml-target) — the CTE case captures the body under its target-excluded context, where the inline case names the real base table directly. Sibling CTEs likewise stay in scope, so `with cv as (…) update (select … ) as v set x = (select … from cv) …` resolves `cv`.

**v1 boundaries** (documented, deferred):

- **INSERT is not admitted.** `insert into (select …)` is deliberately left unchanged: an INSERT target needs a column-list mapping, not an aliased relation, and SQLite has no such form. `insert into (` falls through to the existing `Expected table name` parse error. The CTE-name INSERT (`insert into t …`) already covers "insert through a derived relation". (A future need files a backlog ticket.)
- **DML-bodied target.** `update (insert … returning …) as v …` parses (`subquerySource` admits a RETURNING DML body in a FROM position) but is rejected up front (`no-base-lineage`): a write target must be a SELECT-shaped relation with recoverable base lineage.

**Inline body that reads a CTE — transparent inlining.** `with t as (select … from base) update (select … from t) as v set … where v.… ` writes through: the inline body's single-source chain is flattened down to the terminal base table (the inline-subquery dual of [§ Common Table Expressions](#common-table-expressions-and-the-cte-name-dml-target) — multi-level CTE body), so the substrate sees a single base-table body. An inline subquery sees ALL the statement's CTEs (it sits after the WITH clause) and has no own-name to shadow out; a non-updateable intermediate in the chain rejects with that intermediate's body-shape reason, exactly as for the CTE-name target.

### Window Functions

The window function's output column is `computed` (read-only). Other columns from the windowed input remain updateable per the normal rules.

### Aggregation

Aggregation is read-only at the column level. Grouping columns are passthrough-updateable in principle (uniquely determined per group), but the surrounding aggregate functions defeat row-level identifying predicates: a single view row corresponds to many base rows, and the engine cannot decompose `set group_col = ...` into per-base operations without an explicit row binding from the user. Aggregates remain a delta surface via the incremental-maintenance machinery (see [Incremental Maintenance](incremental-maintenance.md)); update propagation through aggregations is reserved for the future extension that consumes that framework.

## Scalar Invertibility

Scalar functions and operators expose an **invertibility profile** in their schema registration. The lineage walker consults the profile when threading a transformation through a column reference.

```typescript
type InvertibilityProfile =
  | { kind: 'passthrough'; arg: number }
  | { kind: 'inverse'; fn: ScalarFn; domain?: PredicateExpr }
  | { kind: 'opaque' };
```

- **`passthrough`** — the named argument is returned with a non-data-altering transformation. The lineage threads the argument's lineage as if the call were not there. Example: `collate(x, 'NOCASE')` is `{ kind: 'passthrough', arg: 0 }`.
- **`inverse`** — the function has a deterministic inverse, optionally restricted to a domain predicate. When inverting an assignment, the engine substitutes the inverse and conjoins `domain` into the row-identifying predicate. Example: integer addition by a constant — `x + k` has inverse `y => y - k` with unrestricted domain over integers.
- **`opaque`** — no inverse known; columns whose lineage passes through this function become `computed` (read-only).

Built-in functions ship with profiles. `cast`-style conversions advertise `inverse` when lossless and `opaque` when lossy. `coalesce(x, default)` is `passthrough` on `arg = 0` when the default branch is provably unreachable on the update path (via FD-driven `not null` proof). String functions are `opaque` by default; the few invertible cases are declared explicitly. User-defined functions declare their profile at registration. A predicate-typed UDF additionally declares which arguments it sees through (passing lineage through, leaving the row's update site untouched) versus which arguments it consumes opaquely. The same surface is reused by the [assertion-derived-premises](optimizer.md#assertion-derived-premises) pipeline.

**How writability follows from the profile.** The plan-node backward walk resolves every projection to a `base` `UpdateSite` — `identity` / rename (`b as bc`), `passthrough` (an identity-on-value transform: `b collate nocase`, a no-op `cast(b as <same logical type>)`; *no* inverse), or `inverse` (a non-identity invertible transform: `b + 1`; inverse *present*) — else `computed` / `null-extended` (read-only). Both mutation spines route the **full writable-base set** (identity + passthrough + inverse) on the UPDATE write path, applying a site's `inverse` only when present: `set bp = 9` on a `b + 1 as bp` column lowers to `set b = 9 - 1`; `set bc = v` on a `b collate nocase as bc` passthrough column lowers to `set b = v` (no inverse applied). INSERT is **insertable for the inverse-absent subset** — `identity` / rename and `passthrough` store the value verbatim — while registry-`inverse` and `opaque` columns are non-insertable (the lowering writes the value raw, with no hook to apply an inverse; an [authored inverse](#authored-inverses-with-inverse) supplies exactly that hook and *is* insertable). The two spines share an identical insertability gate (`writable && inverse === undefined`, lifted by an authored inverse). The static `view_info` / `column_info` surfaces read the same plan-node lineage and report a `base` site (identity, passthrough, or inverse) writable, agreeing with the dynamic truth.

## Authored inverses (`with inverse`)

The invertibility registry composes inverses it can *infer* (`±k`, identity, passthrough, no-op casts). When the forward expression is opaque to the registry but the author has a chosen inverse — the canonical case is a non-injective `case` mapping where writes should store a representative value — the inverse is **authored inline on the result column**, as a core `select` extension:

```
result_column := expr [ as alias ] [ with inverse ( column = expr { , column = expr } ) ]
```

```sql
select
  case code20 when 'A1' then 'A' when 'A2' then 'A' ... end as code
    with inverse (code20 = case new.code when 'A' then 'A1' ... end),
  b || ' ' || c as full_name
    with inverse (b = substr(new.full_name, 1, instr(new.full_name, ' ') - 1),
                  c = substr(new.full_name, instr(new.full_name, ' ') + 1))
from t;
```

Design rules:

- **Named targets only.** Each assignment names a base column of the FROM sources and supplies the expression that computes it from the written view row. There is no inferred-target shorthand — explicit targets are self-documenting and stable under edits to the forward expression (an inferred form's validity would hinge on which base columns the forward happens to reference). A multi-input forward (`b || ' ' || c`) simply carries one assignment per base column. The assignment-list shape deliberately mirrors the [`with defaults`](#view-defaults) clause.
- **Scoping is asymmetric, by design.** The forward expression is in *base* terms; the inverse expressions are over the **written view row**, referenced with the mandatory `NEW.` qualifier (`new.code` — including `new.<this column>` itself as the written value). Requiring `NEW.` keeps the inverse unambiguous against the base columns otherwise in scope in the body.
- **Validation is position-independent.** Wherever the clause appears, build-time checks require every assignment target to resolve to a column of the FROM sources and every `NEW.*` reference to resolve to an output column of the select — so a typo fails loud even when the relation is never used as a write target. Until the relation *is* a write target, the clause is inert metadata.
- **Consumption is the lineage walk.** A `computed` output column carrying an authored inverse upgrades to a writable `base` site with supplied put expressions; the backward walk routes each target assignment to whichever base relation owns that column (so a multi-target inverse fans out across a join's sides or a decomposition's members through the same per-op routing as everything else). On UPDATE the assigned view value lowers through the authored expressions; on INSERT the envelope evaluates them over the supplied row per `VALUES` row — which is why an authored-inverse column is **insertable** where a registry-`inverse` column is not.
- **Authored wins.** An authored inverse on a column the registry could already invert (or on a bare passthrough) overrides the inferred put — explicit overrides generated, the same stance as the lens layer. The redundant-on-passthrough case warrants an advisory, since it usually signals confusion.
- **The clause is total per column.** The author writes the inverse of the *whole* forward term; the registry does not compose partial authored fragments with inferred steps. (Function-level declared inverses — registering an inverse alongside a UDF so the registry can compose it — are a possible convenience layer; the term-level clause alone is sufficient, since anything composable can be written out.)
- **Law treatment.** **PutGet** (write-then-read reproduces the written value) must hold and is checked by composing `forward(inverse(NEW)) ≡ NEW.col` — decided by enumeration when the column's domain is constrained (a CHECK `in (...)` list): a proven violation is a deploy error naming the column and value; a non-enumerable domain degrades to the safe admit (mutation-time behavior governs, the prover's usual posture). **GetPut** is intentionally surrendered for a non-injective forward — a write-through *normalizes* the base value — and surfaces as an acknowledgeable advisory at the lens boundary ([`lens.getput-lossy`](lens.md#coverage-checklist)), never a silent admit and never a hard error. Enumeration that proves the mapping bijective suppresses the advisory.

Because the clause lives on core `select`, every relation site gets it uniformly — lens bodies (where the [lens prover](lens.md#computed-and-generated-columns) consumes it), plain views, CTEs, and subqueries-in-`from`.

**Status — what is wired today.** The clause parses, round-trips, and is **validated at build time wherever it appears** (`planner/analysis/authored-inverse.ts`, run from the select-projection builder): target resolution against the FROM sources, `new.*` resolution against the select's output columns, the bare-reference rejection, and the cross-result-column duplicate-target rejection (an in-clause duplicate is a parse error). A clause on an **aggregate result column** is rejected outright (the aggregate phase never reaches the projection lineage the clause rides, and aggregate views are read-only — silent inertness would mask the typo'd intent). The lineage walk upgrades a clause-carrying projection to a writable **`authored`** `UpdateSite` (puts target-resolved through the child lineage's ownership routing; **authored wins** over identity / passthrough / registry-`inverse` alike, and an unroutable target degrades the column to `computed` rather than falling back to the inferred put). Consumption:

- **Single-source UPDATE / INSERT** — fully wired. UPDATE lowers one base assignment per put, substituting `new.<x>` with the **written view row's** value of `x`: the assigned value when `x` is assigned in the statement (the carrying column itself, or any co-assigned sibling — every embedded value reads the pre-update row, so cross-references are order-independent), the column's view name otherwise — then riding the standard view→base lowering (the forward read image for unassigned columns). INSERT evaluates the puts per `VALUES` row, with `new.<x>` bound to the supplied cell, else the appended constant-FD / `with defaults` expression for `x`'s base column, else `NULL`; an authored put target counts as **supplied**, so it takes the inverse-computed value ahead of any `with defaults` entry or base `default`. A SELECT-source insert through an authored column is rejected (`unsupported-source` — the per-row cell substitution needs VALUES, the same v1 boundary as the appended-defaults rewrite). Two supplied view columns landing one base column (authored put vs. verbatim target) reject with `conflicting-assignment`.
- **Multi-source (join) UPDATE** — wired: each put routes to its owning join side (a two-sided target set yields two child ops, atomic, FK-parent-first), `new.<x>` binds the written view row exactly as on the single-source path (co-assigned siblings included), and a `new.<x>` whose forward image reads the partner side rides the same captured-read machinery (and gates) as a cross-source `set` value.
- **Multi-source (join) INSERT** — deferred: evaluating puts through the shared-surrogate envelope is rejected with a sited diagnostic naming the column (see Current limitations).
- **Decomposition fan-out** — deferred: a write targeting an authored column of a decomposition-backed logical table rejects with `unsupported-decomposition-member`, naming the member(s) the puts route to.
- **`view_info` / `column_info`** — an authored column reports updatable (single-put inverses carry their base trace; a multi-target inverse reports a null base, like an existence flag) and its put targets count toward insert coverage on the single-source shape.
- **Lens bodies** — the sparse-override merger carries the clause per covered column into the composed read body (a gap-filled column never has one), so a lens write consumes it through the same spine. The prover's law treatment is **wired**: PutGet is checked by enumeration over the column's CHECK `in (...)` domain (`lens.putget-violation` on a proven loss, degrade-to-safe otherwise), GetPut surfaces as the acknowledgeable [`lens.getput-lossy`](lens.md#coverage-checklist) advisory (suppressed when the enumeration proves the forward bijective), an authored inverse satisfies `quereus.lens.writable = true`, a logical CHECK over an authored column enforces row-local via forward substitution (single-source bodies only — a multi-source forward reds `lens.unrealizable-constraint` rather than deploying a CHECK that could pass vacuously on a member write row), and `quereus_effective_lens` reports the per-column `inverse` disposition (`authored` / `inferred` / `none`). The redundant-on-passthrough advisory named above is still not emitted.

The clause **rides `ALTER TABLE … RENAME TO / RENAME COLUMN` propagation** alongside the body, by symmetry with [`with defaults`](#view-defaults): a rename of a FROM-table base column rewrites each assignment's **target** (targets are base columns — exactly what renames touch, riding the same scope-aware walk as an unqualified body reference); renamed tables/columns inside an assignment's expression (subqueries) rewrite scope-aware; and `new.<col>` references — which are by view-output name, so the body rewrite covers aliased projections — are retargeted where a rename shifts an output name: an **unaliased bare projection** of the renamed column, or a **star projection** covering the renamed table (unless an explicit projection still exposes the old name).

## View defaults

A view (or materialized view) declares omitted-insert defaults **first-class**, as a trailing `with defaults (…)` clause of the **core select** — it binds to the whole query expression after `limit`/`offset`, before the DDL-level `with tags`:

```sql
create view dfi_v (id, name) as select id, name from dfi
  with defaults (created = epoch_ms('now'));
```

Because the clause lives on the select AST (`SelectStmt.defaults`), it parses wherever a select parses — a view body, a CTE body, a subquery, or a bare top-level select. It is **inert metadata wherever no write path consumes it** (mirroring an unused `with inverse`): a bare top-level `select … with defaults (…)` parses and runs, ignoring the clause; a VALUES-bodied view's defaults are dead metadata (the view is non-updateable). Only when the view is an actual INSERT write target does the rewrite fire.

Across the **derived DML write targets** the same consume-or-inert rule governs reach. The clause is **active on a CTE-name INSERT target** — `with t as (<body> with defaults (…)) insert into t …` fills the omitted columns through the ephemeral substrate exactly as a named view does (`bodyDefaults` reads it off the flattened body select). It is **inert on an inline-subquery target** — the only inline-subquery writes are UPDATE/DELETE, which never consult defaults, and inline-subquery INSERT is rejected ([§ Inline subquery DML target](#inline-subquery-dml-target)). So the **CTE name is the only derived target that fires defaults**. A body-shape reject (aggregate / set-op / a SELECT-source insert that still needs a default appended — the rewrite is VALUES-only) fires *regardless* of the clause: defaults are appended only after the body is proven decomposable, so they never rescue a non-updateable body.

Each entry names a base column the view projects away (the dominant case — the column has no slot in the view's rename-only output column list) or a `base`-lineage view column, and carries a real SQL **expression** (a first-class AST value with a source location — not re-parsed tag text). At write-through the expression is evaluated per omitted-insert row at step 5 of the insert-defaulting chain (§ [Projection](#projection)): after the user value / constant-FD / FD-reconstruction / EC-propagation sources, ahead of the base column's declared `default`. The expression must be **self-contained** (literals, function calls, subqueries — no references to the inserted row's columns): the rewrite appends it as an extra cell on each `VALUES` row, where a column reference has nothing to bind against and fails at plan time. An entry naming a column that is neither a base column nor a base-lineage view column is a hard sited diagnostic at write time; the read-only `view_info` surface conservatively *skips* such an entry instead (never-throw posture), so `is_insertable_into` stays honest-conservative. **Target resolution stays at write time** (not create time): the base-column lineage the targets resolve against is only assembled when the view is a write target, so the `default-target-not-found` / `conflicting-assignment` diagnostics fire exactly when an insert actually flows through the view.

The clause is accepted identically by `create materialized view` (every MV is a single-source passthrough, so MV write-through shares the same rewrite spine; the defaulted source column is transparent to row-time backing maintenance) and by declarative `view` / `materialized view` items, and it round-trips through `export_schema` and the declarative renderers.

The clause **rides `ALTER TABLE … RENAME TO / RENAME COLUMN` propagation** alongside the body: because the clause is stored inside the select body AST, the scope-aware body rewrite (`renameTableInAst` / `renameColumnInAst` in `schema/rename-rewriter.ts`) descends `select.defaults` directly — a rename of a FROM-table base column rewrites the entry's target `column` via the same synthetic-probe path a `with inverse` target uses (the dominant projected-away case, which the body's projection rewrite alone would never touch), and a renamed table or column inside an entry's `expr` rewrites scope-aware within the select's FROM frame (an inner subquery ref binding a like-named column on its own FROM is disambiguated by that subquery's pushed scope frame). The declarative differ applies the same body walk inversely when reconciling a declared definition against a not-yet-renamed catalog. A clause-only rewrite (projection untouched) still fires exactly one `view_modified` / `materialized_view_modified`, so the regenerated DDL, the MV's `bodyHash`, and a store-backed catalog all carry the new name.

The clause is the **only** insert-default surface. Its precursor — the `quereus.update.default_for.<column>` reserved tag, at both its view-DDL and statement-level sites — has been removed: a stray occurrence is an `unknown-reserved-tag` error like any other retired key. A per-statement default has no replacement surface; supply the column an explicit value in the insert instead. (The earlier `insert defaults (…)` spelling — the clause hung off the DDL statement rather than the select — is likewise gone with no back-compat: re-spell it `with defaults (…)`.)

## Tags

Default propagation is deterministic and predicate-honest, and **no reserved tag carries view-mutation behavior**. The last `quereus.update.*` key, `default_for.<column>`, became the first-class `with defaults` clause (§ [View defaults](#view-defaults)). **Write routing is not a tag either.** It is expressed three ways, in order of precedence:

1. **Predicates** rule — narrowing the row-identifying predicate to a single branch/side routes there.
2. **Per-row presence/membership columns** state routing explicitly and writably — the outer-join existence column (`exists … as hasP`, write `false` to delete the matched non-preserved side, `true` to materialize it) and the set-op membership columns (`set inB = false` to drop a branch). These are real, writable view columns, so the routing lives in the data shape and is self-documenting.
3. **Default fan-out** otherwise — every consistent branch/side (the FK-child default resolves a join delete to one side when a foreign key proves it).

The blanket "this view only ever writes relation X" restriction the removed `target` / `exclude` tags expressed is now achieved by **lens shape**: a view that does not project a relation's columns (and does not expose its presence/membership column) has no path to write that relation through the view. There is no replacement tag.

Shape and site validation for the whole `quereus.*` namespace is centralized in the typed registry `packages/quereus/src/schema/reserved-tags.ts` (`validateReservedTags(tags, site)`): each reserved key is matched to a frozen spec, its position checked against the key's legal `TagSite` set, and its value checked against a `TagValueSchema` (`csv-of-identifiers`, an enum, a `boolean`, …). An unknown or mis-sited key is a hard **error** — so a stray key from the retired `quereus.update.*` family (`default_for.<column>` and the routing keys `target` / `exclude` / `delete_via` / `policy`) is an `unknown-reserved-tag` error at any site — except an empty `quereus.lens.ack` rationale, which is only a **warning**. This registry is the **single shape/site source of truth for every `quereus.*` path** — the lens compiler, the module advertisement builder, and the declarative-schema differ all validate through it with the identical hard-error-on-unknown severity. The registry itself stays policy-free; the throw-first-error / log-warnings caller policy lives in the shared `raiseReservedTagDiagnostics` helper.

At the mutation boundary, tags are validated at two sites (`planner/mutation/mutation-tags.ts`): the view DDL (`ViewSchema.tags`, validated `view-ddl` — where only the inert differ rename hints `quereus.id` / `quereus.previous_name` are legal) and the DML statement (`WITH TAGS (...)` → `stmt.tags`, validated `dml-stmt` — where no reserved key is legal); a sited diagnostic is raised before any base op is built. Validation at the view-ddl site is **lazy**: a direct `create view … with tags (…)` stores the tags unvalidated, and an invalid reserved key surfaces on the first mutation through the view (the declarative differ validates declared view tags at apply, and `ALTER VIEW … SET TAGS` / `ADD TAGS` validate eagerly at plan-build — so the lazy window is the direct create only; `DROP TAGS` never value-validates, making it the escape hatch for a stored invalid key).

## Multi-Base-Table Mutations

A view that touches `n` base tables can emit operations against any subset in a single statement. The propagation pass aggregates the per-table operations and the statement-level executor issues them within the statement's transaction. Order of execution within the statement:

1. FK-parent operations precede FK-child operations where the dependency is provable from declared foreign keys.
2. Within an FK-equivalence class, order is unspecified.
3. All operations see a consistent pre-statement snapshot for **row identification**, realized by **eager key materialization**: a both-sides `update` — and a lenient multi-side `delete` fanned out to both candidate sides — captures each affected view row's base-PK identities once, before any base op fires, and routes every per-side op through that captured set (§ [Inner Join](#inner-join)). The first op therefore cannot rewrite a predicate column — or, for the delete, empty the join — out from under the second op's row identification; both ops target the same pre-mutation set regardless of execution order (and an FK cascade that removes a row early is a silent predicate-scan no-op, not a double-delete).

Constraint enforcement runs at end-of-statement under the prevailing conflict-resolution mode (see [Conflict Resolution](sql.md#conflict-resolution-or-clause)). Deferred CHECKs run at commit per the assertion framework. `Statement.getChangeScope()` (see [Change-scope Documentation](change-scope.md)) reports the union of all base-table operations a prepared statement may emit, providing accurate dependency information for reactive consumers even when the statement targets a complex view.

## Cycles, Self-Joins, Recursive Composition

**Self-joins.** A view that joins `t` to itself produces lineage referencing `t` under two distinct alias-bound update sites. Updates and deletes route per-alias; the engine executes the per-alias operations sequentially, each observing the previous one's effects. Cycles in update propagation (a → b → a via a self-join with mutual references) are detected at plan time and resolved by serializing in alias-declaration order.

**Recursive composition.** Views composed of views are flattened at planning time; propagation operates on the fully-inlined plan. A view whose body references itself (recursive CTE) is read-only.

**View update of a view's base table while the view is open.** Quereus's async iteration model captures a consistent snapshot per cursor (see [Memory Vtab Documentation](memory-table.md)); mutations through a view do not perturb concurrent reads of that view.

## Interaction with Constraints

- **`check` constraints** on base tables apply unchanged to base operations emitted by view mutations. A view selection predicate `σ_p` does *not* become a CHECK constraint — predicates are read-time filters, not write-time invariants. Users who want the converse (reject writes that would carry a row outside the view) attach the predicate as a base-table CHECK or a global `create assertion`.
- **`create assertion`** invariants enforce at commit time across the entire database, including any state produced by view-mediated mutations. This is the supported replacement for `with check option`: it composes across views, contributes premises through the [assertion-derived-premises](optimizer.md#assertion-derived-premises) pipeline, and runs incrementally via `DeltaExecutor`.
- **Foreign keys** with `on delete` / `on update` cascades fire on the base operations emitted by propagation, not on the view-level mutation. A view-mediated delete that emits two base deletes triggers each base's cascade independently.
- **Generated columns** are `computed` lineage; they are read-only at every level. Writes to generated columns through any view are rejected.
- **Conflict resolution (`or` clauses)** applies per base operation. A view mutation with `or ignore` ignores constraint violations on each emitted base operation independently. `or rollback` aborts the enclosing transaction at the first violation, regardless of which base operation triggered it.

## `returning` Clauses

`insert`, `update`, and `delete` through a view support `returning`. The returned rows are projected through the **view's** column list, not the base tables'. The engine evaluates the view body against the post-mutation state to produce returning rows — equivalently, against the captured per-operation results, since the view's lineage maps base rows back to view rows. `returning` columns of `computed` lineage (a view-level computed expression) are evaluated against the post-mutation base values. `returning *` expands to the view's column list. When a `returning` clause is present, `ViewMutationNode` is **relational** — its row type / attributes are the view's projected columns. Two mechanisms realize it:

**Single-source.** The clause is rewritten into base terms — each view-column reference substituted to its base-term lineage, the user's view-spelling preserved as the result-column name — and attached to the rewritten base statement, so the base op's own RETURNING machinery yields the rows. Unqualified columns bind to NEW for insert/update and OLD for delete, so the result is the post-mutation (or, for delete, the deleted) view image; computed view columns re-evaluate against those base values. This is robust against an update that changes a predicate column (it reads NEW/OLD, not a re-query). MV write-through inherits it verbatim.

**Multi-source** (n-way join) `update` / `delete`. The view row spans multiple base tables, so it is not recoverable from the per-side base ops. The mechanism is threaded as `ViewMutationNode.returning` with a `returningTiming`:

- **`delete`** (`pre`): the OLD view image restricted to the mutation's predicate, projected as **plan nodes in base terms over the already-planned `JoinNode`** — `π_{<returning, view-spelled, recomputed from base columns>}( σ_{idPredicate}( JoinNode ) )` — captured **before** the base ops fire (the rows still match the predicate and are about to disappear). Recomputing each view-spelled column from its base term (rather than referencing the body root's output attribute id) is what lets a body-computed column (e.g. `c.note || '!' as banner`) survive: project-merge collapses the computed projection's intermediate attribute id, so a by-id reference would dangle.
- **`update`** (`post`, with an `identityCapture`): each affected view row's **base-PK identities** (every side's PK columns, flattened to `k<side>_<j>`) are captured **before** the base ops fire, built as plan nodes over the already-planned join body and materialized into a shared descriptor (the same working-table-in-context plumbing recursive CTEs and the insert envelope reuse). **After** the base ops, the same planned `JoinNode` is re-queried, projecting the view-spelled base-term RETURNING columns restricted to those captured identities by a correlated EXISTS. The EXISTS is **preserved-keyed**: a *preserved* side matches by exact per-PK-column equality (`k.k<p>_<j> = s<p>.pk<j>`), while a *non-preserved* (outer-join null-extended) side uses a matched-OR-null disjunction `(AND_j k.k<np>_<j> = s<np>.pk<j>) OR (AND_j k.k<np>_<j> is null)`. The matched branch finds a row whose non-preserved partner already existed pre-mutation; the null branch (the non-preserved PK was captured NULL — no partner) identifies the row by its preserved-side equalities **alone**, so a **freshly-materialized null-extended row** (an [outer-join non-preserved-column update](#outer-joins) that minted a partner) surfaces instead of being silently dropped by a `NULL = <minted pk>` match. The same null branch fixes a latent partial-set bug: a **preserved-side update touching a still-null-extended row** is likewise recovered (its captured non-preserved PK is null). SQL three-valued comparison keeps the two branches disjoint (a null `k` value makes the matched-branch equality not-true), so no `is not null` guard is needed; for an all-preserved (inner) join every side is exact equality, byte-identical to the prior behavior. Because the match is on captured **identity** (not the now-stale user predicate), this is robust against an update that **rewrites a column its own WHERE filters on** — and a row the update pushed out of the view's filter is still returned (matching single-source NEW semantics). Composite-PK sides are supported (the capture and EXISTS carry one column per side per PK column); a RETURNING update requires each side to have a primary key (a keyless side is rejected with `unsupported-join`). The same capture also drives a both-sides update's per-side base ops, so a both-sides update *with* RETURNING materializes it exactly once.

An update that changes a **base PK** or the **join-key / FK** column determining which rows join breaks the captured identity, so such a matched row drops from RETURNING (these columns are generally not writable through the supported view shapes); the single-source path has no such limitation (it reads NEW/OLD). RETURNING on an **existence-flag write** (`set hasB = …`) stays rejected with `returning-through-view`: `set hasB = false` deletes the matched non-preserved partition, leaving the captured (non-null) non-preserved PK pointing at a now-null-extended row that neither disjunction branch recovers — genuinely unrecoverable by captured identity. Multi-source (join) **insert** RETURNING — which would need the minted shared surrogate threaded into the projection — and RETURNING through a decomposition-backed logical table are likewise not yet supported (rejected with `returning-through-view`).

## Mutation Context

The `with context` envelope (see [Sequential ID Generation](architecture.md#sequential-id-generation)) wraps the entire view-mediated mutation. It is also the mechanism by which **generated values enter at the propagation boundary while DML stays deterministic**.

Determinism in Quereus means a statement's effect is a pure function of database state and *captured context* — non-deterministic inputs are not forbidden; they are captured once at the envelope, recorded, and replayed identically. A view-mediated mutation frequently needs a value present at neither the user-visible relation nor the inserted row: a surrogate key that several base tables share, a sequence value, a creation timestamp. Such a value is supplied by a **generated default** on the base column (a sequence, a surrogate allocator, a clock read), evaluated through the context envelope and recorded with the statement. The propagation is therefore deterministic-given-context, and the generation is a context concern, identical to how sequential IDs and captured timestamps already work.

Bindings have two cadences:

- **Per-statement** — a captured `now`, a bound parameter. Evaluated once; stable across every row and every base operation the statement emits (transaction-time semantics).
- **Per-row** — a sequence, a surrogate allocator. Evaluated once *per top-level row produced*, so a multi-row insert mints a distinct value per row. The captured context records the per-row values, preserving replay.

### Shared keys are ordinary defaults — the engine chooses no ID policy

A multi-source `insert` (and an n-way lens decomposition insert) needs a shared key that lives in neither the logical row nor any single base table. **The engine does not invent it.** The basis author declares whatever generator they want as the **declared `default` on the anchor's key column**; the engine evaluates that default **once per produced logical row at the envelope** and threads the single value into every member's key column via the **equivalence class** the synthesized (or authored) join establishes (`on k.rid = c.rid` puts the members' key columns in one EC, and the insert-defaulting EC propagation — § [Projection](#projection) step 4 — carries the captured value to every branch). There is one policy: *source the value from the anchor key column's default, then EC-thread it.* A `surrogate` key (distinct from any logical column) is sourced this way; a `logical-tuple` key (the key IS a supplied logical column) threads the supplied value with no default; and a `not null` key with neither a default nor a supplied value raises the ordinary `no-default` diagnostic.

The envelope is realized as a **materialized augmented source**: it holds the per-row supplied view columns, drains them once into an array, appends the **default-evaluated** key per row, and stashes the rows in the runtime context; each base op reads them back through an envelope-scan leaf (the recursive-CTE working-table pattern), so every branch observes the identical row — there is no "which branch generates first" question. Because the materialization happens **before any base write**, a `max()` subquery inside the default observes the **pre-mutation** state for every row; the per-row ordinal (below) is what distinguishes the rows of a multi-row insert. Multi-source `update` / `delete` do not need the envelope — they address existing rows by a subquery over the join, not by sourcing a shared key.

**The `mutation_ordinal()` context primitive.** `mutation_ordinal()` is a nullary, **deterministic** builtin returning the 1-based ordinal of the row being produced within the current statement. It is the column-`default`-position analogue of `row_number()` (§ [Sequential ID Generation](architecture.md#sequential-id-generation)), reaching where a window function cannot — inside a column default. It is valid only during INSERT-default / mutation-context evaluation and errors elsewhere. Being deterministic, a default that uses only it plus deterministic state passes the schema-determinism gate with no `nondeterministic_schema` opt-out. The envelope sets it per row before evaluating the anchor default; it is equally reachable from an ordinary single-source insert's column default.

Bindings have two cadences (a general mutation-context property, independent of the shared-key mechanism):

- **Per-statement** — a captured `now`, a bound parameter. Evaluated once; stable across every row and every base operation the statement emits (transaction-time semantics).
- **Per-row** — the anchor-default shared key, a per-row allocator. Evaluated once *per top-level row produced*, so a multi-row insert produces a distinct value per row.

> **Intentional behavior change.** A surrogate decomposition previously worked with **zero configuration** — the engine fabricated integer keys (`seed + ordinal`, `seed = max(anchor.key)`). It no longer does: the basis author **must declare a `default`** on the anchor's surrogate key column (or expose the key as a supplied logical column). This is the point — the engine stops choosing an ID policy it has no business choosing. The **migration recipe** that reconstructs the old monotonic-integer behavior as ordinary SQL is `default (coalesce((select max(<key>) from <anchor>), 0) + mutation_ordinal())`.

**Worked example.** A logical `User(name, email)` is decomposed over two base relations that share a surrogate `rid`. The surrogate has nowhere to come from in the logical row, so the **anchor declares its default**; the second relation inherits the value through the join-key equivalence class:

```sql
-- basis: two relations sharing a surrogate `rid`; the anchor declares its allocator
create table u_core    (rid int primary key
                          default (coalesce((select max(rid) from u_core), 0) + mutation_ordinal()),
                        name text) using mem();
create table u_contact (rid int primary key, email text) using mem();

-- the lens get
create view User as
  select c.name, k.email
  from u_core c
  join u_contact k on k.rid = c.rid;
```

Now a two-row insert through the lens:

```sql
insert into User (name, email)
  values ('Ada', 'ada@x.io'), ('Lin', 'lin@x.io');
```

Propagation, per top-level row:

1. The envelope evaluates `u_core`'s `default` once per produced row, *before* any base write. `max(rid)` observes the pre-mutation state (0 for an empty table), and `mutation_ordinal()` is `1` for Ada, `2` for Lin — so `rid = 1`, then `2`.
2. The join predicate `k.rid = c.rid` puts `u_core.rid` and `u_contact.rid` in one equivalence class, so the captured `rid` is the value used for *both* base inserts of that row. The default fires once per row, not once per member.
3. The emitted base operations are therefore `u_core(rid=1, name='Ada')` + `u_contact(rid=1, email='ada@x.io')`, then the `2` pair for Lin.

A non-deterministic allocator (`uuid7()`, a clock read) works identically under `pragma nondeterministic_schema`: the default is evaluated **once per row at the envelope** and the single captured value threads to every member, so the members never disagree on the key — the load-bearing evaluate-once-and-thread guarantee, the same way captured timestamps replay. Had the example also carried `created int default now_ms()` with a per-statement binding, that value would stamp the same on both rows, whereas `rid` differs per row. Context bindings evaluate per their cadence and are reused across every per-base operation that consumes them.

### A default may read the in-flight row via `new.<col>` — minting vs. resolving a key

A column `default` can read the **other supplied values of the same row** through `new.<col>`. Only INSERT-supplied (or already-defaulted) siblings are visible — an omitted column raises a resolution error rather than reading a not-yet-evaluated default, so there is no evaluation-order race. The `new.`-qualified form is always available; the bare form resolves too unless a same-named mutation-context variable shadows it. On the single-source insert path this is the same row scope `mutation_ordinal()` participates in, surfaced as ordinary column references at plan-build time (no runtime-context plumbing).

The **anchor key default at the shared-key envelope** reads `new.<col>` too — e.g. `default (coalesce((select max(rid) from anchor), 0) + new.seq)` derives the minted shared key from a supplied view column. Because the key default is evaluated standalone per row (not as part of a row-producing projection), its `new.<col>` refs are bound to fresh attributes and resolved through a per-row **row slot** the envelope emitter installs over each source row — *before* the `__shared_key` is appended — for the duration of that row's evaluation.

A **member insert** of the decomposition / multi-source fan-out reaches the same `new.<col>` context — and crucially the **produced *logical* row's** context, not just the member's own supplied columns. Each member insert is re-planned through the ordinary base-table builder, and the fan-out threads the produced row's NEW context (every supplied logical column registered as `new.<col>` over the shared envelope attributes) as the **parent** of that member insert's default-build scope. So a member's column default can correlate on a sibling logical column the member's own base table does not carry — the key case being an **anchor key column whose surrogate default resolves a parent from an inserted FK** (`default (select … where parent.key = new.<fk>)`, where `<fk>` lives on a *different* member). This covers both default sites of the member insert: the row-expansion default (omitted columns) and the NOT NULL / `or replace` substitution default (which is built unconditionally for every NOT NULL column with a declared default). The envelope attributes stay resolvable through the whole member-insert pipeline because the narrowing envelope projection keeps its source row bound while downstream rows are produced. The member's own supplied columns (and any mutation context) shadow the threaded names, so a name the member carries itself still wins. One mechanism, three sites (single-source insert, envelope anchor key, envelope member); the member site now resolves against the produced logical row, not only the member's slice of it.

The two flavours of generated key follow directly:

- **Minting** a fresh surrogate — the `max() + mutation_ordinal()` recipe above; the default ignores the row's values.
- **Resolving** an existing key — the default reads `new.<col>` to look an existing parent row up. This is the natural shape for a **PK-is-FK extension table** (or lens basis relation) whose surrogate *adopts the parent's* rather than minting its own:

```sql
-- parent identity table
create table h0_users_id (rowId int primary key, value int) using mem();

-- extension relation: its rowId resolves the parent's via the supplied `value`
create table h2_uprof (
  rowId int primary key
          default (select rowId from h0_users_id h0 where h0.value = new.value),
  value int
) using mem();

insert into h2_uprof (value) values (200);   -- rowId is resolved to the matching parent row
```

The default's correlated subquery reads `new.value` (the row's supplied value), so `h2_uprof.rowId` adopts the parent `h0_users_id.rowId` whose `value` matches. Such a default is deterministic *given install state* — it resolves an existing row and introduces no nondeterminism beyond the basis read it already performs, so it needs no `nondeterministic_schema` opt-out.

The same resolving default works as a **decomposition anchor key** through a lens logical-view insert: the anchor holds only the surrogate, its `default (select rowId from h0_users_id h0 where h0.value = new.value)` resolves the parent per produced row, and the resolved surrogate EC-threads into every member — even though the correlated `new.value` is a logical column carried by a *different* member than the anchor (it reaches the anchor key default through the produced-row NEW context the fan-out threads).

## Diagnostics

When propagation cannot proceed, the engine raises a `QuereusError` whose `details.mutationDiagnostic` is a structured record:

```typescript
interface MutationDiagnostic {
  reason:
    | 'no-inverse'                      // scalar function with kind: 'opaque' on update path
    | 'unknown-view-column'             // a top-level where/set/returning ref names something that is not a column of the view (the encapsulation-scope guard)
    | 'no-default'                      // not-null column with no recoverable value on insert
    | 'recursive-cte'                   // recursive CTE in mutation target
    | 'aggregate-target'                // aggregate-shaped column written
    | 'null-extended-create-conflict'   // outer-join insert supplies only non-preserved columns (no preserved anchor), OR a non-preserved-side update's null-extended materialization insert leaves a not-null-without-default base column unset
    | 'unsupported-outer-join-update'    // update of a non-preserved outer-join column with no preserved anchor to key the materialization (a FULL outer join, or a non-preserved side related to no preserved side by an equi-join key) — the LEFT-anchored case is shipped
    | 'default-target-not-found'        // a `with defaults (col = expr, …)` entry names a column that is neither a view nor a base column
    | 'mutual-fk-restrict-delete'       // two-side join DELETE fan-out over a mutual FK whose ON DELETE actions no side order can satisfy under immediate enforcement
    | 'conflicting-assignment'          // two SET targets lower to the same base column
    | 'predicate-contradiction';        // statement's predicate is unsatisfiable
  planNodeId: number;
  column?: string;
  table?: string;
  suggestion?: string;
}
```

An UPDATE that assigns the same base column twice — directly (`update t set b = 1, b = 2`), or via two view columns that lower to one base column (`update v set b = 5, bp = 100` over `select id, b, b + 1 as bp`) — is rejected **unconditionally**: there is no value-agreement softening (`set b = 5, b2 = 5` still rejects), since value equality of arbitrary expressions is undecidable. Enforcement is layered. The base UPDATE builder is the authoritative backstop: every lowered statement (direct base UPDATE, the single-source lowering, and each multi-source per-side / decomposition per-member lowering) is re-planned through it, and it rejects a repeated SET target with a generic `duplicate assignment to column '<col>'`. On top of that, the single-source and decomposition spines detect the collision *during lowering* and raise `conflicting-assignment` naming **both** colliding view columns — a friendlier message. The multi-source join spine relies on the base backstop (it sees only base names anyway).

The INSERT family is guarded by the same reject-unconditionally rule, also layered. An `on conflict do update set b = 1, b = 2` is caught by a name-based `seenTargets` set in upsert-clause building (this path never routes through the base UPDATE builder, so it carries its own backstop). An explicit duplicate INSERT column list (`insert into t (a, a) …`) is caught up front in `buildInsertStmt`. That same column-list guard is the single authoritative backstop for the INSERT analogue of the multi-source collision: every view INSERT spine (single-source, multi-source join, decomposition) re-plans through `buildInsertStmt` with an explicit base-column list, so two view columns that lower to one base column land a duplicate there and are rejected — naming the **base** column.

Diagnostics include a suggestion when one applies — for instance, a missing shared-key default includes a `DEFAULT`-declaration recipe ready to copy. `query_plan().properties` includes the per-column `updateLineage` summary so the user can inspect propagation behavior without issuing a mutation.

## Information Schema Surface

The SQL-standard intent is `information_schema.views`. Quereus has no `information_schema` namespace and no registered `sqlite_schema` — every introspection surface is a **table-valued function** (`schema()`, `table_info(name)`, `foreign_key_info(name)`, …). The engine-idiomatic realization of `information_schema.views` is therefore a TVF in that same family:

```sql
view_info()          -- one row per plain (non-materialized) view, all schemas
view_info('my_view') -- the single matching view (optional name filter)
```

Each row exposes the per-view propagation summary (`'YES'` / `'NO'` text to match the SQL-standard convention):

| Column | Meaning |
|---|---|
| `schema` | schema name (`main`, `temp`, …). |
| `name` | view name. |
| `is_insertable_into` | `'YES'` if every `not null`-without-declared-default, non-generated base column of every reachable base has a recoverable value — projected, or a recoverable default (constant-FD selection pin / declared base default / view-declared insert default). |
| `is_updatable` | `'YES'` if at least one output column has `base` lineage. Per-column updateability is exposed by the companion `column_info(name)` TVF. |
| `is_deletable` | `'YES'` if the row-identifying predicate is constructible at every base reachable from the view — operationally, every reachable base's PK columns are exposed through `base` lineage. |
| `effective_targets` | JSON array of base-table names that mutations through the view may touch by default (`'[]'` when none). |

**Static derivation, not a dry run.** Every column is derived statically from the planned view body's backward `updateLineage` / `attributeDefaults` plus the base-table not-null/default/generated flags — `view_info()` never executes a probe mutation. The body is planned *logically* (preserving the Project/Filter/Join/TableReference operator tree that threads `updateLineage`), the same way the view-mutation substrate plans it, so `effective_targets` agrees with the base set `propagate()` reaches. The substrate's dynamic `propagate()` is the authoritative check; the static surface is the conservative reading — a body whose lineage is not yet threaded (VALUES / aggregate / set-op / recursive-CTE / wholly-computed) yields the conservative all-`NO` / `'[]'` row, never an error — and gains accuracy as later phases thread more lineage, with no rework here.

**Outer-join contract.** A decomposable equi-join body — `inner` / `left` / `right` / `full`, the shape `propagate()` decomposes (`isDecomposableJoinBody`, the boolean shadow of `collectJoinSources`; composite-PK sides and self-joins included) — is read **per-side** from each column's `null-extended` lineage plus a preserved-anchor check, *not* gated wholesale. A **LEFT or RIGHT** outer join is partially writable: every preserved-side base column is `is_updatable = 'YES'`, and a non-preserved (null-extended) column is `'YES'` too — a preserved anchor pins each row's identity for the matched-update / null-extended-insert materialization — so the view is `is_insertable_into` / `is_deletable`. A **FULL** outer join has no preserved side (every row is null-extended on some side), so there is no anchor to key a materialization off: it self-conservatizes to the all-`NO` / `'[]'` row, as does a LEFT/RIGHT body that projects away its entire preserved side. A non-decomposable shape (cross / comma / subquery- or function-source join, or a non-join body) likewise reports the conservative row. `propagate()` is the authoritative dynamic check and the static surface agrees with it per-side (reporting `'YES'` where a write is accepted, `'NO'` where it rejects). (Insert-default recovery is honored from a view's own `with defaults (…)` clause.)

Materialized views are **not** enumerated: a maintained table lists as a *table* in `schema()` (one catalog name, one `TableSchema`), so `view_info()` — walking `getAllViews()` — stays plain-view-only. Its per-column write-through lineage surfaces through `column_info(name)` instead (below), which walks the derivation body with the same classification, so the two functions tell one consistent story.

### Per-column updateability — `column_info(name)`

`information_schema.columns.is_updatable` — per-column updateability for every view, base table, *and* maintained table (materialized view) — is the engine-idiomatic companion to `view_info()`: `view_info : schema()` :: `column_info : table_info`. It takes a **required** target (a base-table or view name) and emits one row per output column:

```sql
column_info('my_table')  -- one row per base-table column
column_info('my_view')   -- one row per view output column
column_info('my_mv')     -- one row per maintained-table column (derivation-body lineage)
```

| Column | Meaning |
|---|---|
| `schema` | schema name the object resolved in. |
| `name` | the table / view name. |
| `cid` | column ordinal (0-based). Base table: column index. View: output-attribute index. |
| `column_name` | the column's output name (the view's alias spelling for a renamed column). |
| `is_updatable` | `'YES'` if a write to this column propagates to a base column (a `base` `UpdateSite`); `'NO'` if read-only (computed / generated / un-threaded lineage). |
| `base_table` | owning base-table name for an updatable column; `null` for a read-only column. |
| `base_column` | owning base-column name for an updatable column; `null` for a read-only column. |

**Static derivation.** For a **base table**, a column is updatable iff it is not `generated` — `base_table`/`base_column` are the column itself. For a **view**, the body is planned *logically* (the same path as `view_info()`) and each output attribute's backward `updateLineage` site is read: a plain `base` site resolving to its producing `TableReferenceNode` is `'YES'` with its base trace; everything else (`computed`, un-threaded, or a site that fails to resolve) is `'NO'` with `null` trace. Every `is_updatable='NO'` row carries `null` `base_table`/`base_column`.

`column_info` shares `view_info`'s gates and reads the same per-column `null-extended` lineage: a non-decomposable join shape — cross / comma (implicit) / subquery- or function-source — short-circuits to all-`NO`/`null` via a non-throwing AST shape check (`isDecomposableJoinBody`, the boolean shadow of `collectJoinSources`), while a decomposable `inner` / `left` / `right` / `full` equi-join (n-way `≥ 2`, composite-PK sides and self-joins included) reports per-side. For a LEFT/RIGHT outer join both the preserved and the non-preserved columns are `'YES'` (the preserved anchor pins identity for the materialization); a FULL join, having no preserved anchor, self-conservatizes to all-`NO`. The two surfaces agree with each other and with the dynamic truth. The `'YES'`/`'NO'` text encoding matches `information_schema.columns.is_updatable` — deliberately **not** `table_info`'s integer `0`/`1`.

A **materialized view** — a maintained table, i.e. a `TableSchema` carrying a `TableDerivation` (detected structurally, never by name pattern) — resolves through the base-table lookup but is *not* reported as plain writable base columns: write-through inherits these view-updateability rules, so `column_info` walks its **derivation body** through the same lineage classification as a plain view. Passthrough/rename columns report `'YES'` tracing to their *source* base column, invertible expressions report `'YES'` through the inverse, and non-invertible expression columns report `'NO'`/`null` ([Materialized Views § Write boundary](materialized-views.md#write-boundary-write-through)). The table's registered columns supply the authoritative output names; a derivation body that fails to plan (e.g. stale source) degrades to conservative all-`'NO'` rows over the registered columns. A dedicated TVF rather than a `table_info` extension keeps base-table introspection decoupled from view-body planning: `table_info` resolves base tables only and carries per-column metadata a view has none of, whereas `column_info` resolves either kind uniformly and emits only the column-granular updateability facts.

## Round-Trip Laws and the Derived Backward Walk

The forward relational direction is computed once, structurally: each operator's `computePhysical` derives its output `PhysicalProperties.fds` (key / FD / equivalence-class / domain) from its children, and the **Key Soundness** property harness (`test/property.spec.ts`) materializes rows and asserts the claimed `keysOf` / `isSet` never over-claim. That harness is the structural net that keeps the forward walk honest.

The **backward** direction — given a mutation against a relation, which base operations realize it — must be kept in lock-step with the forward direction, or an operator could advertise a key forward while its `put` / lineage rule silently disagrees about which base column that key threads to, with no test red. This is the discipline that prevents that divergence (Bohannon, Pierce & Vaughan 2006, *Relational Lenses*; Voigtländer, *bidirectionalization for free*).

### The backward walk is a derived dual, not a parallel hand-walk

There is **one** FD/EC/domain annotation per node — the `PhysicalProperties.fds` the forward `computePhysical` already produces. Each operator's backward method **reads that annotation**; it does not re-derive or hand-duplicate its own:

- **Project** inverts exactly the scalar transforms `scalar-invertibility.ts` classifies (`passthrough` / `inverse` / `opaque`), and threads keys along exactly the FDs `computePhysical` emitted; a non-invertible output is marked `computed`.
- **Filter (σ)** routes constant-FD defaults from the same `∅ → c = v` guarded FDs the forward Filter produced.
- **Join** composes per-source lineage along the join FDs the forward pass computed.

This is the Bohannon–Pierce–Vaughan move adapted to Quereus's FD-annotated operators: the operator's FD/predicate *type* determines **both** directions, so the directions cannot silently disagree once the round-trip law (below) is green.

**North-star.** Auto-deriving `put` from `get` (Voigtländer-style bidirectionalization) is the committed direction. Each backward method is hand-written today but **authored as a get→put derivation from the shared forward annotation** — shaped so the eventual mechanical auto-deriver is a refactor behind the same law, never an unwind of a parallel hand-walk. The auto-deriver is deferred only until the operator set stabilizes (general bodies, lateral-TVF, multi-source decomposition are still in-flight). The load-bearing invariant: **no operator may introduce a backward rule that auto-derivation could not later reproduce.**

### The three round-trip laws

A per-operator round-trip property block (`test/property.spec.ts` § View Round-Trip Laws), sibling to Key Soundness, forces the backward walk to agree with the forward walk over the writable fragment. For a randomly-seeded small base table and a spread of view bodies:

- **PutGet (write-then-read).** Apply a generated mutation through the view, read the view back, and assert the read reflects exactly the mutation's effect on the writable columns — no rows appear/disappear outside the view predicate, computed columns are untouched (a write to one is rejected with `no-inverse`, not silently dropped), and a key the forward walk claims on the view output is the same tuple the backward walk used to bind the base row. This is the law that turns `LIMIT`/`OFFSET`/`DISTINCT` write-widening and the alias-qualifier leak into *property* failures.
- **GetPut (read-then-write-back).** Read a row through the view, write the same values back via an update keyed on the view's identifying predicate, assert the base table diff is empty.
- **Forward/backward lineage agreement (the structural crux).** Plan the body; for each output column cross-check the backward lineage against the forward FD facts (`keysOf` / `fds`): every `base`-writable column has a forward FD path to that base column, and every key the forward walk advertises is reconstructible by the backward identifying predicate. A disagreement reds the test.

The law is the **acceptance gate** for the derived backward walk: a new operator's backward method is not "done" until PutGet / GetPut / lineage-agreement are green over a planned tree that surfaces it. The harness covers three families, each with a pure law core plus a negative self-test that proves the core reds on an injected violation:

- **Single-source projection-and-filter** — the view-body zoo (bare `select *`, explicit / rename projection, computed column, equality-filter, alias-qualified body). `LIMIT`/`OFFSET`/`DISTINCT` bodies are asserted to *reject* (never silently widen).
- **Multi-source key-preserving inner join** — update touching either side or **both** (the both-sides identity-capture path), a **cross-source `set`** (a value reading a partner-side `base` column, captured into `__vmupd_keys` under a `srcN` alias — including the both-sides-precedence case where the read value is the pre-mutation partner value), delete (FK-child default + an explicit parent-side route via an outer-join existence column, `set hasP = false`), and insert with the shared key both **minted** and **directly supplied**; plus the n-way generalization — **composite-PK** inner joins, **≥3-table** inner joins, and **self-joins** (alias-keyed routing, serialized in alias-declaration order) all round-trip. Still-undecomposable shapes (outer-join body, `select *`, composite shared-key insert, a cross-source `set` reading a *computed* partner column or through an *outer* join) are asserted to *reject*.
- **n-way decomposition fan-out** — driven by `quereus.lens.decomp.*` tags: a columnar split with an optional (outer-joined) member, an EAV pivot member, and a surrogate split; INSERT (anchor-first, per-row optional gate, EAV triples, surrogate minted once and threaded into every member), UPDATE routed to the backing member — including the **optional-member / EAV value-write materialization** (a constant value: matched UPDATE / `on conflict do nothing` materialize INSERT / all-null DELETE; an **anchor-resolvable** value: one `on conflict do update set col = excluded.col` upsert; a **member self-reference**: matched UPDATE for present rows + a null-substituted, runtime-non-empty-filtered materialize INSERT for absent rows; an **arbitrary** value — subquery / cross-member / mixed anchor+self, columnar or EAV (an EAV self-reference lowers to a subquery) — via the **single-identity (anchor-key) per-row capture**: materialized once over the planned body into `__vmupd_keys`, read back by the member key (columnar) / entity column (EAV) in the matched UPDATE and the anchor key in a runtime-non-null-filtered materialize INSERT, pre-mutation so a both-sides `set c = b + 1, b = b + 100` reads the pre-mutation `b`), anchor-last DELETE. Deferred shapes (shared-key identity write, non-anchor predicate, composite key) are asserted to *reject*.

### The predicate-honest complement

The fan-out philosophy makes the **complement** — what a write holds fixed, i.e. what the view does *not* expose — *determined*, not chosen (the Bancilhon–Spyratos ambiguity does not arise), so it is a first-class derived object. For the single-source projection-and-filter case the complement is the **projected-away base columns** (present in the base, absent from the view image) plus the **negation-free residual of the view predicate** (the σ conjuncts that constrain base rows the view never surfaces), expressed in the same FD/predicate vocabulary as the forward walk. With the complement in hand the lens prover's round-trip check becomes **computed**, not an enumerated checklist: **GetPut** holds iff `put` leaves the complement fixed, and **PutGet** holds iff `get ∘ put` reproduces the written view image. The annotation layer exposes this object (`viewComplement(node)` / `complementOf` in `analysis/view-complement.ts`); the lens prover (`analyzeRoundTrip` / `emitRoundTrip` in `schema/lens-prover.ts`) is a **live consumer** — at deploy it computes the per-column GetPut/PutGet verdict off the complement and reds `lens.non-invertible` for a writable-presented column whose round-trip it cannot prove faithful (firing only for writable columns; computed columns stay read-only), degrading to the safe verdict outside the single-source fragment ([lens § Round-trip detection](lens.md#coverage-checklist)). The scope is the single-source-fragment the complement covers; the same `resolveBaseSite`-expressed checks generalize to the join/decomposition fragment once the complement is defined there.

## Implementation Map

No new subsystem is introduced — view updateability is the existing FD / EC / predicate-normalization infrastructure consulted in the mutation direction: lineage parallels FDs, propagation parallels emission, view metadata parallels table metadata. The principal source files:

| Concern | Location |
|---|---|
| `updateLineage` / `attributeDefaults` on `PhysicalProperties`; threaded as `computePhysical` overrides on TableReference / Project / Filter / Join, passed through access / Retrieve / Alias boundary nodes | `src/planner/nodes/plan-node.ts` |
| Backward-walk helpers (`deriveProjectUpdateLineage` / `deriveFilterAttributeDefaults` / `deriveJoinUpdateLineage`), the AST-level `deriveViewColumns`, the shared n-way per-site reader `resolveBaseSite` | `src/planner/analysis/update-lineage.ts` |
| Authored-inverse (`with inverse`) build-time validation (`validateAuthoredInverses`) + the validated `new.*` index reader the lowering spines share | `src/planner/analysis/authored-inverse.ts` |
| Law-gated `InvertibilityProfile` registry (`classifyInvertibility`) + recursive inverse-chain composer (`traceInvertibleColumn`) | `src/planner/analysis/scalar-invertibility.ts` |
| Predicate-honest complement (`viewComplement` / `complementOf`) | `src/planner/analysis/view-complement.ts` |
| Single propagation entry (`propagate`, `classifyViewBody`) routing single-source / multi-source / decomposition | `src/planner/mutation/propagate.ts` |
| The one scope-aware column-substitution primitive all backward callers share (`transformExpr`, `collectFromColumnNames`, `transformScopedExpr` / `transformScopedQuery` via a `ScopeContext`) | `src/planner/mutation/scope-transform.ts` |
| Single-source projection-and-filter rewrite (`rewriteViewInsert/Update/Delete`, `analyzeView`) | `src/planner/mutation/single-source.ts` |
| Shared plan-node backward-walk consumer (`analyzeBodyLineage`) — plans a body once, reads `updateLineage` into column→base routing | `src/planner/mutation/backward-body.ts` |
| Two-table inner-join decomposition (`analyzeJoinView`, `decomposeUpdate`/`decomposeDelete`, `buildMultiSourceKeyCapture`, `analyzeMultiSourceInsert`) | `src/planner/mutation/multi-source.ts` |
| n-way decomposition put fan-out (DELETE/UPDATE/INSERT) | `src/planner/mutation/decomposition.ts` |
| Shared-surrogate envelope scan leaf | `src/planner/nodes/envelope-scan-node.ts`, `src/runtime/emit/envelope-scan.ts` |
| `mutation_ordinal()` per-row context primitive (the surrogate-default building block) | `src/func/builtins/mutation.ts` (read off `RuntimeContext.mutationOrdinal`, set by the insert executor + envelope) |
| `ViewMutationNode` wrapper + builder (`buildViewMutation`, `buildMultiSourceInsert`, `buildMultiSourceReturning`) | `src/planner/nodes/view-mutation-node.ts`, `src/planner/building/view-mutation-builder.ts` |
| Base-op issue order + envelope materialization + RETURNING surfacing | `src/runtime/emit/view-mutation.ts` |
| `InvertibilityProfile` type, built-in registry, UDF hook | `src/func/invertibility.ts` |
| `ViewSchema.effectiveTargets` / `defaultsForColumn` (populated at view creation) | `src/schema/view.ts` |
| `view_info()` and `column_info(name)` TVFs | `src/func/builtins/schema.ts` |

## Background

Quereus's view updateability draws on the following bodies of work:

- **Bancilhon, F., & Spyratos, N. (1981). "Update Semantics of Relational Views."** Established the constant-complement framework. Quereus sidesteps the ambiguity by adopting predicate-honest fan-out: rather than choosing one of several legal complements, Quereus applies every consistent base operation.
- **Date, C. J., & Darwen, H. (2006). "Databases, Types, and the Relational Model: The Third Manifesto."** The principle that any relation expression should be a first-class mutation target underpins the unification of views, CTEs, and subqueries-in-`from` as the same propagation surface.
- **Keller, A. M. (1985). "Algorithms for Translating View Updates to Database Updates for Views Involving Selections, Projections, and Joins."** Source of the per-operator decomposition strategies, adapted here to use functional dependencies rather than per-view annotation.
- **Bohannon, A., Pierce, B. C., & Vaughan, J. A. (2006). "Relational Lenses: A Language for Updatable Views."** Types `select` / `project` / `join` lenses with FD-and-predicate annotations and proves GetPut / PutGet *compositionally, per operator*. Directly on point for Quereus's FD-annotated operators, and the basis for the discipline in § Round-Trip Laws: the backward (`put`) direction is a *derived, law-checked* dual of each operator's forward FD walk, never a parallel hand-maintained walk. See also Foster et al. (2007) in [the lens layer's background](lens.md#background).
- **Voigtländer, J. (2009). "Bidirectionalization for Free!"** Source of the committed north-star: mechanically deriving `put` from `get`. Quereus authors every operator's backward method as a get→put derivation now, so the eventual mechanical derivation is a refactor behind the same round-trip law.
- **Dataphor (Alphora, D4 language).** The closest commercial precedent. Quereus borrows the per-view default-annotation idea (realized first-class as the `with defaults` clause) and the view-as-first-class-target stance; it extends the model with FD- and EC-driven default recovery, eliminating most cases where a Dataphor user would have annotated.
- **Litak, T., & Mikulás, S. (2012). "Relational Lattices."** Algebraic framework over the relational lattice. Quereus's propagation rules read as the lattice-dual of the optimizer's query-rewriting rules.
- **Hegner, S. (2004). "An Order-Based Theory of Updates for Closed Database Views."** Influential on the outer-join materialization semantics.

## Departures from SQL Standard

| Standard Feature | Quereus | Rationale |
|---|---|---|
| `with check option` | Not supported. | Replaced by `create assertion`, which composes across views and runs incrementally. |
| `with read only` | Not supported. | Inferred per-column from lineage; no view-level read-only flag. |
| Updateable-view restrictions (key-preserved tables, etc.) | Not enforced as a separate ruleset. | The FD framework subsumes these — views are updateable iff FD-driven propagation succeeds. |
| `instead of` triggers | Not supported (no trigger system). | Tags provide the override surface; predicate-driven dispatch handles the cases that motivate `instead of`. |
| Per-dialect updateability rules (Oracle key-preserved, PostgreSQL simple views, SQL Server schema-bound) | A single uniform rule. | Reduces the user's mental model to "predicates rule, FDs trace lineage". |

## Current limitations

The following shapes are rejected at plan time with a structured diagnostic; they are not yet wired into the propagation substrate:

- **Non-preserved-side outer-join update** — **now shipped for LEFT joins**: an UPDATE of a non-preserved column splits per row into a matched UPDATE + a null-extended-materialization INSERT, both riding the pre-mutation `__vmupd_keys` capture (see [Outer Joins](#outer-joins)). Still deferred: a non-preserved-**only** insert (`null-extended-create-conflict`); a non-preserved update through a **full outer join**, whose every-side-null-extended shape has no preserved anchor to key the materialization (`unsupported-outer-join-update`, surfaces report it conservative); a **composite** non-preserved join key, which the single-column materialization insert cannot re-join (`unsupported-outer-join-update`); **RETURNING** through a non-preserved-side update, which the captured-identity re-query cannot recover for a materialized null-extended row (`returning-through-view`, owned by `view-write-outer-join-nonpreserved-returning`). **RIGHT joins are now write-through-able** — the exact per-side mirror of LEFT (`view-write-right-join-readmit`), admitted into recognition and reported per-side by the static surfaces; only **FULL** stays conservative (no preserved anchor, as noted above for the full-outer non-preserved update).
- **Cross-source `set` values** — an inner-join `update` value that reads a partner-side **`base`** column (`update v set a.x = b.y`, or a scalar expression whose cross-source leaves are all `base`) is **now supported**: the read column rides the `__vmupd_keys` capture under a `srcN` alias and the reference is rewritten to a correlated read keyed by the owning side's PK (the pre-mutation partner value — robust to a both-sides update that also rewrites it). Still rejected: a cross-source value whose **assigned side joins more than one partner row** — the 1:many direction, where the join does not pin a unique key of the partner table (`cross-source-ambiguous-cardinality`, a plan-time reject naming the ambiguity rather than the runtime `Scalar subquery returned more than one row`; multi-hop owner↔partner is conservatively included); a cross-source value reading a **`computed`** (non-base) partner column (`no-inverse`); a cross-source `set` through an **outer** join that reads a non-preserved (null-extended) partner column (`no-inverse` — the partner value is not recoverable from a captured base column); and a cross-source (cross-member) `set` in the **decomposition** fan-out (`cross-source-assignment` — its single-member-table SET cannot express the partner read).
- **Composite shared-key `insert`** — the shared-surrogate envelope threads a single-column key, so an n-way insert whose shared join key spans multiple columns on a side is deferred (`unsupported-decomposition-key`). Composite-PK *identification* (the update/delete capture path) is supported; only the insert envelope's shared key stays single-column.
- **Multi-parent shared-key outer `insert`** — a single shared-key column that references **more than one** presence-gated (optional, outer-joined) parent (`cc.pr references p1(pp) references p2(qq)`, both LEFT-joined and supplied) is deferred (`unsupported-decomposition-key`, detected statically as `keyGate.groups.length >= 2`). One key value cannot satisfy two FK constraints for a partial-supply row — the AND-gate would null the whole key, silently losing the supplied value and orphaning the present parent — so the shape is rejected rather than threaded as a broken AND-gated key (`view-write-outer-insert-shared-key-multi-parent-orphan`). The n-way generalization (per-parent key columns) is future work.
- **Multi-source (join) `insert` RETURNING** — needs the shared key threaded into the RETURNING projection; rejected with `returning-through-view`. RETURNING through a decomposition-backed logical table is likewise rejected.
- **Authored-inverse (`with inverse`) routing gaps** — a multi-source (join) **insert** through an authored column is deferred (the shared-surrogate envelope projects supplied columns verbatim per side; per-row put evaluation over it is a follow-up — `no-inverse`, naming the column); a write targeting an authored column of a **decomposition**-backed logical table is deferred (`unsupported-decomposition-member`, naming the member(s) the puts route to); a **single-source insert with a SELECT source** through an authored column is deferred (`unsupported-source` — VALUES required, the same boundary as the appended-defaults rewrite). The single-source UPDATE/INSERT and multi-source UPDATE paths are wired (§ [Authored inverses](#authored-inverses-with-inverse)).
- **Cross-member logical CHECK / FK on a decomposition `update`** — a lens-synthesized row-local CHECK or child-side FK is threaded onto a decomposition UPDATE's member fan-out only when a **single** member op resolves every write-row column it references ([per-op resolvability gate](lens.md#enforcement-by-constraint-class)). A logical CHECK / FK spanning columns on **more than one** member resolves on no single member op and is **deferred** (silently not enforced — a debug `log` traces the drop), matching the decomposition INSERT path, which also defers cross-member row-local / set-level enforcement. A single-member-resolvable CHECK / FK is enforced normally, and a set-level uniqueness CHECK rides only the op that owns the key (a key-unchanged member UPDATE provably cannot create a duplicate, so dropping it there is sound — not a limitation).
- **Aggregate / window write propagation** — read-only at the column level; reserved for the extension that consumes the [incremental-maintenance](incremental-maintenance.md) framework.
- **Recursive CTE bodies** — read-only (`recursive-cte`).
- **Composite shared keys** — the shared-key envelope threads a single-column key; a multi-column surrogate / shared key is deferred (`unsupported-decomposition-key`). (The surrogate's *value source* is now an ordinary column `default`, so non-integer / non-deterministic allocators — `uuid7()`, a custom UDF — are fully supported; only the multi-column shape remains deferred.)
- **Mechanical `put`-from-`get` auto-derivation** — the committed north-star, deferred until the operator set stabilizes; each backward method is hand-written today but shaped to fold into it behind the round-trip laws.
