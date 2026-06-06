description: |
  A table with NO declared primary key silently forced every column NOT NULL,
  overriding an explicit `null` declaration, because the no-PK "all columns
  become the key" synthesis fed the unconditional `notNull: isPkColumn ? true …`
  promotion in `buildColumnSchemas`. Symptom: `lens.nullability-mismatch` when
  deploying such a logical table over a nullable basis; root defect: a general
  schema-building bug that also rejected NULL inserts into no-PK storage tables.
  Fixed so a *synthesized* all-columns key preserves declared nullability; only
  an *explicitly-declared* PK forces NOT NULL. Uniform across storage + logical.
files:
  - packages/quereus/src/schema/table.ts            # findPKDefinition (returns `synthesized`); isSynthesizedAllColumnsKey helper
  - packages/quereus/src/schema/manager.ts          # buildColumnSchemas — notNull promotion gated on !synthesized
  - packages/quereus/src/schema/ddl-generator.ts    # generateTableDDL / formatColumnDef — omit PK clause for synthesized key
  - packages/quereus/src/schema/lens-prover.ts      # checkTypeAndNullability (UNCHANGED — correct for free once col.notNull is honest)
  - packages/quereus/test/no-pk-nullability.spec.ts # schema-building, storage NULL-insert/dup, DDL round-trip
  - packages/quereus/test/lens-prover.spec.ts       # positive cases for the synthesized key
  - packages/quereus-store/test/rehydrate-catalog.spec.ts  # REVIEW-ADDED: store close→reopen of no-PK nullable table w/ NULL-in-key row
  - docs/schema.md                                  # ColumnSchema primary-key-nullability note + DDL synthesized-key omission
  - docs/lens.md                                    # Coverage checklist type/nullability conformance wording
----

# Complete: no-PK synthesized key must not force columns NOT NULL

## Outcome

Shipped as designed. A synthesized all-columns key (the no-PK fallback) now
preserves each column's declared (or session-default) nullability; only an
*explicitly-declared* PK promotes columns to NOT NULL. The lens prover's
`lens.nullability-mismatch` false-trip is resolved end-to-end (the column's
`notNull` is now honest, so the prover is correct without change). Canonical DDL
omits the PK clause for a synthesized / single-column-table key so the store
persistence round-trip re-synthesizes the key and keeps nullability.

See the implement commit (`ticket(implement): lens-no-pk-nullable-column-deploy-mismatch`)
for the full design rationale. The implementation matched the plan; this stage
verified it and closed the highest-risk testing gap.

## Review findings

### What was checked
- **Implement diff, fresh eyes** — `table.ts` (`findPKDefinition` refactor +
  `isSynthesizedAllColumnsKey`), `manager.ts` (`buildColumnSchemas` notNull
  gate), `ddl-generator.ts` (`generateTableDDL`/`formatColumnDef` PK-clause
  omission), `docs/schema.md`, `docs/lens.md`, and both new specs.
- **Caller audit** — `findPKDefinition` has a single caller (`buildColumnSchemas`),
  correctly destructuring the new `synthesized` flag. Verified.
- **Second notNull-forcing path** — `columnDefToSchema` (table.ts:273) forces
  NOT NULL only for a *column-level* `primaryKey` AST constraint, which a
  synthesized key never carries, so it is correct and needs no change.
- **Shape-vs-flag soundness** — `isSynthesizedAllColumnsKey` is broader than the
  `synthesized` flag (it also matches an explicitly-declared all-columns /
  single-column-table ASC/BINARY/no-conflict PK). Confirmed sound: a declared PK
  already forced its columns NOT NULL, so omitting the clause and re-synthesizing
  yields an identical schema; a nullable column under this shape can only be a
  synthesized key.
- **Conflict-action / desc / collation fidelity** — verified these were already
  dropped from table-level PK emission *before* this change (formatColumnDef
  never emitted column-level `on conflict`; the table-level PK emitter only emits
  names). Not regressions introduced here.
- **Lint + tests** — `yarn lint` clean (exit 0); targeted `no-pk-nullability` +
  `lens-prover` specs 48 passing; `@quereus/store` package 316 passing (incl. the
  review-added test); full memory `yarn test` **4939 passing, 0 failing, 9
  pending**.

### What was found & done
- **Minor (fixed inline)** — *Gap #1 from the handoff*: no store-backend
  close→reopen test for a no-PK **nullable** table holding a NULL-in-key row (the
  flagged highest-risk path). Added
  `rehydrate-catalog.spec.ts › 'no-PK nullable table preserves nullability and a
  NULL-in-key row across reopen'`: it creates `(a integer null, b integer null)
  using store`, inserts `(null, 5)`, rehydrates a fresh `Database`, and asserts
  (a) `a`/`b` stay `notNull === false` and remain in the synthesized key after
  reopen, (b) the persisted NULL-in-key row reads back, (c) a fully-identical
  second row is rejected as a **key/constraint** conflict (not NOT NULL), and (d)
  a distinct NULL-bearing row still inserts. This exercises the real store key
  codec with NULL-in-key, proving the soundness claim on the store backend rather
  than only memory. 316 → passing.

- **Major (new ticket filed)** — `tickets/backlog/canonical-ddl-drops-column-collation.md`:
  while validating the DDL round-trip reasoning, found that `formatColumnDef`
  never emits a column-level `COLLATE` clause (index DDL does). A non-BINARY
  column collation is therefore silently lost on a store reopen. **Pre-existing
  and orthogonal** to nullability — not introduced here — so captured as a
  separate backlog ticket rather than fixed in this pass.

- **Documentation** — `docs/schema.md` (primary-key-nullability + synthesized-key
  DDL omission notes) and `docs/lens.md` (type/nullability conformance wording)
  were read and confirmed to reflect the new reality. No further doc changes
  needed.

### Empty categories (explicit)
- **No correctness defects** in the shipped change. The core fix is sound, the
  shape-based DDL omission is provably round-trip-correct for both the
  synthesized and ambiguous-declared cases, and all suites pass.
- **No DRY / modularity / type-safety issues.** `synthesized` is threaded
  cleanly through a single caller; `isSynthesizedAllColumnsKey` is a small,
  well-documented, exported helper; no `any`.

### Residual (not blocking; lower risk, documented only)
- *Gap #2*: ALTER ADD COLUMN on a no-PK nullable table across a store reopen is
  not directly asserted. It routes through `module.alterTable` →
  `generateTableDDL` (now fixed) and the existing ADD-COLUMN reopen tests plus
  the full `@quereus/store` suite pass, so it is low-risk. Left as a documented
  residual rather than a new ticket.
