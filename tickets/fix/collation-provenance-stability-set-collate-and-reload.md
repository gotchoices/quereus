description: Collation provenance (ScalarType.collationSource rank) is a function of schema *history*, not catalog state — ALTER COLUMN SET COLLATE never sets collationExplicit, and DDL persistence/reload upgrades 'default' to 'declared' — so the comparison-collation lattice ranks the same logical schema differently across sessions and alteration paths.
files:
  - packages/quereus/src/schema/table.ts                       # columnDefToSchema — the ONLY site that sets collationExplicit (CREATE-time COLLATE constraint)
  - packages/quereus/src/vtab/memory/layer/manager.ts          # alterColumn ~1713: newCol = { ...oldCol, collation } — collationExplicit not set
  - packages/quereus-store/src/common/store-module.ts          # alterColumn ~1376: same spread, same gap
  - packages/quereus/src/planner/type-utils.ts                 # columnSchemaToScalarType — collationExplicit → 'declared' | 'default'
  - packages/quereus/src/schema/schema-differ.ts               # emits SET COLLATE for declared-collation diffs (~2313) — apply path inherits the gap
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # the lattice consuming the rank (no change expected here)
  - docs/types.md                                              # § Comparison collation resolution — document the decided semantics
  - docs/sql.md                                                # § 9.2.4 default_collation ("catalog stores the concrete, resolved collation")
difficulty: medium
----

# Collation provenance must be stable across SET COLLATE and schema reload

Ticket `comparison-collation-provenance-and-precedence` introduced the
provenance-ranked comparison lattice: a column whose collation came from an
explicit `COLLATE` clause (`ColumnSchema.collationExplicit`) contributes at
rank 2 ('declared'), a defaulted collation at rank 1 ('default'). The two
ranks have observably different semantics: rank-2 same-rank conflicts are
prepare-time errors while rank-1 conflicts resolve to BINARY silently, and a
rank-1 contribution loses silently to any rank-2 contribution.

`collationExplicit` is set in exactly one place — `columnDefToSchema`
(schema/table.ts, the CREATE-time `COLLATE` constraint). Two paths break the
invariant that a column's rank is determined by the current catalog schema:

**1. `ALTER COLUMN ... SET COLLATE` does not mark the collation explicit.**
Both the memory module (`vtab/memory/layer/manager.ts` `alterColumn`) and the
store module (`quereus-store` `store-module.ts` `alterColumn`) build
`newCol = { ...oldCol, collation: normalized }`. Consequences:

- A user's explicit demand (`alter table t alter column v set collate
  nocase`) on a column created *without* a `COLLATE` clause ranks 'default'
  (rank 1) — it silently loses to any declared collation and silently
  BINARY-resolves against another defaulted collation, where the equivalent
  CREATE-time declaration would win or error.
- Because the spread *inherits* the old flag, the identical SET COLLATE
  statement yields rank 2 when the column happened to be created with a
  `COLLATE` clause and rank 1 when it didn't — same statement, divergent
  semantics based on creation history.
- The schema differ's apply path emits `SET COLLATE` for declared-collation
  diffs, so `apply schema` reproduces a declared column at the wrong rank.

**2. DDL persistence upgrades 'default' to 'declared' on reload.**
Per docs/sql.md § 9.2.4, the catalog stores the concrete resolved collation
and persisted DDL always emits an explicit `COLLATE` for any non-BINARY
collation (the store's load path treats persisted DDL as the source of
truth). A column that got NOCASE from session `default_collation` therefore
reloads through `columnDefToSchema` with `collationExplicit: true` — rank 1
in the creating session, rank 2 after reopen. Observable flips (always in
the fail-louder direction — a silent resolution becomes a prepare-time
error, never silently different results):

- defaulted NOCASE vs defaulted RTRIM: BINARY silently before reopen →
  ambiguous-collation error after.
- defaulted NOCASE vs declared RTRIM: RTRIM silently before reopen →
  ambiguous-collation error after.

The store module's implicit-PK reconcile (`reconcilePkCollations`) has the
same round-trip: it assigns the store default with 'default' provenance
in-session, but the reconciled collation persists as an explicit `COLLATE`
clause and reloads 'declared'.

## Expected behavior

The lattice rank of a column's collation must be a function of the current
catalog schema, not of how or when the schema was arrived at. Concretely:

- `SET COLLATE <name>` is an explicit user declaration and must produce
  `collationExplicit: true` (rank 2), uniformly across modules, regardless
  of the column's creation history. Decide and pin whether `SET COLLATE
  binary` is likewise a rank-2 declaration (consistent with `c text collate
  binary` at CREATE) — consistency argues yes.
- Decide the round-trip story for session-defaulted collations: either
  (a) accept rank upgrade on reload as *intended* semantics — 'default'
  provenance is deliberately session-transient, the persisted catalog is
  fully explicit — and document that in docs/types.md § Comparison collation
  resolution and docs/sql.md § 9.2.4 (the upgrade is fail-louder only, so
  this is defensible); or (b) persist the explicit/implicit distinction so
  provenance survives reload. Option (a) requires only documentation;
  option (b) requires a DDL/catalog representation decision (e.g. eliding
  the stored default or a column tag) and a migration story.
- Tests must pin: SET COLLATE then comparison (both the conflict-error and
  the wins-over-defaulted cases) on both memory and store modules; and —
  if option (b) — a store reopen preserving rank (extend the 06.4.4 §6
  session-default matrix with a close/reopen).
