description: A storage module may say that some of its stored rows hold null in a column declared not null (left over from a schema change). The engine now believes it: for such a module, every not-null column is reported as possibly null and the optimizer no longer draws conclusions from the declaration.
architecture: docs/module-capabilities.md#surface-inventory
files:
  - packages/quereus/src/vtab/capabilities.ts                            # columnNeverNullOnRead (the helper) + both flags' doc comments
  - packages/quereus/src/planner/type-utils.ts                           # tableColumnReadType; relationTypeFromTableSchema
  - packages/quereus/src/planner/nodes/reference.ts                      # tableSchemaAttributes; TableReferenceNode passes its own module
  - packages/quereus/src/planner/util/ind-utils.ts                       # fkChildNullable
  - packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  - packages/quereus/src/planner/analysis/coverage-prover.ts
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/vtab/best-access-plan.ts
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts
  - packages/quereus/src/schema/lens-prover.ts                           # proveForwardInjective gate; review: transport-proof UNIQUE gate
  - packages/quereus/src/planner/building/{delete,update,insert,alter-table}.ts # stored-row images typed as reads
  - packages/quereus/src/planner/mutation/capture-correlation.ts         # review: tripwire NOTE
  - packages/quereus/test/alter-add-column-delegate.spec.ts
  - packages/quereus/test/lens-row-local-null-write.spec.ts
  - docs/module-capabilities.md, docs/lens-prover.md, docs/lens-constraints.md, docs/optimizer-rule-families.md, docs/sql-alter.md, docs/sql-ddl.md
----

# NOT NULL columns of a grandfathering module are read as nullable

## What landed

`permitsGrandfatheredNotNullViolators` (a module capability flag) is now consumed by the planner as well as the lens prover. One helper, `columnNeverNullOnRead(table, columnIndex, module = table.vtabModule)` in `vtab/capabilities.ts`, answers "can a read of this column ever yield NULL": true only when the column is declared NOT NULL and the module does not declare the flag. `tableColumnReadType` in `planner/type-utils.ts` builds a column's read type from it. Every read-side use of a table column's NOT NULL goes through one of the two: scan column types and attributes, UNIQUE→key promotion, foreign-key child nullability, partial-UNIQUE / coverage / query-rewrite reasoning, the `IS NOT NULL` access-path shortcut, the null-safe ordering check, two materialized-view `count(x) = count(*)` assumptions, the lens prover's forward-injectivity gate, and the stored-row images built during writes (DELETE/UPDATE `OLD`, upsert `OLD` and conflict row, ALTER ADD COLUMN backfill/CHECK row images). NEW-row images and write enforcement keep reading the declaration.

Only `permitsGrandfatheredNotNullViolators` widens reads; `delegatesNotNullBackfill` does not. A module that leaves pre-existing rows NULL after a delegated ADD COLUMN must declare both, and the docs now say so (`capabilities.ts`, `module-capabilities.md`, `sql-alter.md`, `sql-ddl.md`).

Consequence in the lens prover (documented in `docs/lens-prover.md`): over a declaring module, a basis column declared NOT NULL reads nullable, so every `not null` logical column it sources (primary key included) carries the `lens.nullability-mismatch` advisory, and in a mixed-module body it is the deploy-blocking error. No shipped module declares the flag.

Commit: `ticket(implement): grandfathered-not-null-columns-read-as-nullable`, plus this review pass.

## Review findings

Read the implement diff first, then every touched file's changed region, and grepped all remaining `.notNull` reads and all `columnSchemaToScalarType` / `columnSchemaToDef` / `relationTypeFromTableSchema` / `tableSchemaAttributes` callers in `packages/quereus/src` to check the read/write classification.

**Correctness — found and fixed (major class, fixed inline because the fix is small and sits on this ticket's invariant):**
- `lens-prover.ts proveKeyByBijectionTransport` classified a logical UNIQUE `proved` (no runtime enforcement, unconditional key FD) when its columns map onto a basis UNIQUE, gated only on the *logical* column being NOT NULL. Over a declaring basis module, that logical NOT NULL is only an advisory, and the basis UNIQUE is NULL-skipping, so several stored rows can hold NULL there and the proved key is false. Fix: when the matched basis key is a UNIQUE (not the PK, which treats NULL as a self-equal value), every mapped basis column must satisfy `columnNeverNullOnRead`; otherwise the key falls to row-time/commit-time enforcement. Reproduced with a new test in `test/lens-row-local-null-write.spec.ts` ("a logical UNIQUE over a basis UNIQUE on the grandfathering module is not `proved`…"): it fails with the gate removed and passes with it. Docstring and `docs/lens-constraints.md` § Set-level updated.

**Classification of remaining `notNull` reads — checked, no change:**
- `func/builtins/schema.ts` (`table_info` reports the declaration), `lens-compiler.ts requiredBasisColumnsOf`, `planner/mutation/*` NOT NULL default/required-column logic, `constraint-builder`, `write-site-analysis`, `generated-column-scope`, `mutation-context`: write-side or report the declaration — correct as is.
- `lens-prover.ts` reads at the logical-key nullability gates (`nullablePrimaryKey`, the guarded-FD clause builder): logical tables carry no module; correct as is.
- `runtime/emit/materialized-view-helpers.ts` and `core/database-materialized-views-plan-builders.ts:275`: the MV's own backing table (native module); correct as is.
- `comparison-collation.ts`, `derived-row-validator.ts`: collation only / derived MV rows; nullability not at stake.
- Upsert conflict-row image in `insert.ts` uses the schema's own module rather than the reference's (the reference is not in scope there); same instance for a registered table, so left as is.

**Tripwires parked (conditional, not tickets):**
- `planner/mutation/capture-correlation.ts keyColumnInfo` (used by decomposition writes and the lens decomposition read-body stitch join; `multi-source.ts requireKeyColumns` makes the same declared-NOT-NULL read for its own keys): decides NULL-safe vs plain `=` key correlation from the declared NOT NULL. Only matters if a declaring module grandfathers a NULL into a *key* column; switching it would change NULL-key join matching, so it is a `NOTE:` at the site rather than a change.
- `lens-prover.ts basisPermitsGrandfatheredNotNull`: the advisory demotion is per lens body, so mixed-module bodies block on every NOT NULL column sourced from a declaring module. `NOTE:` at the site: demote per column by source module if mixed bodies over a declaring module show up.

**Implementer's open questions — answered:**
- Exempt primary-key columns from `columnNeverNullOnRead`? Declined: a primary key does not imply NOT NULL here (docs/schema.md § Primary-key nullability), so `set not null` on a nullable key column under a grandfathering module can leave a NULL key; the helper stays uniform.
- Per-column prover demotion: parked as the tripwire above; it is a design change with no current consumer (no shipped module declares the flag).

**Tests:** the implementer's added assertion in `alter-add-column-delegate.spec.ts` pins the capability branch of the helper end to end (announced `nullable: true`) — kept. The rewritten lens test asserts the advisory now appears and the NULL write still rejects — kept. One test added (the transport-proof reproduction above). No optimizer-path tests added: those paths are each a direct substitution of the helper for the declaration, which the type-level assertion already covers in kind.

**Performance:** `getCapabilities()` is now called once per column in type/attribute builds and some analyses; results are cached per node. Not measured; no evidence it matters, no NOTE added.

**Isolation layer:** `quereus-isolation` `getCapabilities()` spreads the underlying module's flags, so the flag passes through. Not exercised by a test.

**Docs:** read every doc the change touched plus `lens-constraints.md` (which it should have touched; now updated). They reflect the new behavior.

**Validation:** `yarn workspace @quereus/quereus test` — 11190 passing, 23 pending, 0 failing. `yarn workspace @quereus/quereus lint` — clean. `yarn test:store` not run: the store module never declares the flag.
