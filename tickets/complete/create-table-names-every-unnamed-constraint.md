description: Every CHECK, UNIQUE and FOREIGN KEY rule written without a name is now stored under a reserved automatic name wherever a rule is created, so each one can be dropped by name, and a declared schema that stops listing one now applies instead of failing.
architecture: docs/schema-rename-detection.md#unnamed-constraint-lifecycle-body-matched
files:
  - packages/quereus/src/schema/table.ts               # mintTableCheckConstraintName, isAutoConstraintName
  - packages/quereus/src/schema/constraint-builder.ts  # mintUniqueConstraintName, mintForeignKeyConstraintName, nameAddedTableConstraint
  - packages/quereus/src/schema/manager.ts             # CREATE / rehydrate / lens extractors mint
  - packages/quereus/src/schema/catalog.ts             # hasUserWrittenName; pairwise backing-name guards deleted
  - packages/quereus/src/runtime/emit/add-constraint.ts, packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/schema/schema-differ.ts
  - packages/quereus/src/schema/ddl-generator.ts       # comment only (review)
  - docs/sql-constraints.md, docs/sql-alter.md, docs/sql-alter-rename.md, docs/schema.md, docs/schema-rename-detection.md, docs/determinism.md
----

# Name every unnamed constraint where it is created

## What landed

Landed in `ticket(implement): create-table-names-every-unnamed-constraint`. A constraint the user leaves unnamed is now stored under a reserved `_`-prefixed name at every creation site: `CREATE TABLE`, catalog rehydrate, logical (lens) tables, `ALTER TABLE … ADD CONSTRAINT`, `ADD COLUMN` inline, and the declarative differ.

| declaration | stored name |
|---|---|
| column-level CHECK on `a` | `_check_a` |
| table-level CHECK | `_check_<n>`, `n` = its position in `checkConstraints`, bumped while taken |
| UNIQUE | `_uc_<cols>`, `_<N>` suffix on collision |
| FOREIGN KEY | `_fk_<table>_<cols>` |

- Imperative `ALTER … ADD CHECK` now mints `_check_<n>`. It used to mint `check_<n>`, which the differ treated as a user name.
- "Unnamed" now means "no user-written name": either absent, or an `_`-prefixed name (`hasUserWrittenName`). This keeps the duplicate-UNIQUE refusal working after the mint runs.
- The pairwise backing-structure-name guards were deleted because nothing could reach them any more. The differ's "created without a name" refusal and the other fallbacks for a nameless constraint stay, but they are now reachable only through a schema a module builds by hand. Removing them is backlog `debt-constraint-schema-name-required`.
- The persisted DDL now spells auto-names (`constraint _uc_b unique (b)`, `constraint _check_0 check (…)`). A positional `_check_<n>` therefore keeps its name across a reopen even after an earlier CHECK is dropped.

## Review findings

**What was checked.** I read the full source diff of the implement commit across the engine, the store, and the memory and store modules. I traced every consumer of constraint names outside the engine:
- `quereus-isolation`: the overlay UNIQUE index name and the operation text.
- `quereus-store`: `implicitUniqueIndexName` and the store UNIQUE arm.
- `quereus-sync`'s `decideAddConstraint` / `equivalentUniqueExists`.

I also read the DDL generator's constraint emission and the doc diffs. I grepped the docs and every package's `src` for stale spellings (`check_<n>`, the deleted guard names, "no name to drop").

I ran these probes against the built engine, and all behaved as the handoff describes:
- a user-written `_check_0` beside an unnamed table-level CHECK (the mint bumps to `_check_1`);
- ADD COLUMN `unique check (…)` minting `_uc_c` / `_check_c`, both dropped by name, then DROP COLUMN;
- duplicate UNIQUE refused at CREATE, both nameless and against a user-written `_uc_b`;
- a plain index `_uc_b` blocking `add unique (b)`;
- RENAME COLUMN keeping `_uc_b`, after which `add column b unique` mints `_uc_b_2`;
- two FKs on one column minting `_fk_x_b` / `_fk_x_b_2`.

**Correctness.** I found no defects.
- `nameAddedTableConstraint` runs after the user-name check and before both dispatch arms. The FK collation pre-build, the CHECK row scan, both UNIQUE guards and the module therefore all see one name.
- In ADD COLUMN, the UNIQUE and CHECK mints share one set of taken names. The inline FK is still left for the module to name, against the module's latest schema. This matches the revert path's `installedName`, so it is consistent.
- Sync replays the user's original statement text, and each peer mints locally. Unnamed CHECKs already behaved this way under `check_<n>`, so the change adds no divergence.
- There is a new import from `constraint-builder.ts` to `catalog.ts`. It joins an import cycle that already existed (`catalog` → `schema-differ` → `catalog`). Only functions are used across it, and only at runtime, so it is safe.

**Fixed inline (minor, comments only):**
- `alter-table.ts` `revertAddColumn` doc: dropped the stale "an unnamed one has no name to drop by".
- `catalog.ts`: rewrote the duplicate-UNIQUE section header and the `findUniqueConstraintSharingBackingName` doc. Both still described engine paths that no longer reach those functions.
- `schema-differ.ts` `constraintNamesAtAddTime`: the NOTE said RENAME COLUMN moves an unnamed UNIQUE's name. That is now true only for a nameless, hand-built UNIQUE, and the NOTE now says so.
- `ddl-generator.ts` `emitTableConstraints`: the comment now says UNIQUE auto-names are emitted too, and why that keeps positional CHECK names stable across a reopen.

**Tripwire (parked):** The UNIQUE mint skips constraint names but not plain index names, so a user index named `_uc_x` still makes `add unique (x)` fail with a loud refusal. This is parked as a `NOTE:` on `mintUniqueConstraintName` in `constraint-builder.ts`.

**Behaviour changes accepted as-is.** I weighed each change the handoff listed and kept it:
- Lens messages quote auto-names (`lens:unique:_uc_email`). This follows the already-accepted `lens:_check_<n>`.
- Module-side BUSY statement text shows the mint. This is cosmetic.
- A declarative DROP COLUMN now emits `DROP CONSTRAINT _uc_a` first, the same as for a user-named UNIQUE.
- RENAME COLUMN no longer moves `_uc_a`.
- DROP COLUMN / DROP TABLE CHECK refusals quote `_check_0`.
- A user-typed `_x` UNIQUE reads as `UNIQUE` in ADD COLUMN operation text. This is the documented `isAutoConstraintName` corner.
- Legacy store catalogs in which two UNIQUEs shared one backing structure lose enforcement of the second UNIQUE after load. This is documented in `docs/schema.md`, and AGENTS.md says not to worry about backwards compatibility yet.

**Tests.** The new and flipped tests each pin a part of the new contract:
- 10.1.4 §6: drop by auto-name.
- `uc_f` in 50-declarative: the downgrade converges.
- `declarative-upgrade-equivalence`: every downgrade converges.
- The `index-ddl-roundtrip` `_uc_a_b` / `_uc_a_b_2` case.
- The store rename-keeps-store case.

The deleted tests asserted refusals that can no longer be reached. I neither added nor cut any.

**Docs.** The rename, constraints, alter, schema, rename-detection and determinism docs match the new behaviour. Apart from the code comments above, nothing was stale.

**Validation (this pass).**
- `yarn workspace @quereus/quereus run lint`: clean, before and after the comment edits.
- quereus mocha with the spec reporter: 11185 passing, 0 failing, 23 pending.
- `@quereus/store`: 2017 passing. `@quereus/isolation`: 460 passing. `@quereus/sync`: 879 passing.
- I did not re-run the store-backed logic suite (`yarn test:store`); the implementer ran it (384 passing), and this pass changed only comments.
- Confirmed the implementer's warning: the `dot` reporter piped through `tee` ended without a summary after about 1.4k tests. Use `--reporter spec`.

**Empty categories.**
- Resource cleanup: no new resources are acquired.
- Performance: each mint is a set lookup per constraint at DDL time only.
- Type safety: the extractors now return `TableConstraint & { name: string }`, and the remaining `name?` optionality is exactly what the backlog debt ticket removes.
