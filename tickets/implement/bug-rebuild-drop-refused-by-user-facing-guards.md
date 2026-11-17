description: Changing a table's primary key on a storage backend that cannot do it itself fails whenever an assertion or another table's CHECK mentions that table, with an error about dropping a table the user never asked to drop. Let the engine's own temporary drop past the checks meant for user drops, and report copy failures under the user's table name instead of a hidden internal one.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/core/database.ts                    # _setFkRestrictSuppressed (~2940), _setSchemaUnwinding / _isSchemaUnwinding (~2973): add the shared predicate + the new scope here
  - packages/quereus/src/runtime/emit/alter-table.ts         # rebuildViaShadowTable (~2385): the internal DROP + its NOTE (~2479), the pre-drop phase to re-site errors
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts   # assertNoAssertionDependsOn (~67)
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts  # assertNoExpressionDependsOn (~87)
  - packages/quereus/src/runtime/emit/drop-column-guards.ts     # three guards (~155, ~238, ~317) and the header comment
  - packages/quereus/src/schema/manager.ts                   # findChildBlockingDrop (~1573): FK-flag arm + unwinding arm
  - packages/quereus/src/core/database-external-changes.ts   # the other _setFkRestrictSuppressed caller — unchanged, only its doc comment moves
  - packages/quereus/test/alter-table-conformance.spec.ts    # four new arms already added (see below) — currently failing
  - docs/sql-alter.md                                        # "What a failed rebuild leaves" table (~150)
  - docs/schema-undo-plan.md                                 # "Guards during an unwind" (~51)
repro: verified
----

# Problem

When a backend has no in-place re-key, `alter table t alter primary key (…)` runs `rebuildViaShadowTable`: create a hidden `t__rekey_<ms>` with the new key, copy the rows, commit, `drop table t`, rename the hidden table to `t`, re-create indexes. The `drop table t` goes through `emitDropTable`, which runs every guard that protects a user's drop. The rebuild currently stands down only one of them (the foreign-key row guard, through `_setFkRestrictSuppressed`). Two more refuse:

- `assertNoAssertionDependsOn` — any assertion whose body names `t`;
- `assertNoExpressionDependsOn` — another table's CHECK / DEFAULT / generated subquery naming `t`, **and** `t`'s own CHECK subquery naming `t` (the hidden copy carries the same CHECK text, which names the original `t`, so the guard sees the copy as a dependent and the error names `t__rekey_<ms>`).

Separately, a key collision during the copy is reported by the module under the hidden name: `UNIQUE constraint failed: t__rekey_1794883007255 PK.`

# Reproduction (already in the tree)

Four arms were added to `describe('ALTER PRIMARY KEY — shadow rebuild preserves the table definition')` in `packages/quereus/test/alter-table-conformance.spec.ts`, just before the "A re-key changes no row" comment. All four fail at HEAD:

- `a collision during the copy names the user table, not the hidden rebuild table` → message contains `t__rekey_…`;
- `an assertion over the table …` → `cannot drop table 'main.t': assertion 'a' still refers to it`;
- `another table's CHECK subquery naming the table …` → `cannot drop table 'main.t': it is referenced by CHECK constraint 'ck' on table 'u'`;
- `the table's own CHECK subquery naming itself …` → `… CHECK constraint 'ck' on table 't__rekey_<ms>'`.

Run: `node --import file:///C:/projects/quereus/packages/quereus/register.mjs node_modules/mocha/bin/mocha.js packages/quereus/test/alter-table-conformance.spec.ts -g "shadow rebuild preserves"` from the repo root (or `yarn workspace @quereus/quereus test`).

Probe done during fix (then reverted): setting `_setSchemaUnwinding(true)` alongside the FK flag around the internal drop made the three guard arms pass, including the "rule still holds afterwards" assertion in each — the assertion still rejects a violating insert, the other table's CHECK still rejects, and the self-referencing CHECK (`check (code >= 0 or not exists (select 1 from t where code >= 0))`) still rejects after the rename. So waiving the guards for that one statement is sufficient; nothing downstream breaks. Do **not** ship it that way — see the design.

# Design

## One predicate for every reference guard on the drop path

Add to `Database` a single question every drop-path reference guard asks, e.g. `_areDropReferenceGuardsWaived(): boolean`, true while either of two scopes is open:

- the existing apply-schema unwind scope (`_schemaUnwinding`);
- a new **internal drop** scope, e.g. `_setInternalDrop(value): boolean` (set/restore pair returning the prior value, same shape as `_setFkRestrictSuppressed` and `_setSchemaUnwinding`), meaning "this DROP is engine scaffolding: the object comes back under the same name with the same contents before the statement ends".

Switch these guards from `_isSchemaUnwinding()` to the new predicate:

- `assertNoAssertionDependsOn` (assertion-drop-guard.ts)
- `assertNoExpressionDependsOn` (expression-drop-guard.ts)
- the three guards in drop-column-guards.ts
- `findChildBlockingDrop` in manager.ts (replacing both its `_isFkRestrictSuppressed()` and `_isSchemaUnwinding()` arms)

Why not reuse `_setSchemaUnwinding` for the rebuild: that scope also stops ADD CONSTRAINT judging rows, skips CREATE VIEW body planning, sets `restoring` on module `addConstraint` events, and relaxes MV re-attach scans. Those are unwind-specific, and the rebuild is not an unwind. The two scopes share only the drop-guard stand-down, so they share only the predicate.

Why not keep the FK flag in the rebuild: `findChildBlockingDrop`'s comment says the rebuild is that flag's only drop-issuing caller; the external-row apply path (database-external-changes.ts) issues DML only. Once the rebuild uses the internal-drop scope, drop the FK-flag arm from `findChildBlockingDrop` and remove the rebuild bullet from `_setFkRestrictSuppressed`'s doc comment. Check `schema-declarative.ts:609` (apply's up-front `findChildBlockingDrop` call) is unaffected — it never runs inside either scope.

Doc the predicate as the one place a new drop-path reference guard must consult, so a guard added later is covered by the same check. The structural / shape validations (PK column, last column, partial index, DDL transaction policy, capability checks) stay on in both scopes — only reference guards, which protect *other* objects from a dangling reference, stand down.

## The rebuild

In `rebuildViaShadowTable`, replace the `_setFkRestrictSuppressed(true)` / restore around `drop table ${qualifiedTable}` with the internal-drop scope, restored in `finally`. Delete the NOTE that points at this ticket and reword the comment above it to cover all three refusal shapes (FK children, assertions, CHECK/DEFAULT/generated subqueries including the table's own), all for the same reason: the name comes back with identical rows.

## Siting copy-phase errors on the user's table

Wrap the phase before the DROP (create shadow, row copy, commit) so an error from it is re-sited before it propagates: replace every occurrence of the hidden table's name in the message with the user's table name, keep the error's class and `code` (tests and callers check `StatusCode.CONSTRAINT`), and keep the original reachable as `cause` or by mutating the message in place — whichever preserves the class most simply. The shadow name is engine-generated and unique (`<table>__rekey_<ms>`), so a plain substring substitution is exact; it is not parsing. Only this phase: after the DROP, `shadowHoldsRowsError` must keep naming the shadow (it tells the user where the rows are and how to recover), and the index phase already reports through `indexesMissingError`. The failure-cleanup `drop table if exists` warn log keeps the shadow name too.

## Docs

- `docs/sql-alter.md` "What a failed rebuild leaves": the "the drop is refused" row no longer has a reference-guard cause; reword it (module refusing the drop) or drop it. Add a sentence to the ALTER PRIMARY KEY paragraph that the rebuild's internal drop is not judged by the reference guards, and that errors before the swap name the user's table.
- `docs/schema-undo-plan.md` "Guards during an unwind": mention that the same stand-down is shared with the rebuild's internal drop through one predicate, and name it.

# TODO

- Add the internal-drop scope and the shared predicate on `Database`; doc both.
- Point the five guard functions plus `findChildBlockingDrop` at the predicate; remove the FK-flag arm from `findChildBlockingDrop`; update `_setFkRestrictSuppressed`'s doc comment and the guard header comments that cite `_setSchemaUnwinding`.
- Use the internal-drop scope in `rebuildViaShadowTable`; rewrite the comment and remove the NOTE pointing at this ticket.
- Re-site pre-drop errors onto the user's table name, preserving class and code.
- Update `docs/sql-alter.md` and `docs/schema-undo-plan.md`.
- Run the four new arms, then `yarn workspace @quereus/quereus test` and `yarn lint`. Run `test/logic/50.4-declare-schema-apply-restore.sqllogic` under the store (`QUEREUS_TEST_STORE=true`) since it exercises the unwind scope whose check moves.
