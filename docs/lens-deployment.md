# Lens Deployment

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

What happens when a logical schema is deployed against a basis with `apply schema`: the compile steps, the persisted record of what was deployed, the notification modules receive, and the engine-generated backfill for a storage re-decomposition. A satellite of [Lenses and Layered Schemas](lens.md).

## Deployment is a compile step

> **Invariant:** [LENS-001](invariants.md#lens-001--a-logical-removal-never-drops-basis-storage)

Quereus is a query-processing engine, not a deployment system, but it exposes the ingredients an application needs to assemble a complete deployment story. (For the multi-peer dimension — evolving a schema across synced replicas that upgrade at different times — see [Schema Migration in a Synced Database](migration.md), which builds on the deployment ingredients here.) Deploying a logical schema against a basis is a **compile**:

1. **Generate / diff the basis.** The basis is a generated-then-frozen artifact. On each deploy it is diffed against the deployed representation by the declarative-schema differ. Logical evolution produces *additive* basis diffs (new column / table). A column removed from the logical schema does **not** cascade to a basis drop: the mapping detaches and the basis column is retained for later garbage collection. This asymmetry — logical removals never drop basis storage — is what keeps the basis append-mostly and migrations safe.
2. **Compile the lens.** For each logical table, merge the override (if any) with generated gaps into an effective view body over basis.
3. **Register inline.** `Logical.X.T` resolves to that effective body; the query processor sees an ordinary view. The logical spec's constraints are attached at the lens boundary.

The compile is **atomic**: every logical table is compiled and [proved](lens-prover.md#coverage-checklist) before any catalog mutation, and the blocking errors of every table are aggregated into one deploy failure, so a blocked deploy leaves the previously deployed lens state untouched.

A re-deploy is **clear-and-rebuild**: every lens view and slot of the logical schema is replaced. After the catalog mutation it fires one schema-change event per previously deployed view — `lens_view_replaced` (old and new view) when the table is still declared, `lens_view_removed` when it left the declaration; a first deploy fires none. These are deliberately not the `view_added` / `view_removed` a plain `create view` / `drop view` fires: a store-backed catalog persists views on those, and a lens view is recompiled on every deploy, never stored. A prepared statement that read a lens view re-plans on either event; a materialized view whose body read one goes stale on removal, and on replacement only when the get-body or its column names changed ([Schema-change staleness](mv-schema-change.md)). A blocked deploy fires nothing.

The authored source stays sparse (signal only). The *compiled* effective mapping is the inspectable, generated-on-demand artifact (the noise). Because the basis is frozen and the effective lens is recomputed at compile from frozen inputs, the result is deterministic, not a moving target.

## The deployed basis representation

Migrations require a stable record of *what is deployed*, so augmentations can be generated against it and basis invariants verified to be intact. The deployed basis is therefore persisted and **hash-coded** (reusing the schema hasher). A deploy compares the freshly generated basis against the deployed hash, computes the additive diff, and — for data-effecting changes (column adds with backfill, decomposition changes) — emits DDL the application can run with custom backfills, exactly as the declarative-schema pipeline already supports. Schema-only changes (rename) are metadata; data-effecting changes (split / merge / pivot) carry a backfill obligation.

A useful subset of that backfill obligation is **engine-expressible rather than fully delegated**. When the new basis can be populated by running the new lens `get` over the prior basis — a pure re-decomposition such as a split or merge that introduces no information the prior basis lacks — the differ can emit the backfill as generated DDL, the same shape as a one-shot derivation. Only backfills that need data the prior basis does not contain remain the application's to supply. The obligation thus splits cleanly: re-decompositions the engine generates from the lens itself, genuinely new information the application provides.

### The lens deployment snapshot

The deployed representation is persisted per logical schema as a **lens deployment snapshot** (`LensDeploymentSnapshot`), captured on each successful `apply schema X` and **rotated** (`previous ← current`), so the prior deploy survives exactly one re-apply. The snapshot is the **source of truth** the backfill differ diffs — robust to the lens already pointing at the new basis, because it records the *prior* compiled `get` rather than re-deriving from live catalog timing. Per logical table it holds:

- `getBody` — the compiled `get` body deployed for the table (`prior_lens.get(prior_basis)`), wrapped as the backfill's `from (<prior get>)` subquery;
- `logicalColumns` — the logical columns (declaration order), used to test reconstructibility;
- `relationBacking` — per basis relation, the `(basisColumn → logicalColumn)` pairs it backs, derived from the body's projection **plus shared join-key threading** (a columnar split joins its members on a shared key but projects it once; the other members carry the key column and must be backfilled with it);
- `basisHash` — the schema hash of the basis declared schema at deploy time. This is the migration-safety record: a later deploy or introspection confirms the basis still matches the one last deployed against, and a mismatch is surfaced (not silently proceeded past) as a basis-drifted-out-of-band warning.

A first deploy leaves `previous` undefined ⇒ no backfill rows; an unchanged re-apply introduces no new basis relations ⇒ no backfill rows.

### Module deployment notification

The snapshot is also the payload of a **module-facing notification**. A `VirtualTableModule` may implement the optional hook

```ts
notifyLensDeployment?(
  db: Database,
  logicalSchemaName: string,
  snapshot: LensDeploymentSnapshot,
): void | Promise<void>;
```

which the engine fires once per **successful** logical `apply schema X`, after the lens views + slots are registered and the snapshot is rotated. This is the hook a host adapter backing the basis uses to realise / reconcile its backing relations against the freshly deployed lens, rather than mirroring the snapshot shape by hand. The firing contract:

- **Once per successful apply.** Fires only when the deploy returns without throwing — the deploy is atomic, so a blocked deploy (prover error, malformed advertisement, …) aborts before the notification. A **physical** `apply schema` deploys no lens and never fires it.
- **After deploy, outside any migration batch.** The logical-apply path runs no migration-DDL loop (that is the basis/physical path); the notification fires once the lens catalog mutation + snapshot rotation are complete.
- **Snapshot scoped to the affected schema, no second derivation.** The engine re-reads the just-rotated `current` snapshot and passes that exact object, so the notification and `quereus_basis_backfill` see one source of truth. An **empty deploy** (every logical table removed) still fires, carrying an empty snapshot, so a consumer observes the detach.
- **Every registered module, registration order.** A module that backs none of the basis relations should no-op. A module under the [isolation wrapper](../packages/quereus-isolation/README.md) receives the notification through a straight delegate (the deployed shape is isolation-transparent).
- **Errors propagate.** The lens is already deployed when the hook fires; a notification that throws aborts `apply schema X` with that error so the caller learns the module's reconcile failed. The deployed lens is **not** rolled back — a subsequent re-apply re-fires the notification.

### Classification — re-decomposition vs needs-data

For each **new** basis relation `R` (one the prior lens did not back) the differ classifies each of `R`'s columns:

- **reconstructible** — its logical column was produced by the prior get-body (`∈ previous.logicalColumns`); the engine generates its backfill.
- **new** — absent from the prior deploy; the prior basis has no data, so the **application supplies it**.
- A basis column that maps to **no** logical column (e.g. a surrogate-key default) is naturally absent from `relationBacking` and so is **omitted** from the projection — the basis default mints it.

The per-relation category is then `re-decomposition` (every column reconstructible → fully engine-generated), `partial` (some reconstructible → engine generates those, lists the rest as `missing`), or `needs-data` (none → entirely the application's). Threading one *surrogate* shared key across the members of a multi-relation split is part of the [`put` fan-out](lens-default-mapper.md#the-put-fan-out); a multi-member surrogate split emits a `needs-data` deferred-note row rather than an unsound insert.

**The NOT-NULL rule.** A `partial` row's generated `backfill_sql` is a key-only skeleton `insert` that seeds only the reconstructible columns and relies on the basis to mint each omitted column from its declared default. That is sound **only when every omitted basis column is nullable, defaulted, or generated**. Because Quereus columns are **NOT NULL by default**, an omitted column that is NOT NULL with no default has *no* value source: running the skeleton would fail an unguarded NOT NULL constraint. In that case the classifier emits **`backfill_sql = null`** (the application owns the whole insert) while keeping the `partial` category and the reconstructible-columns record, so the app still learns which columns are reconstructible. The runnability test is at the relation level — every NOT-NULL, no-default, non-generated basis column of the member must be among the reconstructible columns — so it also covers a required member column the lens maps to no logical column. **Any emitted `backfill_sql` therefore never fails an unguarded NOT NULL constraint.**

### `quereus_basis_backfill(logical_schema)`

The classified rows are introspected by the integrated TVF, mirroring [`quereus_effective_lens`](lens.md#quereus_effective_lensschema-table): it requires a logical schema, loads the rotated snapshot pair (yielding nothing with no `previous`), and yields one row per new basis relation, ordered by logical table then basis relation:

| column | meaning |
|---|---|
| `logical_table` | the logical table the basis relation backs |
| `basis_relation` | `schema.table` of the new basis member |
| `category` | `re-decomposition` · `partial` · `needs-data` |
| `backfill_sql` | the generated `insert … select … from (<prior get>)` for the reconstructible columns; `NULL` when `needs-data`, or when a `partial` skeleton would violate NOT NULL (the application must own the insert) |
| `generated_columns` | comma-joined basis columns the engine backfills |
| `missing_columns` | comma-joined basis columns the application must supply (empty for `re-decomposition`) |
| `reason` | human note: classification rationale, surrogate omissions, basis-hash-drift warning |

Consistent with the **ingredient model** (the engine generates and classifies the backfill DDL; it does not auto-run a coordinated migration), the application fetches the rows, runs the engine-generated ones, and supplies its own for the rest — the same shape as the `diff schema X` → app-runs-the-DDL flow.

### Sequencing contract

The generated `backfill_sql` reads the **prior** get-body over the **prior** basis tables, which must still hold data when the app runs it. The required order for a re-decomposition deploy:

1. `apply schema Y` — migrate the basis (new member tables created; **prior members retained**, not dropped — they are the backfill source).
2. `apply schema X` — recompile the lens over the new basis (rotates the snapshot; `previous` now holds the prior get-body).
3. `select * from quereus_basis_backfill('x')` — fetch rows; run every non-`NULL` `backfill_sql`; supply app data for `missing_columns`, `needs-data` rows, and any `partial` row whose `backfill_sql` is `NULL`.
4. GC the now-detached prior basis members when convenient.

Because the backfill reads the persisted prior get-body (not the live `X.T` view), step 3 is robust to the lens already pointing at the new basis — the snapshot, not catalog timing, is the source of truth.

## Current limitations

- **GC of detached prior basis storage** — a logical removal detaches the mapping and retains the basis column; reclaiming it is application-driven and out of scope here. (For the synced-deployment retirement policy that consumes this boundary — three-state basis classification, retention horizons — see [Migration § Retirement](migration.md#4-contract--retire-the-old-table).)
