description: Threaded declared column collations into all hand-built write-path scope/attribute scalar types (defaults, RETURNING, OLD/NEW row images, upsert, view-write decomposition, FK constraint scopes) via a shared `columnSchemaToScalarType` helper, so comparisons compiled over a table's row image resolve collations identically to a read-path query. Conformance only; no fact-soundness impact.
files:
  - packages/quereus/src/planner/type-utils.ts                         # columnSchemaToScalarType helper (always carries collationName)
  - packages/quereus/src/planner/building/constraint-builder.ts        # CHECK + buildNotNullDefaults scopes
  - packages/quereus/src/planner/building/default-scope.ts             # new.<col> resolves declared column type
  - packages/quereus/src/planner/building/insert.ts                    # OLD/NEW + upsert existingAttributes
  - packages/quereus/src/planner/building/update.ts                    # OLD/NEW + RETURNING scope
  - packages/quereus/src/planner/building/delete.ts                    # OLD/NEW
  - packages/quereus/src/planner/building/foreign-key-builder.ts       # FK check scope OLD/NEW/bare (fixed in review)
  - packages/quereus/src/planner/mutation/decomposition.ts             # view-write member/eav types
  - packages/quereus/src/planner/mutation/multi-source.ts              # view-write side/key types
  - packages/quereus/test/logic/06.4.3-write-path-collation.sqllogic   # conformance cases
----

# Write-path scope collation conformance (defaults / RETURNING / FK)

Remaining hand-built scalar types on the write path omitted `collationName`, so
comparisons inside DEFAULT expressions, RETURNING projections, and (found during
review) FK existence checks resolved BINARY against declared-collation columns —
diverging from the read path. Fixed by routing every site through a shared
`columnSchemaToScalarType(col, overrides?)` helper in `type-utils.ts` that always
threads `col.collation`; `columnSchemaToDef` / `relationTypeFromTableSchema`
delegate to it so the read and write paths cannot drift.

## Review findings

**What was reviewed:** the implement diff (swept into commit `c04e512e` alongside
ticket 6.2) across `type-utils.ts`, `constraint-builder.ts`, `default-scope.ts`,
`insert.ts`, `update.ts`, `delete.ts`, `decomposition.ts`, `multi-source.ts`, and
the new sqllogic file — plus a sweep of every remaining write-path site that
hand-builds a scalar type from a `ColumnSchema`.

- **Correctness / read-path parity — OK.** The new helper produces exactly the
  ScalarType the old inline literals did, plus `collationName`; `columnSchemaToDef`
  and `relationTypeFromTableSchema` (read path) delegate to it, so no read-path
  regression. `default-scope.ts` now resolves `new.<col>` against the *declared*
  column type (which carries collation) and falls back to the source-attribute
  type when the target column list has no `.type` (the ALTER ADD COLUMN backfill
  path passes `ColumnSchema[]`, whose attrs already carry collation inline) — no
  regression there.

- **Missed site — FIXED INLINE (minor).** `foreign-key-builder.ts` built four
  collation-blind scalar types for the FK constraint-check scope's
  `new.<col>` / `old.<col>` / bare-column symbols (child-side and parent-side FK
  builders) — the identical write-path row-image pattern this ticket targets, not
  in the implementer's file list. The synthesized check `parent.k = NEW.ref` puts
  the child FK column as the right operand, which wins collation precedence
  (`effectiveComparisonCollation`: right, else left, else BINARY), so the omission
  forced BINARY where a read-path join would resolve the child column's declared
  collation. Routed all four through `columnSchemaToScalarType`.

- **Test coverage.** Extended `06.4.3-write-path-collation.sqllogic` with a FK
  section: a NOCASE child column referencing a BINARY parent key matches a
  case-variant parent (FK satisfied), mirrored by an equivalent read-path join,
  with a negative control proving the FK is still enforced. Verified the case
  isolates the fix — without the FK-builder change the comparison resolves BINARY
  and the case-variant insert raises a constraint violation. Existing cases cover
  DEFAULT (`new.c`), OR REPLACE NOT NULL substitution, RETURNING on all three DML
  kinds, and upsert DO UPDATE SET.

- **Checked, not separately pinned (acceptable).** The view-write decomposition
  collation threading (`decomposition.ts` / `multi-source.ts` member, eav, side,
  and key-capture types) has no dedicated sqllogic case. These carry collation as
  type metadata on envelope/key columns and feed no plan-time fact extraction
  (ticket's stated non-soundness scope); the full suite exercises view-write paths
  and stays green. Not worth a bespoke fixture.

- **Left open (out of scope, pre-existing).** `MutationContextVar` carries no
  collation field at all, so a comparison against a `with context` variable still
  resolves BINARY. This is a distinct surface (context vars are not part of the
  table row image) and was flagged by the implementer; no new ticket filed —
  revisit only if context-var collation becomes a stated requirement.

- **DRY / type safety / cleanup — OK.** Duplicate local `columnScalarType`
  helpers in `decomposition.ts` and `multi-source.ts` were removed in favor of the
  shared helper; their `ScalarType` / `ColumnSchema` imports remain used
  elsewhere (no dead imports). No `any`; helper is fully typed.

**Validation:** `yarn lint` clean; full `packages/quereus` suite **5910 passing,
9 pending, 0 failing**.

**Disposition:** one minor finding fixed inline (FK-builder). No major findings;
no new fix/plan/backlog tickets filed.
