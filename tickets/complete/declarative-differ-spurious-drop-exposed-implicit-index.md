description: COMPLETE — Fixed the spurious `DROP INDEX IF EXISTS <name>` the declarative differ emitted for an exposed implicit covering index (a UNIQUE constraint tagged `quereus.expose_implicit_index`). The catalog now marks such entries `CatalogIndex.implicit = true`; the differ filters them out of its standalone-index buckets so a converged schema diffs empty across both backends.
files:
  - packages/quereus/src/schema/catalog.ts (CatalogIndex.implicit marker; collectSchemaCatalog memory loop ~163 + store synthetic loop ~175; indexSchemaToCatalog ~425)
  - packages/quereus/src/schema/schema-differ.ts (computeSchemaDiff — actualIndexes filter ~290)
  - packages/quereus/test/covering-structure.spec.ts (introspection-hiding assertion + `declarative idempotency — exposed implicit covering index` describe, now with a require-hint create+drop-coincidence case)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic (exposed-implicit-index phase at EOF; runs both backends via test:store)
  - docs/schema.md (index body-change detection section, ~line 442)
----

## Summary

An exposed implicit covering index (the secondary BTree backing a UNIQUE
constraint tagged `quereus.expose_implicit_index = true`) is surfaced by
`collectSchemaCatalog` as a `CatalogIndex` so introspection (`schema()`,
`index_info()`) can see it. Its lifecycle, however, belongs to the originating
UNIQUE *constraint* (matched no-churn via the named-constraint path), not to
`CREATE/DROP INDEX`. The differ double-counted the object — matched as a
constraint **and** scheduled for a phantom `DROP INDEX IF EXISTS <name>` by the
orphan-drop loop — so a converged schema produced a migration instead of a no-op.

The fix is a catalog marker + a single differ filter:

- **`CatalogIndex.implicit?: boolean`** (catalog.ts) — set at the only two
  surfacing sites in `collectSchemaCatalog`: the memory real-index loop marks
  `true` exactly when `exposed === true`; the store synthetic loop
  (`exposedImplicitIndexes`) marks every descriptor. Threaded through
  `indexSchemaToCatalog(..., implicit = false)`, which sets the field **only when
  true** so an ordinary index's catalog shape is byte-identical to before.
- **Differ filter** (schema-differ.ts ~290): `actualIndexes` is built from
  `actualCatalog.indexes.filter(i => !i.implicit)`. This single map feeds all
  three downstream index consumers — rename resolution, the create/body loop, and
  the orphan-drop loop — so a marked entry can never enter `indexesToCreate`,
  `indexesToDrop`, `indexTagsChanges`, or a rename op.

## Review findings

### What was checked

- **Read the implement diff first** (commit `05c4b5d0`) with fresh eyes before
  the handoff summary, then cross-checked every claim against the live source.
- **Single-chokepoint claim.** Verified `actualCatalog.indexes` has exactly one
  consumer in `schema-differ.ts` (the `actualIndexes` map) via `find_references`;
  `actualIndexes` then feeds `indexRenames` (rename resolution), the
  create/body loop (through `indexRenames.pairs`), and the orphan-drop loop
  (`for (const [name] of actualIndexes)`). The filter is correctly the one place
  that gates all three. ✓
- **Marker producer surface.** `indexSchemaToCatalog` is the sole producer of
  `CatalogIndex` and has exactly two call sites, both in `collectSchemaCatalog`
  (memory real-index loop; store synthetic loop). No other path constructs a
  `CatalogIndex`. ✓
- **No leak onto ordinary or genuine-unique indexes.** `implicitCoveringIndexExposure`
  excludes `derivedFromIndex` constraints, so a real `CREATE UNIQUE INDEX` is
  absent from the exposure map → `exposed === undefined` → unmarked →
  differ-managed. The `decl_uniq` sqllogic phase still round-trips empty. The
  `if (implicit) entry.implicit = true` guard keeps an ordinary index's object
  shape unchanged (no `implicit: false` noise for code that `.find`/`.map`s the
  catalog). ✓
- **TVF read paths unaffected.** `schema()` / `index_info()` iterate
  `tableSchema.indexes` + `exposedImplicitIndexes(...)` directly and never read
  `CatalogIndex.implicit`, so the marker has no effect on introspection output. ✓
- **`require-hint` semantics.** Confirmed `enforceRequireHint` throws only when
  `creates > 0 && drops > 0` — corroborating the implementer's note that the
  pre-fix bug *silently executed* a pure drop under require-hint rather than
  erroring.
- **Docs.** Read the full `docs/schema.md` § "Index body-change detection" change;
  it accurately distinguishes hidden (absent from `actualCatalog.indexes`) vs
  exposed (present, marked, filtered) and states the convergence / no-phantom-drop
  guarantee. ✓
- **Build / lint / tests** — all green (see below).

### Findings & disposition

- **MINOR — fixed inline.** The implementer explicitly flagged that the
  create+drop *coincidence* shape was untested (an exposed implicit index
  alongside an unrelated genuine index create, under `require-hint`). Pre-fix this
  shape was 1-create / 1-drop, which `require-hint` hard-errors as an ambiguous
  unhinted rename — a strictly louder failure than the pure-drop case the existing
  tests cover. Added `it('a genuine index create alongside the exposed implicit
  index does not trip require-hint', …)` to the `declarative idempotency` describe
  in `covering-structure.spec.ts`: it re-declares the converged table plus a real
  `index idx_expo_extra on ExpoTbl(vin)`, then asserts `computeSchemaDiff(…,
  'require-hint')` does **not** throw, `indexesToDrop == []`, and the only create
  is the genuine index. Verified this guards the regression: the pre-fix
  1-create/1-drop shape would have thrown via `enforceRequireHint`.

- **No MAJOR findings — no new tickets filed.** The fix is minimal, correctly
  scoped to the single chokepoint, and the data-flow audit found no other code
  path that could re-introduce the phantom drop.

- **Collision safety (acknowledged, no action).** A user `declare … index` whose
  name collides with an exposed constraint's implicit name is impossible by
  construction today (implicit names are constraint-derived). If it ever arose,
  the filter makes the marked actual invisible to declared-index matching, so the
  declared index is *created* rather than a spurious drop of the constraint's
  structure — graceful degradation, documented in the `CatalogIndex.implicit`
  doc-comment. Not worth a guard or ticket at present.

### Coverage assessment (the implementer's tests were the floor)

- **Happy path / idempotency:** converged schema diffs empty under both `allow`
  and `require-hint` (spec) + memory & store sqllogic. ✓
- **Interaction / regression:** create+drop coincidence under `require-hint`
  (added this pass). ✓
- **Introspection invariant:** index still surfaced AND carries `implicit ===
  true` (spec). ✓
- **Enforcement still fires:** sqllogic asserts a duplicate UNIQUE insert is
  rejected (the constraint, not the index, governs it) across both backends. ✓
- **Negative / no-leak:** `decl_uniq` genuine-unique-index phase still round-trips
  empty (a marked entry never leaks onto a real unique index). ✓

### Validation run this pass

- `yarn build` (packages/quereus) — clean.
- `yarn lint` (packages/quereus, `src/**` + `test/**`) — 0 problems.
- `covering-structure.spec.ts` — 83 passing (includes the 5 implicit-index tests:
  2 introspection-hiding + 3 declarative-idempotency, the third being the new
  create+drop-coincidence case).
- `50-declarative-schema.sqllogic` — passing in **memory** and **store**
  (`QUEREUS_TEST_STORE=true`) modes.

No `.pre-existing-error.md` written — every test exercised here passed.
