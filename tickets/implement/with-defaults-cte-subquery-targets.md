description: Prove (with tests) that the `with defaults (…)` clause rides CTE-name and inline-subquery DML write targets now that both the clause-rehome and the write-target dispatch have landed. Pure additive coverage + a small doc clarification — no engine code change. Expected outputs below are empirically confirmed against the current tree (throwaway probe, 11/11 cases passed).
prereq: with-defaults-clause-rehome, cte-subquery-dml-write-target-dispatch
files:
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # append the `with defaults` × CTE/subquery target block
  - docs/view-updateability.md                                # § View defaults / § CTEs / § Inline subquery: clarify reach onto derived targets
  - packages/quereus/src/planner/mutation/single-source.ts    # READ-ONLY reference: collectAppendedDefaults / bodyDefaults (INSERT-only consumption)
  - packages/quereus/src/planner/building/dml-target.ts        # READ-ONLY reference: resolveCteTarget / resolveSubqueryTarget set ephemeral selectAst
  - packages/quereus/src/planner/mutation/cte-flatten.ts       # READ-ONLY reference: mergeDefaults — multi-level chain merges defaults (consumer wins)
difficulty: medium
----

# `with defaults (…)` on CTE-name / inline-subquery DML write targets

## Status: design fully resolved, behavior empirically confirmed

The two prereqs have **landed** (both in `tickets/complete/`):

- `with-defaults-clause-rehome` — moved the omitted-insert-defaults clause onto the
  **core select** as `SelectStmt.defaults`, parsed by `parseDefaultsClause` at the tail
  of the select spine (after `limit`/`offset`, before DDL `with tags`).
- The CTE/subquery write-target dispatch, shipped as `1-cte-name-dml-write-target`,
  `2-inline-subquery-dml-write-target`, and `2.5-materialized-view-dml-write-through` —
  a CTE name / inline `(select …) as v` is now a real DML write target routed through
  the **same** `buildViewMutation` substrate a named view uses, via an **ephemeral**
  `MutableViewLike` adapter.

This ticket is therefore the **additive test ticket** it was always meant to be: prove
the clause "rides for free" onto those derived targets, with no new engine code. The
prior block (premise: "the write targets don't exist") is lifted — the targets exist.

## How it rides for free (the mechanism — timeless)

The clause lives on the body select (`SelectStmt.defaults`), read via
`bodyDefaults(view.selectAst)` (`schema/view.ts`). The INSERT lowering
`collectAppendedDefaults` (`single-source.ts:923`) appends each clause entry whose base
column the insert left unsupplied — **INSERT-only**; UPDATE/DELETE never consult it.

- A **CTE-name target** builds its ephemeral adapter with
  `selectAst = flattenCteBody(ctx, cte.query, …)` (`dml-target.ts:74`). For a single-level
  body `flattenCteBody` returns the CTE body's select identity — `.defaults` intact — so
  `bodyDefaults` finds it. CTE-name INSERT **is** supported, so **the clause is active**.
- An **inline-subquery target** builds `selectAst` from `stmt.targetSource.subquery`
  (`dml-target.ts:137`), so `.defaults` survives there too — **but inline-subquery INSERT
  is deliberately rejected** (`insert into (select …)` → `Expected table name`), and the
  only supported ops (UPDATE/DELETE) don't consume defaults. So through an inline subquery
  **the clause is inert** (parses, ignored).
- A **multi-level CTE chain** (`with a as (… with defaults (x)), t as (select * from a
  with defaults (y)) insert into t …`) merges via `mergeDefaults` (`cte-flatten.ts:243`,
  `:370`): inner ∪ consumer, **consumer wins on a column-name collision**.

### The reachability matrix (what this ticket can and cannot prove)

| Target | INSERT | `with defaults` effect |
|---|---|---|
| CTE name (`with t as (…) insert into t …`) | supported | **active** — omitted-fires, supplied-wins, projected-away, typo-errors |
| Inline subquery (`update/delete (select …) as v …`) | rejected | **inert** — UPDATE/DELETE ignore it; INSERT never reached |

The historical analysis (in the now-deleted plan ticket) framed "subquery-in-FROM write
target supplied-wins/omitted-fires" as reachable. It is **not** — there is no INSERT-capable
inline-subquery target. The only INSERT-capable *derived* target is the **CTE name**. Do
not write a supplied-wins/omitted-fires test against an inline subquery; it cannot fire.

### `with defaults` does NOT rescue a non-updatable body

A body-shape reject (aggregate / DISTINCT / LIMIT / set-op / multi-level-with-bad-intermediate)
fires **regardless** of a `with defaults` clause on that body — the clause is appended
*after* the body is proven decomposable, so an unupdatable body rejects with the same
body-shape diagnostic it raises without the clause. Reject parity, not a defaults bypass.

## Edge cases & interactions

The implementer must cover (each is a confirmed expected output — see below):

- **CTE INSERT, omitted column → default fires.** Headline supplied-wins/omitted-fires.
- **CTE INSERT, supplied column → supplied value wins** over the default (no contradiction).
- **CTE INSERT, projected-away defaulted column** — default fills a base column not in the
  CTE body projection (parity with the view `df2_v` / `df3_v` cases).
- **Typo in a `with defaults` column name → sited write error** (`not a column` /
  `default-target-not-found`). This is the proof the clause is *actually consumed* through
  the ephemeral path, not silently dropped — a typo must fail loudly.
- **Inline-subquery UPDATE/DELETE with `with defaults` on the body → clause inert**, the
  write behaves exactly as without it (the row's untouched columns keep their values).
- **Inline-subquery INSERT still rejected** even with a `with defaults` body
  (`Expected table name`).
- **Multi-level CTE chain merges defaults, consumer wins** on a column collision.
- **Aggregate (and set-op / compound) CTE body carrying `with defaults` → body-shape
  reject** (`is not updateable in phase 1` / set-op `phase 1`), clause does not rescue.
- **CTE INSERT with a SELECT source while a default must be appended → `VALUES source`
  reject** (the appended-defaults rewrite is VALUES-only — `single-source.ts:896`; parity
  with the equivalent view). But a SELECT-source insert that supplies **every** column
  (no append needed) works.
- **Duplicate column inside one clause** is a *parse* error (`Duplicate column '…' in WITH
  DEFAULTS`) regardless of target — already covered for the view site; a CTE-body
  occurrence is optional belt-and-suspenders, low value (same parser path).

Boundary/concurrency notes: these are memory-vtab logic tests (single connection,
sequential statements) — no fork/concurrency surface. The clause is pure AST metadata, no
resource lifetime. The ephemeral adapter records no schema dependency (`!view.ephemeral`
guard), so there is no cache/invalidation interaction to test here (that is pinned by
`cte-dml-write-target-plan-rigor`).

## Confirmed expected outputs (verified against the current tree)

Use these verbatim (table/column names are illustrative — rename to fit the 93.4 block's
conventions, but keep the shapes). All confirmed passing in a throwaway probe.

```sql
-- (1) CTE-name INSERT: omitted column filled by the body's `with defaults`.
create table p1 (id integer primary key, color text, created integer);
with t as (select id, color from p1 with defaults (created = 111))
    insert into t (id, color) values (1, 'red');
select * from p1 order by id;
→ [{"id":1,"color":"red","created":111}]

-- (2) CTE-name INSERT: supplied value wins over the default.
create table p2 (id integer primary key, created integer);
with t as (select id, created from p2 with defaults (created = 111))
    insert into t (id, created) values (1, 999);
select * from p2 order by id;
→ [{"id":1,"created":999}]

-- (3) CTE-name INSERT: projected-away defaulted column.
create table p3 (id integer primary key, created integer);
with t as (select id from p3 with defaults (created = 222))
    insert into t (id) values (1);
select * from p3 order by id;
→ [{"id":1,"created":222}]

-- (4) Typo in a `with defaults` column name → sited write error.
create table p4 (id integer primary key, created integer);
with t as (select id from p4 with defaults (nope = 1))
    insert into t (id) values (1);
-- error: not a column

-- (5) Inline-subquery UPDATE carrying `with defaults` — clause INERT.
create table p5 (id integer primary key, color text, created integer);
insert into p5 values (1,'red',5);
update (select id, color from p5 with defaults (created = 999)) as v set color='x' where v.id=1;
select * from p5 order by id;
→ [{"id":1,"color":"x","created":5}]

-- (6) Multi-level CTE chain: inner + consumer defaults MERGE (consumer wins on collision).
create table p6 (id integer primary key, a integer, b integer);
with inner1 as (select id from p6 with defaults (a = 1, b = 2)),
     t as (select id from inner1 with defaults (a = 10))
    insert into t (id) values (1);
select * from p6 order by id;
→ [{"id":1,"a":10,"b":2}]

-- (7) Aggregate CTE body carrying defaults → still body-shape reject.
create table p7 (id integer primary key, g integer, v integer);
insert into p7 values (1,1,10);
with t as (select g, sum(v) as s from p7 group by g with defaults (g = 9))
    insert into t (g) values (2);
-- error: is not updateable in phase 1

-- (8) Inline-subquery INSERT still rejected even with defaults on the body.
create table p8 (id integer primary key, created integer);
insert into (select id from p8 with defaults (created = 1)) values (1);
-- error: Expected table name

-- (A) Compound (set-op) CTE body carrying defaults → set-op body-shape reject.
create table q1 (id integer primary key, created integer);
insert into q1 values (1,5);
with t as (select id from q1 union select id from q1 with defaults (created = 9))
    insert into t (id) values (2);
-- error: phase 1

-- (B) CTE INSERT with SELECT source while a default must be appended → VALUES-source reject.
create table q2 (id integer primary key, created integer);
create table q2src (id integer primary key);
insert into q2src values (7);
with t as (select id from q2 with defaults (created = 111))
    insert into t (id) select id from q2src;
-- error: VALUES source

-- (C) CTE INSERT, SELECT source, NO default needed (all columns supplied) → works.
create table q3 (id integer primary key, created integer);
create table q3src (id integer primary key, c integer);
insert into q3src values (7, 70);
with t as (select id, created from q3 with defaults (created = 111))
    insert into t (id, created) select id, c from q3src;
select * from q3 order by id;
→ [{"id":7,"created":70}]
```

## Documentation

`docs/view-updateability.md` is already correct on the structural claims (L81 routes
CTE/inline-subquery targets through the substrate; § Common Table Expressions L668 and
§ Inline subquery L700 are accurate; § View defaults L789–L796 already states the clause
"parses wherever a select parses — a view body, a CTE body, a subquery … inert metadata
wherever no write path consumes it"). **No false claim remains to walk back** — the
feature tickets fixed the old over-claims. Add only a short clarification:

- In **§ View defaults** (or as a sentence in § Common Table Expressions / § Inline
  subquery): state explicitly that the clause is **active on a CTE-name INSERT target**
  (defaults fill omitted columns through the ephemeral substrate) and **inert on an inline
  subquery target** (UPDATE/DELETE ignore it; inline-subquery INSERT is rejected), so the
  only derived target that fires defaults is the CTE name.
- In the **multi-level CTE body** paragraph (L689): note that a `with defaults (…)` on each
  level **merges** through the flattener, with the consumer winning on a column collision
  (`mergeDefaults`, `cte-flatten.ts`).

Keep it terse and DRY — link back to § View defaults rather than restating the precedence
chain.

## TODO

- Read the existing view `with defaults` block (93.4 lines ~1614–1703), the CTE-name target
  block (~3073–3576) and the inline-subquery block (~3670–3850) to match comment style,
  table-naming, and the `→` / `-- error:` conventions.
- Append a new `with defaults × CTE/subquery write targets` section to
  `93.4-view-mutation.sqllogic` covering cases (1)–(8) and (A)–(C) above. Group with a
  clear banner comment; cross-reference `docs/view-updateability.md § View defaults`.
- Add the doc clarifications described above (active-on-CTE-INSERT / inert-on-inline-subquery;
  multi-level merge note).
- Run `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "93.4-view-mutation" 2>&1 | tee /tmp/934.log; tail -40 /tmp/934.log`
  to confirm the appended block passes in isolation.
- Run the full `yarn workspace @quereus/quereus test` (stream with `tee`) and
  `yarn workspace @quereus/quereus lint` — both must stay green (the additions ride the
  existing per-file aggregate `it`, so the passing count is unchanged).
- Handoff to review: note the reachability matrix (no inline-subquery INSERT defaults path
  exists by design) and that this is pure additive coverage + doc clarification.
