description: Review the cross-schema FK declarative-differ symmetry — verify no spurious churn on unchanged cross-schema FKs and that real parent-schema changes are detected.
files:
  - packages/quereus/src/emit/ast-stringify.ts          # canonicalForeignKeyClause (:1616), constraintBodyToCanonicalString (:1699)
  - packages/quereus/src/schema/ddl-generator.ts         # constraintToCanonicalDDL (:302, actual side)
  - packages/quereus/src/schema/schema-differ.ts          # collectDeclaredNamedConstraints (:1424), reconciledDeclaredBody FK case (:~1620)
  - packages/quereus/test/declarative-equivalence.spec.ts # new "cross-schema foreign keys" describe block
  - docs/schema.md                                         # constraint body-change detection paragraph (:645)
difficulty: medium
----

# Review: cross-schema FK declarative-differ canonical symmetry

## What was implemented

Made the declarative differ (`DIFF SCHEMA` / `APPLY SCHEMA`) treat cross-schema
foreign keys symmetrically. The fix: **the FK parent-schema qualifier is canonical
iff it differs (case-insensitively) from the CHILD table's schema** — an explicit
own-schema qualifier elides to `undefined`, a genuine cross-schema parent survives.
The child schema is now threaded into the canonical-body renderer on both sides.

### Changes (small, surgical — one rule, four call sites)

- **`ast-stringify.ts`**
  - `canonicalForeignKeyClause(fk, childSchemaName?)` — new optional arg; applies the
    elide-when-equal-child rule: `schema = fk.schema && fk.schema.toLowerCase() !==
    childSchemaName?.toLowerCase() ? fk.schema.toLowerCase() : undefined`.
  - `constraintBodyToCanonicalString(tc, childSchemaName?)` — new optional arg,
    forwarded into `canonicalForeignKeyClause`. Optional ⇒ non-FK callers (CHECK /
    UNIQUE — no schema channel) and schema-less contexts are unaffected.
- **`ddl-generator.ts` (actual side)** — `constraintToCanonicalDDL` passes
  `tableSchema.schemaName`. Note: `schemaConstraintToTableConstraint` *already* elides
  a parent == child qualifier (from the prereq), so this pass is **idempotent** on the
  actual side — it's there for one-rule symmetry, not because the actual side was wrong.
- **`schema-differ.ts` (declared side)** — `collectDeclaredNamedConstraints` takes
  `schemaName` (the differ's per-schema target = child schema) and passes it when
  computing `definition`; the FK arm of `reconciledDeclaredBody` passes its `schemaName`
  param. The parent schema is **not** a rename channel (renames are within-schema), so
  the FK clone carries `foreignKey.schema` through untouched.
- **`docs/schema.md`** — extended the "constraint body-change detection" paragraph to
  document the parent-schema qualifier symmetry.

## How to validate

All green at handoff:
- `cd packages/quereus && yarn lint` → exit 0, no output.
- `yarn test` (root, all workspaces) → pass (~3m30s).
- `yarn test:store` → 6127 passing, 13 pending.

Targeted: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
"packages/quereus/test/declarative-equivalence.spec.ts" --grep "cross-schema foreign keys"`

## Test coverage added (new describe block, `declarative-equivalence.spec.ts`)

Each diffs a *non-main* schema via a local `diffOf(db, schemaName)`:

- **Unchanged cross-schema FK → no diff op.** Parent `m` in `main`, child in `s2`
  `references main.m`; re-declare identically → `diff.tablesToAlter` is `[]`. Also
  applies + asserts cross-schema enforcement still fires (orphan rejected).
- **Explicit own-schema qualifier ≡ unqualified.** Live catalog built from `references t`
  (child in `main`); re-declare as `references main.t` → no churn.
- **Parent-schema change IS a body change.** Like-named `m` in both `main` and `s2`;
  child in `s2` goes `references s2.m` → `references main.m`; diff emits
  `constraintsToDrop: ['fk_m']` + one `constraintsToAdd` carrying `main.m`.
- **Regression:** an unchanged same-schema FK still produces no diff op.

The wider suite already covers the same-schema FK differ (`foreign keys`,
`named-constraint body change`, `rename without constraint churn` blocks) — all still pass.

## Known gaps / reviewer attention

- **The "parent-schema change" test crosses the same↔cross boundary** (`references s2.m`
  on an `s2` child elides to bare, then `references main.m` survives). It cleanly
  isolates the *schema-qualifier* channel (parent table name `m` is identical across both
  versions; only the qualifier differs canonically), which is what matters. A purer
  cross→cross variant (child in a third schema, `references s2.m` → `references s3.m`)
  would additionally prove the qualifier is compared as a *value*, not just present/absent.
  Consider adding if you want belt-and-suspenders.
- **Tests 2 & 3 assert at the `computeSchemaDiff` level**, not a full APPLY of the
  drop+recreate. Test 1 does apply + enforce. An end-to-end APPLY of the parent-schema
  change (drop+recreate converges, re-diff empty, enforcement retargets to the new parent)
  would be a stronger floor — not added.
- **Actual-side double elision** (`schemaConstraintToTableConstraint` then
  `canonicalForeignKeyClause`) is intentional and idempotent, but is redundant work. If a
  reviewer prefers single-responsibility, the elision could live in exactly one place
  (the canonical renderer) and `schemaConstraintToTableConstraint` could pass the raw
  `referencedSchema` through — but that would change the *persistence* DDL path too
  (`generateTableDDL` uses the same lift and relies on the qualifier being elided for a
  same-schema FK), so the current split is deliberate. Confirm this reasoning holds.
- **No new `.sqllogic`** — the behavior is differ-internal (canonical string equality),
  best asserted at the diff-op level, so coverage went into the spec. Cross-schema FK
  *enforcement* is already covered by `test/logic/41.5-cross-schema-foreign-keys.sqllogic`.
