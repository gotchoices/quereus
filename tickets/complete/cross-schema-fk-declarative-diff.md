description: Cross-schema FK declarative-differ canonical symmetry — an FK parent-schema qualifier is canonical iff it differs from the CHILD table's schema, so an unchanged cross-schema FK does not churn, an explicit own-schema qualifier ≡ the bare form, and a real parent-schema change is detected as a body change.
files:
  - packages/quereus/src/emit/ast-stringify.ts            # canonicalForeignKeyClause (:1616), constraintBodyToCanonicalString (:1713)
  - packages/quereus/src/schema/ddl-generator.ts           # constraintToCanonicalDDL (:308, actual side); schemaConstraintToTableConstraint own elision (:341)
  - packages/quereus/src/schema/schema-differ.ts            # collectDeclaredNamedConstraints (:1431), reconciledDeclaredBody FK case (:1630), body comparison (:1836)
  - packages/quereus/src/schema/catalog.ts                  # namedConstraints definition via constraintToCanonicalDDL (:257)
  - packages/quereus/test/declarative-equivalence.spec.ts  # "cross-schema foreign keys" describe block (5 tests)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts  # cross-schema FK qualifier round-trip
  - docs/schema.md                                          # constraint body-change detection paragraph (:645)
----

# Cross-schema FK declarative-differ canonical symmetry — COMPLETE

## What shipped

The declarative differ (`DIFF SCHEMA` / `APPLY SCHEMA`) now treats the FK
parent-schema qualifier symmetrically on both the declared-AST and actual-catalog
sides. The single rule: **the parent-schema qualifier is canonical iff it differs
(case-insensitively) from the CHILD table's schema.** An explicit own-schema
qualifier elides to `undefined`; a genuine cross-schema parent survives (case-folded)
as a body-change channel.

The child schema is threaded into `constraintBodyToCanonicalString` on both sides:
- **Actual** — `constraintToCanonicalDDL` passes `tableSchema.schemaName`. (Idempotent:
  `schemaConstraintToTableConstraint` already elides a parent == child qualifier for
  the persistence path; the canonical re-elision is a no-op there but keeps the rule
  in one place.)
- **Declared** — `collectDeclaredNamedConstraints` and `reconciledDeclaredBody` pass
  the differ's per-schema target (the child schema). The parent schema is NOT a rename
  channel (renames are within-schema), so an FK rename reconcile carries
  `foreignKey.schema` through the clone untouched.

Net behavior: re-declaring an unchanged cross-schema FK does not churn; an explicit
own-schema qualifier is equivalent to the bare form; editing the declared parent
schema (`references s2.m` → `references main.m`) is detected as a body change
(drop+recreate). `docs/schema.md` documents the symmetry.

## Review findings

Adversarial pass over commit `dd51ae1e`. Read the full diff first, then the handoff.

### Checked — correctness / symmetry (no issues)
- **The canonical rule is symmetric and idempotent.** Both diff sides funnel through
  `canonicalForeignKeyClause(fk, childSchemaName)` with the same child schema (the
  differ diffs declared schema X against actual catalog X; both supply X). Comparison
  is `.toLowerCase()` on both operands, so parent-schema *case* never churns. On the
  actual side the lift's own `crossSchema` elision runs first, then the canonical
  re-elision — verified idempotent (same-schema → already `undefined` → stays
  `undefined`; cross-schema → survives both passes).
- **All call sites thread the child schema consistently** — no missed site. Verified
  via `find_references` over `constraintBodyToCanonicalString` /
  `collectDeclaredNamedConstraints` / `constraintToCanonicalDDL`: actual side
  (`catalog.ts` → `constraintToCanonicalDDL` → `tableSchema.schemaName`), declared side
  (`collectDeclaredNamedConstraints` + the FK arm of `reconciledDeclaredBody` →
  `schemaName`). The CHECK / UNIQUE arms of `reconciledDeclaredBody` call without the
  arg — harmless, since `constraintBodyToCanonicalString` reads `childSchemaName` ONLY
  in the FK branch.
- **Column-level named FKs are covered too.** `columnConstraintToTableConstraint`
  spreads `cc.foreignKey` (schema intact); `collectDeclaredNamedConstraints` threads
  `schemaName` through the shared `add` for both table- and column-level constraints.
- **Persistence path unaffected.** `generateTableDDL` relies on
  `schemaConstraintToTableConstraint`'s own elision (a same-schema FK emits no
  qualifier; a cross-schema FK keeps one — covered by the round-trip spec). The
  handoff's "double elision is intentional, don't collapse it into one place" reasoning
  holds: collapsing would change the persistence DDL, not just the canonical key.
- **No re-churn loop.** A drop+recreate emits `d.ddl` (raw declared form, qualifier
  intact). On re-diff, both sides canonicalize the qualifier identically → bodies match
  → idempotent. Confirmed by the existing "idempotent re-apply" assertions and the new
  apply+enforce test.

### Found + fixed inline (minor)
- **Test coverage gap (handoff gap #1): qualifier compared as a *value*, not just
  present/absent.** The three original cross-schema tests only crossed the
  same↔cross boundary (qualifier present vs absent). Added a 5th test —
  **"changing one cross-schema parent to ANOTHER cross-schema parent is a body
  change"** — child in `s3`, like-named `m` in both `s2` and `main`, FK
  `references s2.m` → `references main.m`. Both qualifiers genuinely differ from the
  child schema (s3) so neither elides; this proves two surviving-but-distinct
  qualifiers compare unequal (drop+recreate, recreated FK carries `main.m`) AND that the
  unchanged cross→cross FK does not churn. Passes.

### Checked — not addressed, judged acceptable (not a major finding, no ticket filed)
- **End-to-end APPLY of the parent-schema change (handoff gap #2).** Tests 1 and the new
  cross→cross test assert at the `computeSchemaDiff` level for the change case (test 1
  additionally applies + enforces the *no-change* case). A full APPLY of the
  drop+recreate for a parent-schema *edit* (converge → re-diff empty → enforcement
  retargets to the new parent) is NOT added. Acceptable: the drop+recreate APPLY
  machinery is identical to and exercised by the existing "named-constraint body change
  → FK ON DELETE action" test (applies + changes behavior), the ADD-side qualifier
  emit/re-parse is covered by `ddl-generator-roundtrip-positions.spec.ts`, and
  cross-schema FK *enforcement* is covered by the parse-enforce prereq's
  `test/logic/41.5-cross-schema-foreign-keys.sqllogic`. The composition is well-covered;
  a single end-to-end test would be belt-and-suspenders, not closing a real risk gap.
- **Own-schema-qualifier equivalence tested one direction only** (live catalog from the
  bare form, re-declared qualified). The reverse (catalog from qualified, re-declared
  bare) is equivalent by construction — symmetric canonicalization makes both render
  identically. Not worth a second test.

### Checked — empty categories
- **No new bugs introduced.** Type-safe (optional `childSchemaName?: string`, no `any`),
  DRY (one rule, four threaded call sites), SPP-clean (surgical). Resource cleanup /
  error handling: N/A — pure string canonicalization, no I/O or lifecycle.
- **Docs:** `docs/schema.md` constraint body-change paragraph updated and accurate
  against the code (verified the rule, the threading from both sides, and the
  "not a rename channel" claim).

## Validation (all green)
- `cd packages/quereus && yarn lint` → exit 0 (eslint + `tsc -p tsconfig.test.json`,
  so the new test call sites type-check too).
- `declarative-equivalence.spec.ts` full suite → **134 passing**; the
  "cross-schema foreign keys" block → **5 passing** (was 4, +1 inline).
- `ddl-generator-roundtrip-positions.spec.ts` → **18 passing** (persistence path).

No `.pre-existing-error.md` written — no unrelated failures surfaced.
