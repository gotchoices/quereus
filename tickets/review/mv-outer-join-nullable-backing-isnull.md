description: Review the fix for a materialized view over an outer join stamping its null-extended backing column NOT NULL, which made `is null`/`is not null` over the MV fold to wrong results. Root cause was `ProjectNode` re-typing a bare column-ref projection from the column-ref's stale base-table `columnType` instead of the nullable join-output attribute it actually reads. Fix is at the projection layer; it also (correctly) activated a previously-dead lens-prover nullability check, whose fallout was resolved by making optional-member-backed lens test columns nullable.
files: packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/schema/lens-prover.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/51-lens-foundation.sqllogic, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/lens-put-fanout.spec.ts
----

## What changed

### Core fix — `project-node.ts`
A `ProjectNode` derived both its output `RelationType.columns[].type` (`outputTypeCache`) and its
output attributes (`attributesCache`) from `proj.node.getType()`. For a bare `ColumnReferenceNode`
projection, `getType()` returns the node's `columnType`, captured at *build* time from the
**base-table** column scope — so over an outer join it is stale (non-nullable) even though the
join-output attribute the projection reads is nullable (null-extended). `deriveBackingShape` then
stamped the MV backing column NOT NULL, and a base-table NOT NULL is load-bearing: the optimizer
folds `… is null → FALSE` / `… is not null → TRUE` against it, breaking read-side results.

The fix adds:
- `ProjectNode.sourceTypeById()` — `Map<attributeId, ScalarType>` from `this.source.getAttributes()`
  (collision-free; attribute ids are globally unique).
- module-level `effectiveProjectionType(projNode, sourceTypeById)` — for a `ColumnReferenceNode`
  returns the **source-published** type by attribute id, falling back to `projNode.getType()` when
  the id is absent (correlated outer reference) or the node is not a column-ref (no-op, safe to
  apply uniformly).

Applied at every type-derivation site: `outputTypeCache` column `type:`; all three `type:` branches
of `attributesCache` (no-preserve, predefined-attributeId, bare-column-ref, computed); and
`withProjections`'s `predefinedAttributes`. `withChildren` is unchanged — it forwards the
already-corrected attributes via `predefinedAttributes`. `ColumnReferenceNode.columnType` and the
join's outer column scope were deliberately **not** touched (kept blast radius at the projection
layer, as the ticket directed). `materialized-view-helpers.ts:91` is unchanged — with the corrected
body root, `deriveBackingShape` stamps `notNull: false` automatically.

### Fallout — lens prover nullability check (the surprise; review this closely)
The lens prover's `checkTypeAndNullability` (`lens-prover.ts`, ~line 422) rejects a NOT-NULL logical
column whose **basis-derived expression is nullable**. That check was effectively **dead code**
before this fix: the lens `get` body outer-joins optional members (`docs/lens.md` line ~147 —
"optional members outer-joined, their absence preserved"), but the buggy projection reported those
null-extended columns as NOT NULL, so the check never fired. The fix makes the body root report the
correct nullability, which **activates** the check and surfaced 62 lens tests that declared a
NOT-NULL logical column over an **optional** member — unsound declarations that only ever deployed
because of this bug. (`default_column_nullability` defaults to `'not_null'`, so `b integer` is
NOT NULL unless declared `b integer null`.)

These were resolved by appending `null` to the optional-member-backed logical columns — an
**already-established convention** in the same files (many optional columns were already declared
`<col> <type> null`; the failing ones simply forgot it, and several tests themselves do
`set <col> = null` and read `null` back). No production lens code changed; the prover check is now
simply correct rather than masked. **Reviewer: confirm no lens test's intent was to assert NOT-NULL
over an optional member** (none found — every changed column is backed by a `presence: 'optional'`
member or `quereus.lens.decomp.presence.* = 'optional'` tag; mandatory/anchor/PK columns left as-is).

## Use cases for testing / validation

White-box (verified during implement, probes removed):
- MV body root over `select t.id, t.fk, p.name from t left join p on t.fk = p.id`:
  `getType().columns` and `getAttributes()` report `name` as `nullable: true`; `deriveBackingShape`
  reports `notNull: false`. `id`/`fk` stay non-nullable.
- A **right** outer join (`l right join r on l.id = r.id`, keyed on the preserved `r.id`):
  the null-extended left PK `lid` reports `nullable: true`, `rid` stays non-nullable. (A `full` join
  has no provable key → bag → not materializable, so the right join is the materializable analog for
  the both-sided null-extension acceptance case.)

End-to-end (now in the suite):
- `53-materialized-views-rowtime.sqllogic` §30: left-join MV — `where name is null` → `[2]`,
  `where name is not null` → `[1,3]`, `where name = 'a'` → `[1]` (unchanged), full scan correct;
  plus a `delete from p` leg that null-extends another row and re-reads the predicate.
- `maintenance-equivalence.spec.ts` outer/left-join suite: the "preserved" assertion was flipped
  from reading the whole backing back to the **natural** `where name is null` reads; a new
  `is null` / `is not null` equivalence case compares MV-read vs live-body (rewrite disabled) at
  baseline, in-txn (after boundary-crossing mutations), and post-rollback.
- `51-lens-foundation.sqllogic`: `Car.maxSpeed` (optional `Car_perf`) declared `null`.

Commands (all green): `yarn test` (5528 passing in packages/quereus), `yarn lint` (clean),
`yarn build`.

## Known gaps / where to probe

- **Breadth of the projection change.** It relaxes a non-nullable claim to nullable for *any* bare
  column-ref projection whose source publishes a nullable type — not only MV bodies. The full suite
  is green (predicate folding, null-rejection, key/FD inference, lens prover all pass), but the
  reviewer may want to spot-check consumers that read a projection column's static `nullable` over an
  outer join, and the correlated-reference fallback (attr id absent from source → `getType()`).
- **`store` module path not run.** `yarn test:store` was not run (agent-time/idle constraints); the
  change is planner-layer and store-agnostic, but a reviewer preparing a release should run it.
- **Lens test fixes were applied by sub-agents** (lens-advertisement: 31 passing; lens-put-fanout:
  111 passing) under precise per-column guidance; worth a skim that each `null` lands only on an
  optional-member column.
- No `materialized-view-helpers.ts:91` backstop was added (ticket said optional and not a
  substitute); the project-node fix makes it unnecessary.
