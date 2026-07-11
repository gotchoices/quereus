description: A custom text-sorting rule an application registered on the connection can now be named directly when declaring a table column, instead of being rejected because only the three built-in rules were accepted there.
prereq:
files:
  - packages/quereus/src/schema/table.ts                 # validateCollationForType ~194, columnDefToSchema ~255
  - packages/quereus/src/schema/manager.ts               # buildColumnSchemas ~1644 (CREATE + importTable share it)
  - packages/quereus/src/runtime/emit/alter-table.ts     # runAlterColumn SET COLLATE ~968
  - packages/quereus/src/core/database.ts                # registerCollation / _getCollation ~1567; add isCollationRegistered
  - packages/quereus/src/core/database-internal.ts       # DatabaseInternal — expose isCollationRegistered
  - packages/quereus/src/vtab/memory/layer/manager.ts    # alterColumn ~2038, addColumn ~1734, renameColumn ~1919
  - packages/quereus-store/src/common/store-module.ts    # alterColumnChange ~2187, alterAddColumn ~1418, alterRenameColumn ~1629
  - packages/quereus-isolation/src/isolation-module.ts   # deriveAddColumnBackfill ~1690
  - packages/quereus/test/vtab/memory-collation-per-database.spec.ts  # frobnicate-on-INTEGER test flips (see below)
  - packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic       # pins "Unknown collation" (unchanged)
  - packages/quereus/test/logic/41.7-alter-column-collate.sqllogic     # pins "Unknown collation ... for type 'TEXT'" (unchanged)
difficulty: medium
----

# Column DDL accepts registered collations

## Problem recap

`validateCollationForType` (`schema/table.ts:194`) gates a column's explicit
`COLLATE` clause against a **static list** hard-coded on each logical type
(`TEXT_TYPE.supportedCollations = ['BINARY','NOCASE','RTRIM']`). It never consults
the connection's collation registry, so:

- a collation the connection registered (`db.registerCollation('REVERSE', …)`) is
  **rejected** on a TEXT column even though it exists and works in `order by` and
  in index DDL;
- a collation nobody registered is **accepted** on `INTEGER`/`REAL`/`BLOB` (those
  types carry `supportedCollations === undefined`, which the gate reads as
  "anything goes"), only to fail later when a comparator is built.

Index DDL does not have this problem: `IndexColumnSchema.collation` is not gated by
the type's static list — the name simply resolves through `getCollationResolver`
at comparator-build time, which throws `no such collation sequence: X` on an
unregistered name. Column DDL is the only path that pre-validates against the
static list.

## Design

Make the gate **registry-aware** by passing an optional predicate
`isCollationRegistered?: (name: string) => boolean` into `validateCollationForType`
(and threading it through `columnDefToSchema`). Do **not** import `Database` into
`schema/table.ts` — that package sits under `schema/` and `Database` lives in
`core/`, so a direct import risks a cycle. A bare predicate keeps `schema/table.ts`
dependency-free and is trivially suppliable from every call site that has a `db`.

### New `validateCollationForType` semantics

```
normalized = normalizeCollationName(collation)
if normalized === 'BINARY':            return 'BINARY'          // always accepted

// No predicate supplied → LEGACY static-list behavior, byte-for-byte unchanged.
// (Preserves every db-less caller: createBasicSchema, tests, the view-MV DDL
//  helper. None of those carry an unregistered explicit collation on a no-list
//  type, so this branch never regresses.)
if isCollationRegistered === undefined:
    if type.supportedCollations && !type.supportedCollations.includes(normalized): throw
    return normalized

// Predicate supplied → registry-aware behavior:
list = type.supportedCollations
if list?.includes(normalized):         return normalized        // TEXT's BINARY/NOCASE/RTRIM

if list && list.length === 0:                                   // JSON / temporal
    throw  "... (type supports no collation other than BINARY)"

// Reaching here: TEXT + a name not in its list, OR a no-list type (INT/REAL/BLOB).
// Accept iff the connection has the collation registered; reject otherwise.
if isCollationRegistered(normalized):  return normalized
throw  "... (not a registered collation)"   // no-list type
       "... (expected one of: <list>, or a registered collation)"  // TEXT
```

This satisfies every requirement in the plan ticket:

- **registered collation on TEXT (or any non-empty-list custom type) → accepted**
  via the final `isCollationRegistered` branch;
- **unregistered collation → rejected for every type**, INT/REAL/BLOB included
  (they no longer fall through as "anything goes" once a predicate is present);
- **empty-list types (JSON, temporal) still reject every non-BINARY name**,
  registered or not (the `list.length === 0` throw fires before the registry
  branch);
- **error wording stays `Unknown collation …`** — keep that exact prefix and, for
  a TEXT column, the exact substring `Unknown collation 'X' for type 'TEXT'` that
  `41.7` pins. Only the parenthetical suffix varies by case (see the three throw
  messages above). Note the current message unconditionally does
  `type.supportedCollations.join(', ')`, which would throw on a no-list type — the
  new no-list message must NOT dereference the (undefined) list.

### The predicate

`BINARY` is fast-pathed before the predicate is ever consulted, and the built-ins
`NOCASE`/`RTRIM` are seeded into the registry by `registerDefaultCollations()`, so
the predicate is exactly "does the registry hold this name":
`db._getCollation(name) !== undefined`.

Add a small public method for DRY + greppability:

```ts
// core/database.ts
/** True iff `name` names a collation this connection can resolve — a built-in
 *  (BINARY/NOCASE/RTRIM) or one registered via {@link registerCollation}. The
 *  DDL-time counterpart of {@link getCollationResolver} that returns a boolean
 *  instead of throwing; used to gate an explicit column COLLATE. */
isCollationRegistered(name: string): boolean {
    return name.toUpperCase() === 'BINARY' || this._getCollation(name) !== undefined;
}
```

Expose it on the `DatabaseInternal` interface (`database-internal.ts`) too, so the
store and isolation packages can call it exactly as they already call
`_getCollationNormalizer` / `_getCollation` (they cast `this.db as
DatabaseInternal`). Every call site then passes
`(n) => db.isCollationRegistered(n)` (or `this.db.…`).

### What is NOT touched — and why

- **`resolveDefaultCollation`** (the *implicit* default, no explicit COLLATE) is
  unchanged. Its `supportedCollations?.includes()` gate is a separate, deliberate
  mechanism and the create/apply-parity contract rides on it.
- **`extractDeclaredCollation`** (schema-differ, `schema-differ.ts:2099`) is
  unchanged. It renders canonical collation names for diffing — an explicit
  COLLATE is `normalizeCollationName`'d, an absent one goes through
  `resolveDefaultCollation`. It never calls `validateCollationForType`, so the
  plan ticket's worry that threading a `db` "touches extractDeclaredCollation" does
  not materialize. Leave it alone; create/apply parity is preserved.

## Threading — where the predicate flows

Every caller below has a live `db`; pass the predicate. `columnDefToSchema` gains a
4th optional param `isCollationRegistered?` that it forwards to
`validateCollationForType`.

- **`schema/manager.ts::buildColumnSchemas`** — the single CREATE path, **also
  shared by `importTable`** (both call it; see `manager.ts:1840` and `:1907`). It
  is a method with `this.db`; build the predicate there and pass it into the
  `columnDefToSchema` map. This is the one change that covers both fresh CREATE and
  catalog rehydrate.
- **`runtime/emit/alter-table.ts::runAlterColumn`** — the `setCollation !==
  undefined` guard's `validateCollationForType` call (~line 968); pass from
  `rctx.db`.
- **`vtab/memory/layer/manager.ts`** — `alterColumn`'s `validateCollationForType`
  (~2038) and `addColumn`/`renameColumn`'s `columnDefToSchema` (~1734, ~1919); pass
  from `this.db`.
- **`quereus-store/store-module.ts`** — `alterColumnChange`'s
  `validateCollationForType` (~2187) and `alterAddColumn`/`alterRenameColumn`'s
  `columnDefToSchema` (~1418, ~1629); pass from `db`.
- **`quereus-isolation/isolation-module.ts::deriveAddColumnBackfill`** — the
  `columnDefToSchema` at ~1690. This site only reads `.notNull`/`.name` off the
  result, but it runs BEFORE the underlying ADD COLUMN, so if it threw on a valid
  custom collation it would spuriously reject a legal ALTER. Pass the predicate
  (from its `db` arg) so it accepts exactly what the underlying will.

Db-less callers pass nothing (undefined → legacy branch, unchanged):
`createBasicSchema` (`table.ts:437`), the `columnDefToSchema` unit tests, and the
`view-mv-ddl-persistence` DDL helper. None declare an unregistered explicit
collation on a no-list type, so the legacy branch is safe for them.

## Edge cases & interactions

- **`INTEGER collate frobnicate` now rejected at DDL, not at comparator build.**
  This is the headline tightening. `test/vtab/memory-collation-per-database.spec.ts`
  has a test ("unregistered collation → raises rather than silently byte-ordering")
  that today does `create table t (k integer collate frobnicate primary key)` and
  asserts `no such collation sequence: FROBNICATE` (the *resolver's* throw, because
  DDL let it through). After this change the DDL gate rejects it first with
  `Unknown collation`. **Update that test** to assert the new `Unknown collation`
  message for the INTEGER case, and update the file-header comment block that says
  "a *column* declaring `collate REVERSE` is still rejected at DDL by that gate —
  see `feat-ddl-accepts-registered-collations` in the backlog" (that caveat is now
  the thing being fixed). The sibling test that asserts `Unknown collation` for a
  TEXT column ("reports the DDL validation error first for a TEXT column") stays
  green.
- **`INTEGER collate nocase` still accepted** (NOCASE is registered) — a harmless
  no-op on a non-text column, unchanged from today. Only *unregistered* names on
  INT/REAL/BLOB flip from accept→reject.
- **`JSON`/`DATE`/`TIME`/`DATETIME`/`INTERVAL collate <anything-non-BINARY>` stays
  rejected**, registered or not (empty `supportedCollations` list). Add/keep a case
  proving a *registered* custom collation is still refused on JSON, so the
  empty-list precedence over the registry branch is pinned.
- **`collate binary` on JSON/temporal**: today this actually THROWS (empty list,
  `[].includes('BINARY')` is false). The new BINARY fast-path (returns before the
  predicate/list check) makes it *accepted* — a strict improvement and consistent
  with "rejecting every non-BINARY name". Add a case; if any existing test pinned
  the old throw, reconcile it (none found in a first sweep — confirm).
- **Reopen / catalog rehydrate without re-registration.** Because `importTable`
  shares `buildColumnSchemas`, reopening a persisted schema whose column declares a
  *custom* collation now re-validates against the registry at rehydrate. If the
  embedder has not re-registered that collation, DDL rehydrate throws `Unknown
  collation`. This is the SAME loud-failure `3.2-collation-resolver-seam` and the
  store's `validateKeyCollations` (`store-table.ts:431`) already produce for the
  key-collation path — it is consistent, intentional, and documented; it is NOT a
  new silent-fallback risk. Conversely, a persisted custom-collation column DOES
  reopen cleanly once the collation is re-registered (the predicate finds it),
  which the pre-fix code could not do at all. Add a round-trip test:
  register → create with custom collation → simulate reopen (re-register + replay
  DDL) → succeeds; reopen without re-register → throws `Unknown collation`.
- **Predicate must be present on BOTH CREATE and importTable arms.** If the
  predicate were passed on CREATE but omitted on rehydrate, a legally-created
  TEXT-custom-collation column would fail to reopen even *with* re-registration
  (the legacy branch ignores the registry and TEXT's static list has no custom
  name). `buildColumnSchemas` being the shared choke point makes this automatic —
  do not special-case importTable to skip it.
- **ALTER COLUMN SET COLLATE parity.** `runAlterColumn` (engine), the memory
  module, and the store module each re-run `validateCollationForType`; all three
  must pass the predicate so `alter table … alter column x set collate REVERSE`
  accepts a registered custom collation with the same rule as CREATE. The store's
  PK-column SET COLLATE physically re-keys — make sure a *custom* collation is
  keyable (has a normalizer) before that path; the store already rejects a
  normalizer-less collation on a keyed column via `validateKeyCollations`, so a
  comparator-only custom collation on a PK column should still fail there (not
  here) with its existing message. Verify the two throws don't collide confusingly.
- **Case-insensitivity / whitespace.** Names normalize via
  `normalizeCollationName` before the predicate; `_getCollation` also normalizes.
  Confirm `collate reverse`, `collate REVERSE`, and `collate "  ReVeRsE "` all
  resolve identically at the gate.
- **Cross-package build order.** `isCollationRegistered` on `DatabaseInternal`
  must land before store/isolation reference it, or `tsc -b` fails those packages.
  Add the interface member in the same change.

## Tests to add / update (TDD framing)

Primary — enables the deferred headline test from `3.3-memory-vtab-collation-resolver`:

```
-- with REVERSE registered on the connection:
create table t (k text collate REVERSE primary key);   -- now succeeds
insert into t values ('a'),('b'),('c');
select k from t;   -- expect c, b, a  (REVERSE = descending)
```

- **sqllogic** (`test/logic/`): a new file (or extend an existing collation file)
  driving the REVERSE-on-PK create + ordered read above. Note sqllogic can't call
  `registerCollation`; if no harness hook exists to register a collation for a
  `.sqllogic` run, put the primary REVERSE assertions in a `.spec.ts` (mirroring
  `memory-collation-per-database.spec.ts`, which registers collations in JS) and
  keep the sqllogic files limited to the unchanged `Unknown collation` rejections.
  Check `test/logic/102.2-unique-collation.sqllogic` and the harness for an
  existing registration hook before choosing.
- **spec** (`memory-collation-per-database.spec.ts` or a new sibling):
  - register REVERSE → `create table … text collate REVERSE primary key` succeeds
    and orders descending (the headline);
  - `create table … integer collate frobnicate` now throws `Unknown collation`
    (flip the existing resolver-message assertion);
  - `create table … integer collate nocase` still succeeds (registered no-op);
  - `create table … json collate REVERSE` throws even with REVERSE registered
    (empty-list precedence);
  - `alter table … alter column x set collate REVERSE` accepts the registered
    custom collation;
  - reopen round-trip: custom-collation column reopens with re-registration,
    throws `Unknown collation` without it.
- **unchanged, must stay green:** `102.1-unique-edge-cases.sqllogic`
  (`Unknown collation` on TEXT), `41.7-alter-column-collate.sqllogic`
  (`Unknown collation 'nosuchcollation' for type 'TEXT'`).

## TODO

- Add `isCollationRegistered(name)` to `Database` (`core/database.ts`) and to the
  `DatabaseInternal` interface (`core/database-internal.ts`).
- Rewrite `validateCollationForType` (`schema/table.ts`) with the optional
  `isCollationRegistered` predicate and the branch logic above; keep the legacy
  branch byte-identical when the predicate is undefined. Fix the no-list throw so
  it does not dereference an undefined `supportedCollations`.
- Add the optional 4th param to `columnDefToSchema` and forward it to
  `validateCollationForType`.
- Thread the predicate at: `manager.ts::buildColumnSchemas` (covers CREATE +
  importTable); `alter-table.ts::runAlterColumn`; memory `manager.ts` alterColumn /
  addColumn / renameColumn; store `store-module.ts` alterColumnChange /
  alterAddColumn / alterRenameColumn; isolation `deriveAddColumnBackfill`.
- Update `memory-collation-per-database.spec.ts`: flip the INTEGER-frobnicate
  assertion to `Unknown collation`, fix the header-comment caveat, add the REVERSE
  headline + JSON + ALTER + reopen cases.
- Add the sqllogic / spec coverage listed above.
- Update `docs/schema.md` (Per-column collation section) to state that an explicit
  column COLLATE accepts any collation registered on the connection, and that
  reopen requires re-registration (cross-link the resolver-seam note).
- Validate: `yarn workspace @quereus/quereus run lint` (type-checks specs too) and
  `yarn test` (memory path). Stream output with `2>&1 | tee`. Run `yarn test:store`
  if touching the store ALTER paths is non-trivial; note in the review handoff
  whether it was run (store tests are slower).
