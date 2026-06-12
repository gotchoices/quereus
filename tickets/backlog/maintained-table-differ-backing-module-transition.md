description: The declarative differ silently ignores a backing-module (`using <module>(...)`) change on a maintained table — a regression from the pre-6.3 MV bucket (which drop+recreated to migrate the backing). Surface the module on the table comparison and decide attach/detach/migrate semantics, or make the silent-ignore an explicit, surfaced decision.
files:
  - packages/quereus/src/schema/catalog.ts                          # CatalogTable carries no module field; CatalogTable.maintained has backingModuleName/Args but the differ ignores them
  - packages/quereus/src/schema/schema-differ.ts                    # applyMaintainedTransition / computeTableAlterDiff — no module comparison; note where the standalone MV loop used to compare module separately
  - packages/quereus/test/declarative-equivalence.spec.ts           # two "backing-module change … NOT auto-detected (documented gap)" tests pin the no-op (~line 1447, 1505)
  - docs/materialized-views.md                                      # § Declarative-schema integration "Backing-module change (known gap)"
----

# Maintained-table backing-module change: differ silent no-op

## Background

Ticket 6.3 (`maintained-table-differ-transitions`) unified maintained tables into
the table category and dissolved the standalone materialized-view diff bucket.
That bucket used to compare the backing module (`using <module>(...)`) as a
**separate field** (normalized: absent ⇒ memory, `mem` aliased; args under a
stable-key-order render) and, on a mismatch, schedule a **drop + recreate** that
re-materialized the backing into the newly declared module.

After 6.3, a maintained table is compared per-name in the table category and the
differ tracks **no module field for a table** (`CatalogTable` carries none — the
`maintained` descriptor records `backingModuleName`/`backingModuleArgs` but
`applyMaintainedTransition` never reads them). So:

```sql
-- live: maintained table m backed by the memory default
declare schema main {
  table t { id integer primary key, x integer not null }
  materialized view m using mem2() as select id, x from t   -- want: migrate backing into mem2
}
apply schema main;   -- SILENT NO-OP: m stays memory-backed, no error, no warning
```

This is **documented** (`docs/materialized-views.md` § Declarative-schema
integration, "Backing-module change (known gap)") and **pinned** by two tests
asserting the no-op. The 6.3 rationale: an in-place module move is destructive
(drop+create) and was scoped out, achieving "parity with a plain table" (plain
tables also don't track module changes).

## Why this needs a decision

The plain-table parity argument is weak for a maintained table: a maintained
table's backing module **did** round-trip and migrate before 6.3, the capability
exists in the runtime (the old MV path re-materialized into the new module), and
the change is **silent** — a user who declares `using <store>()` expecting the
backing to move to the synced store (the migration.md "place the backing in the
synced store module" story) gets nothing, with no diagnostic. For the
declarative-schema / sync use case this is the difference between a table being
replicated and not.

Possible resolutions (pick during plan):

- **Surface + migrate.** Add a module dimension to the table comparison (the
  `maintained` descriptor already carries `backingModuleName`/`backingModuleArgs`;
  thread them into `applyMaintainedTransition`, normalized the same way the old MV
  loop did). On drift, emit `drop maintained → drop table → create … using <new>`
  (or a dedicated migrate verb if one is warranted) so the backing physically
  moves — restoring the pre-6.3 behavior within the unified model. Note this is a
  destructive, incarnation-minting op (unlike the non-destructive body re-attach),
  so it must be opt-in / clearly distinct from a refresh.
- **Surface + reject.** If an in-place module move stays out of scope, at least
  detect the drift and raise a sited error/warning at diff time ("backing-module
  change on maintained table m is not supported declaratively; drop+recreate
  manually") rather than silently ignoring it.

Either way, the two `NOT auto-detected (documented gap)` tests and the
materialized-views.md gap note must be updated to match the chosen behavior.

## Acceptance

- A declared backing-module (or args) change on a maintained table either
  migrates the backing or surfaces a diagnostic — it is no longer a silent no-op.
- Idempotence holds: re-applying an unchanged schema (including an explicit
  `using memory()` against a default-backed table) produces an empty diff.
- Docs and the pinning tests reflect the chosen semantics; full declarative suite
  green.
