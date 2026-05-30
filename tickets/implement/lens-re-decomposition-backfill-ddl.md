description: Engine-emitted backfill DDL for lens re-decompositions. When a basis change is a pure re-decomposition (split / merge / rename that introduces no information the prior basis lacks), the engine generates the backfill — `insert into <new basis member> select <logical-col exprs> from (<prior lens get over prior basis>)` — instead of delegating it to the application. Backfills needing genuinely new data stay the application's responsibility. Adds the persisted, hash-coded **lens deployment snapshot** (the "deployed basis representation" the doc requires), the re-decomposition classifier, and a `quereus_basis_backfill(logical_schema)` introspection TVF that yields per-basis-relation backfill rows tagged engine-generated vs app-supplied. Design source: `docs/lens.md` § "Deployment Is a Compile Step" / "The deployed basis representation".
prereq: lens-foundation-and-default-mapper
files: packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/basis-backfill.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/func/builtins/explain.ts, docs/lens.md
----

## Scope & framing

This is **second-phase deployment polish** — not required for the lens layer to be usable. It implements the half of the basis-evolution backfill obligation that the engine can discharge itself, leaving genuinely-new-information backfills to the application:

> re-decompositions the engine generates from the lens itself; genuinely new information the application supplies. (`docs/lens.md` § Deployment Is a Compile Step)

Consistent with the **ingredient model** (`docs/lens.md` Departures table — "Deployment orchestration | Out of scope | Quereus exposes generate / diff / hash / emit-DDL ingredients; the application assembles the deployment"), the engine **generates and classifies** backfill DDL; it does **not** auto-run a coordinated migration. The application fetches the rows from `quereus_basis_backfill(...)`, runs the engine-generated ones, and supplies its own for the rest — the same shape as today's `diff schema X` → app-runs-the-DDL flow.

The Implementation-Surface line in `docs/lens.md` (the `schema-differ.ts` / `schema-hasher.ts` entry, currently **"pending — the deployed-basis hash record / engine-emitted re-decomposition backfill DDL (`lens-re-decomposition-backfill-ddl`)"**) is what this ticket lands.

## The invariant that makes this generable

A basis re-decomposition changes how the **logical relation** is stored but not the relation itself. The logical relation is the bridge:

```
logical = prior_lens.get(prior_basis) = new_lens.get(new_basis)
```

Each new basis relation is a decomposition (projection / restriction) of the logical relation:

```
new_basis_member = π_member(logical) = π_member( prior_lens.get(prior_basis) )
```

The right-hand side is a **plain query over the prior basis** — the engine has `prior_lens.get` (the prior compiled lens body) and the prior basis tables still hold the data (the asymmetric-removal rule, already shipped, retains detached basis storage for later GC — see `schema-differ.ts:computeLogicalSchemaDiff` and `docs/lens.md` § Deployment step 1). So the engine can emit the backfill.

Canonical cases:

```sql
-- MERGE  (basis CarCore+CarPerf  →  Car), prior lens = join, new lens = single source
insert into y.Car (id, vin, speed)
  select id, vin, speed from ( <prior get: select id,vin from CarCore join CarPerf using(id)... > );

-- SPLIT  (basis Car  →  CarCore+CarPerf), prior lens = single source, new lens = n-way join
insert into y.CarCore (id, vin)   select id, vin   from ( <prior get: select id,vin,speed from Car> );
insert into y.CarPerf (id, speed) select id, speed from ( <prior get> );
```

In both the new basis member columns map (via the **new** lens) to logical columns, and each logical column is produced by the **prior** lens get over the prior basis. The split's per-member column mapping comes from the new lens's resolved advertisement / name-match (the `lens-multi-source-*` work makes the n-way member mapping richer; this ticket consumes whatever the new slot exposes — single-source name-match works today, columnar split lights up once the decomposition slot carries members).

## Classification — pure re-decomposition vs needs-new-data

Per new basis relation `R` backing logical table `T`, and per basis column of `R` that maps to a logical column `L`:

- `L` is **reconstructible** ⇔ `L` was produced by the **prior** deployment's get-body for `T` (i.e. `L ∈ prior_snapshot.tables[T].logicalColumns`, and its prior provenance was not `hidden`). The data existed before; the engine generates the column's backfill.
- `L` is **new** ⇔ absent from the prior deployment (a freshly-added logical column, or a column whose prior provenance was `hidden`/absent). The prior basis has no data for it → **the application supplies it**.
- A **surrogate shared-key** column with a generator default (`SharedKey.kind === 'surrogate'`) is neither reconstructible nor app-supplied: it is **omitted** from the backfill projection so the basis default mints it. NOTE: threading one surrogate across the members of a multi-relation split (evaluate-once-and-thread, `docs/lens.md` § The Default Mapper) is the concern of `lens-multi-source-put-fanout`; for v1 single-relation re-decomposition (merge, or split whose shared key **is** the logical key) the surrogate case does not arise. Document the deferral; emit a `needs-data`-style note rather than an unsound insert if a multi-member surrogate split is encountered.

Per-relation category:
- `re-decomposition` — every mapped column reconstructible → fully engine-generated.
- `partial` — some reconstructible, some new → engine generates the reconstructible columns, lists the rest as `missing`.
- `needs-data` — none reconstructible → entirely the application's.

## The deployed representation — the lens deployment snapshot

To diff prior→new and to read `prior_lens.get`, persist a **lens deployment snapshot** per logical schema, hash-coded with `computeSchemaHash` (reuse, do not re-implement). Captured by `deployLogicalSchema` on successful deploy, **rotated** so the prior survives one re-apply:

```ts
// schema/lens.ts (or a sibling deployment-snapshot.ts)
interface LensTableSnapshot {
  getBodySql: string;                    // prior_lens.get(prior_basis), astToString(compiledBody)
  logicalColumns: readonly string[];     // non-hidden logical columns, declaration order
  // logicalColumn(lower) -> the basis relation(s) + column(s) that backed it under the prior lens
  columnBacking: ReadonlyMap<string, { relationId: string; basisRelation: { schema: string; table: string }; basisColumn: string }>;
}
interface LensDeploymentSnapshot {
  basisSchemaName: string;
  basisHash: string;                     // computeSchemaHash of the basis schema at deploy time
  tables: ReadonlyMap<string, LensTableSnapshot>;   // lowercased logical table name
}
// Stored per logical schema: { previous?: LensDeploymentSnapshot; current?: LensDeploymentSnapshot }
```

Rotation on `apply schema X`: `previous = current; current = freshly-built`. The backfill TVF diffs `previous → current`. A first deploy leaves `previous` undefined → no backfill rows. Storage lives next to the other declared/lens state in `DeclaredSchemaManager` (e.g. `deployedLensSnapshots: Map<logicalSchema, { previous?, current? }>`), with `removeDeclaredSchema` clearing it alongside the lens declaration.

The `basisHash` is the migration-safety record `docs/lens.md` § "The deployed basis representation" calls for: a deploy can confirm the basis it is augmenting matches the one it last deployed against, and a mismatch is a diagnosable "basis drifted out-of-band" condition (surface as a TVF column / reason; do not silently proceed).

## Surface — `quereus_basis_backfill(logical_schema)`

An integrated TVF mirroring `quereus_effective_lens` (`func/builtins/explain.ts`). One row per new basis relation needing backfill, ordered by logical table then basis relation:

| column | meaning |
|---|---|
| `logical_table` | the logical table the basis relation backs |
| `basis_relation` | `schema.table` of the new basis member |
| `category` | `re-decomposition` · `partial` · `needs-data` |
| `backfill_sql` | the generated `insert … select … from (<prior get>)` for the reconstructible columns; `NULL` when `needs-data` |
| `generated_columns` | comma-joined basis columns the engine backfills |
| `missing_columns` | comma-joined basis columns the application must supply (empty for `re-decomposition`) |
| `reason` | human note: which prior get-body sources the data, surrogate omissions, basis-hash-drift warning, etc. |

`quereus_basis_backfill('x')` resolves the logical schema, requires `schema.kind === 'logical'` (same guard `quereus_effective_lens` uses), loads the rotated snapshot pair, and yields the classified rows. With no `previous` snapshot it yields nothing.

### Sequencing contract (document on the TVF + in `docs/lens.md`)

The generated `backfill_sql` reads the **prior** get-body over the **prior basis tables**, which must still hold data when the app runs it. Required order for a re-decomposition deploy:

1. `apply schema Y` — migrate the basis (new member tables created; **prior members retained**, not dropped — they are the backfill source).
2. `apply schema X` — recompile the lens over the new basis (rotates the snapshot; `previous` now holds the prior get-body).
3. `select * from quereus_basis_backfill('x')` — fetch rows; run the `re-decomposition` / `partial` `backfill_sql`; supply app data for `missing_columns` / `needs-data` rows.
4. GC the now-detached prior basis members when convenient (out of scope here).

Because the backfill reads the persisted prior get-body (not the live `X.T` view), step 3 is robust to the lens already pointing at the new basis — the snapshot, not catalog timing, is the source of truth.

## Why this is independent of the prover's deploy report

The prover ticket (`lens-prover-and-attachment`) builds `LensDeployReport` / `LensDiagnostic` at **logical-constraint-enforcement** time. The backfill classification is a different surface (basis-evolution, logical-side TVF) and does not depend on that report. Keep them separate; a later ticket may also echo the backfill summary into the deploy report, but do not couple them here. No hard prereq on the prover.

## Key tests (TDD)

Put in `packages/quereus/test/lens-backfill.spec.ts` (mirror the `rows()` / `expectThrows()` helpers in `test/lens-overrides.spec.ts`).

- **Merge re-decomposition.** Deploy X over a split basis (CarCore+CarPerf), seed data, re-author basis as merged `Car`, `apply schema Y`, `apply schema X`. `quereus_basis_backfill('x')` yields one `re-decomposition` row for `y.Car` with `backfill_sql` = `insert into y.Car(id,vin,speed) select … from (<prior split get>)`. Running it makes `select * from x.Car` equal the pre-migration reconstruction.
- **Split re-decomposition.** Reverse direction (single → n-way via advertisement or join override). Two `re-decomposition` rows (CarCore, CarPerf); both reconstructible; running both reproduces the logical relation.
- **New column needs data.** Logical X gains `color` backed by a new basis `CarColor(id,color)` while the rest is a pure re-decomposition. `y.CarColor` row is `needs-data` (or `partial` if it shares reconstructible key columns); `color ∈ missing_columns`; no engine SQL fabricates `color`. The re-decomposition rows are still engine-generated.
- **First deploy yields nothing.** No `previous` snapshot ⇒ zero rows.
- **Unchanged re-apply yields nothing.** Re-apply identical X+Y ⇒ no new basis relations ⇒ zero rows.
- **Snapshot rotation + hash.** After two deploys, `previous` holds the first deploy's get-bodies and `basisHash`; assert `computeSchemaHash` captured and `previous`/`current` distinct. Drifting the basis out-of-band surfaces a hash-mismatch `reason`.
- **Surrogate omission (single-relation).** A re-decomposition whose new member carries a surrogate-key default omits the surrogate from the backfill projection (basis default mints it); inserted rows get fresh surrogates and the logical relation round-trips. A multi-member surrogate split emits a deferred-note row rather than an unsound insert.

## TODO (implement)

Phase A — deployed representation
- Add `LensDeploymentSnapshot` / `LensTableSnapshot` types (`schema/lens.ts` or sibling).
- `DeclaredSchemaManager`: `deployedLensSnapshots` map with rotate-on-set semantics; getter for `{ previous, current }`; clear in `removeDeclaredSchema`.
- `deployLogicalSchema` (`lens-compiler.ts`): on successful deploy, build the snapshot from the compiled slots (get-body SQL, non-hidden logical columns, per-column basis backing derived from `columnProvenance` + `advertisement` member mapping, name-match otherwise) and rotate it in. Capture `basisHash = computeSchemaHash(basisDeclaredSchema)`.

Phase B — classifier + generator
- New `schema/basis-backfill.ts`: pure `computeBasisBackfill(prev: LensDeploymentSnapshot, currentSlots, basisCatalog): BackfillRow[]`. Identify per-table new basis relations (relations backing `T` in current but not in `prev`), map each new member's basis columns → logical columns via the current slot's advertisement / name-match, classify each column reconstructible vs new vs surrogate, and emit `insert … select … from (<prev.tables[T].getBodySql>)` for the reconstructible projection. Detect basis-hash drift (current basis hash vs `prev.basisHash`) → `reason` note.
- Reuse `computeSchemaDiff` only where it cleanly identifies added basis relations; the column-level reconstructibility logic is backfill-specific and lives here.

Phase C — introspection TVF
- `quereus_basis_backfill(logical_schema)` in `func/builtins/explain.ts` (mirror `effectiveLensFunc`: `numArgs: 1`, `deterministic: false`, logical-schema guard). Yield the classified rows. Register it where `effectiveLensFunc` is registered.

Phase D — docs + validation
- `docs/lens.md`: flip the Implementation-Surface `schema-differ.ts` / `schema-hasher.ts` line from pending to shipped; document the deployment-snapshot record, the `quereus_basis_backfill` TVF surface + columns, the re-decomposition / partial / needs-data classification, and the sequencing contract. Cross-link from § "Deployment Is a Compile Step" and § "The deployed basis representation".
- Run `yarn workspace @quereus/quereus test` + lint (single-quote the lint glob on Windows) before handoff. Stream long output with `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`.

## Known deferrals (note in handoff, do not solve here)
- Multi-member **surrogate** split threading (one surrogate across n members) → interplays with `lens-multi-source-put-fanout`; emit a deferred-note row, not an unsound insert.
- Echoing the backfill summary into the prover's `LensDeployReport` → a later, optional ticket.
- Actual GC of detached prior basis storage → out of scope (the doc keeps it app-driven).
