description: A column constraint `collate nocase` (or `rtrim`/`binary`) written in lowercase is rejected at DDL with a misleading "not supported" error, purely because the collation-name validation in `columnDefToSchema` uses a case-sensitive `includes` against the (uppercase) `supportedCollations` whitelist. Normalize collation names to their canonical uppercase form at DDL time and validate case-insensitively so `nocase` ≡ `NOCASE`. The collation *lookup* side is already case-insensitive; only DDL validation/normalization is broken.
files: packages/quereus/src/schema/table.ts, packages/quereus/src/types/builtin-types.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic, packages/quereus/test/logic/102.2-unique-collation.sqllogic
----

## Summary

`create table t (id integer primary key, email text collate nocase unique)` is **rejected**
at DDL, while the otherwise-identical uppercase `collate NOCASE` is accepted. The rejection
message contains "not supported", which previously misled a reader into believing UNIQUE
doesn't support collation at all (it does — see the landed
`unique-constraint-honors-column-collation`).

This is purely a **DDL-side case-sensitivity quirk**. SQLite treats collation names
case-insensitively; Quereus should too. The lookup/resolution side is *already*
case-insensitive everywhere (see "Confirmed scope" below) — only the validation +
normalization at schema-build time is wrong.

## Reproduction (confirmed)

The behavior is already pinned by an in-repo regression test. Running

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "102.1" --colors
```

passes today **because** `102.1-unique-edge-cases.sqllogic` §1 currently asserts the
rejection (`-- error: not supported`) for the lowercase spelling. The uppercase spelling
is accepted and enforces case-insensitively (covered by `102.2-unique-collation.sqllogic`).

## Root cause

`columnDefToSchema` — `packages/quereus/src/schema/table.ts`, the `case 'collate':` block
(currently ~lines 190–200):

```ts
case 'collate': {
    schema.collation = constraint.collation ?? 'BINARY';
    if (constraint.collation && logicalType.supportedCollations &&
        !logicalType.supportedCollations.includes(constraint.collation)) {
        throw new QuereusError(
            `Collation '${constraint.collation}' is not supported for type '${logicalType.name}' on column '${def.name}'`,
            StatusCode.ERROR
        );
    }
    break;
}
```

`TEXT_TYPE.supportedCollations = ['BINARY','NOCASE','RTRIM']`
(`packages/quereus/src/types/builtin-types.ts`, ~line 113) is canonical-uppercase, and
`Array.includes` is **case-sensitive**, so lowercase `nocase` fails the membership test
and is rejected. The collation string is also stored verbatim (`schema.collation =
constraint.collation`), so even a mixed-case name that slipped through would not be
normalized.

## Confirmed scope — what is already correct

The collation **lookup/resolution** layer already canonicalizes via `.toUpperCase()`, so
no changes are needed there; storing a normalized (or even un-normalized) name resolves
fine. Verified:

- `util/comparison.ts`: `registerCollation`, `getCollation`, `resolveCollation` all key on
  `name.toUpperCase()`.
- `core/database.ts`: `Database.registerCollation` stores under `name.toUpperCase()`;
  `db._getCollation` is case-insensitive.
- `quereus-store/src/common/encoding.ts`: `registerCollationEncoder` /
  `getCollationEncoder` key on `name.toUpperCase()`.

So the *only* defect is at DDL build time in `columnDefToSchema`. Normalizing the stored
name to canonical uppercase is purely an improvement (the resolvers already uppercase),
and makes the value SQLite-canonical for downstream comparisons via `compareSqlValues` /
`resolveCollation`.

## Inline / table UNIQUE and CREATE INDEX contexts

- **Inline / table-level `unique`**: UNIQUE enforcement reads the *column's* declared
  collation (`ColumnSchema.collation`) per `unique-constraint-honors-column-collation`.
  Fixing `columnDefToSchema` therefore fixes the inline `text collate nocase unique` and
  table-level `unique (x)` cases automatically — no separate change needed.
- **`create [unique] index … collate …`**: `SchemaManager.buildIndexSchema`
  (`packages/quereus/src/schema/manager.ts`, ~line 1437) stores the index column collation
  verbatim: `collation: indexedCol.collation || tableColSchema.collation`. It does **not**
  validate against `supportedCollations` (intentionally — this is the path the
  `PHONENUMBER`/`LENGTH` custom-collation samples rely on), but it also does **not**
  normalize. For consistency with the column-level fix, normalize the index-column
  collation name to canonical uppercase here too (do **not** add a `supportedCollations`
  check — that would regress custom-collation indexes).

## Correction

Add a single shared normalization helper (canonical = trimmed `toUpperCase()`), e.g.
`normalizeCollationName(name: string): string` in `packages/quereus/src/util/comparison.ts`
(it lives next to the other collation registry helpers and is already imported broadly).
Then:

1. In `columnDefToSchema`'s `collate` case:
   - Normalize the requested name once.
   - Store the **normalized** value on `schema.collation` (keep `'BINARY'` default when no
     collation constraint is present).
   - Do the `supportedCollations` membership test against the **normalized** name (the
     whitelist is already uppercase).
   - Reword the error so a genuinely-unknown collation reads as unknown rather than
     conflating with the case quirk, e.g.:
     `Unknown collation '<original>' for type '<TEXT>' on column '<col>' (expected one of: BINARY, NOCASE, RTRIM)`.
     Use the *original* (as-written) spelling in the message for clarity, list the
     `supportedCollations` as the expected set.

2. In `SchemaManager.buildIndexSchema`, normalize the resolved collation name with the
   same helper before storing it on the `IndexColumnSchema` (no whitelist check).

### Out of scope (note, do not fix here)

A registered **custom** collation (e.g. the sample `UNICODE_CI`) used directly on a TEXT
*column* (`x text collate unicode_ci`) is rejected by the `supportedCollations` whitelist
even though it works fine via `CREATE INDEX … COLLATE`. That whitelist-vs-registry
inconsistency is a separate latent gap; this ticket only fixes case-sensitivity. If the
implementer finds it trivial to surface a clearer message it's welcome, but do not change
the whitelist semantics.

## Regression coverage

- `packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic` §1 (lines ~1–35): flip the
  two `-- error: not supported` blocks (`t_uci`, `t_uci2`) to assert that the **lowercase**
  spelling is now **accepted** and enforces identically to uppercase — i.e. a lowercase
  `collate nocase` UNIQUE column accepts `'abc'` then rejects `'ABC'`
  (`-- error: UNIQUE constraint failed: …`), mirroring the §2/§1 patterns in
  `102.2-unique-collation.sqllogic`. Update the §1 prose header (lines ~1–18), which
  currently describes the rejection as a "still-open concern", to describe the
  now-normalized behavior.
- Add a focused case (in 102.1 §1 or a small new section) for an **unknown** collation
  (`collate frobnicate`) asserting it is still rejected, with the new "unknown" wording
  (e.g. `-- error: Unknown collation`), so the unknown-vs-case-quirk distinction is pinned.
- Optionally extend `102.2-unique-collation.sqllogic` with a lowercase-`nocase` variant to
  prove normalized enforcement parity end-to-end (memory + store modes). The reference
  enforcement patterns to mirror are §1/§2 of that file.

## Validation

- `yarn workspace @quereus/quereus run typecheck`
- Targeted: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "102" --colors`
- Full memory-backed suite: `yarn test` (run from repo root). Store-mode (`yarn test:store`)
  exercises the same 102.x logic files; run it if touching anything store-side, otherwise
  the memory suite covers this change.
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).

## TODO

- Add `normalizeCollationName(name: string): string` (trim + `toUpperCase()`) to
  `packages/quereus/src/util/comparison.ts`; export it.
- In `columnDefToSchema` (`schema/table.ts`): normalize `constraint.collation`, store the
  normalized value on `schema.collation`, validate `supportedCollations` membership against
  the normalized name, and reword the unknown-collation error message.
- In `SchemaManager.buildIndexSchema` (`schema/manager.ts`): normalize the resolved
  index-column collation name (no whitelist check).
- Flip the two lowercase-rejection blocks in `102.1-unique-edge-cases.sqllogic` §1 to assert
  acceptance + case-insensitive enforcement; update the §1 prose header accordingly.
- Add an unknown-collation (`collate frobnicate`) rejection case asserting the new wording.
- (Optional) Add a lowercase-`nocase` enforcement-parity section to
  `102.2-unique-collation.sqllogic`.
- Run typecheck, the targeted 102.x logic tests, `yarn test`, and lint.
