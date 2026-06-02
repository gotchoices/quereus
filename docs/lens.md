# Lenses and Layered Schemas

## Overview

Quereus separates a database into three relational layers, in the Codd / ANSI-SPARC tradition but expressed entirely in Quereus's own primitives (all relations virtual, key-addressed, no rowids):

- **Logical** — the relations a developer designs and reasons about, free of any storage commitment. A logical schema declares tables with columns, types, and *logical* constraints (primary key, unique, check, foreign key, not null) and nothing physical: no module association, no indexes, no storage hints. It is a pure design.
- **Basis** — the relations that modules actually back. Basis tables are ordinary `using module(...)` tables and may be spread across many modules (a single logical table can map to a columnar decomposition over several basis tables). Basis is still *relational* — it is the lowest layer a developer reasons about as relations. Covering structures (secondary indexes, unique-enforcement structures) live here as materialized views.
- **Mapping (the lens)** — for each logical table, a bidirectional relational expression that realizes it over basis relations. `get` is the query that produces the logical relation; `put` is the update propagation that pushes logical mutations down to basis. The lens is *not* a schema; it is a per-logical-table **slot**, populated either by explicit `declare lens` syntax or generated internally when absent.

Below basis sits the **physical** layer — module storage layout and the on-disk/in-memory realization of covering structures. The lens never sees physical concerns; it composes over basis relations, and modules handle storage beneath.

The decisive property is **decoupling**: a logical design carries no embodiment, so one logical schema can be paired with different basis schemas (a row-store, a columnar split, an exotic module) at different deployments. The lens is where a design meets a storage.

## What a Lens Is

A lens is the bidirectional-transformation (`get` / `put`) pair that Quereus's [view updateability](view-updateability.md) already provides: `get` is an ordinary `select`, and `put` is the predicate-driven propagation pass. The lens layer adds no new algebra. **There is exactly one operator set — relational algebra — used in both directions.** This is a deliberate design constraint:

- **`get` is relationally complete.** Any mapping expressible as a view is expressible as a lens, because a lens body *is* a view body.
- **`put` is the invertible fragment plus explicit disambiguation.** Not every relational expression has a sound, total inverse. Where propagation can infer the inverse it does; where it cannot, the gap is filled by explicit hints (`default_for`-style tags) or the mutation surfaces a structured diagnostic. Invertibility is made explicit rather than restricting the language.

To the query processor, a logical table is simply a view that is "out there, ready to go." Selecting from `Logical.T` resolves to the lens-compiled body over basis; mutating it propagates through that body via the standard view-update machinery. All lens-specific work happens at compile time: **validate, generate, and attach semantics**.

## Schema Kinds

`Schema` carries a `kind`:

- **`physical`** — module-backed schema. Tables declare `using module(...)`, may carry indexes (as index declarations or materialized views), storage tags, and the full physical surface.
- **`logical`** — declarative-only. Tables declare columns, types, logical constraints, and `with tags`. Module association, indexes, and any physical storage construct are rejected at build time. Tags *are* allowed — they are engine-facing metadata, not a physical commitment, and they survive into the compiled view.

There is no `lens` schema kind. The mapping for a logical table lives in that table's lens slot.

## The Lens Slot

Every logical table has one **lens slot** holding:

- the mapping body (a relational expression over basis), and
- the attachment of the logical spec's constraints and tags onto that body.

The slot is populated by one of two paths:

1. **Explicit** — a `declare lens` block supplies an override body for some logical tables (and may cover only some columns of a table).
2. **Generated** — when no override exists, or for columns an override does not cover, the default mapper generates the body.

At any deployment a logical table has exactly **one** active lens (its inlined body). Portability across embodiments is a *source-level* property — the same logical schema can be written against different lens+basis pairs for different targets — not a simultaneous-catalog property.

## The Default Mapper

When a lens body is not authored, it is generated. The generator is **module-specific and customizable**: the strategy of a standard row-store is the default, but modules can advertise their own logical→basis mapping so that exotic storage strategies (columnar decomposition, EAV, column-family) are accommodated without the developer authoring the join.

The default mapper is an **aligner over two independently-authored models**. Given a logical schema and a basis schema, it matches logical relations and columns to basis by name, type, and structure — and by module advertisements (e.g. "these five basis tables are a columnar decomposition sharing key `id`," from which the mapper generates the n-way join). A developer's overrides are *corrections to the alignment* plus intentional transforms; a rename is simply an alignment the developer overrode on purpose.

Four properties of the generated join are load-bearing for correctness:

- **Advertisements can be primary, not supplementary.** Name/type/structure matching works only when the basis surfaces logical column names. When a decomposition does not — generic value-columns, EAV triples, column-family layouts — the module advertisement is the *sole* alignment source and must carry enough to map each basis relation to the logical column(s) it backs. The advertisement also informs the **`put`** direction, not only `get`: it tells propagation the fan-out shape and the shared key, so an insert through the generated lens reaches every member of the decomposition.
- **Optional components are outer-joined.** A logical row may lack a value for a column that lives in a separate basis relation. The generated body must preserve such a row, so the mapper outer-joins optional components onto the relation that establishes row identity (the preserved side) and inner-joins only mandatory (`not null`) components. Inner-joining everywhere would silently drop rows missing an optional component. The existence soundness of a mandatory inner-join rides the propagated [inclusion-dependency](optimizer.md) surface: the lens compiler injects one inclusion dependency per mandatory component onto the existence anchor, so the prover proves every logical row matches the mandatory side against a threaded existence fact rather than a separate scan (see *The existence-anchor inclusion-dependency contract* below).
- **The shared key need not be a logical key.** A module may join its basis relations on a **surrogate** key and carry the logical key as an ordinary value column. This is a deliberate choice with a consequence: when the shared key is a surrogate, evolution of the logical key (rename, retype, reshape) is a mapping-level edit, because the basis already treats the logical key as a value; when the shared key *is* the logical key, the same evolution is basis-invasive. A surrogate is supplied at insert by a basis-level default, and the load-bearing requirement is **evaluate-once-and-thread**: the surrogate is computed once per logical row and the same value is reused across every branch of the decomposition's fan-out, so all members of the n-way insert agree on identity. The default may be a **non-deterministic generator** (`uuid7()`, `nanoid()`, …) where the local DML policy permits non-determinism — the [change-capture layer](incremental-maintenance.md) records the *resolved* row, so reactive consumers, assertions, and replay see concrete values rather than the expression. The [mutation-context envelope](view-updateability.md#mutation-context) remains available where binding the seed at the statement level is preferred (e.g. to share it across several computed columns), but it is not required for surrogate generation.
- **The empty key (singleton) is the degenerate case, not a special path.** A logical table with `primary key ()` holds 0-or-1 rows. The primary key always decomposes to an existence relation whose arity equals the PK's arity, so a zero-arity PK yields a zero-column, 0-or-1-row existence relation — a basis singleton. The key-equi-join that stitches columns onto the anchor is a conjunction of per-key-column equalities; over a zero-column key that conjunction is empty, hence vacuously `true`, so the generated join reduces to `on true`:

  ```sql
  -- normal table: key = (id)            singleton: key = ()
  from   b_pk      x                     from   b_config__exists x   -- 0-or-1 row, no key, no value
  left join b_col1 c1 on c1.id = x.id    left join b_config_theme  t on true
  left join b_col2 c2 on c2.id = x.id    left join b_config_locale l on true;
  ```

  `left join … on true` is a left Cartesian product; with the anchor 0-or-1 row and each column relation 0-or-1 row, the result is 0-or-1 row — the singleton's cardinality. There is no surrogate to generate (with at most one row there is nothing to distinguish), and the existence anchor still matters for the same reason the multi-row PK store does: it lets the singleton exist with every column null, rather than collapsing "row exists" into "some column is set." The mandatory-column elision applies identically — a `not null` column's relation can serve as the anchor, dropping the separate existence relation.

### The module mapping advertisement

A module advertises how a set of *its* basis relations jointly back one logical table by returning `MappingAdvertisement` descriptors from the optional `VirtualTableModule.getMappingAdvertisements(db, basisSchema)` hook. The method is **module-level given the basis schema** — a module spans many tables and a decomposition spans many relations, so it returns every decomposition it recognizes and the lens compiler's resolver indexes them. Omitting the method means name-match only. A *dedicated* module (columnar / EAV / nd-tree) synthesizes advertisements from its own knowledge; a *generic* module (memory / store) delegates to a shared builder, which assembles them from `quereus.lens.decomp.*` reserved tags on the basis tables.

**Storage and access are separate facets and need not be symmetric.** *Storage shape* (`StorageShape`) drives `put` and the `get` join skeleton; *access shape* (`AccessShape`) drives `get` read-path planning. An nd-tree carries an `access` facet (spatial predicate forms over a coordinate tuple) with a `storage` facet identical in shape to the column stores beside it. The access vocabulary (`AccessForm`) is string-typed with built-in constants (`equality` / `range` / `prefix` / `contains` / `intersects` / `knn`), open by design so vector-similarity / full-text / time-series forms can land without re-litigating the type. A **surrogate vs logical-tuple** shared key is first-class (`SharedKey.kind`): a surrogate requires a generator and engages the per-row evaluate-once-and-thread path, while a logical-tuple key collapses generation entirely. One member is the **existence anchor**, named explicitly (`StorageShape.anchorRelationId`) — never reverse-engineered from outer-join structure. A logical table may have at most one `primary-storage` advertisement (which drives write fan-out); the rest are `auxiliary-access` (read-path-only structures the planner chooses among — see *Auxiliary-access read-path routing*).

**Resolution and validation happen at lens-compile time**, before body compilation. The resolver collects advertisements from every module owning a basis table, filters to the logical table, selects the single primary, and validates structural coherence — the anchor is a member; every member relation, mapped basis column, pivot column, and shared-key column exists; a surrogate key has a generator and a logical-tuple key does not (and its per-member key arity matches the logical PK); every logical column is backed by exactly one member, an EAV pivot, or a name-match. A malformed advertisement aborts the deploy **atomically**, before any catalog mutation.

The default mapper then **consumes** the resolved primary to synthesize the n-way **`get`** body: a left-deep equi-join rooted at the existence anchor (anchor first), mandatory members inner-joined, optional members outer-joined, and EAV pivot members projected as correlated scalar subqueries rather than joined. An EAV column's subquery matches the pivot's attribute column against the **logical column name as a literal**, compared by value equality — so the basis triples must spell the attribute exactly as the logical column is declared, including case; the protocol does not case-fold attribute literals.

#### The existence-anchor inclusion-dependency contract

The `id` a module (or the tag builder) mints **is** the existence anchor's `relationId`, and it must be stable and unique within the basis schema. That id is the `relationId` the lens compiler passes to `InclusionDependency` (`IndTarget.kind: 'relation'`) when it injects one inclusion dependency per mandatory member onto the anchor, recorded on the slot for the prover. The fact is threaded **via the slot**, not seeded at the member scan: the prover plans the compiled body *before* the slot is committed (atomic compile-first deploy), so a scan-time seed would never reach it, and the surrogate join carries no declared SQL FK to recognize. Only **mandatory** members are injected (direction `anchor.key ⊆ member.key`, `nullRejecting: false`, total existence); optional members (outer-joined, their absence preserved), EAV pivots (never inner-joined), and the empty-key singleton inject nothing, since any of those would over-claim.

#### The `put` fan-out

A decomposition body routes off the generic two-table join path to an advertisement-driven member fan-out — the generic path would be unsound for a decomposition (it picks a single delete side, caps at two members, and rejects the outer joins optional members ride). The fan-out's **backward decisions** — column→member routing and the anchor-resolvable predicate gate — are derived from the threaded plan-node update lineage, read through the **shared backward-walk consumer** that plans the synthesized `get` body once and routes each output column to its owning base relation. Single-source, multi-source join, and decomposition share this one consumer. The advertisement supplies the member-presence, shared-key, and EAV-pivot metadata that disambiguates the deferred shapes and drives the insert envelope.

- **DELETE** fans out to every member (mandatory, optional, EAV pivot). Members are ordered **anchor-last**, and each non-anchor member's identifying set is read from the **anchor alone** (`… where memberKey in (select anchorKey from anchor where <pred>)`), never the full join — so an earlier member's delete can never shrink a later member's identifying set. A no-`WHERE` delete is an unconditional `delete from <member>` per member (also the sound singleton path). An EAV pivot's delete removes every triple for the matched entity.
- **UPDATE** routes each assignment to the single **mandatory, non-EAV** member backing it, keyed off the anchor the same anchor-last way.
- **INSERT** fans out one insert per member, **anchor first** (FK-order root), off a shared-surrogate mutation envelope: the user source is materialized once and read back per member, so a generated key is minted **once per produced row** and threaded into every member's key column(s) — the evaluate-once-and-thread invariant. A **surrogate** key mints an auto integer at the envelope (`per-row` ⇒ `seed + ordinal`, distinct per row; `per-statement` ⇒ `seed + 1` bound once for the statement); a **logical-tuple** key threads the supplied logical PK straight through, with no generation. **Optional** members materialize a row only for the rows that supply ≥1 of their columns (a per-row presence filter — the outer-join absence the read preserves); an **EAV pivot** emits one triple insert per supplied attribute (the attribute literal spelled as the logical column is declared), gated on a non-null value; a **singleton** (`primary key ()`) inserts each member unconditionally over the empty key. `on conflict` composes across the member ops; the statement is atomic (a mid-fan-out failure rolls back).

A DELETE/UPDATE `WHERE` is admitted whenever it is **anchor-resolvable** — every logical column it names is either an anchor identity base column *or* a computed mapping whose basis lives on the anchor (`bumped = a + 1` → `a + 1 = 11`; `combined = a || b` → `a || b = '1020'`). Both substitute into a predicate over the anchor's own base columns, which the anchor key subquery already evaluates, so no new substrate is needed. A `WHERE` that references a genuine non-anchor member is deferred (see [Current limitations](#current-limitations)).

#### Override composition with an advertisement

An explicit `declare lens` override composes with an advertised mapping:

- An override **corrects** an advertised column mapping the same way it corrects a name-match — a covered column wins, a rename caps the boundary; the corrected column's provenance still records the advertised member.
- An uncovered logical column gap-fills from the advertisement's per-column mapping when one is present (richer than name-match), re-qualified to that member's alias in the override's `FROM`, falling back to the FROM name-match when the advertisement does not back it. An uncovered column whose backing member is absent from the override's `FROM` errors precisely (naming the column and the member it would need).
- An override may **not** silently re-anchor or change the shared key: a *sparse* override (one that relies on gap-fill) whose FROM references a basis relation outside the advertised decomposition errors, naming the offending relation and the advertised anchor. The developer must instead author a *full* hand-authored body (covering every column), which then bypasses the advertisement entirely.

#### Auxiliary-access read-path routing

When an outer query's `WHERE` over an inlined lens view matches a form an `auxiliary-access` advertisement serves over an advertised column, the planner routes the read through that structure — an **auxiliary seek ⋈ primary decomposition on the logical key** — instead of scanning the full decomposition and applying the predicate as a residual filter. A zero-cost pass-through marker (`LensAuxiliaryAccessNode`) carries the table's routable auxiliaries to the optimizer rule, which is registered *before* predicate-pushdown so the predicate is still directly above the marker. On a match the rule rewrites the matched predicate's access column from the logical column to the auxiliary's **backing basis column**, pushes it onto a scan of the auxiliary's member relation (so the auxiliary's own module serves it through the existing `supports()` / `getBestAccessPlan` surface — no new module execution path), and **semi-joins** that seek back to the decomposition body on the logical primary key. The semi-join preserves the body's output shape and **consumes** the matched predicate (an advertised form is treated as *exact* — the auxiliary fully answers it).

Two channels feed the form-matcher: **comparison forms** (`equality` / `range`) match a `column op value` conjunct; **function-predicate forms** (`prefix` / `contains` / `intersects` / `knn`, and any open form) match through an **extensible recognizer registry** keyed by form name. That registry is the extensibility contract — a vector-similarity or full-text module lands later by advertising a new form and registering a recognizer with **zero engine change**, and until a recognizer exists the query simply scans (graceful degrade). Every step that cannot proceed emits no rewrite and leaves the scan in place: an unrecognized form, a predicate that does not match a recognizer's shape, an access column that is not a logical output, a matched fragment that references any logical column **other than** its access column (it would dangle once pushed below the semi-join onto the aux scan), or an auxiliary lacking a logical-PK-aligned `storage` shape.

The optimization is **non-regressing by construction**: the pre-existing path was a correct residual-filter scan, and the marker is built only for a logical table with a routable auxiliary, so non-lens and non-routable-lens views are untouched. On a match the auxiliary path is selected (it replaces residual-filter-over-full-scan, so it is beneficial whenever it matches); more than one matching auxiliary resolves deterministically by advertisement `id`. The rule routes one **function-predicate** match per query and defers comparison forms to the primary body's own predicate-pushdown, which already answers them — the auxiliary is load-bearing only for exotic forms a scan-plus-residual-filter cannot push.

## Sparse Overrides

The authoring goal is **override without takeover**: a developer renaming one column of a logical table that maps to an n-way join over columnar basis tables must not be forced to write the join. Two mechanisms make this work.

### The baseline is never authored text

The generated mapping is never written into source. The authored artifact contains **only deviations**, so the source is all signal and no noise — which is precisely why full code-generation fails (it buries the intentional, abnormal mappings in generated noise). The full effective mapping is inspectable on demand ("show effective mapping"), but it is not the thing the developer edits.

### Overrides are merged per-attribute

An override authored as ordinary SQL is consumed as a **sparse patch keyed by attribute**, not as opaque text. At compile time, for each logical table:

1. The override `select` (if any) is parsed to a relational expression.
2. Its output **coverage** is read — which logical columns it covers, and from which basis expressions.
3. For every logical column the override does not cover (and does not `hiding`), the default mapper generates the mapping and composes it in.

So renaming a column and later adding a column compose cleanly: the rename override is untouched, and the new column appears as an uncovered attribute the mapper fills. The result is one effective `select` whose projection is exactly the logical columns, in declaration order, minus the hidden ones.

Most overrides cap the generated body at the boundary (rename = projection-with-alias, hide = projection-away, compute = extend, filter = restrict) and never touch the join interior. A change that *must* reach inside the join (a column now originating from a different basis table) is genuinely structural, cannot reduce to a boundary cap, and therefore correctly costs more authoring and surfaces as signal.

#### Coverage is name-based and re-read from source

The eventual mechanism addresses coverage by **stable attribute ID** on the plan tree (riding the existing [attribute-provenance](optimizer.md#attribute-provenance) system), which is what the prover needs anyway. Today the merger composes at the AST level and reconciles the same two properties more cheaply:

- **Coverage is read by name.** A logical column is *covered* when the override's output column name (the `as` alias, e.g. `speed as maxSpeed`, or a bare column name, or a `*`-expansion of a FROM source) matches the logical column name (case-insensitive). Everything else is gap-filled.
- **Survival across baseline regeneration comes from re-reading the override AST from source on every deploy.** The stored override is never rewritten, so the *rename-then-add* example composes: the rename override is untouched and the freshly-added logical column is simply uncovered → gap-filled. This re-read-from-source is the load-bearing assumption of the merger; it stands in for the attribute-ID property.

**`hiding (col, ...)`** lists logical columns to omit from the effective body *and* from the registered view's column list, so `select * from X.T` does not surface them and `X.T.<hidden>` resolves to unknown-column. The logical spec still *declares* a hidden column — the prover decides what an attached constraint over a hidden column means. Each name is validated against the logical table's columns at deploy time; a name matching no logical column (a typo) is an error, not a silent no-op.

#### Body-shape restrictions

The merger composes one effective body by replacing **only the top SELECT's projection** with the composed logical-column list (covered ⊕ gap-fill ⊖ hidden). Body shapes that this single-projection rewrite cannot soundly compose are rejected at deploy/parse time rather than silently mis-mapped:

- **The body must be a single `SELECT`.** Compound set-operations (`union` / `union all` / `intersect` / `except`) and `values (...)` bodies are rejected at parse time — the merger would compose only the top leg and keep the rest verbatim.
- **A computed projection term must be aliased.** An unaliased non-column term (e.g. `select id, speed * 2 from …`) maps to no logical column; it is rejected (naming the term) rather than dropped and gap-filled.
- **Override `FROM` sources must live in the declared basis.** A `table` source (including each leg of a join) qualified with a *different* existing schema (e.g. `from Z.Foo` while the lens is `over Y`) would silently re-anchor the body to `Z`; it is rejected. Unqualified tables (default to the basis) and tables qualified with the basis name are fine, including cross-table joins *within* the basis. The check walks the **whole override body** reflectively, so a cross-basis table buried inside a subquery source, a `with` CTE body, a compound leg, a function-source argument, or a scalar/`where`/`in`/`exists` subquery is rejected too — not only top-level sources. (No CTE-name tracking is needed: the check fires only on an explicit non-basis *schema qualifier*, and CTE/alias references are always bare.)

#### Gap-fill fidelity boundary

Gap-fill resolves an uncovered logical column against the basis tables in the override's `FROM`. When it cannot, it errors rather than guess:

- **Single-source override, basis lacks the column** — the *hide-via-gap-fill trap*: the compile errors naming the column (the author meant to hide it, or to cover it, and did neither).
- **Partial cross-basis join, the gap needs another source** — a full-coverage cross-basis join is fine (gap-fill is a no-op and the body is used verbatim), but a join that covers only *some* columns where an uncovered column is *not reachable from the override's `FROM`* errors rather than emit an unsound body. Reaching a column that lives in a different basis source the single-source mapper cannot join in is genuinely structural — it is the decomposition's concern.

### `quereus_effective_lens(schema, table)`

The composed effective mapping is inspectable on demand (not editable text — see [the baseline is never authored text](#the-baseline-is-never-authored-text)). The integrated TVF resolves the lens slot for a logical `(schema, table)` and yields one row per logical column, in declaration order:

| column | meaning |
|---|---|
| `logical_column` | logical column name |
| `source` | `'override'` (covered by the override) · `'default'` (gap-filled by the default mapper) · `'hidden'` (`hiding (...)`) |
| `advertised_member` | when a resolved primary-storage advertisement backs this column, the member `relationId` that backs it (the existence anchor for an EAV pivot); `NULL` for name-match / override-only provenance |
| `advertisement_anchor` | the resolved decomposition's existence-anchor `relationId` (= advertisement id), or `NULL` when no advertisement backs this logical table |
| `effective_sql` | the composed effective body SQL (repeated on every row) |

## Constraint Attachment

A view predicate is a read-time filter, not a write-time invariant ([view-updateability § Interaction with Constraints](view-updateability.md#interaction-with-constraints)). The lens layer is therefore where the logical spec's constraints become **real constraints on the compiled view**, attached explicitly from the logical declaration rather than inferred from the body.

The governing principle: **a constraint is a logical claim, and the structure that enforces it is an optional physical optimization.** A logical `unique(x, y)` contributes a key/FD to the optimizer and an enforced boundary constraint — but it does **not** auto-create an index (a deliberate departure from the legacy behavior where `unique(...)` eagerly built a secondary BTree at declaration time). In the layered model the two are separated: the constraint is logical; any covering index is an explicit, independent **basis-layer** materialized view. With no such structure the constraint is still correct — enforced by a commit-time scan — just not O(log n). Whether to add the covering index is a physical-tuning decision made against the basis, never a side effect of the logical declaration.

### Enforcement by constraint class

Enforcement splits by class, with each constraint classified at deploy into an enforcement obligation recorded on the lens slot:

- **Row-local (`not null`, `check`)** — evaluable on the projected row being written, so a non-materialized lens enforces them for free at the write boundary. A logical `check` is rewritten from logical→basis column terms and merged into the basis write's per-row constraint check, so it fires on every insert/update through the lens even when the basis carries no such check. This is the common case; most mappings need nothing extra.

- **Set-level (`unique`, primary key)** — enforced by an existence lookup: "does a row with this key already exist?" Two regimes:
  - **Row-time** when a basis covering structure (a materialized index) answers the key: the lookup is O(log n), consistent at the moment of write, and conflict-resolution-capable (`insert or replace` / `or ignore`). This is *not* a new lens code path. The prover classifies the key row-time **only when** a matching basis `UNIQUE` plus a non-stale covering materialized view exists; the single-source re-plan reaches that basis UC in basis terms, and the basis UC's [physical enforcement-through-covering-MV path](materialized-views.md#enforcement-through-a-covering-mv-delivered) does the lookup and honors the conflict action — statement-level `OR` first, else the basis UC's own declared action, else `ABORT`.
  - **Commit-time, detection-only** when no covering structure answers the key: the lens routes a deferred `(select count(*) from <logicalView> as _u where _u.lk = NEW.bk …) <= 1` CHECK. The contained scalar subquery auto-defers it to commit, where the logical view reflects the post-mutation basis, so the new row sees count `1` (unique) or `≥ 2` (duplicate ⇒ ABORT). NULL-distinct falls out for free — `_u.lk = NEW.bk` is `NULL`, never counted, when either side is NULL. Because a commit-time scan can only ABORT, `insert or replace` / `or ignore` / upsert against a commit-time key is rejected up front with a clear diagnostic rather than silently ABORTing at commit.

  A logical key's own constraint-level conflict action is honored on **neither** set-level path — the row-time path resolves the action from the *basis* UC, and the commit-time scan can only ABORT. So a key declaring `on conflict replace` / `ignore` that its backing structure cannot itself honor is rejected at `apply schema` with `lens.unenforceable-conflict-action`, steering the developer to either declare the matching action on the basis UNIQUE/PK (upgrading to row-time honoring) or drop the conflict action. (`on conflict abort` / `fail` / `rollback`, and no declared action, are always fine — they ABORT.)

- **Foreign key** — a cross-relation existence invariant, enforced on both sides:
  - **Child-side.** Each logical FK is realized as a deferred synthesized `EXISTS` existence check against the referenced *logical* relation (child columns rewritten to basis terms, parent side in logical terms), gated by the `foreign_keys` pragma and auto-deferred to commit by the contained `EXISTS` — matching physical child-side FK gating and timing by construction. A covering structure is optional: the optimizer pushes the equality predicate into a basis index seek when one answers it and degrades to an O(n) scan otherwise.
  - **Parent-side RESTRICT / NO ACTION** (on DELETE and UPDATE) is the cross-slot dual: a deferred synthesized `NOT EXISTS` over the schema-qualified logical child. The UPDATE form carries a null-safe short-circuit guard (`(OLD.key ≡ NEW.key …) or NOT EXISTS`) so a benign update that does not touch the referenced key is not rejected, while a value→NULL update of a *nullable* referenced key (which orphans a child) falls through to the reject, matching physical RESTRICT.
  - **Parent-side CASCADE / SET NULL / SET DEFAULT** is *write propagation* rather than a plan-time check. A runtime cascade walker — the logical dual of the physical one, fired from the DML executor after each basis row delete/update — reverse-maps the basis parent to the logical parent slot it backs, discovers the referencing logical FKs, and issues the propagating DML against the logical *child view* (`delete from x.child …` / `update x.child set <fkcol> = …`). Issuing against the *view* re-enters the full lens write path, so the child's own checks and any nested logical cascades fire for free. `SET DEFAULT` uses the **logical** child column's default. MATCH SIMPLE (skip a NULL parent value) and the UPDATE short-circuit mirror the physical walker; recursion terminates by data exhaustion, as for the physical SQL-issuing path.

Set-level and FK obligations are enforced **single-source-spine only** — a multi-source or decomposition parent (whose `OLD.*` is not one basis row) routes nothing.

### The lens boundary is the only place logical constraints apply

A write through the logical view `x.t` bears its full logical FK + CHECK semantics; a write straight to a basis table `y.t` bears **only** the physical (basis-declared) FK + CHECK semantics, even when a logical FK over the same columns exists on the lens. This one rule holds across all three enforced-boundary classes, on whichever write path each uses — the row-local check rides the basis write's per-row pipeline attached only on a lens-routed write; the parent-side RESTRICT `NOT EXISTS` and runtime pre-check are lens-path-scoped; the cascade walker and divergent-action suppression are gated by a `lensRouted` marker on the write. A basis-direct write is therefore never subject to the lens cascade walker, the lens RESTRICT pre-check, or the divergent-action suppression.

### Double-enforcement and redundancy elision

By default the lens **double-enforces** — the lens-level check is synthesized even when the basis carries the equivalent constraint. This is always sound: the re-planned basis write's own check fires too. The redundant lens check is **elided when provably redundant**, and any uncertainty defaults to double-enforce.

Child-side FK elision requires all three of: (1) a single-source, value-preserving child mapping — every logical FK child column maps with no transform to a plain basis child column; (2) the basis child carries an FK whose **unordered** `(child col → parent col)` index pair-set equals the mapped one and references the same basis parent; and (3) the referenced logical parent's lens slot is a faithful, **non-row-reducing** projection of that basis parent (a single `from` with none of `where` / `group by` / `having` / `distinct` / `limit` / `offset` / compound / CTE; `order by` is row-preserving and ignored). Parent-side elision shares this structural core read from the child direction, **plus** an action-match gate the child side does not need: the basis parent-side check only fires for a `restrict` basis FK, so the basis write subsumes the lens RESTRICT only when **every** matching basis FK is `restrict` for the op. Redundancy is decided against the *current* basis FK set at write-plan time, so the elision is exactly as sound as the physical check it defers to.

### Divergent basis-vs-lens actions: the logical action wins

When a basis FK and a logical FK over the same equivalent columns declare **different** parent-side actions (e.g. a basis `on delete cascade` under a logical `on delete set null`), the **logical action wins**. The cascade walker elides only on an *agreeing* basis action; a divergent non-RESTRICT logical action suppresses the basis FK's physical action / RESTRICT check at three sites — the cascade walker, the runtime RESTRICT pre-checks, and the plan-time parent-side check builder — so the logical action runs exactly once.

A retained lens RESTRICT over a *non-restrict* basis FK is the mirror case: it cannot be enforced by the deferred commit-time `NOT EXISTS` (which would observe the **post-cascade** child state, after the basis action already mutated the children, and so always pass). It is enforced instead by a runtime **pre-check** fired BEFORE the basis op, so it observes the **pre-cascade** child state and ABORTs the parent delete / key-update. The pre-check rides the same transitive-RESTRICT walk the physical scan uses, so a basis cascade landing on a deeper basis-backed logical parent is covered within one transitive walk.

### FD contribution to the optimizer

A declared logical key (PK / `unique`) that holds at the lens boundary is also a *fact the optimizer can use* on the **read** path — for DISTINCT elimination, join elimination, and ORDER-BY trailing-key pruning. FDs intrinsic to the compiled body already flow through ordinary view-inlining and per-node FD propagation; what does **not** flow is the declared key the body alone cannot prove — the one that holds only because the lens *enforces* it (row-time, via a covering structure), or a `proved` / `vacuous` key whose guarantee per-node propagation loses in the inlining context.

The soundly-contributable obligations are turned into physical FDs that a unary pass-through marker — `AssertedKeysNode`, wired around the inlined view's projection — merges onto the boundary's FD set. The node carries no rows: it preserves column shape and attribute IDs and emits its source directly (zero runtime cost, like `AliasNode`).

Soundness is gated by the obligation **kind** — a false key FD is a *correctness* defect (it can make DISTINCT / join-elimination / order-by-pruning drop real rows), so the gate under-claims like every other FD-propagation rule:

| Obligation | Contributed FD | Why sound |
|---|---|---|
| `proved` | unconditional `key → others` | The body intrinsically guarantees it (redundant-but-harmless when local propagation already surfaces it, load-bearing when the inlining context loses it). |
| `vacuous` | `∅ → all_cols` (≤1-row) | The empty (singleton) key trivially holds. |
| `enforced-set-level` row-time | **guarded** `key → others [guard: key IS NOT NULL]` | A covering structure enforces uniqueness per row-write — but only over the **non-null** tuples a plain (NULL-skipping) `unique` governs, so the key is *conditionally* unique. The guard activates only under a surrounding predicate that entails it, the same shape a partial `UNIQUE` emits. (A NOT-NULL key answered by a basis UC would have classified `proved`, so a row-time obligation is always over a nullable key.) |
| `enforced-set-level` commit-time | **none** | Detection-only at commit; a duplicate can transiently exist mid-statement (reads-own-writes / Halloween), so assuming the FD mid-statement is unsound. |
| `enforced-row-local` / `enforced-fk` | **none** | Not uniqueness facts. |

A `row-time` obligation is a deploy-time snapshot of "a non-stale covering MV answers this key." The basis is a *physical* schema whose DDL (e.g. `drop materialized view`) does not re-run the lens prover, so a covering MV can be dropped or go stale out-of-band. The row-time contribution is therefore **re-validated at plan time** against the current catalog: the FD is contributed only when a non-stale row-time covering MV still answers the backing basis UC and that UC is non-partial; otherwise it conservatively downgrades to no FD. `proved` / `vacuous` need no currency check — they are structural facts of the immutable compiled body.

Only a logical schema's lens slot yields any FD; a plain view / MV has none, so the boundary node is inlined only when ≥1 FD is contributed. The contribution is **read-side only** — the write path walks the compiled body over basis tables, where the boundary node never appears.

## Computed and Generated Columns

A logical column need not map to stored basis data — it can be **computed** by the lens `get`. Such a column has `computed` lineage ([view-updateability § The Update Site Model](view-updateability.md#the-update-site-model)): reads evaluate the expression, writes are rejected. This is how a generated/derived column is expressed — there is no separate `generated as` construct at the logical layer; a column is generated precisely when its lens body computes it and no `put` inverse exists. A computed column with an invertible body remains writable, by the ordinary scalar-invertibility rules; "generated" is just the non-invertible end of that spectrum.

Two timings look alike but land in different layers, and conflating them is a common error:

- **Standing computed column** — re-evaluated on every read, never stored, tracks its inputs forever. It lives in the lens `get`. `full_name = first || ' ' || last` is standing.
- **One-shot derivation** — evaluated once, at deploy, to populate stored basis data, then maintained as ordinary storage that can diverge from whatever produced it. This is a **backfill** (see [Deployment](#deployment-is-a-compile-step)), not a lens compute. Promoting a standing computed column to stored basis — to index it, or to let it diverge — is exactly a one-shot derivation.

The distinction is the same one that separates a view expression from a materialized derivation: one is recomputed, the other is computed once and stored. The lens `get` expresses the first; the deploy/backfill step expresses the second.

### Proving the spec and the body agree

Because the logical spec and the lens body are authored (or generated) independently, the lens layer **proves they agree**. Each constraint in the logical spec plays one of two roles, decided by whether the lens body already guarantees it:

- **Body proves it** → the spec entry is a *proof obligation* (a completeness check). It contributes keys/FDs to the optimizer at zero enforcement cost. Example: the spec declares `unique(x, y)` and the body is `group by x, y`, or `select * from t` where basis already guarantees it. The primitive that discharges this class is `proveEffectiveKeyUnique` ([Optimizer § Effective-key proving](optimizer.md#effective-key-proving-body-proves-it)): it proves the compiled body's *output* relation is unique on the logical key columns via the body's effective key (FD closure). The lens prover owns the logical-column → output-column mapping and feeds the output-column indices to the primitive. This proves a property of the *derived* relation — it is **not** a base-table covering structure (see [Materialized Views § Covering structures](materialized-views.md#covering-structures)).
- **Body does not prove it** → the spec entry is an *enforced boundary constraint*, per [Constraint Attachment](#constraint-attachment).

These proof obligations are the lens laws restated in Quereus's own terms. **PutGet** ("the mapping loses no logical guarantee") and **GetPut** ("round-tripping basis through the lens is faithful") are exactly the cross-checks that the compiled view's inferred FD / key / domain surface conforms to the logical spec. The two laws bind the two directions, and the [coverage checklist](#coverage-checklist) discharges each: `get` preserving the logical guarantees is *column coverage* plus *type/nullability conformance* plus *constraint realizability*; `put` faithfully reaching storage is *key reconstructibility* plus *round-trip*. A lens that satisfies the first group but not the second is readable yet not faithfully writable — the prover reports the uncovered write paths rather than presenting the relation as updatable. The prover is a consumer of the same key-inference surface the optimizer uses; what it cannot prove, it reports — it never silently assumes coverage.

### Coverage checklist

`proveLens` runs in the lens compiler's compile-first loop, per logical table. Every diagnostic is **coded** (the `lens.*` codes below, a stable vocabulary) and **sited** (`{ table, constraint?, column? }`). Errors aggregate across all tables and throw atomically (before any catalog mutation, preserving the atomic-deploy contract); warnings attach to the deploy report. The prover derives no new inference — it applies the shipped inference surface (`proveEffectiveKeyUnique` / `keysOf` / `isUnique` / the FD framework) per logical aspect, and degrades to the safe verdict (no spurious error) when a fact cannot be established.

Each check has a severity: an **error** blocks the compile (the mapping is unsound or incomplete); a **warning** is advisory (the mapping is correct but suboptimal). One nuance: **key reconstructibility is reported as a warning** — a non-reconstructible PK does not block the deploy (reads still work); it makes the table read-only and any *mutation* errors at the lens boundary.

**Errors — the logical surface is not fully realized:**

| Check | Failure |
|---|---|
| **Column coverage** | Every logical column resolves to a basis expression (override or generated gap). An uncovered column errors, naming the column. |
| **Type / nullability conformance** | Each mapped column's basis-derived type and nullability satisfy the logical declaration. A nullable basis expression under a `not null` logical column errors unless a total default or guard supplies a value. |
| **Constraint realizability** | Each logical constraint is either *proven* by the body or *attachable* as an enforced boundary constraint. A constraint that is neither — e.g. one referencing a column whose lineage is `computed` (no write path) — errors. |
| **Round-trip (lens laws)** | `lens.non-invertible` — GetPut / PutGet hold over the writable fragment. An override whose `put` is non-invertible and undisambiguated errors, naming the operator/column (the same diagnostic surface as [view updateability](view-updateability.md#diagnostics)). |

> **Round-trip detection.** `proveRoundTrip` sits behind a single swappable function. Non-invertibility is already caught where it bites — at mutation time by view-updateability's own diagnostics — and a non-reconstructible key is caught by *key reconstructibility* above, so the deploy-time check adds no *new* error today. The predicate-honest complement that makes GetPut / PutGet *computed* predicates is the planned tightening; the seam is encapsulated so it is a local change.

**Warnings — correct but suboptimal:**

| Check | Advisory |
|---|---|
| **No backing index for a set-level constraint** (`lens.no-backing-index`) | A `unique` / primary key with no basis covering structure is enforced by the O(n) commit-time scan. The prover warns and recommends a basis covering index (a materialized view with `order by` over the constraint columns), noting that row-time conflict resolution (`insert or replace` / `or ignore`) *requires* that structure and is otherwise rejected. (A child-side FK existence check is *not* covered by this advisory: its equality predicate the optimizer pushes into a basis index seek when one answers it, degrading to an O(n) scan otherwise.) |
| **No answering structure for a declared access pattern** (`lens.no-answering-structure`) | If the logical schema (or its tags) declares an expected lookup/ordering with no basis ordering or index to serve it, the prover warns that reads will scan. |
| **Partial override** (`lens.partial-override`) | When an override covers only some columns of a table and the remainder took the default alignment, the prover emits an informational note listing the gap-filled columns, so the generated portion is visible. |

Warnings are reported through the same channel as the compile result (and surfaced in the deploy summary); they never block a deploy. The backing-index warning is the lens layer's single most important advisory, because it is the one place where the "structure is optional, correctness isn't" separation has a visible performance cost the developer should consciously accept or remedy. The recommended remedy is detailed in [Materialized Views § Covering structures](materialized-views.md#covering-structures).

### Acknowledging advisories

Advisories only reduce noise if acknowledged ones stay out of the way — but an acknowledgment must never hide a *newly* important problem. The mechanism balances both:

- **Coded and sited.** Every advisory carries a stable code and the logical site it concerns (table / constraint / column), so an acknowledgment targets exactly one advisory, never a class. An optional `:<target>` segment narrows an ack to a specific column/constraint when a table has several instances of one code.
- **Acknowledged in source, via a reserved tag.** A `quereus.lens.ack.<code>[:<target>]` tag on the logical table or constraint suppresses that advisory from the default report. Because the ack lives in the logical declaration, it is version-controlled and shows up in review — there is no hidden, out-of-band suppress-list. The tag value is a **required rationale** (an empty or missing rationale is itself a warning — the ack still suppresses, but its justification is flagged), so every suppression carries its justification.
- **Tallied, never vanished.** The deploy summary always reports `acknowledged: N` and can expand them on demand: `select * from quereus_lens_advisories('x')` yields one row per advisory of the last deploy — `active`, `re-surfaced`, `acknowledged`, or `acknowledged-unconditional` — with its rationale and current/recorded fingerprints. The default view is decluttered; nothing becomes truly invisible.
- **Re-surfaces on material change.** The prover fingerprints the facts behind each advisory (constraint columns, the presence/absence of a covering structure, a **coarse cardinality band**, the backing basis relation) as a stable base64url FNV-1a digest. The recorded fingerprint is stored **in the DDL**, as a trailing `#fp=<digest>` token on the ack tag value — so it survives schema export round-trip, is version-controlled, and shows up in review. If the facts later diverge — the table crosses a cardinality band, the constraint columns change, a previously-present covering structure is dropped — the recomputed fingerprint no longer matches and the advisory **re-surfaces as un-acknowledged**, flagged *"previously acknowledged; situation changed."* This is the anti-fatigue guarantee that still catches the thing that matters. A first-write ack with no recorded `#fp=` is honored but marked *unconditional* — the author has explicitly opted out of re-surfacing.
  - **Cardinality bands** (so an ack survives ordinary row-count churn — only a band *crossing* re-surfaces it): `empty` (0 rows), `small` (< 1e3), `medium` (< 1e6), `large` (≥ 1e6), `unknown` (no estimate).
- **Escalation policy.** A per-logical-table policy — the reserved tags `quereus.lens.policy.error-on` / `quereus.lens.policy.require-ack`, each a CSV of advisory codes — promotes specific codes beyond advisory. It is **default-empty**: out of the box no code is escalated; a project opts in by tagging each table.
  - `error-on: [code]` — the code is always a hard error; an ack cannot suppress it. For invariants you never permit.
  - `require-ack: [code]` — an un-acknowledged instance is an error, but a valid (fingerprint-matched or first-sight) ack with rationale clears it. This is the sweet spot for `lens.no-backing-index`: it forces a conscious, documented decision without blocking the developer who has genuinely accepted the commit-time scan.
  - **Unknown codes fail loud, never open.** A policy entry naming no real advisory code (a typo or stale code) is a hard deploy error — a governance control that fails open is the worst failure mode. The recognized targets are exactly the warning-severity advisories that flow through governance (`lens.no-backing-index`, `lens.no-answering-structure`, `lens.partial-override`, `lens.pk-not-reconstructible`), validated against the prover's single exported vocabulary so the list cannot drift from what the prover emits. (The error-severity codes are already hard errors and are not governable.)

```sql
declare logical schema X {
  table Car (
    id int primary key,
    vin text,
    unique (vin)
  ) with tags (
    -- rationale + recorded fingerprint (the `#fp=` token is appended once the
    -- advisory's facts are known; a bare rationale is honored unconditionally):
    "quereus.lens.ack.no-backing-index:vin" = 'low-write table; commit-time scan is acceptable #fp=Ab3k_92xQ1pe',
    -- opt this table into forcing a conscious decision on the same code:
    "quereus.lens.policy.require-ack" = 'lens.no-backing-index'
  );
}
```

Acknowledgment suppresses the *warning* only; it has no effect on an `error-on` escalation or on any correctness error from the [coverage checklist](#coverage-checklist).

The reserved `quereus.lens.*` tag shape and site are validated by a typed registry that is the **single source of truth for the entire `quereus.*` namespace** — the view-mutation override surface, the module advertisement builder, and the physical declarative-schema differ all validate through it with one unified hard-error-on-unknown severity. Each key is matched to a frozen spec that checks its site and validates its value; `quereus.lens.ack.<code>` carries a required-nonempty-rationale whose empty/missing case is a warning, while an unknown or mis-sited `quereus.lens.*` key is a hard error.

## Deployment Is a Compile Step

Quereus is a query-processing engine, not a deployment system, but it exposes the ingredients an application needs to assemble a complete deployment story. Deploying a logical schema against a basis is a **compile**:

1. **Generate / diff the basis.** The basis is a generated-then-frozen artifact. On each deploy it is diffed against the deployed representation by the declarative-schema differ. Logical evolution produces *additive* basis diffs (new column / table). A column removed from the logical schema does **not** cascade to a basis drop: the mapping detaches and the basis column is retained for later garbage collection. This asymmetry — logical removals never drop basis storage — is what keeps the basis append-mostly and migrations safe.
2. **Compile the lens.** For each logical table, merge the override (if any) with generated gaps into an effective view body over basis.
3. **Register inline.** `Logical.X.T` resolves to that effective body; the query processor sees an ordinary view. The logical spec's constraints are attached at the lens boundary.

The authored source stays sparse (signal only). The *compiled* effective mapping is the inspectable, generated-on-demand artifact (the noise). Because the basis is frozen and the effective lens is recomputed at compile from frozen inputs, the result is deterministic, not a moving target.

### The deployed basis representation

Migrations require a stable record of *what is deployed*, so augmentations can be generated against it and basis invariants verified to be intact. The deployed basis is therefore persisted and **hash-coded** (reusing the schema hasher). A deploy compares the freshly generated basis against the deployed hash, computes the additive diff, and — for data-effecting changes (column adds with backfill, decomposition changes) — emits DDL the application can run with custom backfills, exactly as the declarative-schema pipeline already supports. Schema-only changes (rename, hide) are metadata; data-effecting changes (split / merge / pivot) carry a backfill obligation.

A useful subset of that backfill obligation is **engine-expressible rather than fully delegated**. When the new basis can be populated by running the new lens `get` over the prior basis — a pure re-decomposition such as a split or merge that introduces no information the prior basis lacks — the differ can emit the backfill as generated DDL, the same shape as a one-shot derivation. Only backfills that need data the prior basis does not contain remain the application's to supply. The obligation thus splits cleanly: re-decompositions the engine generates from the lens itself, genuinely new information the application provides.

#### The lens deployment snapshot

The deployed representation is persisted per logical schema as a **lens deployment snapshot** (`LensDeploymentSnapshot`), captured on each successful `apply schema X` and **rotated** (`previous ← current`), so the prior deploy survives exactly one re-apply. The snapshot is the **source of truth** the backfill differ diffs — robust to the lens already pointing at the new basis, because it records the *prior* compiled `get` rather than re-deriving from live catalog timing. Per logical table it holds:

- `getBody` — the compiled `get` body deployed for the table (`prior_lens.get(prior_basis)`), wrapped as the backfill's `from (<prior get>)` subquery;
- `logicalColumns` — the non-hidden logical columns (declaration order), used to test reconstructibility;
- `relationBacking` — per basis relation, the `(basisColumn → logicalColumn)` pairs it backs, derived from the body's projection **plus shared join-key threading** (a columnar split joins its members on a shared key but projects it once; the other members carry the key column and must be backfilled with it);
- `basisHash` — the schema hash of the basis declared schema at deploy time. This is the migration-safety record: a later deploy or introspection confirms the basis still matches the one last deployed against, and a mismatch is surfaced (not silently proceeded past) as a basis-drifted-out-of-band warning.

A first deploy leaves `previous` undefined ⇒ no backfill rows; an unchanged re-apply introduces no new basis relations ⇒ no backfill rows.

#### Module deployment notification

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

#### Classification — re-decomposition vs needs-data

For each **new** basis relation `R` (one the prior lens did not back) the differ classifies each of `R`'s columns:

- **reconstructible** — its logical column was produced by the prior get-body (`∈ previous.logicalColumns`); the engine generates its backfill.
- **new** — absent from the prior deploy; the prior basis has no data, so the **application supplies it**.
- A basis column that maps to **no** logical column (e.g. a surrogate-key default) is naturally absent from `relationBacking` and so is **omitted** from the projection — the basis default mints it.

The per-relation category is then `re-decomposition` (every column reconstructible → fully engine-generated), `partial` (some reconstructible → engine generates those, lists the rest as `missing`), or `needs-data` (none → entirely the application's). Threading one *surrogate* shared key across the members of a multi-relation split is part of the `put` fan-out; a multi-member surrogate split emits a `needs-data` deferred-note row rather than an unsound insert.

**The NOT-NULL rule.** A `partial` row's generated `backfill_sql` is a key-only skeleton `insert` that seeds only the reconstructible columns and relies on the basis to mint each omitted column from its declared default. That is sound **only when every omitted basis column is nullable, defaulted, or generated**. Because Quereus columns are **NOT NULL by default**, an omitted column that is NOT NULL with no default has *no* value source: running the skeleton would fail an unguarded NOT NULL constraint. In that case the classifier emits **`backfill_sql = null`** (the application owns the whole insert) while keeping the `partial` category and the reconstructible-columns record, so the app still learns which columns are reconstructible. The runnability test is at the relation level — every NOT-NULL, no-default, non-generated basis column of the member must be among the reconstructible columns — so it also covers a required member column the lens maps to no logical column. **Any emitted `backfill_sql` therefore never fails an unguarded NOT NULL constraint.**

#### `quereus_basis_backfill(logical_schema)`

The classified rows are introspected by the integrated TVF, mirroring `quereus_effective_lens`: it requires a logical schema, loads the rotated snapshot pair (yielding nothing with no `previous`), and yields one row per new basis relation, ordered by logical table then basis relation:

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

#### Sequencing contract

The generated `backfill_sql` reads the **prior** get-body over the **prior** basis tables, which must still hold data when the app runs it. The required order for a re-decomposition deploy:

1. `apply schema Y` — migrate the basis (new member tables created; **prior members retained**, not dropped — they are the backfill source).
2. `apply schema X` — recompile the lens over the new basis (rotates the snapshot; `previous` now holds the prior get-body).
3. `select * from quereus_basis_backfill('x')` — fetch rows; run every non-`NULL` `backfill_sql`; supply app data for `missing_columns`, `needs-data` rows, and any `partial` row whose `backfill_sql` is `NULL`.
4. GC the now-detached prior basis members when convenient.

Because the backfill reads the persisted prior get-body (not the live `X.T` view), step 3 is robust to the lens already pointing at the new basis — the snapshot, not catalog timing, is the source of truth.

## Relationship to Materialized Views

Indexes are a basis-layer concern, expressed as **materialized views**: a materialized view with an `order by` describes a clustered/ordered structure — an index. A unique *constraint* is a logical claim (it lives in the logical schema); the *index* that covers it is a basis-layer materialized view. The two legitimately sit at opposite ends of the stack, and the lens carries the constraint down to a level where it is enforceable while the index attaches at basis. This realizes the principle that **a constraint is a logical claim, and the structure that enforces it is an optional physical optimization.**

Unique enforcement is a key existence lookup against that covering materialized view when present (row-time, conflict-resolution-capable), falling back to a commit-time scan when absent. The unified covering-structure surface this layer consumes — the `CoveringStructure` discriminated union (`memory-index` | `materialized-view`), the eager constraint↔structure linking, and the coverage prover that recognizes a covering `order by` MV — is described in [Materialized Views § Covering structures](materialized-views.md#covering-structures).

The write-through prerequisite is satisfied for the covering-index shape: a materialized view keeps its backing table consistent synchronously with each source row-write, within the transaction (the single row-time materialization model — [Materialized Views § Maintenance](materialized-views.md#maintenance-row-time-per-statement)), so a covering MV is *kept current at write time*, which is what a row-time existence lookup requires. Routing `unique` enforcement through that backing table for conflict resolution is described in [Materialized Views § Enforcement through a covering MV](materialized-views.md#enforcement-through-a-covering-mv-delivered). In the logical-schema world — where the auto-index is retired and an explicit covering MV becomes the *sole* enforcement structure — that path is load-bearing. Where no covering structure answers a constraint, the commit-time scan governs the gap (the `lens.no-answering-structure` advisory).

## Syntax

```sql
-- Logical: design only. Constraints and tags allowed; no module, no indexes.
declare logical schema X {
  table Car (
    id int primary key,
    maxSpeed int,
    ...
  ) with tags ("domain.unit.maxSpeed" = 'kph');
}

-- Basis: a physical schema — module-backed tables plus index materialized views.
declare schema Y {
  table CarCore (id int primary key, ...) using mem();
  table CarPerf (id int primary key, speed int, ...) using mem();
  create materialized view ix_carperf_speed as
    select speed, id from CarPerf order by speed;   -- clustered index over CarPerf
}

-- Lens: binds logical X to basis Y; supplies sparse overrides.
declare lens for X over Y {
  view Car as
    select id, speed as maxSpeed              -- rename override
    from Y.CarCore join Y.CarPerf using (id);  -- other Car columns gap-filled
  view Audit as
    select id, who from Y.AuditLog
    hiding (raw_blob);                          -- omit raw_blob from the lens
  -- tables of X not mentioned here are auto-mapped against Y entirely
}
```

- `declare logical schema X { ... }` — `kind: 'logical'`, declarative end-state, diffed by the schema differ.
- `declare lens for X over Y { ... }` — names the logical schema (`for X`) and the **explicit basis** (`over Y`), and populates lens slots. It is a **sibling statement of `declare schema`, not a variant** of it. Unmentioned tables are auto-mapped; columns unmentioned within a mentioned table are gap-filled; columns in `hiding (...)` are omitted entirely. The basis binding lives on the lens, never on the logical schema — that is what keeps the logical schema embodiment-free and lets one logical schema target multiple bases across deployments. Re-declaring a lens for X replaces the prior block; two `view T as` for the same logical table within one block is an error. The lens must be declared **before** `apply schema X` (it is re-read from source on every apply).

## Background

- **Codd, E. F. (1970); ANSI-SPARC three-schema architecture.** The external / conceptual / internal separation. Quereus's logical / mapping / basis layering is this separation expressed over virtual, key-addressed relations.
- **Bohannon, A., Pierce, B. C., & Vaughan, J. A. (2006). "Relational Lenses: A Language for Updatable Views."** Types the canonical `select` / `project` / `join` lenses with FD-and-predicate annotations and proves GetPut / PutGet *compositionally, per operator* — the direct lineage of Quereus's FD-annotated per-operator backward walk. See also [view updateability § Background](view-updateability.md#background).
- **Foster et al. (2007). "Combinators for Bidirectional Tree Transformations" (lenses).** The `get` / `put` formulation and the GetPut / PutGet laws. Quereus realizes lenses without a dedicated combinator language — relational algebra is the lens vocabulary, and the laws become the completeness checks the lens prover discharges.
- **Date & Darwen, "The Third Manifesto."** Any relation expression is a first-class mutation target — the basis on which a logical table can be an inlined, mutable view.
- **Dataphor (Alphora, D4).** Precedent for view-as-first-class-target with mapping metadata; Quereus extends it with FD/EC-driven default recovery and the sparse-override-over-generated-baseline authoring model.

## Departures and Non-Goals

| Topic | Quereus | Rationale |
|---|---|---|
| Logical-table indexes | Not allowed. | Indexes are basis-layer materialized views; logical is embodiment-free. |
| Auto-index for `unique` / PK | Physical schemas only; logical schemas never. | The eager auto-index (`LayerManager.ensureUniqueConstraintIndexes`) is gated on the one-bit `Schema.kind`: a *physical* (basis) table keeps the eager auto-index + implicit covering-structure descriptor; a *logical* table builds **nothing** — its `unique`/PK contributes only a key/FD to the optimizer plus an enforced boundary constraint, and any covering index is a separate basis-layer materialized view. Logical tables are never module-backed, so the path was already unreachable for them; the gate enforces the separation at the source. |
| `with check option` on a lens | Not a separate feature. | Constraints are attached from the logical spec and enforced at the lens boundary; predicates remain read-time filters. |
| Separate lens algebra | None. | Relational algebra is the lens vocabulary in both directions. |
| Deployment orchestration | Out of scope. | Quereus exposes generate / diff / hash / emit-DDL ingredients; the application assembles the deployment. |

## Implementation Map

The lens layer introduces no new runtime: at execution time a logical table is an inlined view, driven by the existing optimizer, [view updateability](view-updateability.md), and [materialized-view](materialized-views.md) machinery. All lens-specific behavior is compile-time **validate / generate / attach**. The principal source files:

| Concern | Location |
|---|---|
| Schema kind + per-schema lens-slot registry | `src/schema/schema.ts` (`Schema.kind: 'physical' \| 'logical'`) |
| Logical-table spec (optional `vtabModule`, `isLogical`) | `src/schema/table.ts` |
| The lens slot (logical spec, basis binding, compiled body, attached constraints, obligations, injected INDs, advertisement) | `src/schema/lens.ts` (`LensSlot`) |
| Parse `declare logical schema` / `declare lens for X over Y` + DDL round-trip | `src/parser/parser.ts`, `src/parser/ast.ts`, `src/emit/ast-stringify.ts` |
| Default name-based aligner, sparse-override merger, basis binding, n-way `get` synthesis (`compileDecompositionBody`), advertisement resolution (`resolveAdvertisement`), existence-anchor IND injection | `src/schema/lens-compiler.ts` |
| `put` fan-out + surrogate threading (DELETE / UPDATE / INSERT over a decomposition) | `src/planner/mutation/decomposition.ts` |
| Shared backward-walk consumer (single / multi-source / decomposition) | `src/planner/mutation/backward-body.ts` |
| Lens prover: FD/key/type/nullability conformance, constraint classification, coverage checklist | `src/schema/lens-prover.ts` (`proveLens`, `computeLensAssertedKeyFds`) |
| Live per-write enforcement (row-local check rewrite, child/parent-side FK, set-level) | `src/planner/mutation/lens-enforcement.ts`, `src/planner/building/view-mutation-builder.ts` |
| Advisory acknowledgment / fingerprint / escalation governance | `src/schema/lens-ack.ts` (`applyAckGovernance`, `computeAdvisoryFingerprint`) |
| Reserved-tag registry (single source of truth for `quereus.*`) | `src/schema/reserved-tags.ts`, `src/schema/reserved-tags-policy.ts` |
| Module mapping advertisement protocol + tag builder | `src/vtab/mapping-advertisement.ts`, `src/schema/mapping-advertisement-tags.ts` |
| Auxiliary-access read-path routing | `src/planner/rules/access/lens-access-form-matcher.ts`, `rule-lens-auxiliary-access`, `LensAuxiliaryAccessNode` |
| Asserted-keys boundary marker | `src/planner/nodes/asserted-keys-node.ts`, wired in `src/planner/building/select.ts` |
| Kind-aware diff + hash (logical removals never drop basis) | `src/schema/schema-differ.ts`, `src/schema/schema-hasher.ts` |
| Lens deployment snapshot, rotation, capture; re-decomposition backfill classifier | `src/schema/lens.ts` (`LensDeploymentSnapshot`), `src/schema/basis-backfill.ts` (`computeBasisBackfill`) |
| Module deployment notification hook | `src/vtab/module.ts` (`notifyLensDeployment`), fired in `src/runtime/emit/schema-declarative.ts` |
| Introspection TVFs (`quereus_effective_lens`, `quereus_lens_advisories`, `quereus_basis_backfill`) | `src/func/builtins/explain.ts` |

The exported surface (`deployLogicalSchema`, `LensDeploymentSnapshot`, `LensTableSnapshot`, `LensRelationBacking`, `LensDeployReport`) is re-exported from the `@quereus/quereus` package root; the AST types those reference (`SelectStmt`, `DeclareSchemaStmt`) are reachable from `@quereus/quereus/parser`.

> **Logical-table representation.** The compiled effective body of each logical table is registered as a **`ViewSchema`** (`Schema.addView`), so `select` from `Logical.T` resolves through the standard view path and mutation rides view updateability with zero new runtime. The logical spec itself (columns / types / constraints — the surface a `ViewSchema` cannot carry) lives in the **lens slot**, keyed by logical table name on the owning `Schema`. Read/write resolution goes through `ViewSchema` / `getView()`, not `TableSchema.viewDefinition`.

## Current Limitations

The design above is realized except for the following, each deferred onto substrate not yet present and each raised at compile or mutation time with a precise diagnostic rather than silently mis-handled:

- **DELETE/UPDATE `WHERE` referencing a genuine non-anchor member** (an EAV pivot column, an embedded subquery) — needs snapshot-consistent multi-member base-op execution, the same substrate the predicate-honest multi-side join delete defers onto. Each case raises its own accurate message.
- **Optional / EAV / shared-key column UPDATE through a decomposition** — a null↔non-null component write is a per-row insert-or-delete *inside* an update group, which the static base-op fan-out cannot yet branch; a key write is an identity change.
- **Non-integer surrogate generators** (`uuid7`, `callback`) and **composite shared keys** — the insert fan-out mints an auto integer and threads a single-column key.
- **True per-logical-key conflict-action honoring** — a row-time key honoring an `on conflict replace` / `ignore` its basis UC does not itself carry would need a per-statement, per-constraint conflict-override channel threaded planner→memory/isolation/store. Today such a mismatch is rejected at deploy (the sound floor). A partial logical `UNIQUE` on a commit-time key is likewise rejected, since the O(n) count scan cannot scope by the partial predicate.
- **Predicate-honest round-trip prover** — the GetPut / PutGet completeness predicates are currently caught at mutation time and by key-reconstructibility, not computed as deploy-time predicates. The seam is encapsulated for the tightening.
- **Auxiliary-access refinements** — a lossy / refinement-required access form that must retain its predicate as a residual; routing through an auxiliary keyed only by a non-logical surrogate (the join-interior surrogate rewrite); and crediting a routable auxiliary in the `lens.no-answering-structure` advisory's answering-structure check.
- **GC of detached prior basis storage** — a logical removal detaches the mapping and retains the basis column; reclaiming it is application-driven and out of scope here.
