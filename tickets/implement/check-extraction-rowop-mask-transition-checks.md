description: Gate CHECK fact extraction to row-invariant checks — skip operation-masked (non insert+update) checks, `old.`-qualified transition checks, and deferred checks; keep assertion-hoist synthetic checks contributing.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts          # add per-check row-invariant gate in extractCheckConstraints
  - packages/quereus/src/planner/analysis/predicate-shape.ts           # walkAstNodes (reuse for old.-screen); columnIndexFromExpr docblock pin for new.
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts     # synthetic checks: operations 0 → DEFAULT_ROWOP_MASK; fix stale comment
  - packages/quereus/src/schema/table.ts                               # RowOpFlag / DEFAULT_ROWOP_MASK / RowConstraintSchema (read-only reference)
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts          # unit pins for the new gates
  - packages/quereus/test/logic/40.2-check-extras.sqllogic             # sqllogic wrong-result pins + controls
  - docs/optimizer.md                                                  # § Check-derived contributions (~line 1549) — document the row-invariant gate
----

# Gate CHECK fact extraction to row-invariant checks

`extractCheckConstraints` (check-extraction.ts:77-81) mints unconditional value
facts (FDs, EC pairs, constant bindings, domain constraints) from **every**
entry in `tableSchema.checkConstraints`. But a CHECK is only a row invariant —
something every stored row satisfies — when it is enforced on every path a row
image can enter the table. Two confirmed breakages (fix-stage research, all
reproduced at current HEAD):

1. **Operation mask ignored.** Enforcement filters by
   `shouldCheckConstraint(constraint, operation)`
   (constraint-builder.ts:22-25); extraction never consults
   `check.operations`. A `check on insert (...)` does not run on UPDATE, so an
   UPDATE can legally store a violating row — but the extracted binding/domain
   makes `ruleFilterContradiction` fold matching WHERE predicates to empty.

2. **`old.` row-image qualifier resolved as same-row column.**
   `old.a` parses as `ColumnExpr { name: 'a', table: 'old' }` (verified).
   `columnIndexFromExpr` (predicate-shape.ts:33-47) deliberately ignores the
   `table` qualifier, so `old.a = b` extracts as the same-row equality
   `a = b` → mirror FDs + EC pair. `collectColumnNames`
   (predicate-shape.ts:157-169) has the same blindness, covering the compound
   `col = <expr>` one-way-FD shape. This is independent of the mask gate:
   a **default-mask** `check (old.a = b)` passes on INSERT because `old.a` is
   NULL (constraint-builder registers OLD with `nullable: true`), so it is a
   transition constraint, not a row invariant, even with `insert|update` mask.

## Confirmed wrong-result repros (all return 0 rows; rows exist)

```sql
-- (1) mask: insert-only check survives an UPDATE it never sees
create table t (id integer primary key, status text, check on insert (status = 'a')) using memory;
insert into t values (1, 'a');
update t set status = 'b' where id = 1;
select * from t where status = 'b';        -- wrong: [] (1 row exists)

-- (2) update-only transition check extracted as same-row EC a=b
create table t3 (id integer primary key, a text, b text unique, check on update (old.a = b)) using memory;
insert into t3 values (1, 'x', 'y1'), (2, 'x', 'y2');
select * from t3 where a = 'x';            -- wrong: [] (2 rows exist)

-- (3) old. under the DEFAULT mask — needs the old-screen, mask gate alone insufficient
create table t4 (id integer primary key, a text, b text, check (old.a = b)) using memory;
insert into t4 values (1, 'x', 'y1');      -- legal: old.a is NULL on insert
select * from t4 where a = 'x';            -- wrong: [] (1 row exists)

-- (4) delete-only check constrains no stored row at all
create table t6 (id integer primary key, v integer, check on delete (v > 0)) using memory;
insert into t6 values (1, -5);             -- legal: check is delete-only
select * from t6 where v <= 0;             -- wrong: [] (1 row exists)
```

Verified-correct behavior to preserve (controls, all pass today):
default-mask `check (v > 0)` folds `v <= 0` to empty; explicit
`check on insert, update (v > 0)` folds identically; `check (new.a = b)`
returns correct rows (its facts are sound — NEW is the stored row image);
assertion-hoist facts fold (`create assertion … not exists (select 1 from t5
where v <= 0)` folds `v <= 0` to empty).

## Hypothesis → correction

Add a per-check **row-invariant gate** at the top of the extraction loop in
`extractCheckConstraints` (before `containsNonDeterministicCall`); a check
contributes facts only when ALL hold:

1. **Mask covers both INSERT and UPDATE**:
   `(check.operations & RowOpFlag.INSERT) !== 0 && (check.operations & RowOpFlag.UPDATE) !== 0`.
   DELETE membership is irrelevant (deleting adds no row image). The default
   mask (`DEFAULT_ROWOP_MASK = INSERT | UPDATE`) qualifies. ALTER ADD CHECK
   backfill validation plus the `permitsGrandfatheredCheckViolators` consumer
   gate (reference.ts:129-142) already cover the pre-existing-rows path for
   qualifying checks.

2. **Not deferred**: skip when `check.deferrable || check.initiallyDeferred`.
   Spec question settled during fix research: the parser does **not** accept
   DEFERRABLE on CHECK constraints (parser.ts:4696 — "DEFERRABLE syntax not
   supported for CHECK constraints in Quereus"), and CHECK deferral is
   otherwise a plan-time classification (`needsDeferred = containsSubquery ||
   containsCommittedRef`, constraint-builder.ts:190) — committed refs can only
   occur inside subqueries, which `containsNonDeterministicCall` already
   screens. So no SQL today can produce a stored table CHECK with these flags
   set; the gate is **defensive** (the schema fields exist; synthetic FK
   checks set them but never enter `tableSchema.checkConstraints`; lens /
   differ paths carry RowConstraintSchema verbatim). A deferred check is
   enforced at commit, so same-transaction reads can see violating rows —
   excluding them is semantically required if they ever become declarable.
   Pin via unit test (the flags can be set on a hand-built
   RowConstraintSchema), not sqllogic.

3. **No `old.` row-image reference anywhere in the expression**: skip when any
   node yielded by `walkAstNodes(check.expr)` is a `ColumnExpr` whose
   `table` qualifier is `'old'` case-insensitively. Suggested helper
   `containsOldRowImageRef(expr)` local to check-extraction.ts (the
   old/new-image semantics are CHECK-specific; predicate-shape.ts stays
   syntactic per its header). `walkAstNodes` is reflective, so guard
   disjuncts, compound operands, between bounds, and in-lists are all covered
   by one screen. Conservative edge: a table literally named `old` using
   self-qualified `old.col` refs loses facts — sound (enforcement scope keys
   `old.<col>` to the OLD image there too, so such refs are ambiguous anyway).

4. **`new.` stays allowed, now deliberately**: `new.<col>` is same-row over
   the NEW image and semantically fine for insert+update-mask checks. Today it
   resolves only via `columnIndexFromExpr`'s qualifier-ignoring. Make that
   explicit: note the deliberate `new.` tolerance in the
   `columnIndexFromExpr` docblock (predicate-shape.ts:27-32) and/or at the
   screen site, and pin with a unit test (`new.a = b` extracts identically to
   `a = b`). Self-table qualifiers `t.col` likewise resolve by bare name and
   are sound (existing behavior, e.g. 40.2-check-extras.sqllogic:224).

### Assertion-hoist path must keep contributing

`assertion-hoist-cache.ts:122-129` builds synthetic `RowConstraintSchema`s
with `operations: 0 as RowOpMask` and the comment "`operations` is unused by
extractCheckConstraints; defaulting to 0 is safe" — the mask gate would
silently drop every hoisted assertion fact. Fix by setting a real mask on the
synthetic checks (`operations: DEFAULT_ROWOP_MASK`) and updating the stale
comment. Assertion predicates are table-level SQL (`not exists (select 1 from
T [where P])` negated via `negateAst`) and cannot contain `old.`/`new.`
row-image refs, so gates 2–4 are no-ops there.

### Consumers covered by the shared gate (no per-consumer work)

- `getCheckExtraction` → `TableReferenceNode.computePhysical`
  (reference.ts:129-152): FDs/ECs/bindings/domains.
- `lens-prover.ts` `enumerableDomain` via `getCheckExtraction(ctx.table)` /
  `getCheckExtraction(basis)`: lens logical constraints are verbatim
  `RowConstraintSchema` with real parsed masks (lens.ts:257,
  `buildLogicalConstraints`), so the same filter applies correctly.
- `extractCheckConstraints` direct call in assertion-hoist (handled above).

The `getCheckExtraction` WeakMap cache needs no change — the gate is a pure
function of the schema instance.

### Pre-existing tests to watch

- 40.2-check-extras.sqllogic:224 `check on delete (t_selfq_d.qty = 0)` —
  today extraction mints a `qty = 0` binding from this delete-only check; the
  test only exercises deletes so no wrong result manifests. The mask gate
  drops those facts (correct); test should still pass.
- 40.2-check-extras.sqllogic:336 `check on update (old.c = c)` with NOCASE —
  already contributes nothing (collation gate); stays contributing nothing
  (mask + old-screen).
- test/optimizer/check-fold-gated-by-capability.spec.ts and
  test/optimizer/assertion-as-premise.spec.ts pin the surviving paths
  (default-mask DDL checks, hoisted assertions) — must keep passing.

## TODO

- [ ] In `extractCheckConstraints` (check-extraction.ts), add the per-check
      row-invariant gate: require `operations` ⊇ INSERT|UPDATE; skip
      `deferrable`/`initiallyDeferred` checks; skip checks containing any
      `old.`-qualified `ColumnExpr` (new helper `containsOldRowImageRef`
      using `walkAstNodes`). Document each leg with a brief comment keyed to
      enforcement (`shouldCheckConstraint`, OLD-image NULL-on-insert).
- [ ] Pin the deliberate `new.`/self-qualifier tolerance: docblock note on
      `columnIndexFromExpr` (predicate-shape.ts) or at the screen site.
- [ ] assertion-hoist-cache.ts: `operations: 0` → `DEFAULT_ROWOP_MASK` on the
      synthetic checks; rewrite the "unused by extraction" comment.
- [ ] Unit tests (check-derived-fds.spec.ts): masks insert-only / update-only
      / delete-only / insert|delete / update|delete extract nothing (equality
      + range + in shapes); insert|update and insert|update|delete extract as
      before; `deferrable: true` and `initiallyDeferred: true` extract
      nothing; `old.` ref in a plain operand, inside a compound RHS
      (`a = old.b + 1`), in an implication-form guard disjunct, and in
      between/in shapes each kill the whole check while sibling checks in the
      same array still contribute; `new.a = b` extracts identically to
      `a = b`.
- [ ] sqllogic pins (extend 40.2-check-extras.sqllogic or a sibling logic
      file): repros (1)–(4) above asserting the rows ARE returned, plus
      controls: default-mask fold still empty, explicit
      `check on insert, update` fold still empty, `new.`-qualified check rows
      still returned.
- [ ] Assertion-hoist control: confirm assertion-as-premise.spec.ts still
      passes; if it lacks a fold-to-empty pin through `getCheckExtraction`'s
      mask gate, add one (the fix-stage control was: `create assertion pos_v
      check (not exists (select 1 from t5 where v <= 0))` then
      `select * from t5 where v <= 0` folds empty).
- [ ] Update docs/optimizer.md § Check-derived contributions (~line 1549):
      state the row-invariant gate (mask ⊇ insert|update, no `old.` refs, not
      deferred) ahead of the shape table.
- [ ] `yarn test` + `yarn workspace @quereus/quereus run typecheck` + lint.
