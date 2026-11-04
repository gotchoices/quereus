description: On a storage backend that cannot change a primary key in place, a primary-key change whose final commit fails leaves the table empty, because the table swap survives the failure while the copied rows do not. The rows should be safely committed before the original table is dropped, and the copy should not re-check rows that are not changing.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts   # rebuildViaShadowTable: the copy, the new commit, the failure cleanup, and the docblock
  - packages/quereus/src/parser/ast.ts   # InsertStmt gains the engine-only marker
  - packages/quereus/src/planner/building/insert.ts   # buildInsertStmt, the three build calls the marker skips (~984-1008)
  - packages/quereus/src/core/database.ts   # _parseSql is private today
  - packages/quereus/src/runtime/emit/ddl-transaction-policy.ts   # rebuildNotOnlyEffectError message
  - packages/quereus/test/no-alter-module.ts   # stub backend that forces the rebuild path
  - packages/quereus/test/alter-table-conformance.spec.ts   # 'ALTER PRIMARY KEY — shadow rebuild preserves the table definition'
  - packages/quereus/test/apply-schema-restore.spec.ts   # 'a primary-key rebuild that is not the only effect of the apply'
  - docs/schema-undo-plan.md
  - docs/module-authoring-schema-changes.md
  - docs/sql-alter.md
  - docs/schema-declarative.md
  - docs/module-events.md
  - tickets/backlog/bug-rebuild-copy-refused-when-table-reads-context.md   # closed by this fix; delete when done
repro: verified
----

# A rebuilt primary key loses its rows when a commit fails

A backend that cannot re-key in place changes a primary key by building a hidden copy of the table (the shadow table), copying the rows, dropping the original and renaming the copy over it (`rebuildViaShadowTable`). The drop and rename survive a rollback and the row copy does not. Any failure after the drop that rolls the transaction back therefore empties the table.

The engine refuses this inside an explicit transaction and in an `apply schema` that does anything else. A lone `ALTER PRIMARY KEY` in autocommit and a one-step apply stay allowed, on the assumption that nothing can fail after the rebuild. The commit still can.

Only third-party backends reach this path: memory and the store both re-key in place. On such a backend it is easier to hit than first thought. It needs no pragma and no deferrable constraint, only a CHECK with a subquery whose result has moved since the row was written.

## Reproduction

Run through a temporary spec on `makeNoAlterModule({ withRenameTable: true })`. "Before" is current code. "After" is a prototype of the fix below, removed again before this handoff. With the prototype, `yarn workspace @quereus/quereus run test` gave 10949 passing and 0 failing. `yarn test:store` was not run, because the store re-keys in place.

| Case | Before | After |
|---|---|---|
| `foreign key … deferrable initially deferred`, orphan row inserted with the pragma off | `CHECK constraint failed: fk`, no rows | succeeds, rows kept |
| plain `foreign key`, orphan row inserted with the pragma off | same: every child-side foreign key is queued for commit | succeeds, rows kept, a new orphan is still refused, new key enforced |
| `check (x > (select max(id) from o))`, row valid when written, `o` grew later | `CHECK constraint failed: ck …`, no rows | succeeds, rows kept |
| deferred foreign key orphan, one-step `apply schema main` | `CHECK constraint failed: fk`, no rows | succeeds, rows kept |
| every module commit throws during the ALTER, valid rows | the error, no rows | the error, original table intact, no shadow left |
| only the commit after the swap throws, valid rows | not reachable in the same form | the error, rows kept under the new key |
| `renameTable` throws, valid rows | the error, `t` gone, rows destroyed | the error, `t` gone, rows held in the shadow table |
| rows collide under the new key | `UNIQUE constraint failed: t__rekey_… PK`, rows kept | unchanged |
| `check (new.v <= cap)` with `with context (cap integer)` | `requires mutation context variable 'cap'`, rows kept | succeeds, rows kept |
| `v … default cap` with `with context (cap integer)` | same refusal | succeeds once `buildNotNullDefaults` is also skipped, rows kept |
| prepared `alter`, and `insert; alter; insert` in one `exec` | not run | succeeds, autocommit restored |

The prototype did not include the error wording for the failed rename.

Not run: a user index whose re-creation fails after the rename. From the code it should leave the rows and the new key with the index missing, and the statement reporting the failure.

## Root cause

Two separate faults sit in `rebuildViaShadowTable`:

- **The copied rows are not durable when the original is dropped.** This is the loss, whatever makes the later rollback happen.
- **The copy re-judges rows it is not changing.** The insert queues each child-side foreign key and subquery CHECK for commit, so a violation that was already there fails a statement that changes no row. It also compiles CHECKs and defaults that read `with context` variables the copy has no values for. That is the failure in backlog ticket `bug-rebuild-copy-refused-when-table-reads-context`, which this fix closes.

The failure cleanup adds a third way to lose rows. It drops the shadow table even when the original is already gone, so a failed rename destroys the only copy.

## Fix

All three changes are needed. Committing alone would turn the loss into a refusal, and the expected behaviour is that a violation already present cannot fail a re-key.

**Commit the copy before the drop.** Immediately after the copy statement:

```typescript
await rctx.db._commitTransaction();
await rctx.db._ensureTransaction();
```

After this, a failed commit of the copy leaves the original untouched, and the existing catch drops the shadow. A failure after the drop rolls back nothing that matters, because the rows are already committed. The commit runs inside `withPublicEventsSuppressed` and the copy's events are suppressed, so subscribers still see one `alter` and nothing else (`alter-table-events.spec.ts` passed with the prototype).

**This revisits a recorded decision, so update it.** `docs/schema-undo-plan.md` says committing right after the rebuild was rejected, for two reasons. Neither applies to this narrower commit:

- "A nested statement would be committing a transaction its outer statement owns." A direct `ALTER` owns its implicit transaction. In a one-step apply the outer statement owns it, but the existing only-effect refusal guarantees the transaction holds nothing else. The rebuild is only reachable where that holds: an explicit transaction, a savepoint (which upgrades the transaction to explicit) and an atomic `exec` batch are all refused first.
- "The commit would run deferred checks and assertions against a half-migrated schema." This commit runs before the drop, when the original and the shadow are both whole. The copy queued no checks, and no assertion can name a machine-generated table.

That earlier decision was about keeping a multi-step apply undoable, and multi-step applies stay refused, so it stands for them. Add a tripwire at the commit:

```typescript
// NOTE: commits the whole implicit transaction. Safe because the rebuild is refused wherever anything else could be in it (explicit transaction, apply with other effects); if a new path ever issues ALTER PRIMARY KEY nested inside a statement that has written, this commit carries those writes and the path needs its own refusal.
```

**Make the copy judge only the key.** Add an optional marker to `InsertStmt`, for example `skipRowChecks?: boolean`, documented as engine-only and never set by the parser. In `buildInsertStmt`, when it is set, skip `buildConstraintChecks`, `buildChildSideFKChecks` and `buildNotNullDefaults`. The defaults are only used by `or replace`, and the copy is `or abort`. The rebuild parses its copy statement, sets the marker on the result and runs it through `_execAstWithinTransaction`; `_parseSql` has to stop being `private` for that (mark it `@internal`).

Uniqueness stays enforced, because the module does that, so a collision under the new key is still refused. The optimizer's trust in a declared CHECK or foreign key is unaffected: the table holds the same rows and declares the same constraints as before.

A marker on the statement was chosen over a `Database` flag like `_setFkRestrictSuppressed`, because it cannot leak to any other statement and needs no restoring. Skipping at runtime in `checkCheckConstraints` was rejected because the plan-time compile is what raises the `with context` refusal.

**Keep the shadow once it holds the only copy.** Track this in a local: set it after the drop, clear it after the rename. While set, the catch does not drop the shadow, and it throws an error wrapping the original as its cause. The error names the shadow table, says it holds the rows, and gives the recovery statement, `alter table <shadow> rename to <table>`. This is the one case the expected behaviour describes as "must say that it did": the rows are not lost, but they are not where the user expects.

**What a failure now leaves:**

| Failure point | Table | Rows | Reported |
|---|---|---|---|
| copy refused (key collision) | original | intact | the error |
| commit of the copy | original | intact | the error |
| drop refused | original | intact | the error |
| rename | missing | in the shadow table, named in the error | the wrapped error |
| index re-creation | new key, index missing | intact | the error |
| final commit | new key | intact | the error, though the key did change |

The last row is a statement that reports failure after its effect landed. With nothing staged, it takes a module that fails a commit with no work in it. The rows are safe, so accept it and record it as a `NOTE:` on the commit call. Re-issuing the statement should then be a no-op, but that was not run. From the code, the discarded event batch means no `alter` event is delivered in that case, which is a gap for a syncing peer; this was not run.

## Tests

Add to the rebuild `describe` in `alter-table-conformance.spec.ts`:

- A subquery CHECK whose subject has moved, and a plain foreign key with an orphan: each re-keys, keeps its rows, and still refuses a new violating write. These go through different builders, so each gets an arm.
- The backlog ticket's two `with context` shapes re-key and keep their rows.
- A module commit failing while the copy commits: the original keeps its old key and rows, and no shadow remains.
- A module commit failing after the swap: rows kept. Arm the failure from a wrapped `renameTable`, because the order of commits across connections is not stable enough to count.
- `renameTable` throwing: the error names the shadow, the shadow holds the rows, and the recovery statement in the message works once the failure is cleared.

Add to `apply-schema-restore.spec.ts`: a one-step apply over an orphan row keeps its rows and the new key.

To fail a commit, wrap `db.registerConnection` and replace `commit` on the connection it receives. Wrapping `createConnection` on the table never fired when tried.

## TODO

- Add the commit and its tripwire `NOTE:` after the copy in `rebuildViaShadowTable`, plus the `NOTE:` on the final-commit case.
- Add the `InsertStmt` marker, the three skips in `buildInsertStmt`, and make `_parseSql` `@internal`; run the copy through it.
- Keep the shadow in the catch once it holds the only copy, and raise the wrapped error naming it.
- Rewrite the `rebuildViaShadowTable` docblock: the apply bullet's reason is no longer "rolls back the row copy". The explicit-transaction bullet still holds, since committing there would commit the user's transaction behind their back.
- Remove the copy's `NOTE:` pointing at `bug-rebuild-copy-refused-when-table-reads-context`, and re-read the event-suppression `NOTE:` above the scope: a module's commit-time events for the copy now arrive inside the scope, while events deferred to a later tick can still leak.
- Reword `rebuildNotOnlyEffectError`: "would leave the table empty" is no longer true. The reason a multi-step apply is refused is now that the rebuild commits part-way, so it would commit the earlier steps and could not be rolled back with the later ones. Check tests that match this message.
- Update `docs/schema-undo-plan.md` § A primary-key rebuild: rewrite the paragraph on the rejected commit (it names this ticket), and check the reasons given for the seed-row and `endSchemaBatch` conditions. Keep those refusals; a failing seed or batch end would need an undo that is itself a rebuild, so loosening them is separate work.
- Update `docs/module-authoring-schema-changes.md` (the explicit-transaction and apply bullets), `docs/sql-alter.md` (the same two preconditions, plus that the rebuild commits the copy before the swap and does not re-judge rows), `docs/schema-declarative.md` (line ~154) and `docs/module-events.md` (line ~281, commit-time events).
- Add the tests above, confirming each fails without its part of the fix.
- Delete `tickets/backlog/bug-rebuild-copy-refused-when-table-reads-context.md` once its two shapes pass.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test`.
