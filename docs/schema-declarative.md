# Declarative Schema

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

The `declare schema` / `apply schema` pipeline: how a declared schema is diffed against the catalog, the order a migration runs in, how a failed apply is restored, and the seed, hashing and declared-schema APIs around it. The rest of the schema subsystem is in [schema.md](schema.md).


The `declare schema` / `diff schema` / `apply schema` workflow provides order-independent, end-state schema declarations: the engine diffs against the current catalog (`computeSchemaDiff`) and builds an ordered migration plan (`generateMigrationPlan`). Key diff types:

- `SchemaDiff` — tables/views/indexes/assertions to create, drop, alter, or rename
- `MigrationCreate` — one entry of a create bucket: the rendered DDL text (`sql`) paired with the exact statement AST it was rendered from (`ast`). A view create also carries `viewReach`, the names its body names plus the views reached from them through declared view bodies, which the planner orders creates by and does not copy onto the plan step
- `MigrationStep` — one statement of the plan: `sql` always, plus `ast` when the step came from a statement rather than a template string, plus `undo` / `irreversible` when the plan was built with the pre-apply catalog (see [Undo Plan](schema-undo-plan.md))
- `TableAlterDiff` — columns to rename, add, alter, or drop within an existing table; named-constraint rename / drop / add (`constraintsToRename` / `constraintsToDrop` / `constraintsToAdd`)
- `ColumnAttributeChange` — per-column attribute drift within `columnsToAlter`: nullability, data type, default, **collation**, and tags. Each surfaces as the matching `ALTER COLUMN … SET …` statement. Column collation is projected into the diff catalog (`CatalogTable.columns[].collation`, default `'BINARY'`) so the differ detects a `COLLATE` change as it does a type or default change; an absent `COLLATE` and an explicit `COLLATE BINARY` compare equal (no spurious diff). Unlike tags, collation is **behavioral** and participates in the schema hash.

- `SchemaDiff.maintainedModuleMigrations` — backing-module moves on maintained tables (a declared `using <module>(args)` change on a `materialized view` / `create table … maintained as`). Each is realized as a **destructive drop+recreate** (the DROP rides `tablesToDrop`; the recreate, which re-materializes the body into the new module, rides `tablesToCreate`), minting a new incarnation. Surfaced unconditionally by `diff schema`; **gated** at `apply schema` on `allow_destructive` (see below). See [Materialized Views § Declarative-schema integration](materialized-views.md#declarative-schema-integration).

Destructive changes require explicit acknowledgement. The maintained-table backing-module move is the one case currently **enforced**: `apply schema` aborts (before any DDL runs) unless re-run with `options (allow_destructive = true)`, since the new incarnation changes row identity for a replicated/synced table. See the [SQL Reference](sql-ddl.md#20-declarative-schema-optional-order-independent) for the full gating contract and syntax.

Direct `create table` / `create view` DDL and the corresponding `declare schema` + `apply schema` body are guaranteed to produce indistinguishable catalogs and runtime behaviour.

## Applied-state snapshot (the unchanged-schema fast path)

Re-applying an unchanged declaration used to pay for a full comparison to be told nothing changed, and `computeSchemaDiff` is two thirds to three quarters of a no-op apply's cost. `apply schema` therefore keeps, per `Database` and per (lowercased) schema name, an **applied-state snapshot**: what the declaration rendered to, what the live catalog rendered to, and the effective `default_collation`, as of the end of the last successful apply whose migration plan came out **empty**.

On the next apply the physical branch collects the catalog as before, re-renders both sides, and compares. On a three-way match it skips `computeSchemaDiff` and `generateMigrationPlan` entirely; everything else — schema creation, the seed loop, the empty-plan hook behaviour — is unchanged.

| | rendered by | includes |
|---|---|---|
| declared side | `renderDeclaredSchemaCanonical` (`schema/schema-hasher.ts`) | the `isLogical` kind prefix + `generateDeclaredDDL`, **tags included** |
| catalog side | `renderCatalogForComparison` (`schema/catalog-rendering.ts`) | every field of every `Catalog*` interface, each category sorted so live `Map` insertion order cannot matter |

**Why skipping is sound.** `computeSchemaDiff(declared, catalog, renamePolicy, defaultCollation)` reads nothing but its four arguments. On a hit, two of them render identically to the recorded strings and the third is compared directly; the remaining one, `renamePolicy`, is inert when there are no differences — there are no name-change pairs for a policy to police. (`allow_destructive` likewise only gates a non-empty `diff.maintainedModuleMigrations`.) So the diff would again be empty.

**Duplicate-name checks are among the skipped work.** `computeSchemaDiff` is also where the
`table`/`view`/`materialized view` and `assertion` duplicate-declared-name rejection
([SCH-003](invariants.md#sch-003--a-declared-schema-names-each-object-once)) and the declared-index-name
arm of the per-schema index-name-uniqueness check ([SCH-001](invariants.md#sch-001--index-names-are-unique-per-schema))
live, so the fast path skips them too. That is safe rather than a hole for the same reason as above:
a snapshot is recorded only after a diff that *succeeded*, so it can never describe a
duplicate-bearing declaration, and adding a duplicate changes the declared rendering — which makes
the fast path miss and the diff run. Any future declaration-shape guard added to the differ
inherits the same requirement: it must be defeated by a change the declared rendering shows.

**Why it is recorded only after a verified-empty plan.** At write time this process has *observed*, via a real diff, that the catalog matches the declaration. Two consequences are features rather than accidents:

- The very first apply on a fresh database migrates, so it records nothing; the *second* apply diffs, finds the plan empty, and records; the third and later are fast. This preserves `apply schema`'s self-healing property — if DDL generation were ever imperfect, a repeat apply still re-diffs rather than being told by a cache that everything is fine.
- A failed apply (a mid-migration DDL failure, a module refusing the final commit, a seed failure) records nothing, so the next apply reconciles in full. A snapshot an *earlier* apply recorded stays valid across a later restored failure, precisely because the restore returns the catalog to the state that snapshot describes (see [Failure and restoration](#failure-and-restoration)).

A snapshot is a claim about a *pair* of renderings — "these two were once verified equal" — not about a moment in time, so it survives a later re-`declare schema` (a byte-identical redeclaration still renders the same and still hits) and survives an intervening migrating apply (drift makes the compare miss; repairing the drift makes it match again). `removeDeclaredSchema` clears it, since nothing is left to compare against.

**Not covered, deliberately:**

- **`diff schema`** — a preview; no cache read, no cache write, ever.
- **`explain schema`** — keeps returning the tag-stripped version hash (see [Schema Hashing](#schema-hashing)).
- **Logical schemas / lenses** — the `isLogical` branch returns before catalog collection and has real side effects on every apply (lens compile, snapshot rotation, module notification). No fast path there.
- **Reserved-tag warning advisories** — `computeSchemaDiff` raises tag diagnostics. The `severity:'error'` ones throw, so an apply that recorded a snapshot never had one; the `severity:'warning'` ones go to a debug logger and are not re-logged on a fast-pathed apply. This is the one observable difference, and it is debug-log-only.
- **A second `Database` over the same store, or a store reopen** — each connection has its own `DeclaredSchemaManager` and starts with an empty snapshot map, so it always reconciles first. In particular this does **not** help the declare-and-apply-once-per-process-start case; serving that needs the snapshot persisted alongside the catalog.

Measured on the synthetic 54-table / 14-view declaration of `bench/apply-schema-unchanged.mjs` (median of 9, one Windows box — treat the ratios as the finding):

| declaration | full-diff no-op | fast-pathed no-op | |
|---|---|---|---|
| 20.4 KB | 1.52 ms | 0.64 ms | 58% off |
| 62.9 KB | 3.13 ms | 1.14 ms | 64% off |
| 112.7 KB | 5.64 ms | 1.52 ms | 73% off |

The fast path removes `computeSchemaDiff` (0.86 / 2.30 / 4.35 ms) and adds a catalog render plus a string compare (0.17 / 0.40 / 0.56 ms and 0.004 / 0.012 / 0.017 ms); `collectSchemaCatalog` (0.26 / 0.46 / 0.67 ms) is still paid on both paths. Storing the rendered strings rather than hashing them is what removes hash-collision risk from the comparison — the cost is memory proportional to the schema's DDL (309 KB catalog + 109 KB declaration at the top size measured). The *encoding* is still separator-delimited rather than uniquely decodable: a tag value or string `DEFAULT` containing a raw newline reaches the rendering verbatim, so text crafted to imitate another item's rendering can in principle make two different catalogs render alike. See the `NOTE:` on `renderCatalogForComparison` and `tickets/backlog/debt-catalog-rendering-injective-encoding`.

## Logical schemas and lenses

`declare logical schema X { ... }` declares a design-only schema (`kind: 'logical'`) — columns and *logical* constraints, no module / index / storage. At `apply schema X` the lens compiler aligns each logical table against a basis schema and registers an inlined effective view body, so reads ride the standard view path and writes ride [view updateability](view-updateability.md).

`declare lens for X over Y { view T as <select> ... }` is a **sibling statement** (parsed to `DeclareLensStmt`, stored on `DeclaredSchemaManager` keyed by the logical schema name) that binds logical schema `X` to an **explicit basis** `Y` and supplies per-table sparse overrides:

```sql
declare logical schema X { table Car (id int primary key, maxSpeed int, color text); }
declare lens for X over Y {
  view Car as select id, speed as maxSpeed from Y.CarCore;   -- rename; color gap-filled
}
apply schema X;
```

The override projection covers some columns (by output name); the default mapper gap-fills the rest from the override's `FROM`, and every logical column must end up mapped (an uncovered column the basis cannot back is a compile error). `over Y` is the explicit basis, resolving the auto-inference ambiguity with multiple physical bases. Inspect the composed result with `quereus_effective_lens(schema, table)`. See [Lenses and Layered Schemas](lens.md) for the full model — the name-based / re-read-from-source merge and the gap-fill fidelity boundary.

### Acknowledging lens advisories (`quereus.lens.ack.*` / `quereus.lens.policy.*`)

At `apply schema X` the lens prover emits **coded, sited advisories** (`lens.no-backing-index`, `lens.no-answering-structure`, `lens.partial-override`, `lens.getput-lossy`) onto the deploy report. A developer accepts one in source with a reserved tag on the logical table (or a constraint), so the suppression is version-controlled and reviewable rather than an out-of-band suppress-list:

```sql
declare logical schema X {
  table Car (id int primary key, vin text, unique (vin))
    with tags (
      -- acknowledge the no-backing-index advisory for the vin constraint:
      "quereus.lens.ack.no-backing-index:vin" = 'low-write table; commit-time scan accepted',
      -- (optional) force a conscious decision on that code for this table:
      "quereus.lens.policy.require-ack" = 'lens.no-backing-index'
    );
}
```

- **`quereus.lens.ack.<code>[:<target>]`** — acknowledges the advisory whose `<code>` (the `lens.`-stripped advisory code) it names; the optional `:<target>` narrows to a column/constraint. The value is a **required rationale**; an empty rationale still suppresses but surfaces an empty-rationale meta-warning on the report. A trailing `#fp=<digest>` token records the advisory's fingerprint (it round-trips through DDL export) so the advisory **re-surfaces** when the underlying facts change; a bare rationale, with no `#fp=`, is honored unconditionally.
- **`quereus.lens.policy.error-on` / `quereus.lens.policy.require-ack`** — a per-logical-table escalation policy (CSV of advisory codes, **default-empty**). `error-on` codes are always hard errors an ack cannot suppress; `require-ack` codes are hard errors only when *un*-acknowledged (a valid ack clears them). Escalation errors abort the deploy atomically alongside the prover's blocking errors.

The deploy summary tallies `acknowledged: N` (`LensDeployReport.acknowledged.length`); `select * from quereus_lens_advisories('x')` expands the full list — one row per advisory with its `status` (`active` / `re-surfaced` / `acknowledged` / `acknowledged-unconditional`), rationale, and current/recorded fingerprints. All `quereus.lens.*` tag shape/site validation lives in the typed registry `src/schema/reserved-tags.ts`. For the governance model — which facts each fingerprint covers, the cardinality bands, and the full status semantics — see [Lenses and Layered Schemas](lens.md).

## Migration Order

`generateMigrationPlan` is the single ordering authority; `generateMigrationDDL` is a thin wrapper over it (`plan.map(s => s.sql)`). `diff schema` shows the wrapper's strings; `apply schema` walks the plan. Because the preview text and the executed statement are two fields of one object, the two can never disagree.

A create step (and the `set maintained as` re-attach) carries the statement AST its DDL was rendered from, so `apply schema` executes a **spine clone** of it instead of re-lexing text the differ just produced. The clone is required, not defensive polish: a step's AST is (a subtree of) the statement `DeclaredSchemaManager` holds — the schema qualifiers spread only the outermost node, so a view's `select`, an assertion's body and a `set maintained as` body are the declaration's own subtrees on **every** target schema — while the create emitters retain what they execute (`ViewSchema.selectAst` and its assertion / maintained-table counterparts) and rename propagation rewrites those catalog bodies *in place*. Handing over the original node would let a later `ALTER TABLE … RENAME` silently rewrite the declaration, at which point `diff schema` stops reporting the drift it exists to report. Because `spineCloneAst` copies the whole statement while the catalog retains only a few subtrees of it, the clone costs roughly what the parse it replaces costs (measured over 68 creates: 0.91 ms clone vs 1.07 ms parse on a 20.4 KB declaration; 3.57 ms vs 3.13 ms on a 112.7 KB one) — so a create-heavy `apply schema` nets a few percent off the migration loop, not the large win the uncloned form appeared to offer. Reclaiming it means moving ownership into the create emitters so each copies only what it stores. Template-built steps (renames, drops, column/constraint alters, `SET TAGS`) carry no AST and are parsed as before. Either way the log line and the `Failed to execute DDL: …` wrapper name `step.sql`, so error text is identical on both branches. One consequence: an error raised while executing a create now carries the source location of the **declaration**, not of the generated DDL string — on the *cause*, since the `Failed to execute DDL: …` wrapper supplies no line/column of its own.

Pairing the two guarantees they name the same statement, but it does not by itself guarantee they *mean* the same statement — a renderer that dropped a field would make `apply schema` do more than `diff schema` previewed. `schema-differ.spec.ts` § "the paired AST and its rendered DDL mean the same statement" pins that property over every create form: re-parsing a create's own `sql` must reproduce its `ast`, modulo source positions and exactly two normalizations the schema builder applies anyway — collation-name case (`validateCollationForType` upper-cases) and `moduleArgs: {}` vs absent (`resolveModuleInfo` does `stmt.moduleArgs || {}`). Adding a field to a create's AST node without teaching `ast-stringify` to render it fails there.

The plan produces DDL in a fixed order:

1. **Renames first** — `ALTER TABLE ... RENAME TO` for **tables** with a stable identity hint (`quereus.id` / `quereus.previous_name`). This frees the old name before any create reuses it and lets the engine's rename rewriter propagate references through dependents. Hinted **view / index** renames emit no DDL here (no rename primitive exists) — they are realized as drop(old) + recreate(declared) in the phases below; the non-table `RenameOp`s on `SchemaDiff.renames` are metadata only.
2. **Drops second** — `DROP TABLE`, `DROP VIEW`, `DROP INDEX` for objects neither declared nor consumed by a rename. A view is dropped ahead of every view it reaches through the pre-apply catalog's view bodies, including through a view that stays, so the restore can recreate them in reverse (see [Restoring a failed apply](schema-undo-plan.md#restoring-a-failed-apply)). A plan where no dropped view reaches another keeps its order: declared views first, in declaration order, then removed ones in catalog order. The walk sees only the schema being applied, so a chain that passes through another schema's view gives no order.
3. **Creates third** — `CREATE TABLE` for new objects. A table a foreign key names is created before the table naming it, so a module that checks or resolves a foreign key as the child is created sees the parent first. The sort is stable on declaration order (`orderDependenciesFirst`), and tables in a cycle keep declaration order. A maintained create stays after every create written before it, because it plans its body as it runs and that body can read any of them. A foreign key whose parent is a maintained create does not affect the order. `CREATE VIEW` is *not* here: it is sorted into stage 2 of step 4. `CREATE INDEX` and `CREATE ASSERTION` are not here either: they run after step 4 (see below).
4. **Alters and view creates** — in stages that span every altered table, because an `ALTER` validates what it refers to and one table's statement can refer to what another table's statement changes. A table's own steps keep the relative order the stages give them.
   1. `RENAME COLUMN`, all tables, so every later statement in any table sees post-rename names.
   2. Per table: `ADD COLUMN`, `ALTER COLUMN`, `RENAME CONSTRAINT` then `DROP CONSTRAINT` (free or remove a name before any re-add, and drop a UNIQUE before the PK change so it can't strand a PK dependency), then `ALTER PRIMARY KEY`. A table comes after the tables and new views its added columns name in an inline foreign key or a DEFAULT, CHECK or generated expression, because those arrive inside `ADD COLUMN`, and after any new view those views reach. These steps stay together per table because `ADD COLUMN … references t` checks `t`'s primary key as it stands, so it has to run after `t`'s own `ALTER PRIMARY KEY`.

      `CREATE VIEW` runs in this stage too, because it plans its body as it runs. A view is created after every table's stage 2 steps, unless a table's added column reads it, directly or through other declared views, including an existing view over a view this plan recreates. Then it goes ahead of that table. A new view also follows the new views it reaches, whether its body names them or it reads them through other declared views, including one this plan leaves alone. A chain that passes through another schema's view gives no order, so write the view it reaches first. The view is ordered after every altered table, not only the ones it names, because a table it reaches through an existing view is not in its statement, and `diff schema` plans without a catalog. Where those preferences conflict, following a table the view's body names wins. A view statement executes as declared, since `RENAME COLUMN` has already run.
   3. `ADD CONSTRAINT`, all tables, after every table's columns and key are in place. Named foreign keys in two tables can therefore point at each other's new columns.
   4. `DROP COLUMN`, all tables, after every table's `DROP CONSTRAINT` has cleared the guards that refuse dropping a column still referred to. A DEFAULT or generated expression has no constraint to drop first, so a table's drops come before those of the tables its dropped columns' expressions read.
   5. `SET TAGS`, all tables, last, because a constraint's tags can name a constraint from stage 3.

   Tables with no such reference between them keep declaration order in every stage, using one stable sort (`orderDependenciesFirst`, `schema/dependency-order.ts`): the earliest declared table whose dependencies are met goes next, and tables in a cycle keep declaration order, unless a new view that one of them reads has to run after another of them. A plan that alters one table is simply that table's steps in stage order.
5. **Index and assertion creates last** — `CREATE INDEX` and `CREATE ASSERTION`, after every table alter and maintained re-attach. Both resolve their columns/body against the live catalog, so one that references a column the same plan adds (`ADD COLUMN`) or renames (`RENAME COLUMN`) must run after it. Nothing in the alter block depends on a new index existing, and `DROP INDEX` stays in step 2 so a version that removes an index together with its column still works.

This ordering frees dropped tables' names before creates run. It also means the order tables are written in does not decide whether a declaration applies, when some order of the plan's steps can reach the end state. A constraint `ADD` lands after all `CREATE TABLE`s and every table's column and key changes, so a declared FK added to an existing table can reference a freshly-declared parent, or a column another existing table gains in the same plan.

**Known limits.** The stage 2 and stage 4 ordering works per table. It finds tables from names written directly in a column definition. These cases are not covered:

- **Inline references that form a cycle.** `t.d … references u(z)` beside `u.z … references t(d)` fails in every order, because each needs the other inside `ADD COLUMN`. Declare at least one as a named table-level foreign key, which moves it to stage 3.
- **A cycle that exists only between tables.** `t.d … references u(z)` needs the new `u.z`, while `u.z … references t(id)` names a column `t` already has. Read per table this is a cycle, so declaration order holds: `u` written first applies, `t` written first fails. The same workaround applies.
- **References through a view.** A DEFAULT reading an existing view over `t` gives no ordering edge to `t`, so declaration order holds. Adding: `u.z … default ((select max(d) from v))` with `v` as `select * from t` fails when `u` is written first and `t` gains `d`. Dropping: the same `u.z` and `t.d` both removed fail when `t` is written first.
- **A table that gains a column and a reader of a new view over it.** `t` gaining `d` and also `z … default ((select m from w))`, with `w` a new view reading `t.d`, fails: stage 2 keeps one table's steps together, so `w` runs first and does not find `d`. The same holds for a CHECK or generated column. Splitting the added columns would change the order columns are declared in. Add `d` in an earlier apply.
- **Dropped columns whose expressions read each other.** Neither `DROP COLUMN` can go first. Remove the DEFAULTs in an earlier apply.

A failure while adding a column reports the step's error and restores the catalog. A refused `DROP COLUMN` instead reports the schema as **partially migrated**: the step is marked irreversible before it runs, so the plan's earlier steps stay applied even though the refused drop itself changed nothing (see [Failure and restoration](#failure-and-restoration)). A `CREATE VIEW` that fails after a `SET DATA TYPE` in the same plan reports the same, because the retype has already run and cannot be undone. Correct the declaration and re-apply.

## Undo plan

Moved to [Undo Plan](schema-undo-plan.md).

## Failure and restoration

A migrating `apply schema` is **all-or-nothing**, with one stated residual. The loop executes the plan under an undo journal; when a step fails, the journal runs in reverse, the catalog is checked against its pre-apply state, and the step's own error is rethrown — the apply either happened or it did not. The residual is a data-destroying step: `DROP TABLE`, `DROP COLUMN` and `ALTER COLUMN … SET DATA TYPE` are the three the planner marks `irreversible`, and once one has run (or is the step that failed) the apply is no longer restorable. A later failure then reports the schema as **partially migrated**, naming the step that cannot be undone, with the original failure as `cause`; the same wrapped error is raised when an undo statement itself fails or the post-unwind catalog does not match.

The guarantee also covers a **refused commit**: a module that throws from `endSchemaBatch` after every step ran fails the apply just as a failing step does. The apply is unwound and the module's own error is rethrown, so a retry re-plans and re-sends the DDL. The same residual applies: if a data-destroying step ran, nothing is unwound and the error reports the schema as partially migrated, with the module's error as `cause`. The catalog is then ahead of a store that refused, so a retry diffs clean and can succeed with nothing written; retrying does not repair it.

The undo cannot take back a commit, so a **primary-key change that needs a rebuild is refused** unless it is everything the apply does. A module that cannot re-key in place changes a key through the engine's shadow-table rebuild, which commits its row copy before dropping the original. An apply runs in one transaction, so that commit would commit the earlier steps, and a later failure could not take the rebuild back. A rebuild therefore runs only when the plan has exactly one step, no seed rows will be applied, and no registered module defines `endSchemaBatch` (any of them could refuse the commit). Otherwise the apply fails with `ERROR`, naming the table and module; run `alter table … alter primary key (…)` on its own in autocommit, then re-apply. A module that re-keys in place, as both built-in backends do, never reaches this. Detail: [Undo Plan § A primary-key rebuild](schema-undo-plan.md#a-primary-key-rebuild).

The undo is ordinary DDL, so the restore is **tier-independent** (every `ddlTransactionality` tier, nothing new for module authors). After a failed step it runs inside the module batch, before `endSchemaBatch(error)` fires; after a refused commit that batch is closed, so it runs in a second one. Inside an explicit transaction a failed apply restores to the pre-apply point and leaves the transaction open — savepoint-like. Under `ddl_transaction_policy = 'strict'` a refused forward step is unwound like any other failure, with no new exposure. A restored failure announces no schema events; an unrestorable one keeps the events of the steps that landed. Outside the guarantee: **seeding** (`with seed` runs after the loop, so a malformed seed row aborts with the migration already applied) and a table's **constraint storage order** (a restored constraint is re-appended; the differ keys constraints by name and is unaffected). Executor detail: [Undo Plan § Restoring a failed apply](schema-undo-plan.md#restoring-a-failed-apply).

## Redefining what a rule reads

No statement replaces a view in place, so a changed view is planned as `DROP VIEW` plus `CREATE VIEW`, and a maintained table moving to another backing module as `DROP TABLE` plus a recreate. A table's CHECK, DEFAULT or generated expression may read such an object, directly or through further views, and the guard on the drop (`assertNoExpressionDependsOn`) refuses to break it. Inside `apply schema` that refusal has one exception:

**A drop passes the guard when this plan creates the same object again under the same name**: the name is in both `viewsToDrop` and `viewsToCreate`, or both `tablesToDrop` and `tablesToCreate` (`objectsRecreatedByDiff`, held on `Database._setSchemaRecreatedObjects` around the migration loop). Otherwise the guard stays on. A declaration that removes a view while a CHECK still reaches it, directly or mid-chain, is refused, and so is a hinted view rename, which is a different name on each side, and a view replaced by a table of the same name, which spans the two buckets. Nothing writes rows while the object is absent, because seeds run after the plan.

**After the last step, the existing rows are judged.** Every row-invariant CHECK reaching a recreated object, on any table in any schema, is scanned by `rejectCheckViolatedByExistingRows`, the check `ADD CONSTRAINT` makes, so its `permitsGrandfatheredCheckViolators` opt-out and row-invariant filter apply the same way. This matches what a user has to write by hand (`drop constraint`, `drop view`, `create view`, `add constraint`):

| what reads the object | a new view the rows violate | a new view that lost the column |
|---|---|---|
| row-invariant CHECK | fails: `CHECK constraint failed` | fails, even with no rows: `Column not found` |
| `check on insert` / `check on update` | applies | applies; surfaces on the next write that uses it |
| DEFAULT or generated column | applies | applies; surfaces on the next write that uses it |

A failure takes the failed-step path: the plan is unwound, or the schema is reported as partially migrated if a `DROP TABLE` already ran. The message names the CHECK and what it reads, since its body may not mention the object: `apply schema 'main': CHECK constraint 'pc' on table 'P' reads recreated 'main.v1' through view 'v2' and fails: …`, with the scan's error as `cause`. The rows are judged against the new view alone, so rows that already broke the CHECK before the apply fail it too, as they would fail `ADD CONSTRAINT`.

**Assertions keep their guard.** An unchanged assertion that reaches a recreated object through views or maintained tables is dropped first and recreated last, as one that names the object directly already was, and `CREATE ASSERTION` plans its body, so a new view that lost a column it reads fails there. The walk follows both the declared bodies and the catalog's. The catalog's are what the guard follows when the drop runs, which matters for a maintained table the plan re-attaches off the object later; only the declared ones spell a table's new name when the plan also renames it.

An assertion that reaches an object going away for good is not dropped first and stays refused at the object's drop. Letting it go first would fail at its recreate instead, and by then a `DROP TABLE` would have destroyed the rows.

**Known limits.**

- `diff schema` output run by hand is refused at the `DROP VIEW`, because the exception exists only inside `apply schema`. The refusal names the CHECK, which is the way forward: drop it around the view.
- An assertion in another schema is not in the catalog the differ sees, so it is not dropped first and refuses the drop.
- A view removed together with the rule that reads it is refused, because view drops run before `DROP CONSTRAINT` (`bug-apply-schema-refuses-view-removed-with-its-check`).
- A view whose rule also reads a NOT NULL mutation-context variable cannot be redefined. The scan has no context to supply, so it refuses as `ADD CONSTRAINT` does, with that command's wording. The same is true by hand.

## Yielding during an apply

A long `apply schema` gives up the thread between migration steps, between undo statements and between seed rows, once it has held the thread for about one 60 Hz frame (16 ms). Timers, I/O callbacks and interface events can then run, including on a module whose hooks do no real waiting, where every `await` would otherwise settle without returning to the event loop. A short apply never yields.

**This does not cancel anything.** After a `Promise.race` loses to a timeout, the apply keeps running and finishes or fails on its own, and statements issued meanwhile queue behind it. An `AbortSignal` passed to `exec` does not reach the apply's own statements, so it does not stop an apply either. There is no way to cancel an apply today.

What other work sees during a yield:

- **Ordinary statements** queue behind the execution mutex and run after the apply, against its final catalog. This has always been so.
- **`readConcurrency: 'committed'` reads** also wait while the migration runs, because the catalog at that point may hold a table or column that a later failing step takes back. While seed rows run they do not wait: the catalog is final by then and the rows are uncommitted, so they are invisible. See [SQL Transactions § Concurrent committed reads](sql-txn.md#86-concurrent-committed-reads).
- **`db.close()`** does not wait for the apply. The apply's next statement is refused with `Database is closed` and the apply rejects. Undo statements are refused the same way, so once a migration step has landed the apply also reports the schema as not restored. Do not treat that as a clean rollback: a module that folds the apply into a batch discards it when `endSchemaBatch` receives the error, and a module with no batch hooks keeps the steps that ran. The outcome differs when no statement is left to refuse. If `close()` lands after the plan's last step and there is no seeding, the apply resolves, because every step ran and the batch ends with no error. If it lands just before a table's seed rows, the apply rejects saying the table was not found after migration. During seeding it rejects with the seed error and no not-restored line, since the migration had already finished.
- **Synchronous catalog APIs** (`db.defineTable`, `db.registerModule`, direct `db.schemaManager` access) and option setters take no mutex, so a timer can call them mid-apply and they are not protected. If such a call changes the catalog, the restore check notices it, on the failure path only. Synchronous reads, including `db.prepare(sql).getColumnNames()`, see the catalog as it stands mid-apply.

Some work cannot yield, because yields only fall between statements. One slow step cannot be split (an `ALTER` backfilling 50 000 rows was measured holding the thread for 77 ms), and neither can a single module hook. Planning is synchronous (53 ms at 8000 tables), and logical (lens) deployment is synchronous and is not paced.

## Rename Detection

Moved to [Rename Detection](schema-rename-detection.md#rename-detection).

## Module Batch Hooks

Virtual table modules may opt into a per-`apply schema` batch via the optional `beginSchemaBatch` / `endSchemaBatch` callbacks on `VirtualTableModule`. When the migration loop has at least one DDL statement, the engine calls `beginSchemaBatch(db, schemaName)` on every registered module defining it (in registration order), runs the loop, then calls `endSchemaBatch(db, schemaName, error?)` on those modules in reverse order — passing the loop error on failure, `undefined` on success.

This lets a storage-backed module fold the whole migration into one substrate commit: open an in-memory overlay in begin, have subsequent `create` / `destroy` / `alterTable` calls join it, then commit (or discard) in end. Modules without the hooks are skipped. The idempotent fast-path (no DDL to run) skips both hooks. A batch can span several event-loop turns even if the module's hooks never wait, because the apply [yields between steps](#yielding-during-an-apply).

If `beginSchemaBatch` itself throws, already-started modules receive `endSchemaBatch(error)` with the begin failure and the error propagates out of `apply schema`.

A throw from `endSchemaBatch` depends on what came before it. After a failed step it is logged, so the original cause survives. After a clean loop it is a refused commit, which fails the apply: the engine opens a second begin/end pair and runs the undo DDL inside it, so "exactly once" holds per begin rather than per apply. A refusal must mean nothing from that batch reached the store, and a module that refused may receive undo DDL for changes its store never received, which it must accept. See [Undo Plan § A refused commit](schema-undo-plan.md#a-refused-commit).

## Seed Data

Declared schemas can include seed data (`seed <tableName> values ...`). Under `apply schema ... with seed`:

1. Each declared seed row is written as `INSERT INTO <tbl> VALUES (…) ON CONFLICT (<pk-cols>) DO NOTHING` — **idempotent**: a re-apply skips seed PKs already present rather than colliding. User-edited and non-seed rows stay in place, so a reopen never destroys user data and fires no `ON DELETE CASCADE`. (A table whose PK is empty — a `primary key ()` singleton — falls back to the untargeted `ON CONFLICT DO NOTHING`.)
2. Per-table, after all structural migrations complete (and after `endSchemaBatch` fires).
3. On **both** apply paths. The [applied-state snapshot](#applied-state-snapshot-the-unchanged-schema-fast-path) elides the diff and the migration plan, nothing else — so a table emptied since the last apply gets its seed rows back, which is the behaviour a user relies on and the only reading consistent with "observably indistinguishable from a full apply whose diff came out empty". Seeding is idempotent, so the repeat costs no correctness.

**One block per table** (SCH-003): `setSeedData` overwrites by key, so a repeat drops the first block's rows. `declare schema` rejects it before storing anything; the differ never sees `seed` items, so the guard cannot live at diff time.

### Rejected alternatives

- **Wipe-then-reseed** (`DELETE FROM <tbl>` unless freshly created). Freshness comes from diffing the in-memory catalog, which a reopen does not rehydrate for host-backed row data, so an already-seeded table reads as fresh, the wipe is skipped, and the bare `INSERT`s collide with persisted rows.
- **`OR REPLACE`.** Delete-then-insert, so re-seeding a parent with `ON DELETE CASCADE` children fires that cascade on every reopen — even when the values are byte-for-byte identical.
- **`OR IGNORE`.** Skips a row on **any** constraint failure (SQLite semantics), so a malformed seed row — a `CHECK` violation, a missing `NOT NULL`, a dangling child FK — vanishes without a diagnostic.

Targeting the PK keeps errors visible: `DO NOTHING` suppresses a row only when the conflict is at the PK columns. Every other violation aborts the apply, including a duplicate on a **secondary** `UNIQUE` index (whose conflicting row carries a *different* PK).

## Schema Hashing

`explain schema [<name>]` returns a short hash of the declared schema, for versioning:

```sql
explain schema main;
-- Returns: hash:a1b2c3d4
explain schema main version '2.0';
-- Returns: version:2.0,hash:a1b2c3d4
```

**The version hash and the reconciliation rendering are different strings, deliberately.** Both go through `renderDeclaredSchemaCanonical` (`schema/schema-hasher.ts`), but `computeSchemaHash` calls it on a **tag-stripped** copy first, because tags are non-behavioral metadata and must not move a schema's version. The differ, by contrast, *does* diff tags and emits `ALTER … SET TAGS` steps for them — so the [applied-state snapshot](#applied-state-snapshot-the-unchanged-schema-fast-path) uses the tags-**inclusive** rendering. Reusing the version hash there would silently skip a tag-only edit. Do not conflate the two.

## DeclaredSchemaManager API

The `DeclaredSchemaManager` (via `db.declaredSchemaManager`) stores declared schema ASTs and seed data between `declare schema` and `apply schema` calls.

| Method | Description |
|--------|-------------|
| `setDeclaredSchema(schemaName, declaration)` | Stores a `DeclareSchemaStmt` AST |
| `getDeclaredSchema(schemaName)` | Retrieves stored declaration, or `undefined` |
| `hasDeclaredSchema(schemaName)` | Returns `true` if a declaration exists |
| `removeDeclaredSchema(schemaName)` | Removes declaration and its seed data |
| `setSeedData(schemaName, tableName, rows)` | Stores seed data rows (`SqlValue[][]`) for a table |
| `getSeedData(schemaName, tableName)` | Retrieves seed data for a specific table |
| `getAllSeedData(schemaName)` | Returns all seed data for a schema (`Map<string, SqlValue[][]>`) |
| `clearSeedData(schemaName)` | Clears all seed data for a schema |
| `getDeclaredRendering(schemaName)` | Canonical **tags-inclusive** rendering of the stored declaration (memoized), or `undefined` |
| `getAppliedSnapshot(schemaName)` | The [applied-state snapshot](#applied-state-snapshot-the-unchanged-schema-fast-path), or `undefined` |
| `setAppliedSnapshot(schemaName, snapshot)` | Records one — only valid after an apply that succeeded **and** produced an empty plan |

All name lookups are case-insensitive. The manager is stateful: re-declaring a schema clears its seed data and replaces earlier state. Re-declaring also drops the memoized rendering (it described the previous declaration) but **keeps** the applied snapshot, so a byte-identical redeclaration still takes the fast path; `removeDeclaredSchema` drops both.
