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

The rules below apply identically to view bodies, CTE bodies, subqueries in `from`, and the inline target of `update (select ...) set ...`.

### Projection

**Updates** pass through unchanged: assignments are rewritten against the underlying columns named by the projection.

**Inserts** must supply values for every base-table column for which the insert's value list does not. Sources are consulted in order:

1. The insert's value list (after applying the inverse of any scalar transformation in the projection).
2. **Constant FD** — a column constrained to a constant by an upstream selection predicate (the relation carries the FD `∅ → c = v`) takes that constant.
3. **FD reconstruction** — a column functionally determined by other surviving / supplied columns is reconstructed symbolically from the FD's right-hand side.
4. **EC propagation** — a column in an equivalence class with a supplied column or a constant takes the EC representative's value.
5. The view's `default_for` tag (expression over surviving columns).
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

A `set` **value** may read a column owned by a *different* side than the column it assigns (`update v set a.x = b.y` — a per-row value sourced from the partner row, which a single-table SET cannot otherwise express). When the read column has `base` lineage, the partner base column is projected into the up-front `__vmupd_keys` capture under a stable `srcN` alias (alongside the per-side PK columns) and the reference is rewritten to a correlated scalar read of it — `set a.x = (select src0 from __vmupd_keys k where k.k<ownerSide>_0 = <a.pk0> …)` — keyed by the *owning* side's PK so each lowered single-table `update a` row reads its joined row's value. Because the capture materializes **before** any base op fires (the same eager key materialization), the read-back is the **pre-mutation** partner value — robust against a both-sides update (`set a.x = b.y, b.y = …`) that also rewrites the read column. A scalar expression over a partner column (`set x = b.y + 1`) is admitted when **every** cross-source leaf has `base` lineage (the leaf is captured; the expression and any owning-site inverse apply on read); a read of a `computed` (non-base) partner column is rejected (`no-inverse`), and a same-side read keeps the ordinary owning-qualifier strip (no capture). Cross-source `set` through an **outer** join is deferred with the outer-join body, and cross-source (cross-member) `set` in the decomposition fan-out stays rejected (`cross-source-assignment`).

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
- *Row is null-extended* (guard fails — the non-preserved side had no matching row): the update is rewritten as an **insert** on the non-preserved side. Values for the join-predicate columns come from the preserved side via EC; values for non-`set` columns come from defaults or `default_for` tags; values for `set` columns come from the user's assignment. If the resulting insert lacks a `not null`-without-default value, the entire propagation fails with a diagnostic.

**Inserts** through an outer-joined view follow the join's structural intent. An insert with values for both sides produces inserts on both sides under the join predicate. An insert with values only for the preserved side produces a single preserved-side insert (the resulting row is null-extended through the view). An insert with values only for the non-preserved side requires the join predicate to be satisfiable against an existing preserved row; otherwise it is rejected.

**Deletes** route to the preserved side by default — this is the only way for the joined row to disappear from the view; deleting from the non-preserved side merely null-extends it, leaving the row visible. Tags override.

`full outer join` is handled as a generalization: every side is both preserved and non-preserved depending on the matched/unmatched status of each row.

> **Shipped (LEFT):** the multi-source substrate admits **LEFT** outer-join bodies and wires preserved-side update passthrough, delete-to-the-preserved-side (an unmatched/null-extended row is deletable too), insert routing (both-side under the minted shared key, preserved-only producing a null-extended row, and a non-preserved side as a presence-gated optional member of the envelope fan-out), **and the non-preserved-side UPDATE** (the per-row matched-update / null-extended-insert materialization — `view-write-optional-member-transitions`). The static `view_info` / `column_info` surfaces report these per-side: every base column — preserved or non-preserved — is `is_updatable = 'YES'` (the non-preserved side is updatable because a preserved anchor pins each row's identity), and the view is `is_insertable_into` / `is_deletable`.
>
> **How the non-preserved-side UPDATE is realized (no new runtime substrate).** Both branches ride the existing up-front `__vmupd_keys` capture, materialized **pre-mutation** over the planned join body (§ Multi-Base-Table Mutations): the capture projects the non-preserved side's PK (null for a null-extended row — the partition discriminator), the EC join key from the preserved side, and the assigned value(s). The **matched** branch is an ordinary per-side UPDATE keyed on that PK (a null captured PK never equals a real one, so a null-extended row is naturally excluded) whose SET reads the captured value back. The **null-extended** branch is a single `insert into <np> (<joinKey>, <set cols…>) select … from __vmupd_keys where <np PK> is null and <joinKey> is not null` — an insert-from-the-captured-partition that sets the non-preserved join column to the captured preserved-side key (so the preserved row joins the freshly materialized row), the `set` columns to their captured values, and everything else to base defaults. A null-extended row whose preserved-side join key is itself **null** has no key to seed a joinable row, so its update is a no-op (the documented boundary). A NOT NULL non-preserved column the create branch cannot supply rejects at plan time with `null-extended-create-conflict`.
>
> **Boundaries (reject at plan time, data-independent).** The materialization insert threads a **single** non-preserved join column, so a **composite** join key (the non-preserved side equated on more than one column) rejects `unsupported-outer-join-update` — the matched branch alone would be expressible, but a single-column insert cannot re-join a null-extended row (the conservative precedent of `null-extended-create-conflict`). **RETURNING** through a non-preserved-side update rejects `returning-through-view`: the post-mutation re-query identifies rows by the captured non-preserved PK, which a freshly materialized null-extended row no longer matches (captured NULL vs the minted key), so it would return a silent partial set — deferred until the re-query keys off the stable preserved-side identity (`view-write-outer-join-nonpreserved-returning`).
>
> **RIGHT / FULL — not yet, gated by the runtime:** the Quereus runtime cannot execute a `right join` or `full join` at all (`runtime/emit/join.ts` throws `RIGHT/FULL JOIN is not supported yet`, pinned by `test/logic/90.5-unsupported-join-types.sqllogic`), so such a view is neither readable nor *writable*. RIGHT is therefore **excluded from write-through recognition** and the static surfaces report it conservative all-`NO` (the preserved/non-preserved classification is the mirror of LEFT and would otherwise advertise it `is_updatable`). FULL self-conservatizes (no preserved anchor — a non-preserved update there rejects `unsupported-outer-join-update`, since no preserved side can key the materialization). Re-admit RIGHT — and, once the runtime supports it, FULL — when `runtime/emit/join.ts` gains those join types.
>
> **Still deferred (LEFT):** a non-preserved-**only** insert (no preserved row to attach to) rejects `null-extended-create-conflict`. (The **decomposition optional-member / EAV UPDATE** dual — null→non-null materializes a component, non-null→all-null deletes it — is the decomposition analogue and is now **shipped** as anchor-keyed base ops in `decomposition.ts`; see [Decomposition fan-out](lens.md#the-default-mapper) § UPDATE. Only a non-constant optional/EAV value and a shared-key identity write stay rejected with `unsupported-decomposition-update`.)

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
component + the join-predicate guard). The flag-bearing `JoinNode` stays the
nested-loop join (the join-physical-selection / merge / fanout / elimination rules
bail on it) so the appended flag column is never dropped by a physical rewrite —
a documented read-half limitation (existence joins forgo hash/merge selection).

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
branch to be retained or probed when no other column needs it. No such pruning pass exists
yet: the membership runner is selected whenever the node carries any flag, so an unused
flag on a `union all` currently forces the buffering runner instead of the streaming one
(correctness is unaffected; a sibling prune to `prune-unused-existence-flag` is deferred).

### Set-operation membership writes

The first set-op view writability in the engine (`planner/mutation/set-op.ts`). A
membership column **is** the branch presence, so *writing* it drives the branch's
existence — the explicit, per-row control surface that replaces the never-built
`quereus.update.*` routing-tag dispatch for set-ops (`union-branch` / `delete_via`,
removed by `remove-update-routing-tag-surface`). Scope is the **binary
(non-nested)** case: `union` / `union all` / `except` / `intersect`. Nested / subtree
flags and product-coordinate addressing are `set-op-membership-nested`.

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

**A branch is itself a view body.** Each operand (`select … from B`) is a single-source
(or, in principle, join) view body, so each per-branch op is lowered to an AST `BaseOp`
against a **synthetic branch view-like** and run back through `propagate` — reusing the
spines verbatim (the branch's own σ predicate, column renames, and base routing are honored
by its own spine; `no-default` / computed-column rejections fall out of the recursion). A
branch that bottoms out in a base table emits one base op; a branch that is itself a
`SetOperationNode` would recurse again (the nested subtree write — `set-op-membership-nested`).

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

**v1 limitations (documented).** Identification is by the full data tuple, so a `union all`
view with **duplicate data tuples** in a branch fans a delete/data-write to *all* copies of
that tuple (the count variant is deferred). A data-fan-out value that *references* a data
column requires the operand legs to use matching column names (a leg rename of a
referenced column is not yet remapped); literal values are unaffected. A branch leg must
be a plain (optionally renamed) base-column projection — a `select *` or computed leg
column in a writable branch is rejected.

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

### Common Table Expressions and Subqueries in `from`

CTE references are inlined; propagation runs on the unfolded plan. Non-recursive CTEs are therefore transparently mutable. Recursive CTEs are read-only and rejected with a `recursive-cte` diagnostic. A subquery in `from` is structurally identical to an inlined CTE; the propagation pass treats them as the same. `update (select ... from t join s on ...) as v set v.col = ...` works without special-casing.

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

**How writability follows from the profile.** The plan-node backward walk resolves every projection to a `base` `UpdateSite` — `identity` / rename (`b as bc`), `passthrough` (an identity-on-value transform: `b collate nocase`, a no-op `cast(b as <same logical type>)`; *no* inverse), or `inverse` (a non-identity invertible transform: `b + 1`; inverse *present*) — else `computed` / `null-extended` (read-only). Both mutation spines route the **full writable-base set** (identity + passthrough + inverse) on the UPDATE write path, applying a site's `inverse` only when present: `set bp = 9` on a `b + 1 as bp` column lowers to `set b = 9 - 1`; `set bc = v` on a `b collate nocase as bc` passthrough column lowers to `set b = v` (no inverse applied). INSERT is **insertable for the inverse-absent subset** — `identity` / rename and `passthrough` store the value verbatim — while `inverse` and `opaque` columns are non-insertable (the lowering writes the value raw, with no hook to apply an inverse). The two spines share an identical insertability gate (`writable && inverse === undefined`). The static `view_info` / `column_info` surfaces read the same plan-node lineage and report a `base` site (identity, passthrough, or inverse) writable, agreeing with the dynamic truth.

## Tags: The Override Surface

Default propagation is deterministic and predicate-honest, and there is exactly **one** override mechanism left in the `quereus.update.*` namespace: `default_for.<column>`, which supplies a *value* for an omitted insert column. **Write routing is no longer a tag.** It is expressed three ways, in order of precedence:

1. **Predicates** rule — narrowing the row-identifying predicate to a single branch/side routes there.
2. **Per-row presence/membership columns** state routing explicitly and writably — the outer-join existence column (`exists … as hasP`, write `false` to delete the matched non-preserved side, `true` to materialize it) and the set-op membership columns (`set inB = false` to drop a branch). These are real, writable view columns, so the routing lives in the data shape and is self-documenting.
3. **Default fan-out** otherwise — every consistent branch/side (the FK-child default resolves a join delete to one side when a foreign key proves it).

The blanket "this view only ever writes relation X" restriction the removed `target` / `exclude` tags expressed is now achieved by **lens shape**: a view that does not project a relation's columns (and does not expose its presence/membership column) has no path to write that relation through the view. There is no replacement tag.

Shape and site validation for the whole `quereus.*` namespace is centralized in the typed registry `packages/quereus/src/schema/reserved-tags.ts` (`validateReservedTags(tags, site)`): each reserved key is matched to a frozen spec, its position checked against the key's legal `TagSite` set, and its value checked against a `TagValueSchema` (`csv-of-identifiers`, an enum, an `expression`, …). An unknown or mis-sited key is a hard **error** — so a stray `quereus.update.target` / `exclude` / `delete_via` / `policy` (the removed routing keys) is now an `unknown-reserved-tag` error at any site — except an empty `quereus.lens.ack` rationale, which is only a **warning**. This registry is the **single shape/site source of truth for every `quereus.*` path** — the lens compiler, the view-mutation override surface, the module advertisement builder, and the declarative-schema differ all validate through it with the identical hard-error-on-unknown severity. The registry itself stays policy-free; the throw-first-error / log-warnings caller policy lives in the shared `raiseReservedTagDiagnostics` helper. The registry validates a tag's shape/site; the `default_for` **semantics** are realized by the view-mutation override surface (collection + merge in `planner/mutation/mutation-tags.ts`, consumption in the single-source / multi-source spines).

Tags are collected at two sites: the view DDL (`ViewSchema.tags`, validated `view-ddl`) and the DML statement (`WITH TAGS (...)` → `stmt.tags`, validated `dml-stmt`); a sited diagnostic is raised before any base op is built.

| Tag | Where | Effect |
|---|---|---|
| `"quereus.update.default_for.<column>"` | view DDL, projection, dml statement | Default expression for `insert` through the view when the column is omitted. The expression may reference any surviving column. A statement-level binding overrides the view-level default for that statement. |

`default_for` is the **only** retained `quereus.update.*` key. A statement-level binding appears in a `with tags (...)` clause on the statement, where a `with context (...)` clause would sit (before `set` / the `values` source / `where`, or trailing):

```sql
insert into v with tags ("quereus.update.default_for.created" = 'epoch_ms(''now'')') values (...);
```

A `default_for` value is a TEXT **expression** (parsed as SQL), so a non-literal must be SQL-quoted as shown. Statement-level tags override view-level tags for the duration of the statement.

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

**Multi-source** inner-join `update` / `delete`. The view row spans both base tables, so it is not recoverable from the per-side base ops. The mechanism is threaded as `ViewMutationNode.returning` with a `returningTiming`:

- **`delete`** (`pre`): the OLD view image restricted to the mutation's predicate, projected as **plan nodes in base terms over the already-planned `JoinNode`** — `π_{<returning, view-spelled, recomputed from base columns>}( σ_{idPredicate}( JoinNode ) )` — captured **before** the base ops fire (the rows still match the predicate and are about to disappear). Recomputing each view-spelled column from its base term (rather than referencing the body root's output attribute id) is what lets a body-computed column (e.g. `c.note || '!' as banner`) survive: project-merge collapses the computed projection's intermediate attribute id, so a by-id reference would dangle.
- **`update`** (`post`, with an `identityCapture`): each affected view row's **base-PK identities** (every side's PK columns, flattened to `k<side>_<j>`) are captured **before** the base ops fire, built as plan nodes over the already-planned join body and materialized into a shared descriptor (the same working-table-in-context plumbing recursive CTEs and the insert envelope reuse). **After** the base ops, the same planned `JoinNode` is re-queried, projecting the view-spelled base-term RETURNING columns restricted to those captured identities by a correlated EXISTS matching every side's PK columns. Because the match is on captured **identity** (not the now-stale user predicate), this is robust against an update that **rewrites a column its own WHERE filters on** — and a row the update pushed out of the view's filter is still returned (matching single-source NEW semantics). Composite-PK sides are supported (the capture and EXISTS carry one column per side per PK column); a RETURNING update requires each side to have a primary key (a keyless side is rejected with `unsupported-join`). The same capture also drives a both-sides update's per-side base ops, so a both-sides update *with* RETURNING materializes it exactly once.

An update that changes a **base PK** or the **join-key / FK** column determining which rows join breaks the captured identity, so such a row drops from RETURNING (these columns are generally not writable through the supported view shapes); the single-source path has no such limitation (it reads NEW/OLD). Multi-source (join) **insert** RETURNING — which would need the minted shared surrogate threaded into the projection — and RETURNING through a decomposition-backed logical table are not yet supported (rejected with `returning-through-view`).

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

A non-deterministic allocator (`uuid7()`, a clock read) works identically under `pragma nondeterministic_schema`: the default is evaluated **once per row at the envelope** and the single captured value threads to every member, so the members never disagree on the key — the load-bearing evaluate-once-and-thread guarantee, the same way captured timestamps replay. Had the example also carried `created int default now_ms()` with a per-statement binding, that value would stamp the same on both rows, whereas `rid` differs per row. Per-column `default_for` tags may reference context bindings; bindings evaluate per their cadence and are reused across every per-base operation that consumes them.

### A default may read the in-flight row via `new.<col>` — minting vs. resolving a key

A column `default` can read the **other supplied values of the same row** through `new.<col>`. Only INSERT-supplied (or already-defaulted) siblings are visible — an omitted column raises a resolution error rather than reading a not-yet-evaluated default, so there is no evaluation-order race. The `new.`-qualified form is always available; the bare form resolves too unless a same-named mutation-context variable shadows it. On the single-source insert path this is the same row scope `mutation_ordinal()` participates in, surfaced as ordinary column references at plan-build time (no runtime-context plumbing).

The **anchor key default at the shared-key envelope** reads `new.<col>` too — e.g. `default (coalesce((select max(rid) from anchor), 0) + new.seq)` derives the minted shared key from a supplied view column. Because the key default is evaluated standalone per row (not as part of a row-producing projection), its `new.<col>` refs are bound to fresh attributes and resolved through a per-row **row slot** the envelope emitter installs over each source row — *before* the `__shared_key` is appended — for the duration of that row's evaluation. A **member-table** column default likewise reads its supplied siblings via `new.<col>`, since each member insert re-plans through the ordinary base-table row-expansion (which already wires `new.<col>` against the envelope projection). One mechanism, three sites (single-source insert, envelope anchor key, envelope member).

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
    | 'tag-target-not-found'            // a quereus.update.default_for.<col> names a column that is neither a view nor a base column (the routing tags were removed; this remains for the retained default_for key)
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

Diagnostics include a suggestion when one applies — for instance, `no-default` includes the `with tags ("quereus.update.default_for.col" = ...)` fragment ready to copy. `query_plan().properties` includes the per-column `updateLineage` summary so the user can inspect propagation behavior without issuing a mutation.

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
| `is_insertable_into` | `'YES'` if every `not null`-without-declared-default, non-generated base column of every reachable base has a recoverable value — projected, or a recoverable default (constant-FD selection pin / declared base default / `default_for`). |
| `is_updatable` | `'YES'` if at least one output column has `base` lineage. Per-column updateability is exposed by the companion `column_info(name)` TVF. |
| `is_deletable` | `'YES'` if the row-identifying predicate is constructible at every base reachable from the view — operationally, every reachable base's PK columns are exposed through `base` lineage. |
| `effective_targets` | JSON array of base-table names that mutations through the view may touch by default (`'[]'` when none). |

**Static derivation, not a dry run.** Every column is derived statically from the planned view body's backward `updateLineage` / `attributeDefaults` plus the base-table not-null/default/generated flags — `view_info()` never executes a probe mutation. The body is planned *logically* (preserving the Project/Filter/Join/TableReference operator tree that threads `updateLineage`), the same way the view-mutation substrate plans it, so `effective_targets` agrees with the base set `propagate()` reaches. The substrate's dynamic `propagate()` is the authoritative check; the static surface is the conservative reading — a body whose lineage is not yet threaded (VALUES / aggregate / set-op / recursive-CTE / wholly-computed) yields the conservative all-`NO` / `'[]'` row, never an error — and gains accuracy as later phases thread more lineage, with no rework here.

**Outer-join contract.** A body carrying any `null-extended` lineage site (a LEFT / RIGHT / FULL outer join) yields the conservative all-`NO` / `'[]'` row, *regardless of which columns the projection keeps*. This is a deliberate today-truth gate: `propagate()` rejects an outer-join body wholesale today (`collectInnerJoinSources` accepts only two-table inner equi-joins, so neither side is writable), and the static surface must agree (reporting `'YES'` here would be a dangerous YES-when-NO over-report). The gate is body-level rather than per-column precisely because the preserved side is also unwritable today; when outer-join write materialization lands, this relaxes to per-side writability. (`default_for` recovery is honored from a view's own `with tags (…)` DDL.)

Materialized views are **not** enumerated: they are read-only at the user-write boundary, so `view_info()` walks `getAllViews()` only.

### Per-column updateability — `column_info(name)`

`information_schema.columns.is_updatable` — per-column updateability for every view *and* base table — is the engine-idiomatic companion to `view_info()`: `view_info : schema()` :: `column_info : table_info`. It takes a **required** target (a base-table or view name) and emits one row per output column:

```sql
column_info('my_table')  -- one row per base-table column
column_info('my_view')   -- one row per view output column
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

`column_info` shares `view_info`'s conservative gates: a body carrying any `null-extended` site (an outer join) short-circuits to all-`NO`/`null`, and a non-inner-join shape — cross joins, `> 2`-table joins, self-joins, which never null-extend but which `propagate()` still rejects — short-circuits via a non-throwing AST shape check (`isDecomposableJoinBody`, the boolean shadow of `collectInnerJoinSources`). The two surfaces agree with each other and with the dynamic truth, and relax together when per-side write materialization lands. The `'YES'`/`'NO'` text encoding matches `information_schema.columns.is_updatable` — deliberately **not** `table_info`'s integer `0`/`1`.

Materialized views resolve to neither path (their user-facing name is not a `getView` hit, nor by that name a base-table hit — the backing is `_mv_<name>`), so `column_info('an_mv')` throws not-found, consistent with `view_info` excluding MVs. A dedicated TVF rather than a `table_info` extension keeps base-table introspection decoupled from view-body planning: `table_info` resolves base tables only and carries per-column metadata a view has none of, whereas `column_info` resolves either kind uniformly and emits only the column-granular updateability facts.

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
- **n-way decomposition fan-out** — driven by `quereus.lens.decomp.*` tags: a columnar split with an optional (outer-joined) member, an EAV pivot member, and a surrogate split; INSERT (anchor-first, per-row optional gate, EAV triples, surrogate minted once and threaded into every member), UPDATE routed to the backing member — including the **optional-member / EAV value-write materialization** (matched UPDATE / `on conflict do nothing` materialize INSERT / all-null DELETE), anchor-last DELETE. Deferred shapes (shared-key identity write, non-constant optional/EAV value, non-anchor predicate, composite key) are asserted to *reject*.

### The predicate-honest complement

The fan-out philosophy makes the **complement** — what a write holds fixed, i.e. what the view does *not* expose — *determined*, not chosen (the Bancilhon–Spyratos ambiguity does not arise), so it is a first-class derived object. For the single-source projection-and-filter case the complement is the **projected-away base columns** (present in the base, absent from the view image) plus the **negation-free residual of the view predicate** (the σ conjuncts that constrain base rows the view never surfaces), expressed in the same FD/predicate vocabulary as the forward walk. With the complement in hand the lens prover's round-trip check becomes **computed**, not an enumerated checklist: **GetPut** holds iff `put` leaves the complement fixed, and **PutGet** holds iff `get ∘ put` reproduces the written view image. The annotation layer exposes this object (`viewComplement(node)` / `complementOf` in `analysis/view-complement.ts`); the lens prover (`proveRoundTrip` in `schema/lens-prover.ts`) is a **live consumer** — at deploy it computes the per-column GetPut/PutGet verdict off the complement and reds `lens.non-invertible` for a writable-presented column whose round-trip it cannot prove faithful (firing only for writable columns; computed columns stay read-only), degrading to the safe verdict outside the single-source fragment ([lens § Round-trip detection](lens.md#coverage-checklist)). The scope is the single-source-fragment the complement covers; the same `resolveBaseSite`-expressed checks generalize to the join/decomposition fragment once the complement is defined there.

## Implementation Map

No new subsystem is introduced — view updateability is the existing FD / EC / predicate-normalization infrastructure consulted in the mutation direction: lineage parallels FDs, propagation parallels emission, view metadata parallels table metadata. The principal source files:

| Concern | Location |
|---|---|
| `updateLineage` / `attributeDefaults` on `PhysicalProperties`; threaded as `computePhysical` overrides on TableReference / Project / Filter / Join, passed through access / Retrieve / Alias boundary nodes | `src/planner/nodes/plan-node.ts` |
| Backward-walk helpers (`deriveProjectUpdateLineage` / `deriveFilterAttributeDefaults` / `deriveJoinUpdateLineage`), the AST-level `deriveViewColumns`, the shared n-way per-site reader `resolveBaseSite` | `src/planner/analysis/update-lineage.ts` |
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
- **Dataphor (Alphora, D4 language).** The closest commercial precedent. Quereus borrows the `default_for`-style metadata mechanism and the view-as-first-class-target stance; it extends the model with FD- and EC-driven default recovery, eliminating most cases where a Dataphor user would have annotated.
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

- **Non-preserved-side outer-join update** — **now shipped for LEFT joins**: an UPDATE of a non-preserved column splits per row into a matched UPDATE + a null-extended-materialization INSERT, both riding the pre-mutation `__vmupd_keys` capture (see [Outer Joins](#outer-joins)). Still deferred: a non-preserved-**only** insert (`null-extended-create-conflict`); a non-preserved update through a **full outer join**, whose every-side-null-extended shape has no preserved anchor to key the materialization (`unsupported-outer-join-update`, surfaces report it conservative); a **composite** non-preserved join key, which the single-column materialization insert cannot re-join (`unsupported-outer-join-update`); **RETURNING** through a non-preserved-side update, which the captured-identity re-query cannot recover for a materialized null-extended row (`returning-through-view`, owned by `view-write-outer-join-nonpreserved-returning`); and **RIGHT joins entirely**, which the runtime cannot execute (`runtime/emit/join.ts`, pinned by `90.5-unsupported-join-types`) — excluded from recognition and reported conservative until runtime RIGHT-join support lands.
- **Cross-source `set` values** — an inner-join `update` value that reads a partner-side **`base`** column (`update v set a.x = b.y`, or a scalar expression whose cross-source leaves are all `base`) is **now supported**: the read column rides the `__vmupd_keys` capture under a `srcN` alias and the reference is rewritten to a correlated read keyed by the owning side's PK (the pre-mutation partner value — robust to a both-sides update that also rewrites it). Still rejected: a cross-source value reading a **`computed`** (non-base) partner column (`no-inverse`); a cross-source `set` through an **outer** join that reads a non-preserved (null-extended) partner column (`no-inverse` — the partner value is not recoverable from a captured base column); and a cross-source (cross-member) `set` in the **decomposition** fan-out (`cross-source-assignment` — its single-member-table SET cannot express the partner read).
- **Composite shared-key `insert`** — the shared-surrogate envelope threads a single-column key, so an n-way insert whose shared join key spans multiple columns on a side is deferred (`unsupported-decomposition-key`). Composite-PK *identification* (the update/delete capture path) is supported; only the insert envelope's shared key stays single-column.
- **Multi-source (join) `insert` RETURNING** — needs the shared key threaded into the RETURNING projection; rejected with `returning-through-view`. RETURNING through a decomposition-backed logical table is likewise rejected.
- **Aggregate / window write propagation** — read-only at the column level; reserved for the extension that consumes the [incremental-maintenance](incremental-maintenance.md) framework.
- **Recursive CTE bodies** — read-only (`recursive-cte`).
- **Composite shared keys** — the shared-key envelope threads a single-column key; a multi-column surrogate / shared key is deferred (`unsupported-decomposition-key`). (The surrogate's *value source* is now an ordinary column `default`, so non-integer / non-deterministic allocators — `uuid7()`, a custom UDF — are fully supported; only the multi-column shape remains deferred.)
- **Mechanical `put`-from-`get` auto-derivation** — the committed north-star, deferred until the operator set stabilizes; each backward method is hand-written today but shaped to fold into it behind the round-trip laws.
