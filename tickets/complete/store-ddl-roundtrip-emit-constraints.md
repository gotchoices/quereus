description: COMPLETE — generateTableDDL now emits table-level CHECK / UNIQUE / FOREIGN KEY constraints so store-backed tables retain and keep enforcing them across closeAll() + reopen + rehydrateCatalog. Routed through the existing AST emitter (tableConstraintsToString) via a full-fidelity schema→AST lift, so persistence DDL and declarative AST→SQL DDL cannot drift. CREATE-UNIQUE-INDEX-derived UNIQUE constraints are excluded (round-trip via their index). Reviewed and accepted.
files:
  - packages/quereus/src/schema/ddl-generator.ts                    # full-fidelity lift + emitTableConstraints() + generateTableDDL emission
  - packages/quereus/src/emit/ast-stringify.ts                      # tableConstraintsToString reused (single emitter); canonical path strips name/tags/deferrable
  - packages/quereus/test/schema/catalog.spec.ts                    # parse-back + drop/recreate constraint roundtrip
  - packages/quereus-store/test/ddl-generator.spec.ts               # per-class emit asserts + derivedFromIndex negative
  - packages/quereus-store/test/rehydrate-catalog.spec.ts           # UNIQUE/CHECK/FK reopen-survival enforcement
  - packages/quereus-store/src/common/store-module.ts               # saveTableDDL → generateTableDDL → rehydrateCatalog round-trip
----

# Complete: store DDL round-trip now emits table constraints

## Summary

`generateTableDDL` (the schema→DDL persistence emitter) previously serialized only
columns + PK + USING + WITH TAGS, silently dropping every table-level UNIQUE /
FOREIGN KEY / CHECK. Because `quereus-store` persists that string and re-parses it
on open, all table constraints vanished on reconnect — a data-integrity regression
for the store backend (memory is unaffected — it keeps the live `TableSchema` and
never round-trips).

The fix made `schemaConstraintToTableConstraint` full-fidelity (carries `name` +
`tags`, reconstructs FK deferrability) and added `emitTableConstraints()`, which
renders CHECK → UNIQUE(non-`derivedFromIndex`) → FK through the reused
`tableConstraintsToString`. The canonical-body consumer strips `name`/`tags`/
deferrable downstream, so `constraintToCanonicalDDL` output is byte-unchanged and
the catalog differ (which diffs via the separate `namedConstraints` channel, not
the `ddl` field) is unaffected.

## Review findings

### What was checked
- **Implement diff read first, fresh** (`git show 3b6f2050`) before the handoff
  summary: the `ddl-generator.ts` lift + `emitTableConstraints`, the reused
  `ast-stringify.ts` emitter, and all four test files.
- **Differ isolation** — confirmed the declarative differ
  (`schema-differ.ts::collectDeclaredNamedConstraints` / the actual-side
  `namedConstraints` map) diffs constraints by the `namedConstraints` channel and
  never parses the `ddl` field, so emitting constraints into `ddl` cannot churn the
  differ. Auto `_`-prefixed names are symmetrically excluded on both sides.
- **Canonical path truly unchanged** — `constraintBodyToCanonicalString` does
  `{ ...tc, name: undefined, tags: undefined }` and `canonicalForeignKeyClause`
  drops `deferrable`/`initiallyDeferred`; the added fidelity fields are stripped
  before comparison. Verified green by the `namedConstraints definition
  canonicalization` suite.
- **Constraint↔index relationship** — a table-level UNIQUE auto-builds a covering
  structure (`manager.ts::ensureUniqueConstraintIndexes`); confirmed the store path
  does NOT persist a separate index DDL for it (`saveTableDDL` writes only the table
  DDL; store UNIQUE enforcement is a full-scan), so reopen cannot double-create.
- **Lint + full test runs** (see below).

### What was found / verified beyond the implementer's tests (a floor, not a finish)
- **Re-persist idempotency (gap in implementer's tests — now verified).** The
  implementer's rehydrate tests assert enforcement-after-reopen but not that the
  rehydrated schema re-serializes stably or that constraints aren't doubled. Wrote a
  throwaway store spec that creates a table with one of each constraint class (plus
  an unnamed column CHECK), persists via INSERT, reopens via `rehydrateCatalog`, and
  asserts: (a) exactly one `uq_email`, one `fk_pref`, and `{_check_status, chk_qty}`
  — **no doubling**; (b) `generateTableDDL(rehydrated) === generateTableDDL(original)`
  — **byte-stable**. Passed. The verbose forms (`check on insert, update (...)`,
  explicit `on delete restrict on update restrict`) re-parse to the identical schema,
  so persistence converges. Scratch spec removed after verification (working tree
  clean).
- **Cross-schema FK (documented pre-existing limitation).** `AST.ForeignKeyClause.table`
  is unqualified and cannot encode `referencedSchema`, so a cross-schema FK loses its
  qualifier on round-trip (re-parses to a same-schema reference). By construction this
  is lossy-not-crashing (the emitter simply omits the qualifier); same-schema FKs
  round-trip exactly. Already excluded from catalog drop-ordering. No test added —
  out of scope per the ticket, and not a regression.

### Minor (noted, not fixed — deliberate)
- **Cosmetic case mix.** `generateTableDDL` emits uppercase structural keywords
  (`CREATE TABLE`, `PRIMARY KEY`, `NOT NULL`, `DEFAULT`) but the constraint clause
  is lowercase (`unique (...)`, `check (...)`, `foreign key (...)`) because it reuses
  the lowercase-keyword `tableConstraintsToString`. Re-parses correctly and is
  byte-stable; "fixing" it would mean re-implementing the constraint emitter in
  uppercase, discarding the DRY single-emitter reuse that is the whole point of the
  fix. Left as the correct tradeoff.
- **Column `COLLATE` not persisted (pre-existing, orthogonal).** `formatColumnDef`
  never emitted per-column `COLLATE`, so a NOCASE column's collation is lost on
  persistence round-trip independent of this change. The store's UNIQUE enforcement
  is BINARY full-scan anyway (documented in `docs/schema.md`). Predates this ticket;
  not a constraint-emission concern. Flagging only for awareness — no action here.

### Major
- None. No new fix/plan/backlog tickets filed.

### Validation (reproduced by reviewer)
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` (full runner) — **4849 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/store test` — **292 passing, 0 failing**.
- Targeted: `Schema Catalog` (30), `declarative-equivalence` incl. both churn-idempotency
  guards + `Schema Differ` reserved-tag (77) — all green.
- `yarn test:store` / `yarn test:full` (LevelDB store path) NOT run — release/store-diagnosis
  runs per AGENTS; the DDL persistence/rehydration code is provider-agnostic and fully
  exercised by the InMemoryKVStore provider. No `.pre-existing-error.md` written (no
  failures surfaced).

## Disposition

Implementation is correct, DRY (single emitter, single lift), and idempotent on
re-persist. Tests cover happy path, per-class emit, the derivedFromIndex negative,
reopen-survival enforcement, parse-back, and full drop+recreate; the reviewer added
(and removed) idempotency/no-doubling verification. Accepted as complete.
