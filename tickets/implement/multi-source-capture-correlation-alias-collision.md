description: Give the multi-source lowered per-side UPDATE a collision-proof correlation alias (the analog of single-source SELF_ALIAS / `__vm_self`) and qualify the capture read-back's owning-PK operands and the owning-side strip-to-bare refs with it, so a correlation reference emitted inside a user value subquery binds the lowered statement's target row instead of re-binding to a same-named column in the subquery's FROM.
prereq:
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # capturedValueSubquery, stripSideQualifier, per-side UPDATE build, np matched read-back
  - packages/quereus/src/planner/mutation/single-source.ts       # SELF_ALIAS — export it for reuse
  - packages/quereus/src/planner/building/update.ts              # already consumes stmt.alias as the target AliasedScope correlation name (no change expected)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-* cross-source `set` tests — add the two collision regressions here
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` — note the per-side `__vm_self` qualification
difficulty: medium
----

# Multi-source value-subquery correlation refs can rebind to inner FROM columns

## Problem (confirmed in code)

The multi-source SET-value lowering emits two kinds of **bare** (unqualified) owning-side
column references that are *intended* to correlate out to the lowered per-side UPDATE's
target row. Both rebind to the wrong source when they land inside a user value subquery
whose FROM introduces a same-named column (innermost-scope SQL rules):

1. **Capture read-back owning-PK operands.** `capturedValueSubquery()`
   (`multi-source.ts:2611`) builds `(select <srcN> from __vmupd_keys k where k.k<i>_0 =
   <pk0> …)` with the right operand `{ type: 'column', name: pk }` — **bare**. When the
   partner read sits inside a user value subquery (`set cval = (select … from t where … pv
   …)`), this capture subquery nests inside that subquery, and a bare `<pk0>` re-binds to a
   same-named column of `t` (e.g. `t.cid`). The per-row read-back then keys on the wrong
   value → silent wrong result (or NULL when no capture row matches).

2. **Owning-side strip-to-bare.** `stripSideQualifier`'s `substitute`
   (`multi-source.ts:2587`) rewrites an owning-alias ref (`c.cval`) to `{ type: 'column',
   name: col.name }` — **bare** — at every nesting depth. Inside a nested value subquery
   whose FROM has the **base** column name, the stripped ref rebinds locally instead of
   correlating to the target row. (This bites a *rename*: `select c.realval as cval`; a
   subquery `… where x < cval` substitutes the view col `cval` to `c.realval`, strips to
   bare `realval`, and rebinds to `t.realval` when `t` has one.)

Both hazards are pre-existing and orthogonal to the bare-projection routing work. The
`substituteViewColumns`/`makeViewColumnDescend` scope-aware descent already handles the
*decision to substitute* (a name shadowed by the subquery's own FROM is left local — the
user-intent case), and `stripSideQualifier`'s `aliasShadow` set already leaves a
**user-authored** alias-qualified ref colliding-but-shadowed local. So every owning ref the
strip rewrites, and every PK operand the capture read-back emits, is **lowering-injected**
and *should* correlate to the target row — exactly the single-source situation `SELF_ALIAS`
solved.

## Design — mirror the single-source `SELF_ALIAS` spine

The single-source spine (`single-source.ts`) lowers a view UPDATE/DELETE onto a target
carrying a synthesized collision-proof correlation alias `SELF_ALIAS = '__vm_self'`
(`single-source.ts:88`); the base builder registers it as the target's `AliasedScope`
correlation name (`building/update.ts:135` — `correlationName = stmt.alias?.toLowerCase()
?? tableName`), and substituted subquery-descent base terms are qualified with it
(`makeBaseQualifier(ctx, baseTable, SELF_ALIAS)`), so an `__vm_self.col` term binds the
outer target row even when the user subquery FROM names the same base table.

The multi-source per-side lowered UPDATE is *also* a single-table UPDATE planned
independently through the same base builder (`multi-source.ts:1665`). Reuse the **same**
constant: each per-side UPDATE is a flat base UPDATE, never co-scoped or nested with another
lowered target (view-over-view is rejected; a user value subquery is a plain SELECT that
never re-lowers), so two `__vm_self`-aliased targets can never be in scope at once — the
exact invariant the `SELF_ALIAS` docstring already states. `AliasedScope` keeps **bare**
column resolution working (it delegates unqualified names to the parent table scope —
`scopes/aliased.ts:47`), so adding the alias is **plan-identical** for the existing bare
refs and only *adds* `__vm_self`-qualified resolution.

Concretely:

- `capturedValueSubquery` gains an optional trailing `correlationAlias?: string` param. When
  supplied, the PK right operands become `{ type: 'column', name: pk, table: correlationAlias
  }` (composite keys: every conjunct qualifies). Default `undefined` ⇒ bare ⇒ **byte-identical**
  for `decomposition.ts` and any legacy caller that does not pass it.
- The multi-source per-side callers pass `SELF_ALIAS`:
  - `routePartnerRead` (the cross-source `set` read-back — the bug-1 site).
  - the non-preserved matched read-back (`multi-source.ts:1513`) — top-level, so bare already
    resolves, but pass `SELF_ALIAS` for a uniform rule (its host per-side UPDATE carries the
    alias).
- `stripSideQualifier`'s owning branch qualifies the strip: `return { type: 'column', name:
  col.name, table: SELF_ALIAS }` (the bug-2 site).
- The per-side UPDATE statement (`multi-source.ts:1665`) carries `alias: SELF_ALIAS`, so the
  base builder registers the `__vm_self` correlation scope the qualified refs bind through.

**Do NOT touch `buildCapturedKeyPredicate` (`multi-source.ts:1900`).** Its `<pk_j>` right
operands sit at the *top level* of the per-side op's WHERE (never nested in a user subquery),
so they cannot collide and still resolve bare under the aliased scope. It is also shared by
the existence-DELETE and RETURNING re-query paths, which we are not aliasing — leaving it bare
keeps those byte-identical. Likewise leave the existence-DELETE (`multi-source.ts:1692`) and
the null-extended materialize INSERT untouched (an INSERT has no target-row scan to correlate
to — the single-source spine keeps INSERTs at the base-table-name qualifier for the same
reason).

Export `SELF_ALIAS` from `single-source.ts` (it is currently a module-local `const`) and
import it into `multi-source.ts` to keep one source of truth; extend its docstring to note
the multi-source per-side reuse.

## Why the user-intent case is already correct (no over-qualification)

`set cval = (select max(x) from t where x < cval)` where `t` **has** a `cval` column: the
`makeViewColumnDescend` shadow logic sees `cval` shadowed by `t`'s `cval` and leaves it
**local** — it is never substituted, so `stripSideQualifier` never sees it and it binds
`t.cval` (the user's innermost-scope intent). The strip/qualify only ever fires on a
lowering-injected ref. The bug-2 regression therefore must use a **rename** (view name ≠ base
name) so the descent substitutes (the *view* name is not in `t`) while the *base* name
collides — see uq-23 below.

## Edge cases & interactions (write these up front)

- **Composite owning PK** — `capturedValueSubquery` conjoins one equality per PK column; every
  conjunct's right operand must carry `__vm_self`. Cover a 2-column owning PK side.
- **Bug-1: capture read-back owning-PK collision** — partner read nested in a subquery whose
  FROM has a column named like the owning PK; assert correct (not NULL/wrong) read-back.
- **Bug-2: owning strip-to-bare collision** — renamed owning column whose **base** name
  collides with a column in the value subquery's FROM; assert correlation to the target row.
- **User-authored shadowed ref stays local** — existing alias-shadow regressions (uq-16/uq-17
  family) must still leave a user `from things c` / `from points p` collision subquery-local;
  the `aliasShadow` check fires before the owning/partner sets, so qualification never touches
  it. Confirm no regression.
- **Bare user/local/unknown leaf** — untouched (binds local or fails loudly at build); uq-9 /
  uq-14 regressions must be unchanged.
- **Self-join** — two sides of one base table are two independent per-side UPDATEs, each
  aliased `__vm_self` in isolation; the owning-vs-table-name strip ordering is unchanged.
- **Both-sides update** (`set a.x = b.y, b.y = …`) — two per-side UPDATEs, each `__vm_self`,
  each with its own qualified read-back; the pre-mutation capture semantics are unchanged.
- **Outer-join non-preserved matched read-back** (`multi-source.ts:1513`, the `min`-deduped
  form) — now passes `SELF_ALIAS`; its host per-side UPDATE carries the alias. Verify the
  existing LEFT/RIGHT non-preserved-update tests are unchanged.
- **decomposition.ts callers** — pass no `correlationAlias` ⇒ byte-identical; do not modify.
- **Legacy non-build path** (`registerCrossSource === undefined`) — rejects
  `cross-source-assignment` before reaching `capturedValueSubquery`; unaffected.
- **RETURNING through a multi-source view** — the re-query path (`multi-source.ts:~2311`) uses
  `buildCapturedKeyPredicate` (left bare/untouched). Confirm no RETURNING regression; deeper
  RETURNING-subquery correlation qualification is out of scope.
- **Plan-identity** — for every non-colliding statement the only change is an added target
  alias + qualified injected refs that resolve to the same columns; behavior is plan-identical
  (not byte-identical). The `.sqllogic` suite asserts behavior, so existing uq-1…uq-21 must
  pass untouched.

## Key tests (add to `test/logic/93.4-view-mutation.sqllogic`, uq-22 / uq-23)

Both are constructed so a rebind to the inner FROM column yields an *observably different*
result (the regression fails loudly on the unfixed code).

**uq-22 — capture read-back owning-PK collision (bug 1).** The value subquery's FROM has a
`cid` column colliding with the owning side's PK; the partner read of `pv` nests the capture
read-back inside it.

```sql
create table uq22_p (pid integer primary key, pv integer);
create table uq22_c (cid integer primary key, pref integer, cval integer,
    foreign key (pref) references uq22_p(pid));
create table uq22_t (tid integer primary key, x integer, cid integer);  -- `cid` collides
insert into uq22_p values (10, 100), (20, 200);
insert into uq22_c values (1, 10, 1), (2, 20, 2);
insert into uq22_t values (1, 50, 99), (2, 150, 99), (3, 250, 99);      -- cid=99 ≠ any target cid
create view uq22_v as
    select c.cid as cid, cval, pv from uq22_c c join uq22_p p on p.pid = c.pref;
-- cid=2 joins pv=200; capture read-back must correlate `cid` to uq22_c (=2), not uq22_t.cid (=99).
update uq22_v set cval = (select max(x) from uq22_t where x < pv) where cid = 2;
select cid, cval from uq22_c order by cid;
→ [{"cid":1,"cval":1},{"cid":2,"cval":150}]
-- Unfixed: bare `cid` binds uq22_t.cid (=99) → k.kc_0=99 matches no capture row → src0 NULL
--          → `x < NULL` → max() NULL → cval becomes NULL (wrong).
```

**uq-23 — owning strip-to-bare collision (bug 2).** A renamed owning column; the value
subquery's FROM has the **base** column name.

```sql
create table uq23_p (pid integer primary key, pv integer);
create table uq23_c (cid integer primary key, pref integer, realval integer,
    foreign key (pref) references uq23_p(pid));
create table uq23_t (tid integer primary key, x integer, realval integer);  -- base name `realval` collides
insert into uq23_p values (10, 100), (20, 200);
insert into uq23_c values (1, 10, 5), (2, 20, 7);
insert into uq23_t values (1, 3, 999), (2, 6, 999), (3, 9, 999);
create view uq23_v as
    select c.cid as cid, c.realval as cval, pv from uq23_c c join uq23_p p on p.pid = c.pref;
-- `cval` (no col in uq23_t) substitutes to owning `c.realval`; strip must yield __vm_self.realval,
-- not bare `realval` (which would rebind to uq23_t.realval = 999).
update uq23_v set cval = (select max(x) from uq23_t where x < cval) where cid = 2;
select cid, realval from uq23_c order by cid;
→ [{"cid":1,"realval":5},{"cid":2,"realval":6}]   -- target realval=7 → max(x<7)=6
-- Unfixed: bare `realval` binds uq23_t.realval (=999) → max(x<999)=9 (wrong).
```

Optionally add a **composite-owning-PK** variant of uq-22 (a two-column owning PK side) to
exercise the per-conjunct qualification.

## TODO

- Export `SELF_ALIAS` from `single-source.ts`; extend its docstring to note multi-source
  per-side reuse. Import it into `multi-source.ts`.
- Add `correlationAlias?: string` (trailing, optional) to `capturedValueSubquery`; qualify
  each PK right operand with it when supplied; default bare (byte-identical for existing/
  decomposition callers).
- In `stripSideQualifier`: pass `SELF_ALIAS` from `routePartnerRead`'s `capturedValueSubquery`
  call; qualify the owning-branch strip output with `table: SELF_ALIAS`.
- Pass `SELF_ALIAS` to the non-preserved matched read-back `capturedValueSubquery`
  (`multi-source.ts:1513`) for a uniform rule.
- Add `alias: SELF_ALIAS` to the per-side UPDATE statement (`multi-source.ts:1665`). Leave
  `buildCapturedKeyPredicate`, the existence-DELETE, and the materialize INSERT untouched.
- Add uq-22 / uq-23 (and optionally a composite-PK variant) to
  `test/logic/93.4-view-mutation.sqllogic`.
- Update `docs/view-updateability.md` § Inner Join, cross-source `set` to state the per-side
  UPDATE carries the `__vm_self` collision-proof alias and the capture read-back / owning-strip
  refs are qualified with it (mirroring single-source).
- Run `yarn workspace @quereus/quereus test` (at minimum the 93.4 suite) and the lint script;
  confirm uq-1…uq-21 and the outer-join non-preserved-update tests are unchanged.
