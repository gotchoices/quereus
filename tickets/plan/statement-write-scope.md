description: Let a host or a virtual-table module ask a write statement (INSERT, UPDATE, DELETE) where each value it writes comes from, which other rows it read to decide its effect, and which constraints its writes are subject to — so a module that queues writes offline can predict whether another writer could make a queued write fail.
architecture: docs/change-scope.md
files: packages/quereus/src/core/statement.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/vtab/, docs/change-scope.md, docs/module-authoring.md
difficulty: hard
----

Requested by the Optimystic project for its offline-sync design (`docs/offline-sync.md` in the optimystic repository, section "What the analysis needs from Quereus"). Optimystic's stages that consume this are parked in its backlog until a Quereus release carries it; nothing here should be shaped around Optimystic beyond what a general host or module would also want.

## The use case

A module that acknowledges a commit locally and sends it to the network later needs to tell the application, at commit time, whether another writer could make that write fail when it is replayed over newer state. Most writes cannot fail — a row inserted under a fresh random id — and a few can — a row inserted under a natural key, an update of a row other people edit. Telling them apart needs facts only the planner has.

## What exists

`Statement.getChangeScope()` reports, per table, which columns a statement reads and whether each read is pinned to rows, groups or the whole table (binding modes from `analyzeRowSpecific` / `extractBindings`), plus `nonDeterministicSources` (time, random, volatile functions, parameters). It deliberately reports no watches for DML without `RETURNING`.

## What is wanted

A statement-level description of a **write**, available two ways:

- **Host-facing:** `Statement.getWriteScope()` beside `getChangeScope()`, for a prepared DML statement.
- **Module-facing:** the same description for the statement currently calling a virtual table's `update()`, through a hook the module can read at staging time (a field on `UpdateArgs`, or a per-statement callback on the connection — the plan should pick one and say why).

The description carries:

- **Read scope of everything the statement reads to decide its effect** — its `WHERE`, `SET` and `VALUES` expressions, its source query, and the constraint checks its writes trigger — with binding modes, and with the target row's own key read separated from the rest.
- **Per written column, the provenance of the value:** a literal; a parameter; a context variable; a fresh source (a function flagged as producing a value unique per call with at least 128 bits of entropy — e.g. a 16-byte random function, a UUIDv4 function, or a module-registered function such as Optimystic's `StampId()` — or a deterministic function of one); the row's own previous values (`set n = n + 1`); or other rows. How a module marks its own function as a fresh source needs a flag (e.g. on `FunctionFlags`).
- **How target rows were chosen:** by a key equality (`row`) or by another predicate (`global`).
- **The constraints the write is subject to**, each classed as row-local or cross-row (foreign keys, CHECKs with subqueries, assertions, deferred constraints).
- **Self-independence:** whether every written value is independent of the row's own previous values, so re-applying the write to its own result changes nothing. This is not the existing `PhysicalProperties.idempotent` ("safe to evaluate twice in one transaction") and must be stated separately.
- **The conflict disposition** (`or ignore`, `on conflict do nothing`, `or replace`, plain).

**Conservative by construction:** anything the analysis cannot describe is reported as unknown (provenance "other rows", selection `global`), the same rule row classification follows ("when uncertain, classify as global").

## Done when

The API exists with tests over representative statements (insert of literals / parameters / a random function / a select; update by key with `set x = :p` and `set n = n + 1`; update by predicate; delete by key; a write under a foreign key and a subquery CHECK), `docs/change-scope.md` (or a sibling doc) documents it, and `docs/module-authoring.md` documents the module hook.
