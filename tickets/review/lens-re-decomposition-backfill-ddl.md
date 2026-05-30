description: Review the engine-emitted backfill DDL for lens basis re-decompositions — the persisted/hash-coded lens deployment snapshot, the re-decomposition classifier/generator, and the `quereus_basis_backfill(logical_schema)` introspection TVF. Verify the classification (re-decomposition / partial / needs-data), the generated `insert … select … from (<prior get>)` DDL, shared-key threading for columnar splits, basis-hash drift detection, and the sequencing contract.
prereq: lens-foundation-and-default-mapper
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/basis-backfill.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/lens-backfill.spec.ts, docs/lens.md
----

## What landed

Second-phase deployment polish: the half of the basis-evolution backfill obligation the engine can discharge itself (pure re-decompositions — split / merge / rename), leaving genuinely-new-information backfills to the application. The lens layer was already usable without this; this is the `quereus_basis_backfill` introspection surface + the deployed-basis snapshot it diffs.

The invariant: `logical = prior_lens.get(prior_basis) = new_lens.get(new_basis)`, so each new basis member is a projection of the logical relation, which the engine already has as a query over the prior basis. Where every column of a new member is reconstructible that way, the engine generates the backfill itself.

### Phase A — deployed representation (`lens.ts`, `declared-schema-manager.ts`, `lens-compiler.ts`)
- `LensDeploymentSnapshot` / `LensTableSnapshot` / `LensRelationBacking` types in `schema/lens.ts`. Per logical table: `getBody` (the compiled prior `get`, stored as **AST** by reference — see deviation #2 below), `logicalColumns` (non-hidden, for reconstructibility), `relationBacking` (per basis relation, its `basisColumn → logicalColumn` pairs), `basisHash` (`computeSchemaHash` of the basis declared schema), and `surrogateMemberKeys`.
- `DeclaredSchemaManager.deployedLensSnapshots` map with **rotate-on-set** (`previous ← current`); `rotateDeployedLensSnapshot` / `getDeployedLensSnapshots`; cleared in `removeDeclaredSchema`.
- `deployLogicalSchema` builds + rotates the snapshot **after** successful catalog mutation (atomic — an aborted re-apply leaves the prior snapshot intact). `deriveRelationBacking` walks the compiled body's projection **plus shared join-key threading** (collectJoinKeyEquivalences) so a columnar-split member that carries the shared key but doesn't project it is still backfillable.

### Phase B — classifier + generator (`basis-backfill.ts`)
- Pure `computeBasisBackfill(prev, current, liveBasisHash?)`. Diffs the snapshot pair, finds new basis relations (in current.relationBacking, not prev), classifies each column reconstructible (∈ prev.logicalColumns) vs new, emits `insert … select … from (<prior get>)` (built as an AST `InsertStmt` → `astToString`) for the reconstructible projection. Categories: `re-decomposition` / `partial` / `needs-data`. Detects basis-hash drift → `reason` note. Defers a multi-member surrogate split.

### Phase C — TVF (`explain.ts`, `index.ts`)
- `quereus_basis_backfill(logical_schema)` (numArgs 1, deterministic false, logical-schema guard mirroring `quereus_effective_lens`). Loads the rotated snapshot pair (nothing if no `previous`), recomputes the live basis hash for drift detection, yields the classified rows. Registered in `BUILTIN_FUNCTIONS`.

### Phase D — docs
- `docs/lens.md` § "The deployed basis representation" expanded with the snapshot record, classification, TVF column table, and sequencing contract; the Implementation-Surface `schema-differ.ts` / `schema-hasher.ts` line flipped pending → shipped.

## Validation status (all green)
- `yarn workspace @quereus/quereus test` → **3916 passing, 9 pending, 0 failing**.
- `yarn typecheck` clean; `yarn lint` clean.
- New `test/lens-backfill.spec.ts` (7 cases, all passing): merge re-decomposition (1 engine-generated row, runs + reproduces the relation); split re-decomposition (2 rows CarCore/CarPerf, both run + reproduce); new-column-needs-data (CarCore/CarPerf `re-decomposition` + CarColor `partial` with `color` missing, never fabricated); first-deploy yields nothing; unchanged re-apply yields nothing; snapshot rotation + basis-hash drift (asserts `previous`/`current` distinct, hashes captured + distinct, prior get-body retained, drift flagged in `reason`); single-relation surrogate omission (the `sk` default column omitted, minted by the basis default, relation round-trips).

## How to exercise (use cases)
```sql
-- Merge: split basis (CarCore+CarPerf) → merged Car
declare schema y { table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } }
apply schema y;  -- + seed
declare logical schema x { table Car { id integer primary key, vin text, speed integer } }
declare lens for x over y { view Car as select c.id, c.vin, p.speed from y.CarCore c join y.CarPerf p using (id) }
apply schema x;  -- snapshot 1
-- migrate basis: ADD merged Car, RETAIN CarCore+CarPerf (backfill source)
declare schema y { table CarCore {...} table CarPerf {...} table Car { id integer primary key, vin text, speed integer } }
apply schema y;
declare lens for x over y { view Car as select id, vin, speed from y.Car }
apply schema x;  -- snapshot 2 (rotates)
select * from quereus_basis_backfill('x');
-- → ('Car', 'y.Car', 're-decomposition', 'insert into "y"."Car" ("id","vin","speed") select "id","vin","speed" from (<prior join>) as "__lens_prior"', 'id, vin, speed', '', '<reason>')
-- run backfill_sql, then `select * from x.Car` reproduces the pre-migration relation.
```
Split is the reverse (single Car → CarCore+CarPerf via a join override). `quereus_basis_backfill` requires `schema.kind === 'logical'` and errors otherwise (like `quereus_effective_lens`).

## Reviewer focus / honest gaps (treat the tests as a floor)

1. **`partial` generates a key-only skeleton insert.** Per the ticket ("engine generates the reconstructible columns, lists the rest as `missing`"), a `partial` relation emits `insert into R (<reconstructible cols>) select … from (<prior get>)` — for the new-column case that is just the key, producing one skeleton row per prior logical row with the new column NULL, which the app then UPDATEs. **Worth a hard look**: is skeleton-insert the right default, or should a relation whose *only* reconstructible columns are keys be `needs-data` (app owns the whole insert)? It currently classifies `partial` whenever ≥1 column reconstructs. The test only checks classification + that `color` is never fabricated; it does **not** run the partial backfill.

2. **Signature / storage deviations from the ticket sketch.** (a) `computeBasisBackfill(prev, current, liveBasisHash?)` takes **both snapshots** rather than the ticket-suggested `(prev, currentSlots, basisCatalog)` — the doc endorses "the snapshot, not catalog timing, is the source of truth," so the differ reads only the deterministic snapshot pair. (b) `LensTableSnapshot.getBody` stores the compiled **AST** (by reference to the never-mutated `compiledBody`), not the `getBodySql: string` the ticket typed — for fidelity / no re-parse; `astToString(getBody)` recovers the SQL. (c) the ticket's per-logical-column `columnBacking` became per-relation `relationBacking` (with join-key threading) because a split member needs the shared key even when the lens projects it once.

3. **Basis-hash drift is live-vs-current, not prev-vs-current.** The ticket text said "current vs prev," but prev≠current is true for *every* normal re-decomposition (the basis legitimately changed). Drift is computed as `liveBasisHash (recomputed at TVF time) !== current.basisHash` — the meaningful "basis drifted out-of-band since the last lens deploy" signal. Confirm this matches intent.

4. **Multi-member surrogate split deferral is dormant defensive code.** `surrogateMemberKeys` is derived from `slot.advertisement` (surrogate shared key). But the v1 body producer does **not** synthesize the advertisement join (that's `lens-multi-source-decomposition`), so a compiled body never references advertisement member relations → `relationBacking` never lists them as new relations → the deferral branch is currently unreachable in practice. It is sound defensive code for when synthesis lands, but it is **untested** (no test can set it up today). Flagged as a known deferral, not a verified path.

5. **Computed (non-column) projections get no basis backing.** `deriveRelationBacking` only records plain column refs; a computed logical column (`first || ' ' || last`) is omitted from `relationBacking`, so it plays no part in a re-decomposition classification. Correct for pure split/merge/rename (plain refs); a re-decomposition mixing computed columns won't classify those columns. Worth confirming this is acceptable for v1.

6. **ON-condition key threading is best-effort.** `using (...)` is the fully-exercised path; `on a.x = b.y [and …]` extracts only AND-conjoined `col = col` equalities. Complex ON predicates (functions, OR, non-equi) won't thread keys → split members joined that way would miss their key and classify as `partial`/`needs-data`. Tests use `using`.

7. **No enforcement of the sequencing contract.** The engine generates the DDL but does not enforce that the app retains the prior basis members (the backfill source) or runs steps in order; a basis migration that drops prior members before backfilling will make the generated SQL fail at runtime. This is by design (ingredient model) but is unguarded.

## Known deferrals (documented, not solved here)
- Multi-member **surrogate** split threading (one surrogate across n members) → `lens-multi-source-put-fanout`.
- Echoing the backfill summary into the prover's `LensDeployReport` → later optional ticket.
- GC of detached prior basis storage → out of scope (app-driven).
