----
description: Prove the `with defaults` clause on CTE / subquery-in-FROM write targets — BLOCKED, the premise that these are write targets is false in the current engine
prereq: with-defaults-clause-rehome
files: packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/ (new coverage), docs/view-updateability.md, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/planner/building/{insert,update,delete}.ts
difficulty: medium
----

**BLOCKED — category (b) premise mismatch (with a category (a) design question riding on it).**
Unblocks when the dev decides scope: **(i)** build CTE / subquery-in-FROM *write-target* dispatch
(a new feature — not present today and not a tess ticket), after which this test ticket can run as
written; **OR (ii)** re-scope this ticket to drop the write-target coverage (cover only the inert
read-only clause) and correct the docs that currently claim the capability exists. No defensible
default — see "Why this needs sign-off" below.

> Note on the `prereq:` header: `with-defaults-clause-rehome` is still in `implement/` (so `with
> defaults` does not yet parse on a core select — see Blocker A). That dependency is real but is the
> auto-deferred kind, **not** the reason for this block. The block is **Blocker B** below, which is
> independent of the rehome and is not itself a tess ticket.

## Why blocked

The ticket's headline premise is stated in its own first paragraph:

> "**CTE bodies and subqueries-in-`from`** — both first-class write targets in this engine — can now
> carry `with defaults (…)` for free."

This premise is **false**. There is no CTE / subquery-in-FROM *write-target* path in the engine, so
there is nothing for `with defaults` to ride on, and the ticket explicitly says *"do not invent new
write support here."* The capability the ticket sets out to prove does not exist.

### Empirical proof (throwaway probe, run on the current tree, then deleted)

Against `create table base (id integer primary key, color text)`:

| Attempted write target | Result |
|---|---|
| `with t as (select id, color from base) update t set color = 'x' where id = 1` | **ERROR** `Table 't' not found in schema path: main` |
| `with t as (...) insert into t (id) values (3)` | **ERROR** `Table 't' not found …` |
| `with t as (...) delete from t where id = 1` | **ERROR** `Table 't' not found …` |
| `update (select id, color from base) as v set color = 'x' where id = 1` | **ERROR** `Expected table name. (at line 1, column 8)` |
| `delete from (select id, color from base) where id = 1` | **ERROR** `Expected table name. (at line 1, column 13)` |
| control: `create view gv as select id from base where color='red' insert defaults (color='red')` | **SUCCEEDS** (defaults work *only* on DDL view sites today) |
| control: `select id, color from base with defaults (color='green')` (core select) | **ERROR** parse failure (Blocker A — rehome not landed) |

### Code evidence (why CTE / subquery targets are not reachable)

- **Parser / AST:** the DML target is always a bare identifier.
  - `InsertStmt.table: IdentifierExpr` (`ast.ts:213`), `UpdateStmt.table: IdentifierExpr`
    (`ast.ts:235`), `DeleteStmt.table: IdentifierExpr` (`ast.ts:256`).
  - The `alias?` fields on UpdateStmt/DeleteStmt carry explicit comments: *"The parser never produces
    it (there is no `UPDATE t AS x` / `DELETE FROM t AS x` user syntax in scope)."* (`ast.ts:241-242`,
    `ast.ts:262`).
  - All three DML productions parse the target via `tableIdentifier()` (`parser.ts:422` insert,
    `:2271` update, `:2331` delete), which throws `"Expected table name."` (`parser.ts:941`) on
    anything that is not a bare/qualified identifier — so a parenthesized subquery target cannot
    parse at all.
- **Builders:** `insert.ts:476`, `update.ts:70`, `delete.ts:70` resolve `stmt.table` only via
  `schemaManager.getView(...)` / `getMaintainedTable(...)`. A CTE name is registered in the planning
  **scope**, not the schema manager, so it falls through to `buildTableReference` → schema-manager
  lookup → `Table not found`. There is **no** fallback that routes a CTE name or a subquery through
  `buildViewMutation` / `propagate` / the single-source spine.

### The docs already claim this works — and are wrong

`docs/view-updateability.md` asserts the capability in two places, neither backed by code:
- **L81:** *"The rules below apply identically to view bodies, CTE bodies, subqueries in `from`, and
  the inline target of `update (select ...) set ...`."*
- **L662** (§ Common Table Expressions and Subqueries in `from`): *"Non-recursive CTEs are therefore
  transparently mutable. … `update (select ... from t join s on ...) as v set v.col = ...` works
  without special-casing."*

Both are contradicted by the probe (`Expected table name` / `Table not found`). Whoever picks this
up must reconcile these docs with reality — either by building the capability or by correcting the
prose.

## The two blockers (independent)

- **Blocker A (auto-deferred, tess):** `with-defaults-clause-rehome` has not landed, so `with
  defaults` does not yet parse on a core select. This is the normal deferred-prereq situation; it
  alone would NOT justify a block.
- **Blocker B (the block — premise mismatch, not a tess ticket):** CTE / subquery-in-FROM *write
  targets* do not exist in the engine. The rehome landing does not change this — it only moves the
  defaults clause onto the select AST; it adds no CTE/subquery write-target dispatch. So even
  post-rehome, the ticket's write-target coverage is unreachable.

## Why this needs sign-off (no defensible default)

The docs may be **intentionally aspirational** (describing a designed end-state the dev plans to
build), or they may be a **bug** (over-claiming an unbuilt feature). I cannot tell which, and the two
readings lead to opposite actions:

- If the dev *intends* to build CTE/subquery write-target dispatch → the right move is a new
  feature/plan ticket for that dispatch, with this test ticket chained behind it. That is a
  substantial new feature (parser grammar for a subquery DML target / CTE-name target resolution +
  routing into the view-mutation substrate), well beyond this additive test ticket and explicitly
  out of its scope.
- If the dev wants to *walk the docs back* → re-scope this ticket to the achievable residue (below)
  and fix the false doc claims.

Picking either unilaterally would either silently expand a "medium / additive test" ticket into a
feature build, or delete documented (if unimplemented) intent. That is a design call for the human.

## Achievable residue (for whoever unblocks this)

Once the rehome lands, the *only* part of this ticket that is reachable without new write-target
support is the **inert read-only case**: `with defaults (…)` on a CTE / subquery that is merely
*read* (never a write target) parses and is ignored — mirroring the rehome's bare-top-level-select
inert case. Plus correcting the L81 / L662 doc claims. Everything else in the original ticket
(supplied-wins / omitted-fires through a CTE/subquery write target, `default-target-not-found` on a
typo'd target, compound-CTE write-through, non-updatable subquery write-through) presupposes a write
target that does not exist.

## Original ticket intent (preserved verbatim for context)

The source ticket wanted to prove that, because the rehome moves `with defaults` onto core select,
CTE bodies and subqueries-in-FROM (assumed to be first-class write targets) could carry the clause
"for free", with these cases: CTE write target (supplied-wins + omitted-fires), subquery-in-FROM
write target (same), routing parity / `default-target-not-found` on a typo'd target, inert read-only
case, compound-CTE body, and a non-updatable (aggregated) subquery carrying the clause. Plus a
`docs/view-updateability.md` note that the clause rides core select and is therefore available on
CTE / subquery-in-FROM / lens-body write targets. The note as specified would itself be inaccurate
(see "the docs already claim this works — and are wrong").
