description: FK validation and enforcement fix — default FK action is now `'restrict'` (was `'ignore'`), CREATE-TABLE FK now matches ADD-COLUMN, child-side EXISTS check is always emitted, child INSERT/UPDATE fails when the parent table is missing for non-NULL FK, child/parent column-count parity validated at DDL time, DROP of an FK-referenced parent is blocked while children have rows, and `'ignore'` removed from `ForeignKeyAction`.
files:
  packages/quereus/src/planner/building/foreign-key-builder.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/core/database.ts
  docs/sql.md
  docs/usage.md
  docs/functions.md
  packages/quereus/test/logic/41-fk-extended-targets.sqllogic
  packages/quereus/test/logic/41-fk-cascade-conflict-and-self-ref.sqllogic
  packages/quereus/test/logic/41-foreign-keys.sqllogic
  packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## What landed

### Phase A — FK enforcement defaults
- `extractForeignKeys` (`schema/manager.ts`) defaults `onDelete`/`onUpdate` to `'restrict'` for both column-level and table-level FKs.
- `parseForeignKeyAction` (`parser/parser.ts`): `NO ACTION` now maps to `'restrict'` (was `'ignore'`).
- `buildChildSideFKChecks` (`planner/building/foreign-key-builder.ts`): the both-`'ignore'` short-circuit is gone; child-side EXISTS is always emitted.
- `executeForeignKeyActions` (`runtime/foreign-key-actions.ts`): the `action === 'ignore'` arm is gone.
- `ForeignKeyAction` (`parser/ast.ts`): `'ignore'` removed from the union.
- `foreignKeyActionToString` (`emit/ast-stringify.ts`): `'ignore'` case removed.
- `ForeignKeyConstraintSchema` (`schema/table.ts`): doc-comment defaults updated to `'restrict'`.

### Phase B — FK arity validation at DDL
- CREATE TABLE: `extractForeignKeys` (`schema/manager.ts`) rejects child/parent column-count mismatches with a clear constraint-and-arity error message for both column-level and table-level FKs.
- ADD COLUMN: `extractColumnLevelForeignKeys` (`runtime/emit/alter-table.ts`) does the same for the column-level form.

### Phase C — missing-parent FK enforcement
- `buildChildSideFKChecks` (`planner/building/foreign-key-builder.ts`): when the parent table is unresolved, builds a `null-guards-OR-FALSE` synthetic constraint. MATCH SIMPLE still allows NULL FK rows; non-NULL rows now fail.

### Phase D — DROP TABLE blocked while child rows reference
- New `assertNoReferencingChildrenForDrop` in `schema/manager.ts`, called from `dropTable` before mutation. No-op when `foreign_keys` PRAGMA is off; skips self-FK (those rows go away with the table). For each matching FK, runs `select 1 from <child> where <fk1> is not null and ... limit 1` and throws `QuereusError(StatusCode.CONSTRAINT, ...)` on a hit.

### Schema-declarative drop ordering (required by Phase D)
- `CatalogTable` (`schema/catalog.ts`) gained `referencedTables: string[]` (same-schema only, self-FK excluded).
- `computeSchemaDiff` / new `orderDropsByFKDependency` (`schema/schema-differ.ts`): drops are ordered children-before-parents via DFS post-order (then reversed). Cycles bail out gracefully.

### Tests landed
- `41-fk-extended-targets.sqllogic`: arity-mismatch rejected at CREATE; FK to missing parent fails on non-NULL row; multi-column FK with non-natural parent column order.
- `41-fk-cascade-conflict-and-self-ref.sqllogic`: cascade-then-RESTRICT chain, self-referential composite FK, DROP TABLE of FK-referenced parent, DEFERRABLE INITIALLY DEFERRED column-level FK auto-commit. (`INSERT OR IGNORE` block still commented — separate concern, see follow-ups.)
- `41-foreign-keys.sqllogic`: `NO ACTION` block rewritten to reflect the new RESTRICT semantics.
- `06.3.2-schema-foreign-keys.sqllogic`: introspection expectation updated from `"ignore"` to `"restrict"`.
- `50-declarative-schema.sqllogic`: drop-order expectation flipped to `comments` before `posts` (children first).

### Review pass — doc / comment cleanup
- `docs/sql.md`: section 7.6.x rewritten — default action is now documented as `restrict`; `no action` documented as a synonym for `restrict`; old "IGNORE / NO ACTION (default)" enforcement bullet removed; child-side missing-parent behavior added.
- `docs/usage.md`: `foreign_keys` option description updated to "ON DELETE / ON UPDATE default to RESTRICT" (was "FKs default to IGNORE actions").
- `docs/functions.md`: `foreign_key_info` table no longer lists `ignore` as a valid `on_update`/`on_delete` value.
- `core/database.ts`: `foreign_keys` option description updated to match.
- `planner/building/foreign-key-builder.ts`: stale comment about IGNORE inside `buildParentSideFKChecks` cleaned up.

## Validation

- `yarn build` — clean.
- `yarn test --grep "foreign|fk-|declarative-schema"` — 6/6 FK / declarative-schema logic suites pass (`06.3.2-schema-foreign-keys`, `41-fk-cascade-conflict-and-self-ref`, `41-fk-cross-schema`, `41-fk-extended-targets`, `41-foreign-keys`, `50-declarative-schema`).
- `yarn test` at FK ticket commit (19e1963e) — 2522 passing.
- `yarn lint` — clean.

There is one pre-existing unrelated test failure at HEAD: `Extended constraint pushdown — OR predicates — handles OR with range predicate as residual correctly` in `test/optimizer/extended-constraint-pushdown.spec.ts`. It passes at the FK ticket commit (19e1963e) and was introduced by a later ticket; not in scope for this review.

## Use cases

1. **Default FK actions enforce.** `create table c (x integer references p(id))` with no `ON DELETE`/`ON UPDATE`: `insert into c values (<non-existent>)` errors; deleting a referenced parent row errors.
2. **`NO ACTION` is RESTRICT.** Mixed-clause FK with `ON DELETE NO ACTION` behaves identically to `ON DELETE RESTRICT`.
3. **Arity mismatch rejected at CREATE.** `foreign key (x) references mp(a, b)` and the column-level analogue both throw at CREATE-TABLE / ADD-COLUMN time.
4. **Multi-column FK respects parent column order.** `foreign key (x, y) references mp2(b, a)` with `(x, y) = (100, 1)` finds parent `(b=100, a=1)`; `(1, 100)` errors.
5. **Missing parent table.** `foreign key (p_id) references no_such_parent(id)` allows NULL `p_id` but rejects non-NULL.
6. **Self-FK composite.** `tree (id, pid, tag, unique (id, tag), foreign key (pid, tag) references tree(id, tag))` accepts root self-match and valid children, rejects mismatched `(pid, tag)`.
7. **DROP TABLE of FK-referenced parent.** Child rows present → `drop table parent` errors. After the child is dropped, parent drop succeeds. Self-FK does not block its own drop.
8. **Cascade-then-RESTRICT chain.** `update fa set id = N` cascades into fb, RESTRICTed by fc → end-to-end aborts atomically.
9. **DEFERRABLE INITIALLY DEFERRED column-level FK.** Auto-commit insert with no enclosing tx still rejects the violation; repeating the insert fails the same way (no dangling implicit tx).
10. **Schema differ drop ordering.** `apply schema` / `diff schema` produce children-first DDL when both children and parents are being dropped.

## Out of scope / follow-ups

- **`INSERT OR IGNORE` not silencing FK violations.** Block 1 of `41-fk-cascade-conflict-and-self-ref.sqllogic` remains commented; the runtime's IGNORE path only silences UNIQUE conflicts. Worth a separate ticket.
- **Cross-schema FK drop ordering.** `referencedTables` only tracks same-schema references. Multi-schema migrations dropping parents in schema A and children in schema B simultaneously are not ordered. Not currently exercised.
- **Distinguish RESTRICT vs NO ACTION.** Both currently map to `'restrict'`. NO ACTION should defer to end-of-statement. Tests in our corpus pass either way today; introducing a separate `'noAction'` value is deferred.
- **Pre-existing OR-predicate residual test failure** in `test/optimizer/extended-constraint-pushdown.spec.ts:289` (unrelated to FK; introduced post-FK by a later ticket).
