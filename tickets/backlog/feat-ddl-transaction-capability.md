----
description: Quereus has never decided whether schema changes belong to the surrounding transaction — today a rolled-back transaction still leaves a newly created index behind. Decide the intended semantics, and let a caller ask a storage backend what it actually guarantees.
files:
  - packages/quereus/src/vtab/capabilities.ts            # ModuleCapabilities — advisory vs engine-consulted flags
  - packages/quereus/src/vtab/memory/layer/manager.ts    # createIndex / addConstraint / alterTable — write outside the coordinator
  - packages/quereus-store/src/common/store-module.ts    # renameTable DDL-commits the coordinator (~1806)
  - docs/module-authoring.md                             # § Capability negotiation surface
  - docs/memory-table.md
  - docs/store.md
----

# What are the transaction semantics of DDL?

## The gap

`create index`, `alter table … add constraint`, and friends write their catalog entry and
their physical structures immediately, outside the transaction coordinator. A `rollback`
does not undo them. Nothing in the codebase says whether that is the intended contract or an
accident, and different backends already diverge:

- **memory** — DDL mutates the base layer directly; rollback leaves the index behind.
- **store** — `renameTable` explicitly commits the whole module's buffered writes before
  moving the on-disk directory, and documents that ALTER is "effectively DDL-committing".
  Other ALTER arms do neither.

Today the leftover-index case is benign: every reader re-validates an index entry against
the live row before returning it, so a stale entry cannot manufacture a wrong result. But
"benign" is a property nobody wrote down and nobody tests.

## Why now

Two fix tickets (`bug-memory-ddl-validation-ignores-pending-rows`,
`bug-store-add-constraint-unique-ignores-pending-rows`) close the case where DDL's
existing-row validation ignored the transaction's own uncommitted rows. They deliberately
stop short of making DDL itself transactional. The remaining question is the one Nate posed:

> Quereus should *support* the cleanest version of transaction semantics (both DML and DDL)
> for modules that fully cooperate. Modules may have degraded capabilities; for those we do
> some combination of trying to make up for shortcomings and documenting the limits of our
> guarantees — preferably providing a way to query those capabilities.

## What this ticket is for

Decide, then expose:

1. **The reference semantics.** What does a fully-cooperating module promise? Presumably:
   a schema change is buffered with the transaction, visible to statements after it within
   that transaction, and discarded whole on rollback — catalog entry, physical structures,
   and all.

2. **The degraded tiers.** Name them concretely. At minimum there is *DDL auto-commits*
   (the schema change and every buffered write become durable at DDL time; a later rollback
   undoes nothing — the store's `renameTable` posture today) and *DDL is non-transactional*
   (the schema change escapes the transaction but buffered DML does not — the memory backend
   today).

3. **The query surface.** A `ModuleCapabilities` field, e.g. `ddlTransactionality:
   'transactional' | 'auto-commit' | 'non-transactional'`. Note that most existing
   `ModuleCapabilities` flags are advisory and engine-consulted by nothing; decide whether
   this one gates engine behavior (e.g. refusing `create index` inside an explicit
   transaction on a non-transactional module unless a pragma opts in) or joins the advisory
   set. If advisory, say so in the doc comment, as the others do.

4. **The write-up.** `docs/module-authoring.md` § Capability negotiation surface, plus the
   backend-specific consequences in `docs/memory-table.md` and `docs/store.md`.

Whether to *raise* either native backend to the transactional tier is out of scope for the
decision itself — file it separately if the answer is yes. Both would need a
transaction-scoped catalog, which `SchemaManager` does not have.
