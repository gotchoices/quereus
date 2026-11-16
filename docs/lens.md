# Lenses and Layered Schemas

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

## Overview

A database has two faces that rarely match. There is the design you want to *think* in — clean tables with the columns, types, and rules your application cares about — and the storage you actually *run on*, which may split one designed table across several physical tables, fold it into key-value triples, or spread it across more than one storage module. A **lens** is the two-way mapping between them: it lets you read and write your designed tables normally while the engine translates, in both directions, to and from however the data is really stored.

Concretely. Suppose you want to work with a `Car` table:

```sql
-- The design — how you want to think about it. No storage decisions here.
declare logical schema App {
  table Car (
    id       int primary key,
    make     text,
    topSpeed int
  );
}
```

…but your storage keeps each car's identity and its performance numbers in separate physical tables:

```sql
-- The storage — ordinary module-backed tables. Quereus calls this the "basis".
declare schema Store {
  table CarCore  (id int primary key, make text)    using memory;
  table CarSpeed (id int primary key, topSpeed int) using memory;
}
```

A lens binds the design to the storage. This one is a single line — it tells the engine how the two storage tables join. Because the column names already line up, nothing else needs saying; each `Car` column maps itself:

```sql
declare lens for App over Store {
  view Car as
    select id, make, topSpeed
    from CarCore join CarSpeed using (id);
}
apply schema App;
```

Now `App.Car` behaves like an ordinary table **in both directions**:

```sql
select id, make, topSpeed from App.Car where id = 7;
--   → reads CarCore joined to CarSpeed, transparently

insert into App.Car (id, make, topSpeed) values (7, 'Civic', 180);
--   → writes (id, make) to CarCore and (id, topSpeed) to CarSpeed, in one statement

update App.Car set topSpeed = 200 where id = 7;
--   → updates only CarSpeed
```

That is the whole idea. You design `Car` once; the storage underneath can be a single table, a column split like this, a key-value layout, or several modules at once — and `App.Car` reads and writes the same way regardless. Swapping storage strategies becomes a change to the lens, never to the design or the application. This is the decisive property: **the design carries no commitment to how it is stored.**

The rest of this document, and the [topic documents](#topic-documents) it links, is the precise machinery behind that picture — how the mapping is generated when you don't write it, how writes reach the right storage tables, how the rules you declared on the design are still enforced, and how the engine *proves* the mapping is faithful before it deploys.

### Key terms

A few terms recur throughout; no background in database research is assumed.

- **Logical** — the design layer: the tables, columns, types, and rules (primary key, `unique`, `check`, foreign key, `not null`) you reason about. No storage.
- **Basis** — the storage layer seen *as relations*: ordinary `using module(...)` tables, possibly several per logical table, possibly across several modules.
- **Lens** — the mapping between one logical table and the basis, in two directions. **`get`** is the *read* — an ordinary `select` that produces the logical table from basis. **`put`** is the *write* — how an `insert` / `update` / `delete` on the logical table is pushed back down to basis. "Bidirectional" just means a lens has both.
- **Decomposition** — a logical table whose data is split across more than one basis table (the `Car` example splits across two). When the engine generates such a mapping itself, one basis table acts as the **anchor** — the one that decides whether a row exists — and the others attach their columns to it.
- **Surrogate key** — an internal join key (often auto-generated) that basis tables share, distinct from the logical primary key.
- **Functional dependency (FD)** — shorthand for "these columns determine those" (a primary key determines the rest of its row). Quereus tracks FDs all through the query plan; the lens layer reuses that tracking to decide what is writable and to prove keys hold. You will see the names **GetPut** and **PutGet** later — they are the two correctness laws a lens must satisfy, defined in [The Lens Prover](lens-prover.md#proving-the-spec-and-the-body-agree).

### The three layers

Stated precisely, a database separates into three layers of relations (Quereus expresses all three with its own virtual, key-addressed tables — there are no row-ids):

- **Logical** — the relations a developer designs and reasons about, free of any storage commitment. A logical schema declares tables with columns, types, and *logical* constraints (primary key, unique, check, foreign key, not null) and nothing physical: no module association, no indexes, no storage hints. It is a pure design.
- **Basis** — the relations that modules actually back. Basis tables are ordinary `using module(...)` tables and may be spread across many modules (a single logical table can map to a columnar decomposition over several basis tables). Basis is still *relational* — it is the lowest layer a developer reasons about as relations. Covering structures (secondary indexes, unique-enforcement structures) live here as materialized views.
- **Mapping (the lens)** — for each logical table, the bidirectional `get` / `put` pair that realizes it over basis relations. The lens is *not* a schema; it is a per-logical-table **slot**, populated either by an explicit `declare lens` block or generated for you when absent.

Below basis sits the **physical** layer — module storage layout and the on-disk/in-memory realization of covering structures. The lens never sees physical concerns; it composes over basis relations, and modules handle storage beneath.

## Topic documents

This document is the **hub**: the layer model, the lens slot, sparse overrides, computed columns, and the syntax surface. The subsystems large enough to read on their own live in the topic documents below.

<!-- NOTE: the sections below that moved into a satellite left a short stub behind under
     their original heading, so their old anchors still resolve here. `yarn docs:check`
     therefore cannot tell a link deliberately left on a stub from one that should have been
     retargeted and was not. When linking real content that lives in a satellite, link the
     satellite — not the stub. -->

| Document | Covers |
| --- | --- |
| [The Lens Default Mapper](lens-default-mapper.md) | How the engine generates a lens body: the name-and-advertisement aligner, the module mapping advertisement protocol, the `put` fan-out that writes through a decomposition to every member table, and auxiliary-access read routing. |
| [Lens Constraint Attachment](lens-constraints.md) | How logical `not null` / `check` / `unique` / primary-key / foreign-key rules are enforced on writes through the lens, when a redundant check is elided, and which declared keys the optimizer may rely on. |
| [The Lens Prover](lens-prover.md) | What `proveLens` checks at deploy: the proof-obligation / enforced-constraint split, the coverage checklist, every `lens.*` diagnostic code, and advisory acknowledgment and escalation. |
| [Lens Deployment](lens-deployment.md) | What `apply schema` does for a logical schema: the compile steps, the deployment snapshot, the module deployment notification, and the engine-generated backfill for a storage re-decomposition. |

## What a Lens Is

A lens reuses machinery Quereus already has, rather than inventing a new sublanguage. The **`get`** direction is an ordinary `select`. The **`put`** direction is the engine's existing ability to push a change through a view down to its base tables (see [view updateability](view-updateability.md)) — an `insert` / `update` / `delete` on the view becomes the equivalent writes on the tables underneath. So **the only operator set, in both directions, is ordinary relational algebra** (the operations behind `select`). Two consequences follow:

- **Any view can serve as the read mapping.** If you can write it as a `select`, you can use it as a `get` — a lens body *is* a view body.
- **A write goes through only when the mapping can be run in reverse.** Not every expression has a sound inverse — `lower(name)` cannot be undone, for instance. Where the engine can infer the inverse it does; where it cannot, the write is refused with a clear diagnostic naming the column. Invertibility is made explicit rather than silently narrowing what you can write.

To the query processor, then, a logical table is simply a view that is "out there, ready to go." Selecting from `Logical.T` resolves to the lens-compiled body over basis; mutating it propagates through that body via the standard view-update machinery. All lens-specific work happens at compile time: **validate, generate, and attach semantics** — there is no lens-specific code at query runtime.

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

Moved to [The Lens Default Mapper](lens-default-mapper.md). When you don't write a lens, the engine writes one — it matches each logical column to a basis column by name (plus any hints a storage module advertises) and assembles the join, exactly as in the `Car` example above. The satellite covers what keeps that generated mapping correct when the match is *not* a clean one-to-one — split tables, optional columns, generated keys, and storage that doesn't expose your column names at all — and how a write through it fans out to every member table.

## Sparse Overrides

The authoring goal is **override without takeover**: a developer renaming one column of a logical table that maps to an n-way join over columnar basis tables must not be forced to write the join. Two mechanisms make this work.

### The baseline is never authored text

The generated mapping is never written into source. The authored artifact contains **only deviations**, so the source is all signal and no noise — which is precisely why full code-generation fails (it buries the intentional, abnormal mappings in generated noise). The full effective mapping is inspectable on demand ("show effective mapping"), but it is not the thing the developer edits.

### Overrides are merged per-attribute

An override authored as ordinary SQL is consumed as a **sparse patch keyed by attribute**, not as opaque text. At compile time, for each logical table:

1. The override `select` (if any) is parsed to a relational expression.
2. Its output **coverage** is read — which logical columns it covers, and from which basis expressions.
3. For every logical column the override does not cover, the default mapper generates the mapping and composes it in.

So renaming a column and later adding a column compose cleanly: the rename override is untouched, and the new column appears as an uncovered attribute the mapper fills. The result is one effective `select` whose projection is exactly the logical columns, in declaration order.

Most overrides cap the generated body at the boundary (rename = projection-with-alias, compute = extend, filter = restrict) and never touch the join interior. A change that *must* reach inside the join (a column now originating from a different basis table) is genuinely structural, cannot reduce to a boundary cap, and therefore correctly costs more authoring and surfaces as signal.

#### Coverage is name-based and re-read from source

The merger composes at the AST level, and two properties follow from that:

- **Coverage is read by name.** A logical column is *covered* when the override's output column name (the `as` alias, e.g. `speed as maxSpeed`, or a bare column name, or a `*`-expansion of a FROM source) matches the logical column name (case-insensitive). Everything else is gap-filled.
- **Survival across baseline regeneration comes from re-reading the override AST from source on every deploy.** The stored override is never rewritten, so the *rename-then-add* example composes: the rename override is untouched and the freshly-added logical column is simply uncovered → gap-filled. This re-read-from-source is the load-bearing assumption of the merger (see [Current Limitations](#current-limitations)).

#### What "covered" means

An override projection is a **sparse patch, not an exhaustive column list.** Writing `select id, who` does not say "the view has only these two columns" — it says "`id` and `who` are *covered* by this override; every other logical column is gap-filled." **Omission is not exclusion:** an unmentioned logical column is gap-filled, not dropped — and if the basis cannot back it, that is a coverage error (every logical column must map to basis). Coverage is decided **entirely by a projection term's output name**, never by what the term computes:

```sql
-- The design. `label` is derived; `id`, `who`, `ip` are ordinary columns.
declare logical schema X {
  table Audit (id int primary key, who text, ip text, label text);
}

declare lens for X over Y {           -- basis Y.AuditLog has columns id, who, ip
  view Audit as
    select
      id,                   -- covered, identity  → writable
      who,                  -- covered, identity  → writable
      upper(who) as label   -- covered, computed  → read-only
    from Y.AuditLog;
  -- `ip` is unmentioned → gap-filled from Y.AuditLog.ip by name (it is NOT dropped)
}
```

Here every logical column is either *covered* (`id`, `who`, `label`) or *gap-filled* (`ip`). The points:

- **The alias is the coverage key — the expression's shape is invisible.** `upper(who) as label` covers logical column `label` exactly as a bare `label` would; the merger never looks inside the term to decide coverage, however deeply nested it is. (A computed term therefore *must* be aliased — an unaliased `upper(who)` maps to no logical column and is rejected; see [Body-shape restrictions](#body-shape-restrictions).)
- **Omission is not exclusion — this is the one that surprises.** Leaving `ip` out of the `select` does *not* drop it. `ip` is a logical column the projection does not cover, so the default mapper name-matches it to `Y.AuditLog.ip` and gap-fills it straight back in. Every logical column must end up mapped: if the basis cannot back an omitted column, the compile fails with a coverage error rather than silently dropping it (see [Gap-fill fidelity boundary](#gap-fill-fidelity-boundary)).
- **A computed mapping is always authored, never gap-filled.** Gap-fill only name-matches (or follows a module advertisement); it never synthesizes an expression. So `label`'s `upper(who)` mapping has to be written out — the mapper cannot guess it — which is why a computed column is "signal" rather than something generated. (A *derived* column like `label` is still a legitimate part of the design: consumers read it, it simply isn't stored.)
- **Writability of a covered column follows scalar-invertibility, composed over the nest.** A bare/renamed column, or an invertible expression composed of invertible steps (`(speed + 1) - 2 as adjusted` — each `±k` step inverts, so the nest does), stays writable — a write runs the inverse — while any opaque step (`upper`, `substr`, a hash, or `* 2` — the registry inverts only `±k`, not `*`) makes the column read-only and a write raises `no-inverse` (see [Computed and Generated Columns](#computed-and-generated-columns)). So `label` is read-only.

`quereus_effective_lens('x', 'Audit')` reports the resolved disposition of every logical column — `override` or `default` — so the covered-vs-gap-filled split is inspectable without guessing.

#### Body-shape restrictions

The merger composes one effective body by replacing **only the top SELECT's projection** with the composed logical-column list (covered ⊕ gap-fill). Body shapes that this single-projection rewrite cannot soundly compose are rejected at deploy/parse time rather than silently mis-mapped:

- **The body must be a single `SELECT`.** Compound set-operations (`union` / `union all` / `intersect` / `except`) and `values (...)` bodies are rejected at parse time — the merger would compose only the top leg and keep the rest verbatim.
- **A computed projection term must be aliased.** An unaliased non-column term (e.g. `select id, speed * 2 from …`) maps to no logical column; it is rejected (naming the term) rather than dropped and gap-filled.
- **Every `FROM` source must name the declared basis, or a CTE of the same body.** Two ways an override could escape its `over Y` basis, both rejected at deploy naming the relation:
  - *Qualified with another schema* — `from Z.Foo` would bind in `Z`, re-anchoring the body off its basis.
  - *Bare and absent from the basis* — nothing pins it, so it would fall through to the **default schema path** at read time and bind `main`'s same-named relation: the same re-anchor, minus the qualifier that would have made it visible.

  Fine: a bare basis relation, one qualified with the basis name, a CTE reference, and cross-table joins *within* the basis. A basis **view** counts as a basis relation here (it is still not introspectable — see the gap-fill boundary below). Function (TVF) sources resolve through the function registry, not the schema path, so they are out of scope. The check walks the **whole body** reflectively, so an escaping source buried in a subquery source, a `with` CTE body, a compound leg, a function-source argument, or a scalar/`where`/`in`/`exists` subquery is rejected too — not only top-level sources.
- **The compiled body stores the basis qualifier the compiler resolved.** "Unqualified defaults to the basis" is a rule about the *authored* text: the effective body the engine stores rewrites each bare basis source to `<basis>.<relation>` explicitly — the same fully-qualified form the synthesized default-mapper and decomposition bodies emit. Otherwise nothing in the stored body would record which schema a bare name meant, and each consumer would re-resolve it its own way (the read path plans under the *logical* schema's home path; the prover and `explain` round-trip through SQL text with no schema path at all), so a bare source over a non-`main` basis would fail to resolve or bind a same-named default-path table. Qualifying once at compile time makes every consumer agree by construction — including `resolveSlotBasisSource`, which therefore reads the stored qualifier and never re-defaults a bare name. Visible consequence: `quereus_effective_lens`'s `effective_sql` shows the basis qualifier even where the author wrote a bare name. The authored `declare lens` text is untouched and still round-trips as written.
- **A CTE shadows a same-named basis relation, everywhere in the body.** A name a `with` CTE declares is the CTE: it is neither basis-qualified nor collected as a basis source, so `*` expansion and gap-fill cannot draw columns from the shadowed basis table. An uncovered logical column only that table could have backed is an uncovered-column error at deploy, rather than a body that deploys and fails at read. The shadow set is *flat over the whole body*, not per-scope — a name used as a CTE anywhere disables basis resolution for it in every scope of that body. That over-shadows a body meaning the basis relation in one scope and a CTE in another: such a source is left bare and exempted from the basis check above, so it reports the ordinary unresolved-relation error at read time rather than binding the wrong relation.

#### Gap-fill fidelity boundary

Gap-fill resolves an uncovered logical column against the basis tables in the override's `FROM`. When it cannot, it errors rather than guess:

- **Single-source override, basis lacks the column** — the compile errors naming the column. Every logical column must map to basis, so an uncovered column the basis cannot back is a hard error: cover it explicitly, or it should not be a logical column of this design.
- **Partial cross-basis join, the gap needs another source** — a full-coverage cross-basis join is fine (gap-fill is a no-op and the body is used verbatim), but a join that covers only *some* columns where an uncovered column is *not reachable from the override's `FROM`* errors rather than emit an unsound body. Reaching a column that lives in a different basis source the single-source mapper cannot join in is genuinely structural — it is the decomposition's concern.

### `quereus_effective_lens(schema, table)`

The composed effective mapping is inspectable on demand (not editable text — see [the baseline is never authored text](#the-baseline-is-never-authored-text)). The integrated TVF resolves the lens slot for a logical `(schema, table)` and yields one row per logical column, in declaration order:

| column | meaning |
|---|---|
| `logical_column` | logical column name |
| `source` | `'override'` (covered by the override) · `'default'` (gap-filled by the default mapper) |
| `inverse` | `'authored'` (a `with inverse` clause supplies the put) · `'inferred'` (registry invertibility / identity / passthrough) · `'none'` (computed, read-only) |
| `advertised_member` | when a resolved primary-storage advertisement backs this column, the member `relationId` that backs it (the existence anchor for an EAV pivot); `NULL` for name-match / override-only provenance |
| `advertisement_anchor` | the resolved decomposition's existence-anchor `relationId` (= advertisement id), or `NULL` when no advertisement backs this logical table |
| `effective_sql` | the composed effective body SQL (repeated on every row) |

## Constraint Attachment

Moved to [Lens Constraint Attachment](lens-constraints.md). The rules you declared on the logical table — `not null`, `check`, `unique`, foreign keys — are real, and the lens is what enforces them when you write through it. A plain view cannot do this: its `where` filters what you *read* but constrains nothing on write. So the lens carries each declared rule down to the storage write and enforces it there, classified at deploy into *how* it is enforced: per row, by a key lookup against a covering structure, or by a scan at commit. Only writes routed through the lens bear these rules; a write straight to a basis table bears only the basis's own.

## Computed and Generated Columns

A logical column need not map to stored basis data — it can be **computed** by the lens `get`. Such a column has `computed` lineage ([view-updateability § The Update Site Model](view-updateability.md#the-update-site-model)): reads evaluate the expression, writes are rejected. This is how a generated/derived column is expressed — there is no separate `generated as` construct at the logical layer; a column is generated precisely when its lens body computes it and no `put` inverse exists. A computed column with an invertible body remains writable, by the ordinary scalar-invertibility rules; "generated" is just the non-invertible end of that spectrum.

**Writable intent (`quereus.lens.writable`).** A computed column is read-only *by default*, and the prover admits it as such — it cannot tell a column the author *meant* to be derived from one the author *meant* to be writable but whose body happens to be non-invertible (an authoring mistake silently accepted as read-only). The reserved per-logical-column tag `quereus.lens.writable` supplies the missing intent: `= true` declares the column **must** have a faithful write path, so an opaque/non-invertible body carrying it becomes a deploy error (`lens.non-invertible`) rather than a silent read-only column; `= false` (explicit read-only intent, documentation only) and *absent* both keep the conservative admit. The signal lives on the logical column's `with tags (...)` and survives schema export/round-trip. An invertible composed body (e.g. `(speed + 1) - 2`) tagged writable deploys writable with no error — the intent is satisfied. (Completeness gap: a writable-intent column whose body is *out of* the single-source projection-and-filter fragment degrades to safe and does **not** deploy-block; it still reds at mutation time — see the [round-trip detection](lens-prover.md#coverage-checklist) callout.)

**Authored inverses (`with inverse`).** When the registry cannot infer an inverse but the author has a chosen one — the canonical case is a non-injective mapping (twenty legacy codes collapsed to three) where a write should store a representative — the inverse is authored inline on the lens body's result column via the core-select [`with inverse (col = expr, …)` clause](vu-inverses.md#authored-inverses-with-inverse). The column upgrades from `computed` (read-only) to writable-with-supplied-put; because the clause is per-result-column, it rides the sparse-override merger like any covered term (gap-filled columns are identity mappings and never need one). An authored inverse satisfies the `quereus.lens.writable = true` intent the same way an inferred one does. PutGet is checked by composition at deploy; GetPut is intentionally surrendered for a non-injective forward (a write-through normalizes) and surfaces as the acknowledgeable `lens.getput-lossy` advisory rather than an error — see the [coverage checklist](lens-prover.md#coverage-checklist).

Two timings look alike but land in different layers, and conflating them is a common error:

- **Standing computed column** — re-evaluated on every read, never stored, tracks its inputs forever. It lives in the lens `get`. `full_name = first || ' ' || last` is standing.
- **One-shot derivation** — evaluated once, at deploy, to populate stored basis data, then maintained as ordinary storage that can diverge from whatever produced it. This is a **backfill** (see [Lens Deployment](lens-deployment.md#the-deployed-basis-representation)), not a lens compute. Promoting a standing computed column to stored basis — to index it, or to let it diverge — is exactly a one-shot derivation.

The distinction is the same one that separates a view expression from a materialized derivation: one is recomputed, the other is computed once and stored. The lens `get` expresses the first; the deploy/backfill step expresses the second.

## Deployment Is a Compile Step

Moved to [Lens Deployment](lens-deployment.md). Deploying a logical schema diffs the basis (a logical removal detaches the mapping and never drops basis storage), compiles each lens body, and registers it as an ordinary view, atomically. A per-schema deployment snapshot records what was deployed, is handed to modules through `notifyLensDeployment`, and drives the engine-generated backfill `quereus_basis_backfill` reports for a storage re-decomposition.

## Relationship to Materialized Views

Indexes are a basis-layer concern, expressed as **materialized views**: a materialized view with an `order by` describes a clustered/ordered structure — an index. A unique *constraint* is a logical claim (it lives in the logical schema); the *index* that covers it is a basis-layer materialized view. The two legitimately sit at opposite ends of the stack, and the lens carries the constraint down to a level where it is enforceable while the index attaches at basis. This realizes the principle that **a constraint is a logical claim, and the structure that enforces it is an optional physical optimization.**

Unique enforcement is a key existence lookup against that covering materialized view when present (row-time, conflict-resolution-capable), falling back to a commit-time scan when absent. The unified covering-structure surface this layer consumes — the `CoveringStructure` discriminated union (`memory-index` | `materialized-view`), the eager constraint↔structure linking, and the coverage prover that recognizes a covering `order by` MV — is described in [Derived-Row Constraints § Covering structures](mv-constraints.md#covering-structures).

The write-through prerequisite is satisfied for the covering-index shape: a materialized view keeps its backing table consistent synchronously with each source row-write, within the transaction (the single row-time materialization model — [Materialized-View Maintenance](mv-maintenance.md#maintenance-row-time-per-statement)), so a covering MV is *kept current at write time*, which is what a row-time existence lookup requires. Routing `unique` enforcement through that backing table for conflict resolution is described in [Derived-Row Constraints § Enforcement through a covering MV](mv-constraints.md#enforcement-through-a-covering-mv). For a logical schema — which builds no auto-index, so an explicit covering MV is the *sole* enforcement structure — that path is load-bearing. Where no covering structure answers a constraint, the commit-time scan governs the gap (the `lens.no-answering-structure` advisory).

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
  table CarCore (id int primary key, ...) using memory;
  table CarPerf (id int primary key, speed int, ...) using memory;
  create materialized view ix_carperf_speed as
    select speed, id from CarPerf order by speed;   -- clustered index over CarPerf
}

-- Lens: binds logical X to basis Y; supplies sparse overrides.
declare lens for X over Y {
  view Car as
    select id, speed as maxSpeed              -- rename override
    from Y.CarCore join Y.CarPerf using (id);  -- other Car columns gap-filled
  view Audit as
    select id, who, upper(who) as label         -- compute override; other Audit columns gap-filled
    from Y.AuditLog;
  -- tables of X not mentioned here are auto-mapped against Y entirely
}
```

- `declare logical schema X { ... }` — `kind: 'logical'`, declarative end-state, diffed by the schema differ.
- `declare lens for X over Y { ... }` — names the logical schema (`for X`) and the **explicit basis** (`over Y`), and populates lens slots. It is a **sibling statement of `declare schema`, not a variant** of it. Unmentioned tables are auto-mapped; columns unmentioned within a mentioned table are gap-filled. The basis binding lives on the lens, never on the logical schema — that is what keeps the logical schema embodiment-free and lets one logical schema target multiple bases across deployments. Re-declaring a lens for X replaces the prior block; two `view T as` for the same logical table within one block is an error. The lens must be declared **before** `apply schema X` (it is re-read from source on every apply).

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
| Auto-index for `unique` / PK | Physical schemas only; logical schemas never. | The eager auto-index (`LayerManager.ensureUniqueConstraintIndexes`) is gated on the one-bit `Schema.kind`: a *physical* (basis) table keeps the eager auto-index + implicit covering-structure descriptor; a *logical* table builds **nothing** — its `unique`/PK contributes only a key/FD to the optimizer plus an enforced boundary constraint, and any covering index is a separate basis-layer materialized view. Logical tables are never module-backed, so the path is unreachable for them anyway; the gate states the separation at the source. |
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

Each satellite lists the limitations of its own subsystem: [the default mapper and `put` fan-out](lens-default-mapper.md#current-limitations), [constraint attachment](lens-constraints.md#current-limitations), and [deployment](lens-deployment.md#current-limitations). The ones that belong to the layer as a whole, each raised at compile or mutation time with a precise diagnostic rather than silently mis-handled:

- **Round-trip proving outside the single-source fragment** — the deploy-time GetPut / PutGet predicate covers the single-source projection-and-filter fragment; join and decomposition bodies degrade to the mutation-time and key-reconstructibility checks. See the [round-trip detection](lens-prover.md#coverage-checklist) callout.
- **Override coverage is matched by name, not by attribute ID** — see [Coverage is name-based and re-read from source](#coverage-is-name-based-and-re-read-from-source). Addressing coverage by stable attribute ID on the plan tree (the [attribute-provenance](optimizer.md#attribute-provenance) system the prover already uses) would stop coverage depending on re-reading the override from source.
