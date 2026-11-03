# Undo Plan

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

How the declarative migration planner records, on every step of a plan, the statements that take that step back, the two rules that make an undo correct under renames, and how `apply schema` uses the result to unwind a migration that failed partway or whose final commit a module refused ([§ Restoring a failed apply](#restoring-a-failed-apply)). A satellite of [Schema Management](schema.md); the plan ordering it unwinds is described there under [Declarative Schema](schema.md#declarative-schema), and the user-facing guarantee under [Failure and restoration](schema.md#failure-and-restoration).

`generateMigrationPlan(diff, schemaName, actual)` — given the same pre-apply `SchemaCatalog` that `computeSchemaDiff` was handed — also records, on every step, how to take that step back: `undo`, the DDL statements (in execution order) that return the catalog to the state the step found it in, or `irreversible`, a user-readable reason why no statement can. An empty `undo` means the step changed nothing (an `IF EXISTS` drop of an object that was already absent). `generateMigrationDDL` never passes a catalog, so `diff schema` output and cost are untouched; without the catalog nothing about the undo is computed. The undo is plain SQL text, not an AST: it only ever runs on an executor's failure path, where re-parsing a handful of short statements costs nothing.

Two rules make an undo correct, and every arm of the planner honours both:

1. **Spell the target the way the forward step spelled it.** The unwind runs in reverse, so when a step's undo runs every later step has already been taken back and the catalog is in the state the step itself left behind. Table renames are the plan's first steps, so a later `ALTER TABLE t …` step — and its undo — name the post-rename table, and the planner finds the pre-apply table under its old name.
2. **Forward-apply the renames in force to anything taken from the pre-apply catalog.** A restored constraint, view, assertion or derivation body, a column default and the old primary key are all spelled with pre-rename names in the catalog. The renames whose steps *precede* the step are still in force when its undo runs, so the planner applies them to the body forward — through the same `renameTableInAst` / `renameColumnInAst` walkers the live rename propagation uses, so the two cannot drift. This is the differ's rename-reconciled comparison (`reconciledDeclaredBody`, [Rename Detection § Constraint body-change detection](schema-rename-detection.md#constraint-body-change-detection-droprecreate)) pointed the other way. Only *preceding* renames count: a view dropped before the column-rename phase is restored with the old column names, because by the time its undo runs the column rename has already been reversed.

The planner tracks the renames in force as it pushes the plan (`UndoRenderer` in `schema-differ.ts`), so every catalog lookup and every body rewrite goes through exactly the renames whose steps came before. Undo per step:

| forward step | undo |
|---|---|
| `ALTER TABLE a RENAME TO b` | `ALTER TABLE b RENAME TO a` |
| `DROP ASSERTION IF EXISTS a` / `DROP VIEW IF EXISTS v` | the `create assertion` / `create view` rendered from the catalog's body AST (`CatalogAssertion.check`, `CatalogView.select` + `columns`) through the same renderers the create buckets use |
| `DROP INDEX IF EXISTS i` | the catalog's index DDL re-parsed, re-targeted at the table's current name, re-rendered |
| `ALTER TABLE t DROP MAINTAINED` | `alter table t set maintained [(cols)] as <body>` from the catalog's derivation body and recorded column list |
| `CREATE TABLE` / `VIEW` / `INDEX` / `ASSERTION` (incl. the materialized-view sugar) | `DROP … IF EXISTS` of the object the statement names |
| `RENAME COLUMN a TO b` / `RENAME CONSTRAINT a TO b` | the reverse rename |
| `ADD COLUMN c …` | `DROP CONSTRAINT` of each inline CHECK, newest first, then `DROP COLUMN c`. `DROP COLUMN` refuses a column a CHECK names, its own included, while the module's `DROP COLUMN` already prunes an inline UNIQUE or foreign key. A stored CHECK name is predicted by running the forward step's own mint (`extractColumnLevelCheckConstraints`) over a per-table set of taken names, seeded from the catalog and kept across the plan's `ADD COLUMN` steps. A name a `create unique index` took is the one miss, because the catalog does not record it: the undo then fails and the apply reports the schema as not restored |
| `ADD constraint c …` | `DROP CONSTRAINT c` (the name parsed from the fragment) |
| `DROP DEFAULT` / `SET DEFAULT e` / `SET COLLATE x` / `SET NOT NULL` / `DROP NOT NULL` | restore the catalog's default (or `DROP DEFAULT` when there was none — and after a `dropStaleDefaultFirst` clear, the column reaches `SET DEFAULT` with no default, so that undo is `DROP DEFAULT`), collation, or the opposite nullability |
| `DROP CONSTRAINT c` | `ADD constraint c <body> [with tags]` from the catalog's full-fidelity constraint lift (`namedConstraints[].bodyAst`, or `unnamedConstraints[].bodyAst` for an unnamed constraint dropped by its stored auto-name, which the re-add restores — deferrability survives; the canonical `definition` has dropped it) |
| `ALTER PRIMARY KEY (new)` | `ALTER PRIMARY KEY (old)` from the catalog's `primaryKey`, column names spelled through the renames in force |
| any `SET TAGS` (table, column, constraint, view, index; either verb) | the same verb with the catalog's tag set; the empty set restores "no tags" |
| `SET MAINTAINED … AS <new>` | the prior `set maintained … as <old>` when the table was maintained at that step; `DROP MAINTAINED` when it was plain — including the re-attach reshape leg, where this same plan detached it earlier, so the pair composes back to the original derivation |
| `DROP TABLE IF EXISTS t` / `DROP COLUMN c` / `ALTER COLUMN c SET DATA TYPE T` | **irreversible** |


Exactly three steps are irreversible, and they are the data-destroying ones: no catalog bookkeeping restores rows or values the storage module already threw away, and restoring the *catalog* alone would be worse than a partial apply (the apply would be reported as fully undone while the table sits emptied). A step whose target the pre-apply catalog does not mention — including a name a rename in force has vacated, since whatever sits under it now this plan created — undoes to nothing rather than being marked irreversible (its forward statement is a no-op or fails before changing anything); a catalog entry that lacks what its restore needs — a hand-built catalog with no body AST, an index whose recorded DDL does not parse — is reported as `irreversible` with the reason, never thrown, so a partial diff literal in a test cannot break the planner.

## Restoring a failed apply

`apply schema` executes the plan through `runBatchedMigrationLoop` (`runtime/emit/schema-declarative.ts`), which keeps an **undo journal**: the `undo` of every step that succeeded, in execution order (a step whose `undo` is empty pushes nothing). What happens on a failing step depends on whether the journal is still trustworthy:

1. **Before executing a step marked `irreversible`, the journal is poisoned** — before, not after, because the step may apply partially before it throws, so its own failure must not be treated as restorable either. Once poisoned, journaling stops.
2. **On a failure with an unpoisoned journal**, the journal runs in reverse (each step's undo statements in their own order) through the same nested-statement path the forward steps used, still inside the module batch. The catalog is then re-collected and its `renderCatalogForRestoreCheck` rendering compared to the one taken before the first step ran. That rendering is the applied-state comparison rendering minus a table's and a view's `ddl` text, which record storage order and text history the differ does not consider: `ADD CONSTRAINT` appends, so a dropped-and-restored constraint comes back last in the table's DDL; and the rename propagation rewrites `ViewSchema.sql` to the body alone, so a rename and its reverse leave a view's text spelled differently. Everything an undo can touch is in the structured fields.
3. **`endSchemaBatch(error)` fires**, with the step's original error, after the unwind — so a module that discards its overlay on error discards the forward and the undo DDL together and rewinds to the pre-apply substrate, while a module with no batch hooks has had both applied for real. Either way the substrate agrees with the catalog. (On an *unrestorable* failure no unwind ran, and a module that discards its overlay would rewind a substrate the catalog still describes as migrated — no built-in module discards today; the `endSchemaBatch` contract in `vtab/module.ts` carries the note.)
4. **The error is thrown.** A verified restore rethrows the step's own `Failed to execute DDL: …` error unchanged and retracts every schema event batched since the apply began. Otherwise the error is wrapped: the original message first, then one of three reasons — *the earlier step `X` cannot be undone (…)* (or *the failing step `X` cannot be undone*, when the irreversible step is the one that failed), *undo statement `Y` failed (…)*, or *after unwinding, the catalog does not match its pre-apply state* — with the original error as `cause`, and the schema events of the landed steps are kept — delivered at commit inside an explicit transaction; in autocommit the failed statement's implicit transaction rolls back and drops them, as it does for any failed DDL statement whose catalog change escaped (see [Usage](usage.md)).

An undo statement that throws stops the unwind where it is: the schema is then in a state neither the user nor the plan asked for, and continuing past a failed undo would only compound it. A failure on the first step has an empty journal and passes its error through untouched. If `beginSchemaBatch` itself throws, no step ran and nothing is unwound. Seeding runs after the loop and is outside the guarantee.

### A refused commit

A module that throws from `endSchemaBatch` after every step ran has refused to commit, so the apply failed even though no step did. `endSchemaBatch` still fires on every other module, and the first refusal in firing order (reverse registration order) becomes the primary error; the rest are logged. Then:

1. **If the journal is poisoned, nothing is unwound.** The error is wrapped with the *earlier step `X` cannot be undone* reason, with the refusal as `cause`, and the schema events are kept.
2. **Otherwise a second batch opens.** The first batch is closed, so `beginSchemaBatch` fires again on every module, and the journal runs and is verified exactly as for a failed step. A `beginSchemaBatch` that throws here means no undo ran: the reason is *the module batch could not be reopened for the unwind (…)*.
3. **The second batch always ends with no error, even when an undo statement failed.** A module whose first commit landed has to commit the undo that did run, so its store matches the catalog as far as the unwind got, and an error would tell a discarding module to throw that away.
4. **The verdict.** An undo failure or a fingerprint mismatch is reported first, and any refusal of the second end is then only logged. Otherwise the second end's refusals are judged by registered module name against the first end's:

   | module's first `endSchemaBatch` | it refuses the second | why |
   |---|---|---|
   | threw | tolerated and logged | its store still holds the pre-apply state, which is what the `endSchemaBatch` contract requires a refusal to mean |
   | succeeded | not restored: *module `x` committed the migration and then refused to commit its undo (…)* | its store holds the forward change under a restored catalog, which the fingerprint check cannot see |

5. **The error is thrown** from the same site as a failed step. A verified restore rethrows the primary error unchanged and retracts the schema events; the next apply re-plans and re-sends the DDL. Otherwise the wrapped error carries the primary error's message, then the reason, with the primary error as `cause` (a thrown value that is not an `Error` contributes only its text) and the events are kept.

A step failure followed by a refused end stays a step failure: the step's error is reported and the refusal is logged.

Two limits are reported rather than solved:

- **A poisoned journal leaves the catalog ahead of the store.** The catalog keeps the forward change while the refusing store may not have it, so a retry diffs clean and can report success with nothing written. Retrying does not repair this; the wrapped error is the signal, and a fresh `Database` over the store is how the catalog is re-read. The `NOTE:` on `endSchemaBatch` describes the same mismatch for an unrestorable step failure.
- **An undo statement that itself needs the store** can fail if the store is why the commit was refused (a module whose `dropIndex` first builds the table, say). The apply then reports *undo statement `Y` failed (…)*, with no special case.

Why an undo journal rather than transactional DDL: the undo statements are ordinary DDL, so this works identically on every module tier (`transactional`, `non-transactional`, `auto-commit`) and needs nothing new from module authors. On an `auto-commit` module the forward DDL may have force-committed the surrounding transaction; the undo DDL commits the same way, so the end state is still the pre-apply catalog. Raising the built-in backends to the transactional tier is separate work (`feat-transactional-ddl-native-backends`) and would not change the contract described here.
