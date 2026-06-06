description: Reject a cross-source `update v set owner.x = partner.y` at PLAN TIME when the owning (assigned) side joins more than one partner row (the 1:many direction), with a diagnostic that names the cross-source ambiguity — instead of the generic runtime `Scalar subquery returned more than one row`.
files: packages/quereus/src/planner/mutation/multi-source.ts (stripSideQualifier, decomposeUpdate, collectCrossSideEqualities, resolveColumnSide, requireKeyColumns, capturedValueSubquery), packages/quereus/src/planner/mutation/mutation-diagnostic.ts (MutationDiagnosticReason), packages/quereus/src/schema/table.ts (TableSchema.primaryKeyDefinition / uniqueConstraints / indexes — read-only), packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/docs/view-updateability.md
----

## Problem

`decomposeUpdate` admits a cross-source `update v set owner.x = partner.y` by projecting
the partner base column `partner.y` into the up-front `__vmupd_keys` capture under a stable
`srcN` alias and rewriting the reference to a correlated scalar read
(`capturedValueSubquery` — `(select srcN from __vmupd_keys k where k.k<owner>_0 = <owner.pk0>
[and …])`), keyed by the **owning** side's PK.

The capture carries **one `srcN` row per joined owner/partner pair**. The correlated
read-back is therefore single-valued *only when the owning side joins at most one partner
row*. All shipped cross-source tests (`93.4-view-mutation.sqllogic`, `ax_jv_x`, `ax_jv_x2`,
`ax_xscpk_v`, `ax_xs_self`) read in the child-reads-parent / join-to-PK direction, where an
FK is many-to-one (or the join equates to the partner's PK), so each owning row joins exactly
one partner → exactly one capture row → well-defined.

In the **reverse** (1:many) direction — the owning side is parent-like and joins *many*
partners (`update v set pv = cv` where one parent matches many children) — the capture holds
one `srcN` row per joined pair, so for a fixed owner PK the correlated read returns multiple
rows. Today this fails at runtime in `runtime/emit/subquery.ts:61` with the generic
`Scalar subquery returned more than one row` (StatusCode.ERROR). Safe (it errors rather than
picking an arbitrary partner) but the message points at neither the cross-source `set` nor
the reason.

## Resolution (design settled — plan-time rejection)

Reject at **plan time** with a dedicated diagnostic. The plan-time cardinality proof is
cheap and uses only already-available schema metadata; the runtime-rewording fallback the
plan ticket floated is **not** taken (the proof is not costly).

### The proof: "owning side joins at most one partner"

Add a helper that decides, for an owner side index and a partner side index, whether the
owning side provably joins **at most one** partner row across the view's join:

- Collect the join's cross-side `column = column` equalities **directly** between owner and
  partner via the existing `collectCrossSideEqualities(sel.from!, sides)` (it already walks
  every nested ON predicate and USING list across the n-way tree). Keep the conjuncts whose
  two operands resolve to `{owner, partner}`, and gather the **partner-side** column names
  they pin (lowercased) into a set `partnerEquatedCols`.
- The owning side joins at most one partner **iff** some **unique key** of the partner table
  is a subset of `partnerEquatedCols`. A unique key fixing each of its columns to a
  per-owner-row value admits ≤1 partner row. Partner unique keys:
  - the PK — `partner.schema.primaryKeyDefinition` → `columns[def.index].name`;
  - each `partner.schema.uniqueConstraints` whose `predicate` is **absent** (a partial
    UNIQUE bounds uniqueness only within its predicate scope, so it does not prove global
    at-most-one) → `columns` (indices) → names;
  - each `partner.schema.indexes` with `unique === true` and **no** `predicate` → its
    `columns` (confirm the column-name field on `IndexColumnSchema`).
- NULL semantics need no special handling: a `=` join only matches non-null equal values,
  and a unique key bounds each non-null value to ≤1 row; PK columns are NOT NULL regardless.

This is the inverse of the FK-correlation reasoning (`edgeCorrelated`) the delete path uses,
but **FK is not required** — the proof is purely partner-side uniqueness. The canonical safe
FK-child-reads-parent case is subsumed: the FK references the parent's PK, the join equates
the child's FK column to that PK, so the parent's PK ⊆ `partnerEquatedCols`.

### The gate

Place the check at the **rewrite site** so it covers every read that lowers to
`capturedValueSubquery` (top-level *and* a partner ref nested in a value subquery), not only
top-level refs:

- In `stripSideQualifier`'s `substitute`, the `otherQuals.has(t)` branch (just before
  `registerCrossSource(col)`): resolve the partner side with
  `resolveColumnSide(col, analysis.sides)`; if it resolves and the owning side does **not**
  provably join at most one partner, `raiseMutationDiagnostic`.
- Thread the proof in as a small memoized closure (bound to this assignment's owning side
  index) built in `decomposeUpdate` — symmetric with how `registerCrossSource` is threaded —
  so the equalities are collected once, not per leaf. `stripSideQualifier` will need access
  to `analysis.sides` (and the partner-name for the message); pass what it lacks.
- Leave `gateCrossSourceReads` (the base-lineage gate) unchanged — it runs first, so a
  computed partner column still rejects `no-inverse` before the cardinality check is reached.
  Scoping the gate to the `registerCrossSource` branch keeps it off the outer-join
  non-preserved materialization path (`registerCapturedExpr`, `capturedValueSubquery` at the
  `out.nullExtended` branch), which is a separate concern and out of scope here.

### Diagnostic

Add a dedicated reason `cross-source-ambiguous-cardinality` to `MutationDiagnosticReason`
(a one-line comment describing the 1:many cross-source `set` reject). Message shape:

> cannot write through view '<view>': the cross-source assignment of column '<assignedCol>'
> reads column '<partnerCol>' on base table '<partnerTable>', but the assigned side joins
> more than one '<partnerTable>' row (the join does not constrain '<partnerTable>' to a
> unique key), so the partner value is ambiguous — a cross-source `set` value is well-defined
> only when the assigned side joins at most one partner row.

Carry `column` (the assigned view column) and `table` (the view name) on the diagnostic.

## Edge cases & interactions

- **Owning side composite PK** (`ax_xscpk_v`): the proof is about the *partner*'s unique key,
  not the owner's — the owner's composite PK only widens the correlation conjuncts. Must stay
  ACCEPTED (partner `p` joined by its PK `pp`).
- **Self-join** (`ax_xs_self`: `e join m on e.mgr = m.id`, `set sal = msal`): owner `e`,
  partner `m` are distinct alias-keyed sides of one base table; `m.id` is that table's PK and
  is equated → at-most-one → ACCEPTED. Verify the alias-keyed `resolveColumnSide` /
  `collectCrossSideEqualities` path pins the partner side correctly (table names collide).
- **Two distinct cross-source leaves in one statement** (`ax_jv_x2`: `cw = pv + pw`, and
  `cv = pv, cw = pw`): each leaf is checked independently at its rewrite; all read the same
  partner side, which is at-most-one → ACCEPTED.
- **Computed partner column** (`ax_jv_xc`: `cval = pvc` where `pvc = p.pv*2`): still rejected
  `no-inverse` by `gateCrossSourceReads` BEFORE the cardinality check — ordering must be
  preserved (no double-diagnostic, no change of reason).
- **Partner unique-but-not-PK column** (e.g. partner join column declared UNIQUE, no FK):
  must be ACCEPTED via the unique-constraint / unique-index branch of the proof (it works
  today at runtime — do not regress it to a reject). Add a test.
- **Partial unique key** (UNIQUE constraint/index with a `predicate`): must NOT count toward
  at-most-one (conservatively reject if it is the only candidate key) — a partial unique does
  not bound the joined rows that fall outside its predicate.
- **Multi-hop transitive cross-source** (owner and partner not directly joined — e.g.
  `a join b … join c …`, `set a.x = c.y`): no direct owner↔partner equality ⇒ not proven ⇒
  REJECTED (conservative). This only over-rejects (never falsely accepts) and no shipped test
  exercises it; name the limitation in the diagnostic path / docs and, if it later proves
  needed, file a follow-up for transitive value-determinacy (union-find over all cross-side
  equalities). The shipped 3-table test (`ax_three`, `bv = 9`) is *same-side*, not
  cross-source, so it is unaffected.
- **`registerCrossSource` absent** (legacy `propagateMultiSource` path, no capture carrier):
  the existing `cross-source-assignment` reject still fires first — the cardinality gate is
  reached only on the build path that supplies the carrier. No change to the legacy path.
- **RETURNING through the cross-source update**: orthogonal — the reject fires during
  decomposition before RETURNING re-query is built; no interaction.
- **No partner key at all** (keyless partner table): no unique key exists ⇒ REJECTED. (A
  keyless *owning* side already rejects earlier via `requireKeyColumns`.)

## Key tests (add to `93.4-view-mutation.sqllogic`, near the existing cross-source block ~L563-628)

- **Reject the 1:many direction.** Parent-reads-child view, parent joins ≥2 children:
  ```sql
  create table xs1n_p (pid integer primary key, pv integer);
  create table xs1n_c (cid integer primary key, pref integer, cv integer,
      foreign key (pref) references xs1n_p(pid));
  insert into xs1n_p values (10, 100);
  insert into xs1n_c values (1, 10, 11), (2, 10, 22);   -- two children of parent 10
  create view xs1n_v as
      select p.pid as pid, p.pv as pv, c.cv as cv
      from xs1n_p p join xs1n_c c on c.pref = p.pid;
  update xs1n_v set pv = cv where pid = 10;
  -- error: cannot write through
  ```
  Expected: a plan-time `ViewMutationError`, reason `cross-source-ambiguous-cardinality`,
  message naming the cross-source ambiguity (NOT the runtime `Scalar subquery returned more
  than one row`). Confirm `xs1n_p` is unchanged (the statement never executed).
- **Accept partner unique-but-not-PK** (regression guard for the unique-constraint branch):
  a partner whose join column carries a UNIQUE constraint (not the PK) must still ACCEPT
  `set owner.x = partner.y` and apply the value.
- **Re-run the existing accepted cross-source cases** (`ax_jv_x`, `ax_jv_x2`, `ax_xscpk_v`,
  `ax_xs_self`) — all stay ACCEPTED with unchanged results (no over-rejection).
- Consider a `view-mutation-substrate.spec.ts` assertion on `err.mutationDiagnostic.reason`
  if the substrate spec is the right home for the structured-reason check.

## TODO

- Add `cross-source-ambiguous-cardinality` to `MutationDiagnosticReason` in
  `mutation-diagnostic.ts` with a one-line comment.
- Implement `ownerJoinsAtMostOnePartner(ownerIdx, partnerIdx, sel, sides)` in
  `multi-source.ts` (PK + non-partial UNIQUE constraint + non-partial UNIQUE index, subset of
  the partner-side equated columns from `collectCrossSideEqualities`). Confirm the
  column-name field on `IndexColumnSchema` for the unique-index branch.
- Thread a memoized, owner-bound cardinality checker into `stripSideQualifier`; add the gate
  in the `otherQuals.has(t)` branch before `registerCrossSource(col)`, resolving the partner
  side via `resolveColumnSide(col, analysis.sides)` and raising the new diagnostic when the
  owner is not provably at-most-one. Pass `analysis.sides` / partner-table name through as
  needed for the gate and message.
- Add the reject + unique-not-PK accept tests to `93.4-view-mutation.sqllogic`; re-run the
  existing cross-source block.
- Document the cardinality requirement in `docs/view-updateability.md` (§ Inner Join,
  cross-source `set`): a cross-source value is admissible only when the assigned side joins
  at most one partner row (partner-side unique-key proof); note the multi-hop conservative
  reject.
- `yarn workspace @quereus/quereus run build`, then `yarn workspace @quereus/quereus test`
  (stream with `Tee-Object`); lint with single-quoted globs.
