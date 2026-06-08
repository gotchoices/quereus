description: BUG (static-surface desync) — `column_info` over-claims `is_updatable = YES` for a membership flag declared on the **left leg of a subtree operand** of a nested set-op view. The static `surfacedInnerFlagNames` helper (`collectSubtreeFlagNames`) only descends a subtree operand's RIGHT leg (`compound.select`), never its left leg, so deeper-left surfaced inner flags are missed by the static surface even though the plan surfaces them and the dynamic write correctly rejects writing them. Pre-existing (`nestable-flagged-set-ops`), independent of `set-op-leftwrap-write` but in the same surface family; symmetric on both sides.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Symptom

A nested set-op membership view whose **subtree operand has a flagged left leg** mis-reports
that left-leg flag as writable on the static `column_info` surface, while the dynamic write
correctly defers it. The two surfaces disagree (a Round-Trip / surface-authority violation:
`column_info` must not claim writable what `propagate()` rejects).

### Minimal repro

```sql
create table A (id integer primary key, x integer) using memory;
create table B (id integer primary key, x integer) using memory;
create table C (id integer primary key, x integer) using memory;
create table D (id integer primary key, x integer) using memory;

-- Right operand is a subtree whose LEFT leg `(B union[inP,inQ] C)` carries flags.
create view V as
  select id, x from A
  union exists left as inL, exists right as inR
  ( (select id, x from B union exists left as inP, exists right as inQ select id, x from C)
    union select id, x from D );
```

- View columns (plan): `[id, x, inP, inQ, inL, inR]` — `inP`/`inQ` ARE surfaced inner flags.
- `select column_name, is_updatable from column_info('V')` → reports **`inP`/`inQ` = `YES`** (wrong).
- Dynamic write `update V set inP = true where id = 2` → correctly **rejects**:
  `'inP' is a surfaced inner-branch membership flag of a nested set operation … deferred to
  set-op-membership-nested`.

So the static surface over-claims updatability for `inP`/`inQ`.

## Root cause

`packages/quereus/src/planner/mutation/set-op.ts` — `collectSubtreeFlagNames` (the recursion behind
the exported `surfacedInnerFlagNames`, which `schema.ts`'s `column_info` consumes):

```ts
function collectSubtreeFlagNames(operand: AST.QueryExpr, out: string[]): void {
	if (operand.type !== 'select' || !operand.compound || operand.compound.op === 'diff') return;
	for (const e of operand.compound.existence ?? []) out.push(e.name);
	collectSubtreeFlagNames(operand.compound.select, out);   // <-- RIGHT leg only
}
```

It pushes the subtree's own top-link existence flags and descends only `compound.select` (the
right operand). A flag declared on the subtree's **left leg** — which lives in the SelectStmt's own
core (reached via `leftBranchSelect`) and may itself be a `select * from (compound)` wrapper —
is never visited (nor unwrapped). The **dynamic** path does not have this gap: its
`analysis.surfacedInnerFlagNames` is derived **positionally from the plan**
(`viewColNames.slice(dataColCount, length - flags.length)`), so it includes every surfaced inner
flag regardless of which leg declared it. Hence static under-counts and the two disagree.

The bug predates `set-op-leftwrap-write`; the repro above uses a RIGHT-side subtree, so the new
left-operand unwrap is not involved. It is **symmetric**: the same gap applies to the left leg of a
parallel-sibling LEFT subtree operand.

## Expected behavior

`surfacedInnerFlagNames` (static) must enumerate the SAME flag set, in the SAME layout order, that
the plan surfaces between the data columns and the body's own flags — i.e. it must descend BOTH legs
of every subtree operand (unwrapping each `select * from (compound)` wrapper, mirroring the read/plan
combinator's surfacing order), so `column_info` reports every surfaced inner flag `is_updatable = NO`,
agreeing with the dynamic reject. The fix likely walks the left leg via `leftBranchSelect` +
`unwrapBranchSelect` in addition to `compound.select`, in the order the planner appends the flags
(verify against `SetOperationNode` / the read combinator's attribute order — the left-leg flags
surfaced **before** the outer own flags in the repro: `[id, x, inP, inQ, inL, inR]`).

## Verification

- Add a property test: for the repro view, `column_info('V')` reports `inP`/`inQ` = `NO`, and
  cross-check against the dynamic reject of `update V set inP = true`.
- Cover both sides (a flagged left leg of a RIGHT subtree operand AND of a parallel-sibling LEFT
  subtree operand) and ≥1 deeper nesting level.
- Confirm `surfacedInnerFlagNames` (static) order matches `analysis.surfacedInnerFlagNames`
  (plan-derived) element-for-element for these shapes.
