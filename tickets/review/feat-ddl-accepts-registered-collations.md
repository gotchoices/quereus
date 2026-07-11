description: Verify that declaring a table column with a custom text-sorting rule the application registered on the connection is now accepted, while an unregistered rule is rejected up front for every column type.
prereq:
files:
  - packages/quereus/src/schema/table.ts                 # validateCollationForType (rewritten), columnDefToSchema (4th param)
  - packages/quereus/src/core/database.ts                # isCollationRegistered() added after registerCollation
  - packages/quereus/src/core/database-internal.ts       # isCollationRegistered on DatabaseInternal
  - packages/quereus/src/schema/manager.ts               # buildColumnSchemas threads predicate (CREATE + importTable)
  - packages/quereus/src/runtime/emit/alter-table.ts     # runAlterColumn SET COLLATE threads rctx.db predicate
  - packages/quereus/src/vtab/memory/layer/manager.ts    # alterColumn / addColumn / renameColumn thread this.db predicate
  - packages/quereus-store/src/common/store-module.ts    # alterColumnSetCollation / alterAddColumn / alterRenameColumn thread db predicate
  - packages/quereus-isolation/src/isolation-module.ts   # deriveAddColumnBackfill threads db predicate
  - packages/quereus/src/planner/analysis/sat-checker.ts # tryResolve doc updated: unknown-branch now DDL-unreachable (tripwire)
  - packages/quereus/test/vtab/memory-collation-per-database.spec.ts       # new "column DDL accepts a registered collation" describe + INTEGER-frobnicate flip
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts         # e2e test rewritten to register the collation
  - packages/quereus-isolation/test/collation-resolver.spec.ts              # FROBNICATE assertion flipped to "Unknown collation"
  - docs/schema.md                                       # createTable § "Column COLLATE validation (declaration time)"
----

# Review: column DDL accepts registered collations

## What the change does (plain terms)

Before: declaring `create table t (k text collate REVERSE …)` was **rejected** even
after `db.registerCollation('REVERSE', …)`, because the column-DDL collation gate only
checked a hard-coded per-type list (`TEXT` allows `BINARY`/`NOCASE`/`RTRIM`). The same
gate *accepted* any name — registered or not — on `INTEGER`/`REAL`/`BLOB` (types with no
list), which then failed later at comparator-build with `no such collation sequence: X`.

After: the gate (`validateCollationForType`) is **registry-aware**. An explicit column
`COLLATE`:
- `BINARY` → always accepted (fast-path);
- a name on the type's list (TEXT's built-ins) → accepted;
- an *empty*-list type (`JSON`, `DATE`/`TIME`/`DATETIME`/`TIMESPAN`) → every non-BINARY
  name rejected, registered or not;
- otherwise (TEXT off-list, OR a no-list type) → accepted **iff the connection has the
  collation registered**, else rejected with `Unknown collation '<name>' for type '<type>' …`.

The predicate is `db.isCollationRegistered(name)` (new public method on `Database`, also
on the `DatabaseInternal` interface). It is threaded into every column-DDL site that has a
live `db`: CREATE + catalog rehydrate (`buildColumnSchemas`, the shared choke point),
engine `ALTER COLUMN SET COLLATE`, memory `addColumn`/`renameColumn`/`alterColumn`, store
`alterAddColumn`/`alterRenameColumn`/`alterColumnSetCollation`, and isolation
`deriveAddColumnBackfill`. Db-less callers (`createBasicSchema`, unit tests, the view-MV
DDL helper) pass no predicate and keep the legacy static-list behavior byte-for-byte
(the one exception: `collate binary` on a JSON/temporal column now *accepts* instead of
throwing, via the BINARY fast-path — a strict improvement; no test pinned the old throw).

## Behavior changes reviewers should confirm are intended

1. **`INTEGER/REAL/BLOB collate <unregistered>` now rejected at DDL** (was accepted, then
   failed at comparator build). This is the headline tightening. Flipped tests:
   `memory-collation-per-database.spec.ts` (INTEGER-frobnicate → `Unknown collation`),
   `quereus-isolation/test/collation-resolver.spec.ts` (FROBNICATE → `Unknown collation`).
2. **Reopen re-validates against the registry.** Because `importTable` shares
   `buildColumnSchemas`, a persisted column declaring a custom collation reopens cleanly
   **only if** the collation is re-registered; otherwise DDL rehydrate throws
   `Unknown collation`. This is the same loud, no-silent-fallback failure the key-collation
   resolver seam already produces — consistent, not a new hazard.
3. **`collate binary` on JSON/temporal now accepted** (BINARY fast-path precedes the
   empty-list throw).

## Use cases to exercise / validate

Primary (in `memory-collation-per-database.spec.ts`, all passing):
```sql
-- with REVERSE registered on the connection:
create table t (k text collate REVERSE primary key);   -- now succeeds
insert into t values ('a'),('b'),('c');
select k from t;   -- c, b, a  (REVERSE = descending PK walk)
```
- registered custom collation on TEXT PK → accepted + orders descending (headline);
- case/whitespace variants (`reverse`, `REVERSE`, `"  ReVeRsE "`) resolve identically;
- registered built-in (`nocase`) on INTEGER → accepted no-op;
- registered custom collation on JSON → still rejected (empty-list precedence);
- `collate binary` on JSON → accepted (fast-path);
- `alter table … set collate REVERSE` (registered) → accepted; unregistered → rejected;
- reopen round-trip: replay CREATE DDL with re-registration → succeeds; without → throws.

Cross-package: isolation `create table … collate MYCOLL … using isolated` (registered)
accepted; FROBNICATE rejected. Store SET COLLATE built-ins covered by `41.7*` sqllogic
under store mode.

## Tests run (this is a floor, not a ceiling)

- `yarn workspace @quereus/quereus run lint` → **exit 0** (eslint + `tsc` typecheck of specs).
- `yarn build` (tsc -b, all packages + apps) → **clean**.
- `yarn workspace @quereus/quereus run test` (memory) → **6968 passing, 0 failing**.
- Full isolation mocha suite → **245 passing**; full store mocha spec suite → **948 passing**.
- Store-mode collation sqllogic (`QUEREUS_TEST_STORE=true`, grep `41.7|102.1|102.2|43.1`) →
  **7 passing** (exercises the store ALTER-COLLATE path with built-ins).

## Known gaps / honest flags for the reviewer

- **Store custom-collation SET COLLATE / CREATE not driven with a *custom* collation.**
  `.sqllogic` can't call `registerCollation`, so store-mode coverage of a REGISTERED
  custom collation (vs built-ins) on CREATE and on `ALTER … SET COLLATE` — including the
  store's physical PK re-key path — is not exercised. The store code change is mechanical
  (threads the same predicate the memory path uses), and the memory spec covers the custom
  path end-to-end, but a store `.spec.ts` mirroring `memory-collation-per-database.spec.ts`
  (registering a collation in JS) would close this. **Full `yarn test:store` (all logic
  tests under LevelDB) was NOT run** — only the store *unit* spec suite and the filtered
  store-mode collation sqllogic. Consider running it if the store ALTER paths warrant it.
- **Isolation/store test edits are not tsc-typechecked.** Only `@quereus/quereus` has a
  real lint; the isolation/store `lint` scripts are no-ops (per AGENTS.md). Those two test
  files ran green under mocha (ts-node strips types, does not typecheck). The edits are a
  string literal + comments, so risk is low, but they had no compiler pass.
- **`sat-checker.ts` `unknown` branch is now DDL-unreachable (tripwire, not a ticket).**
  The predicate-contradiction checker's defensive "answer `unknown` instead of throwing on
  an unresolvable column collation" can no longer be reached via CREATE (DDL rejects the
  unregistered name up front). The guard is kept as cheap insurance for any future path;
  the reasoning is recorded as a `NOTE:` at the site (`tryResolve` doc comment) and the
  branch stays directly unit-tested at `predicate-contradiction.spec.ts:294`. No action
  unless a future path reintroduces an unvalidated collation onto a column.

## Not touched (deliberately)

- `resolveDefaultCollation` (the *implicit* default, no explicit COLLATE) — unchanged; it
  never consults the registry, preserving create/apply parity.
- `extractDeclaredCollation` (schema differ) — never calls `validateCollationForType`;
  create/apply parity preserved.
