description: Relax the plan-time `mutual-fk-restrict-delete` reject so it only fires when the view's join provably correlates a mutual-FK edge (the joined rows necessarily cross-reference). A join on non-FK columns — where the joined rows don't structurally cross-reference — falls back to the fixed-order fan-out and defers to the runtime RESTRICT pre-check, fixing the data-independent over-rejection.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md, packages/quereus/src/schema/table.ts (resolveReferencedColumns — reuse, do not modify)

## Problem (reproduced)

`decomposeDelete` raises `mutual-fk-restrict-delete` at plan time whenever
`orderDeleteFanout(analysis.sides) === undefined`. That predicate is **schema-only**:
`orderDeleteFanout` → `inboundDeleteAction` / `deletableFirst` inspect only the two
base tables' declared `foreignKeys`, never the join predicate or the actual rows. So a
view over a mutual `restrict`/`restrict` (or `restrict`/`cascade`, `cascade`/`restrict`)
FK pair is rejected up front **regardless of the data** — even when the specific joined
rows do not in fact cross-reference via the FK and the delete would succeed at runtime.

Confirmed (current HEAD, `packages/quereus/dist`):

```sql
create table m_a (aid integer primary key, label text, bref integer null,
    foreign key (bref) references m_b(bid) on delete restrict);
create table m_b (bid integer primary key, label text, aref integer null,
    foreign key (aref) references m_a(aid) on delete restrict);
insert into m_a (aid, label, bref) values (1, 'x', null);
insert into m_b (bid, label, aref) values (10, 'x', null);
create view m_jv as select a.aid as aid, b.bid as bid from m_a a join m_b b on a.label = b.label;
delete from m_jv where aid = 1;
--   ACTUAL:   rejected at plan time with `mutual-fk-restrict-delete`.
--   CORRECT:  should succeed — the FK columns are NULL (MATCH SIMPLE: no FK match),
--             so the runtime RESTRICT pre-check finds no referencing row.
```

A direct `delete from m_a where aid = 1` followed by `delete from m_b where bid = 10`
(the `[0, 1]` fan-out the engine *would* emit) both succeed at runtime — proving the
plan-time reject is a false positive for this shape. The join is on a **non-FK column**
(`a.label = b.label`); the FK columns (`bref`/`aref`) are left NULL.

## Resolution — option (a): gate the reject on join-FK correlation (whole-reject level)

Keep the schema-only `orderDeleteFanout` exactly as is for choosing a feasible order.
Only change the **reject branch**: when `orderDeleteFanout` returns `undefined`, raise
`mutual-fk-restrict-delete` **only if the join provably correlates at least one mutual
FK edge** — i.e. forces the child's FK column(s) equal to the parent's referenced
(PK) column(s), so the joined partner necessarily references the deleted row and a
RESTRICT necessarily fires. When the join correlates **neither** edge, fall back to the
fixed `[0, 1]` fan-out and let the runtime RESTRICT pre-check
(`runtime/foreign-key-actions.ts`) decide on the real data.

### Why "at least one edge correlated", not "both", and not per-direction

The gate is deliberately at the **whole-reject** level (correlated edge ⇒ keep the
reject), not folded into per-direction `deletableFirst`. The existing goldens pin why:

- **(fo-g)/(fo-h)** (`test/logic/93.4-view-mutation.sqllogic` ~lines 694–742) join
  `on b.aref = a.aid` — that correlates exactly **one** mutual edge (`b.aref → a.aid`).
  The *other* edge's cross-reference (`a.bref = b.bid`) is present only in the seeded
  data, not structurally forced by the join. Requiring **both** edges correlated — or
  refining `deletableFirst` per-direction with correlation — would stop rejecting these
  and surface a **raw transitive-FK runtime error** instead of the actionable
  diagnostic. So those two shapes must continue to reject. Requiring **at least one**
  edge keeps them rejecting.
- The over-rejection repro joins on a **non-FK column** (`a.label = b.label`) — it
  correlates **neither** edge — so it falls back and runs.
- Principle: when the join correlates an edge, at least one delete direction *provably*
  trips a RESTRICT; the other direction's feasibility is data-dependent and unknowable
  at plan time, and is **structurally indistinguishable** from the (fo-h) shape (one
  edge joined-on, the other only data-referencing). So the conservative reject is the
  defensible choice there. Only when **neither** edge is correlated can the planner say
  no direction's RESTRICT is provable — which is exactly the condition under which a
  plan-time reject is unjustified. This is a strict *reduction* of over-rejection, not
  a claim of perfect precision (a join correlating one edge whose other edge's FK
  columns happen to be NULL is still over-rejected — accepted residual conservatism,
  documented below).

This restores the pre-`view-delete-fanout-mutual-fk-asymmetric-cascade-ordering`
behavior (fixed `[0, 1]`, defer to runtime) for the non-correlated case only; every
correlated shape the asymmetric-ordering ticket added (fo-g…fo-j) is untouched —
fo-i/fo-j already return a valid order from `orderDeleteFanout`, so they never reach
the reject branch at all.

## Correlation-detection algorithm (`joinCorrelatesMutualFk`)

New helper in `multi-source.ts`, alongside `fkChildIndex` / `inboundDeleteAction` /
`orderDeleteFanout`. Signature roughly:

```
function joinCorrelatesMutualFk(analysis: JoinViewAnalysis): boolean
```

1. **Collect cross-side equalities.** Flatten the join ON condition
   (`analysis.sel.from![0]` is the single `join`; its `.condition`) **and** the body
   WHERE (`analysis.sel.where`) on `AND` (operator string is upper-case `'AND'` — see
   `single-source.ts` `flattenAnd`, which you may export and reuse). Keep each conjunct
   that is `binary` with `operator === '='` and **both** operands `type === 'column'`.
2. **Resolve each column operand to a side (0 or 1).** By explicit `.table` qualifier
   matching a side's `alias` (already lowercased) or `schema.name.toLowerCase()`; if the
   ref is unqualified, by **unique** ownership of `col.name` among the two sides'
   columns (`schema.columns`). Ambiguous / unresolved ⇒ skip that conjunct
   (conservative: an unresolved term cannot prove correlation).
3. From the conjuncts whose two operands resolve to **different** sides, build the set
   of equated `(side, columnName)` pairs.
4. **Per mutual edge.** The two edges mirror the `referencedTable` / `referencedSchema`
   match in `fkChildIndex`: edgeA = the FK on side0 referencing side1; edgeB = the FK on
   side1 referencing side0. For each present edge `(child, parent)`: child FK column
   names = `fk.columns.map(i => child.schema.columns[i].name)`; parent referenced column
   names = `resolveReferencedColumns(fk, parent.schema)` (exported from
   `schema/table.ts`) mapped through `parent.schema.columns[i].name`. The edge is
   **correlated** iff for **every** `(childCol, refCol)` pair there is a cross-side
   equality equating `child`.childCol with `parent`.refCol.
5. Return `true` iff **at least one** edge is correlated. (A pure no-FK pair has no
   mutual edges ⇒ returns `false`, but it never reaches the reject anyway since
   `orderDeleteFanout` returns `[0, 1]` for both-inbound-absent.)

Handles the single-column FK shape (the only one that reaches here — composite-PK sides
are rejected by `requireSingleColumnPk` when the ops are built) and naturally generalizes
to composite by requiring all pairs.

## Wiring the reject branch (`decomposeDelete`)

Current (`multi-source.ts` ~lines 1106–1120):

```ts
if (sides.length === 2) {
  const fanoutOrder = orderDeleteFanout(analysis.sides);
  if (fanoutOrder === undefined) {
    // ... raise mutual-fk-restrict-delete ...
  }
  order = fanoutOrder;
} else { order = sides; }
```

Becomes: when `fanoutOrder === undefined`, raise **only if**
`joinCorrelatesMutualFk(analysis)`; otherwise `order = [0, 1]` (the deferred-to-runtime
fixed fan-out). Keep the existing diagnostic message verbatim for the reject path.

## Docs

Update `docs/view-updateability.md` § Inner Join — Deletes (the long blockquote
~lines 405–447, around the `mutual-fk-restrict-delete` paragraph). Document that the
plan-time reject now requires the join to **correlate at least one mutual FK edge**
(the joined rows provably cross-reference); a join on non-FK columns where the joined
rows are not proven to cross-reference falls back to the fixed-order fan-out and defers
to the runtime RESTRICT pre-check on the actual data. Note the accepted residual
conservatism (a join correlating one edge whose other edge's FK columns are NULL at
delete time is still rejected, being indistinguishable at plan time from the
data-referencing (fo-h) shape).

## TODO

- Add `joinCorrelatesMutualFk(analysis)` to `multi-source.ts` per the algorithm above;
  reuse `resolveReferencedColumns` (exported from `schema/table.ts`) and export/reuse
  `flattenAnd` from `single-source.ts` (or replicate the tiny `AND`-flatten locally).
- Gate the `mutual-fk-restrict-delete` reject in `decomposeDelete` on
  `joinCorrelatesMutualFk(analysis)`; fall back to `order = [0, 1]` when not correlated.
- Add goldens to `test/logic/93.4-view-mutation.sqllogic` after (fo-j) (~line 806):
  - **(fo-k)** the repro — mutual `restrict`/`restrict` FK, join on a **non-FK column**
    (`a.lbl = b.lbl`), FK columns left NULL. Seed a joined pair plus non-joining
    siblings; assert `delete from … where aid = 1` now **succeeds**, removing both base
    rows of the joined identity and leaving the siblings:
    ```sql
    create table k_a (aid integer primary key, lbl text, bref integer null,
        foreign key (bref) references k_b(bid) on delete restrict);
    create table k_b (bid integer primary key, lbl text, aref integer null,
        foreign key (aref) references k_a(aid) on delete restrict);
    insert into k_a (aid, lbl, bref) values (1, 'x', null), (2, 'y', null);
    insert into k_b (bid, lbl, aref) values (10, 'x', null), (20, 'z', null);
    create view k_jv as select a.aid as aid, b.bid as bid from k_a a join k_b b on a.lbl = b.lbl;
    select aid, bid from k_jv order by aid;          -- → [{"aid":1,"bid":10}]
    delete from k_jv where aid = 1;                  -- fans out [0,1]; runtime OK (FK cols NULL)
    select aid from k_a order by aid;                -- → [{"aid":2}]
    select bid from k_b order by bid;                -- → [{"bid":20}]
    ```
  - **(fo-l)** (recommended) the residual tradeoff: same non-FK join, but back-fill the
    FK columns so the joined rows *do* cross-reference in data. The deferred `[0,1]`
    fan-out's runtime RESTRICT pre-check then raises the raw transitive-FK error.
    Confirm and pin the exact error substring (`-- error: …`). This documents that a
    non-correlated join trades the plan-time diagnostic for the runtime error when the
    data happens to reference.
- Confirm **(fo-g)/(fo-h)** still reject at plan time (join `on b.aref = a.aid`
  correlates edge B) and (fo-i)/(fo-j) still succeed — no golden changes there.
- Run `yarn workspace @quereus/quereus test` (stream with `2>&1 | tee /tmp/t.log; tail`)
  and `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
