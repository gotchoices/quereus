description: When two open connections share one table and one of them changes the table's columns, the other connection keeps using its old column list and reads values under the wrong names or writes them into the wrong columns. Make that connection fail with a clear "table definition changed, re-open" error instead of silently returning or storing wrong data.
architecture: docs/schema.md
files:
  - packages/quereus/src/runtime/emit/scan.ts                 # scan leaf connect (line ~147) — passes no tableSchema to connect
  - packages/quereus/src/runtime/utils.ts                     # getVTable — DML connect (line ~144)
  - packages/quereus/src/runtime/emit/remote-query.ts         # pushdown connect (line ~25)
  - packages/quereus/src/runtime/emit/analyze.ts              # ANALYZE connect (line ~122)
  - packages/quereus/src/vtab/table.ts                        # VirtualTable.tableSchema (optional; the module's live definition)
  - packages/quereus/src/schema/table.ts                      # TableSchema / ColumnSchema shape
  - packages/quereus/src/common/types.ts                      # StatusCode.SCHEMA = 17
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts  # existing two-connection test whose comment points at this ticket (line ~427)
  - packages/quereus-isolation/test/alter-tags-forwarding.spec.ts   # two-connection test that must keep passing after a tag-only change
  - docs/schema.md
repro: verified
---

# Problem

Each `Database` keeps its own catalog (its record of tables and their columns). Two `Database` objects can register the same module instance and so share one physical table — the isolation layer's design and tests use this shape deliberately (per-connection overlays, overlay "poison" when another connection's DDL strands staged rows; see `docs/design-isolation-challenges.md`). When connection A alters the table, only A's catalog is updated. Connection B plans every later statement against its stale entry, and the module hands back rows in the new layout. Nothing checks that the two agree.

Reproduced on both the isolation-wrapped memory module and a plain shared `MemoryTableModule` (so this is engine-level, not isolation-specific). Table `t (id integer primary key, x integer, z text)` with row `(1, 1, 'zz')`; B's catalog mirrors A's entry (`dbB.schemaManager.getMainSchema().addTable(dbA.schemaManager.getTable('main','t')!)`); A runs the ALTER; then B:

| A runs | B `select * from t` | B `insert into t (id, x, z) values (2, 2, 'w')`, then A reads |
|---|---|---|
| `add column c integer default 7` | `{id:1, x:1, z:'zz', col_3:7}` — extra value under a placeholder name | succeeds; memory leg stores the row with `c` missing (`{id:2,x:2,z:'w'}` — no `c` at all) |
| `drop column x` | `{id:1, x:'zz'}` — z's value reported as x | succeeds; stores `{id:2, z:2}` (x's value lands in z) and on plain memory a third stray value `col_2:'w'` in a two-column table |
| `rename column x to y` | `{id:1, x:1, z:'zz'}` — old name, harmless | succeeds, positionally correct |

So after DROP COLUMN, B silently corrupts the table. Severity is corruption, not just mislabelling.

# Decision taken in this fix stage

The ticket's own minimum ("a connection must never silently return rows read against a stale column list; failing loudly and telling it to re-read is acceptable") is settled enough to build. Automatically adopting the other connection's change is a separate feature, parked as `feat-connection-adopts-another-connections-schema-change` in `backlog/`.

# Design: a stale-catalog guard at table connect

Every runtime path that turns a catalog table into a live `VirtualTable` calls `module.connect(...)` — four sites in `packages/quereus/src/runtime` (scan leaf, `getVTable` for DML, remote-query pushdown, ANALYZE). The returned instance optionally exposes `tableSchema`, which is the module's *live* definition (memory: the manager's current schema; isolation: the underlying's). Right after connect, compare it with the connecting `Database`'s **current catalog entry** for that table (`db.schemaManager.getTable(schemaName, name)`), and throw `QuereusError(..., StatusCode.SCHEMA)` naming the table when the row layout differs, e.g. "table main.t was altered outside this connection; its definition here is stale — re-open the connection".

Put the check in one shared helper all four sites call (DRY; one place to reason about), not inline per site.

**Compare against the current catalog entry, not the plan's schema.** Within one `Database` the catalog is always updated by the same ALTER that updated the module, so the check never fires on a single connection. Comparing to the plan's schema instead would false-positive on plans legitimately frozen earlier in the same connection — a deferred constraint's plan is frozen at row-write time and can be evaluated after a later ADD COLUMN in the same transaction (see the `tableNameRemap` comment in `scan.ts` around line 120). Note the scan site connects under `effectiveName` (post-rename) — look the catalog up under that name.

**Fast path:** if the catalog entry and the module's schema are the same object, they agree; skip the comparison. That is the normal single-connection case for the memory module. Only fall through to a structural comparison when the objects differ (store modules may rebuild their schema object; the mirrored-catalog case shares the *old* object while the module holds a new one).

**What "row layout differs" means.** Compare what decides how a stored row's values are read and written:
- column count, and per column in order: name (case-insensitive), logical type, collation, not-null, generated-ness;
- the primary-key definition (column indexes and direction).

Deliberately **excluded**: tags (A's `alter table … set tags` must not break B — `alter-tags-forwarding.spec.ts` has the module rewrite tags while `other` keeps reading and committing), statistics/row estimates, aux data, and table-level constraints (CHECK, FOREIGN KEY, UNIQUE). Constraint drift is real (B would not enforce a CHECK that A added) but it does not misplace values; it belongs to the backlog follow-up. Whether a column's DEFAULT belongs in the comparison is the implementer's call — leaning include, since B inserting with a stale default writes a value A's definition would not have.

**When the module's instance has no `tableSchema`** (it is optional on `VirtualTable`, and some modules populate it lazily — see `IsolatedTable.ensureOverlay`), skip the check. Modules that cannot report their live definition get no protection; say so in docs.

# Risks the implementer must check

- **A window inside A's own DDL** where the module already holds the new definition but A's catalog has not been updated yet (the engine registers the module's answer *after* `alterTable` returns). Any scan the engine runs in that window — e.g. a validation or rebuild scan during ALTER — would false-positive. Run the full suite; if it trips, the fix is to recognise that window (e.g. skip when the plan's schema is identical to the module's), not to weaken the comparison.
- **Store module** (`yarn test:store`) builds schema objects of its own; confirm the structural comparison treats an equivalent rebuilt schema as equal (collation and type spellings in particular).
- **The existing two-connection ADD COLUMN test** in `packages/quereus-isolation/test/alter-table-conformance.spec.ts` (~line 420–476) expects B's next read after A's ALTER to throw `CONSTRAINT` (overlay poison). With the guard, B's read will throw `SCHEMA` first. B's **commit** still has to throw `CONSTRAINT` (commit flushes through `commitConnectionOverlays`, which does not connect through the engine) — that is the assertion that protects data. Update the read assertion to expect `SCHEMA` and rewrite the comment that points at this ticket ("separate, tracked gap … in `tickets/backlog/`") to describe the guard instead. Confirm B can still `rollback` afterwards.
- **A statement already running in B** when A alters (async interleaving between two `Database`s) is not covered — the check runs at connect, and an in-flight cursor is past it. Leave a `NOTE:` tripwire at the helper; do not try to solve it here.
- **Separate processes or separate module instances** over one persistent store (e.g. two `StoreModule`s on one LevelDB path) are not covered: there, B's module instance is as stale as B's catalog, so both sides agree with each other. Document as out of scope.

# Test

One reproduction test, at the engine layer (plain shared `MemoryTableModule`, no isolation), in `packages/quereus/test/` (Mocha): two `Database`s, B mirrors A's catalog entry, A runs `alter table t drop column x`; B's `select * from t` and B's `insert` both throw `StatusCode.SCHEMA`, and the table's committed rows are unchanged afterwards. A second case: A runs `alter table t set tags (...)` (or another non-layout change) and B keeps working — this pins the "tags excluded" branch. Don't add per-ALTER-kind matrix tests.

# TODO

- Add the shared post-connect guard helper (runtime layer) with the layout comparison and identity fast path; throw `StatusCode.SCHEMA` with the qualified table name.
- Call it from the scan leaf, `getVTable`, remote-query and ANALYZE connect sites (scan: use `effectiveName` for the catalog lookup).
- Add the `NOTE:` tripwire for in-flight statements at the helper.
- Add the reproduction test in `packages/quereus/test/`.
- Update `alter-table-conformance.spec.ts`'s two-connection ADD COLUMN test (read → `SCHEMA`; commit stays `CONSTRAINT`) and its comment.
- Document in `docs/schema.md`: catalogs are per-`Database`; a connection whose catalog disagrees with the module's live row layout fails with `SCHEMA` at connect; tags/constraints are not compared; modules without `tableSchema` and cross-process stores are not covered. Cross-link from `docs/design-isolation-layer.md` near "Overlays are per-connection" (line ~124).
- Run `yarn test`, `yarn test:store`, and `yarn lint` (quereus package).
