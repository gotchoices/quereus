description: Reject a decomposition whose member stitch key (or EAV materialize conflict target) is not a declared PRIMARY KEY / UNIQUE at deploy time, instead of relying on read-join soundness implicitly and risking a double-insert on the optional/EAV materialize path. Corner #1 of the view-write-decomposition-optional-update review hardening.
files: packages/quereus/src/schema/lens-compiler.ts (validatePrimaryAdvertisement), packages/quereus/src/planner/mutation/decomposition.ts (buildOptionalMaterializeInsert / buildEavMaterializeInsert doc comments), packages/quereus/test/lens-put-fanout.spec.ts, docs/lens.md (§ The Default Mapper) / docs/view-updateability.md (§ Decomposition put fan-out)
----

## Context

The shipped decomposition put fan-out (`planner/mutation/decomposition.ts`) materializes
absent optional / EAV component rows on UPDATE with an `on conflict (<target>) do nothing`
INSERT:

- **optional columnar** (`buildOptionalMaterializeInsert`): `insert into <member> (<memberKey>, …)
  select <anchorKey>, … from <anchor> where <pred> on conflict (<memberKey>) do nothing`.
- **EAV pivot** (`buildEavMaterializeInsert`): `insert into <pivot> (<entity>, <attr>, <val>)
  select <anchorKey>, '<attr>', <value> from <anchor> where <pred>
  on conflict (<entity>, <attr>) do nothing`.

The `do nothing` is what partitions the affected rows between the **matched UPDATE** and the
**materialize INSERT**: the matched anchors already have a component row, so their insert
collides on the conflict target and is skipped, ceding them to the UPDATE. The runtime
`do nothing` (`dml-executor.ts` `matchUpsertClause` → `processInsertRow`) only fires on a
detected **PK / UNIQUE** violation. If the conflict target is **not** a declared unique on the
member, no conflict is raised and the materialize would **double-insert** the matched rows
instead of ceding them.

The same uniqueness fact also underwrites the **read** side: the get body stitches members with
an equi-join `anchor.key = member.key` (columnar) and projects EAV columns as `(entity, attr)`
correlated subqueries. A non-unique columnar stitch key multiplies join rows; a non-unique
`(entity, attr)` makes the EAV subquery multi-valued. So a non-unique conflict target is
structurally unsound across **both** directions of the lens — but nothing asserts it today.

This is **not a known live bug**: every shipped fixture uses a PK stitch key, and the view image
is sound across the property oracles. It is an undefended structural assumption a future
advertisement shape could trip.

## Design

Add a **deploy-time** guard in `validatePrimaryAdvertisement`
(`packages/quereus/src/schema/lens-compiler.ts`), beside the existing surrogate-default /
key-arity / key-column-existence checks. Deploy time is the correct gate (not plan time): the
fan-out only ever runs on a **deployed** lens, the invariant governs the **read** path too (a
plan-time check would leave reads silently multiplying), and it is caught once at `apply schema`
rather than per-mutation. Validation errors there are plain strings aggregated into the existing
`QuereusError` (`lens: advertisement for logical table '…' is invalid: …`) — no
`raiseMutationDiagnostic` / reason code is used at deploy time, consistent with the sibling
checks.

The invariant, per member:

- **EAV pivot member** — the materialize conflict target is `(entityColumn, attributeColumn)`.
  That column set must equal a declared PRIMARY KEY or non-partial UNIQUE constraint on the
  member basis table. The member's *stitch key* (`entity` alone) is intentionally one-to-many
  and is **not** required unique.
- **non-EAV (columnar) member** — the conflict target is the member's stitch key columns
  (`sharedKey.keyColumnsByRelation.get(member.relationId)`). That column set must equal a
  declared PRIMARY KEY or non-partial UNIQUE constraint. An **empty** stitch key (the singleton
  `primary key ()` shape) is skipped — there is no stitch to validate and no materialize path.

"Equal a declared unique" is **exact set-equality** with the column set of a declared PRIMARY
KEY or a non-partial UNIQUE constraint (`UniqueConstraintSchema.predicate === undefined`; a
partial UC only guarantees uniqueness within its scope and cannot back an unqualified
`on conflict`). Exact-set-match mirrors how `on conflict (cols)` resolves a constraint by its
column set. Validate **every** member (anchor included): the anchor's own stitch key must be
unique for the logical-PK / surrogate identity to be 1:1.

`TableSchema` surface (already in use in this file):
- `table.columnIndexMap: ReadonlyMap<string, number>` — lowercased column name → index.
- `table.primaryKeyDefinition: ReadonlyArray<{ index: number; … }>`.
- `table.uniqueConstraints?: ReadonlyArray<{ columns: ReadonlyArray<number>; predicate?: … }>`.

Sketch (drop into `validatePrimaryAdvertisement` after the key-column-existence loop, reusing
the already-resolved `memberTables` map):

```ts
for (const member of storage.members) {
  const table = memberTables.get(member.relationId);
  if (!table) continue; // missing relation already reported
  if (member.attributePivot) {
    const target = [member.attributePivot.entityColumn, member.attributePivot.attributeColumn];
    const idx = resolveColumnIndices(table, target);
    if (idx && !indicesFormDeclaredUnique(table, idx)) {
      errors.push(`EAV pivot member '${member.relationId}' conflict target (${target.join(', ')}) ` +
        `is not a declared PRIMARY KEY or UNIQUE constraint on '${table.name}'; the get-side ` +
        `correlated subquery requires (entity, attribute) single-valued and the per-attribute ` +
        `materialize INSERT cedes matched triples via \`on conflict (${target.join(', ')}) do nothing\``);
    }
    continue;
  }
  const keyCols = sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
  if (keyCols.length === 0) continue; // singleton — nothing to stitch
  const idx = resolveColumnIndices(table, keyCols);
  if (idx && !indicesFormDeclaredUnique(table, idx)) {
    errors.push(`member '${member.relationId}' stitch key (${keyCols.join(', ')}) is not a ` +
      `declared PRIMARY KEY or UNIQUE constraint on basis relation '${table.name}'; the ` +
      `decomposition equi-join requires a 1:1 stitch and the optional-member materialize ` +
      `INSERT's \`on conflict (${keyCols.join(', ')}) do nothing\` only cedes matched rows ` +
      `against a declared unique — declare a PRIMARY KEY / UNIQUE on those columns`);
  }
}
```

Two small private helpers (place near `buildColumnBackingMap`):

```ts
function resolveColumnIndices(table: TableSchema, names: readonly string[]): number[] | undefined {
  const out: number[] = [];
  for (const n of names) {
    const i = table.columnIndexMap.get(n.toLowerCase());
    if (i === undefined) return undefined; // unresolved name already reported elsewhere
    out.push(i);
  }
  return out;
}

function indicesFormDeclaredUnique(table: TableSchema, indices: readonly number[]): boolean {
  const want = new Set(indices);
  const eq = (cols: readonly number[]) => cols.length === want.size && cols.every(c => want.has(c));
  const pk = table.primaryKeyDefinition.map(p => p.index);
  if (pk.length > 0 && eq(pk)) return true;
  for (const uc of table.uniqueConstraints ?? []) {
    if (uc.predicate !== undefined) continue; // partial UNIQUE is not a whole-table key
    if (eq(uc.columns)) return true;
  }
  return false;
}
```

Because a non-unique conflict target can no longer deploy, the plan-time materialize builders may
**rely** on the invariant — no redundant plan-time check is added. Update the doc comments on
`buildOptionalMaterializeInsert` and `buildEavMaterializeInsert` (and the relevant docs section) to
state that the `on conflict` target is **guaranteed** a declared unique by the deploy-time guard,
so the matched-UPDATE / materialize-INSERT partition is sound.

## Edge cases & interactions

- **EAV vs columnar target divergence** — the EAV clause must check `(entity, attr)`, NOT the
  stitch key (`entity`). Getting this wrong would falsely reject every EAV decomposition (whose
  stitch key is deliberately one-to-many). Pin both: an EAV fixture with a proper `(entity, attr)`
  PK deploys; one without is rejected.
- **Singleton (`primary key ()`)** — empty stitch key, no materialize path. Must be skipped, not
  rejected. The existing singleton fixture must still deploy.
- **UNIQUE (not PK) stitch key** — a column-level `unique` (non-partial UC) must satisfy the
  guard, not only a PRIMARY KEY. Pin an accept case where the stitch column is `unique` while the
  table PK is a different column.
- **Partial UNIQUE** — a `create unique index … where …`-derived UC (`predicate !== undefined`)
  must NOT satisfy the guard (it only guarantees uniqueness within its scope). (Hard to construct
  through the lens fixtures; the `predicate !== undefined` skip is the defense — note it, optional
  to test.)
- **Self-decomposition** (`selfDecompositionAd`, both members → table `S`, stitch `id` = S's PK) —
  must still **deploy** (it is rejected later at *write* time by the existing self-decomposition
  guard, and reads through it). The new guard sees `id` = PK and passes. Verify the existing
  self-decomposition tests still pass (deploy + read succeed; write still rejects).
- **Empty-schema vehicle** (`emptySchemaAd`, `relation.schema: ''`) — `memberTables` resolves it
  against the basis (`resolveBasisRelation`), so the guard finds the PK and passes; the table must
  still deploy and read. Verify those robustness tests still pass.
- **Anchor included** — validating the anchor's own stitch key is intentional. All fixtures give
  the anchor a PK stitch key, so none regress.
- **No-PK base tables** — do NOT construct a reject vehicle with a base table that has *no* PK
  (Quereus is key-addressed; a PK-less table may be rejected or treated as singleton at CREATE,
  muddying the test). Instead give the member table a PK on a **different** column than its stitch
  key (e.g. `(rid integer primary key, id integer, c integer)` with stitch key `id`) — `id` is a
  plain non-unique column, the table is otherwise valid, and the guard fires cleanly.
- **Tag-built vs module advertisements** — both route through `resolveAdvertisement` →
  `validatePrimaryAdvertisement`, so the guard covers `buildAdvertisementsFromTags` (property.spec)
  and `AdvertisingModule` (lens-put-fanout.spec) shapes alike. No separate wiring.

## Expected tests

Add a `describe('lens decomposition put: stitch-key uniqueness guard', …)` to
`packages/quereus/test/lens-put-fanout.spec.ts` (it already has `AdvertisingModule`, `colMap`,
`keyMap`, `expectThrows`). Use small bespoke advertisements:

- **reject: columnar optional member with a non-unique stitch key** — member `T_c` created as
  `(rid integer primary key, id integer, c integer)`, optional, stitch key `['id']`. `apply
  schema` (deploy) throws matching `/stitch key.*not a declared|1:1 stitch/i`.
- **reject: EAV member whose (entity, attr) is not unique** — `E_eav` as
  `(rid integer primary key, eid integer, attr text, val integer)` (no PK/UNIQUE on `(eid, attr)`).
  Deploy throws matching `/EAV pivot.*conflict target.*not a declared/i`.
- **accept: UNIQUE (not PK) stitch key deploys and round-trips** — `T_c` as
  `(rid integer primary key, id integer unique, c integer)`, stitch key `['id']`. Deploy
  succeeds; an optional-member UPDATE materialize (`update x.T set c = 7 where id = 2` on an absent
  row) creates the row via `on conflict (id) do nothing` and the view reads it back.
- **accept: singleton still deploys** — reuse `singletonAd`; assert `apply schema` does not throw
  (a smoke deploy, the existing singleton insert test already covers behavior).
- (optional) **accept: self-decomposition / empty-schema fixtures still deploy** — assert the
  existing `setupSelfDecomposition` / `setupEmptySchema` paths do not throw at deploy (guard
  passes), leaving their write-time / read behavior to the existing tests.

## Docs

Document the stitch-key-uniqueness invariant in `docs/lens.md` § The Default Mapper (or
`docs/view-updateability.md` § Decomposition put fan-out): every member's stitch key (columnar)
and every EAV pivot's `(entity, attribute)` must be a declared PRIMARY KEY / non-partial UNIQUE,
validated at deploy time; this underwrites both the get-side 1:1 stitch / single-valued subquery
and the put-side `on conflict do nothing` materialize partition.

## TODO

- Add `resolveColumnIndices` + `indicesFormDeclaredUnique` private helpers to `lens-compiler.ts`.
- Add the per-member stitch-key / EAV-conflict-target uniqueness loop to
  `validatePrimaryAdvertisement` (after the key-column-existence loop, reusing `memberTables`).
- Update `buildOptionalMaterializeInsert` / `buildEavMaterializeInsert` doc comments to state the
  conflict target is deploy-time-guaranteed unique.
- Add the reject/accept tests above to `lens-put-fanout.spec.ts`.
- Update the lens docs section with the invariant.
- `yarn workspace @quereus/quereus run build`, then run the lens specs (stream output):
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lensA.log; tail -n 60 /tmp/lensA.log`
  (or scope to the relevant spec files), and lint the package.
