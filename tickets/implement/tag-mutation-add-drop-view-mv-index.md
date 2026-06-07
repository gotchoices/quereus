description: Extend per-key `ADD TAGS (k = v)` (merge) and `DROP TAGS (k)` (delete) ergonomics to ALTER VIEW / ALTER MATERIALIZED VIEW / ALTER INDEX, mirroring the just-shipped ALTER TABLE add/drop verbs. Pure-metadata catalog mutations; design is fully determined by the prereq pattern.
prereq:
files:
  - packages/quereus/src/parser/ast.ts                              # AlterObjectTagsAction → discriminated setTags(mode)/dropTags
  - packages/quereus/src/parser/parser.ts                           # parseSetObjectTagsAction → branch SET/ADD/DROP TAGS (rename to parseObjectTagsAction)
  - packages/quereus/src/planner/nodes/set-object-tags-node.ts      # carry the mutation (replace/merge/drop), update toString/getLogicalAttributes
  - packages/quereus/src/planner/building/set-object-tags.ts        # validate reserved on setTags only; thread the mutation
  - packages/quereus/src/runtime/emit/set-object-tags.ts            # dispatch objectKind × op → matching SchemaManager setter
  - packages/quereus/src/schema/manager.ts                          # extract update{View,MaterializedView,Index}Tags helper + add merge*/drop* setters
  - packages/quereus/src/emit/ast-stringify.ts                      # alter{View,MaterializedView,Index}ToString → set/add/drop forms
  - packages/quereus/test/logic/50-metadata-tags.sqllogic           # Phases 32+ (ADD/DROP on view/MV/index + edge cases)
  - packages/quereus/test/schema-manager.spec.ts                    # unit tests for the 6 new merge*/drop* setters
  - packages/quereus/test/parser.spec.ts                            # parse + round-trip for the new view/MV/index forms
  - docs/sql.md                                                     # §2.7 "SET TAGS on views, materialized views, and indexes" → add ADD/DROP
----

# ADD TAGS / DROP TAGS on views, materialized views, and indexes

## Why

The prereq `tag-mutation-add-drop-ergonomics` (now in `complete/`) shipped per-key
`ADD TAGS (k = v)` (merge) and `DROP TAGS (k)` (delete) on **ALTER TABLE** at the
table / column / named-constraint sites, layered over whole-set `SET TAGS`. The other
tagged catalog objects — plain views, materialized views, and indexes — still accept
**only** whole-set `SET TAGS`. This ticket brings them to parity:

```sql
alter view v              add tags (cacheable = true);   -- merge: set/overwrite, keep rest
alter view v              drop tags (purpose);           -- delete keys (atomic NOTFOUND if absent)
alter materialized view m add tags (owner = 'team-b');
alter materialized view m drop tags (legacy);
alter index ix            add tags (purpose = 'search');
alter index ix            drop tags (purpose);
```

The change is a pure-mechanical extension of an existing, fully-reviewed pattern — no
new semantics are invented. The resolution table below is copied verbatim from the
ALTER TABLE work; the implementer's job is to reuse the same primitives at the
view/MV/index sites.

## Determined semantics (mirror ALTER TABLE exactly)

- `ADD TAGS` = **merge**: set/overwrite the listed keys, keep the rest. Empty list `()`
  is a **no-op** (it does NOT clear — that is what distinguishes `ADD TAGS ()` from
  `SET TAGS ()`).
- `DROP TAGS` = **delete listed keys**, **atomic**: every listed key must currently be
  present, else a `NOTFOUND` error names the missing key(s) and **nothing** is dropped.
  Dropping the last key(s) leaves `tags IS NULL`. Empty list `()` is a no-op.
- Key matching is **verbatim / case-sensitive** (how `parseTags` / `parseTagKeys` store keys).
- `ADD TAGS` validates reserved `quereus.*` keys at the object's site
  (`view-ddl` for view/MV, `physical-index` for index) **exactly as `SET TAGS` does** —
  it shares the same plan-build validation path. `DROP TAGS` removes by key and does
  **no** value validation (dropping a reserved override is legitimate).
- All three verbs are **catalog-only** — no module / data round-trip, no re-materialize,
  no physical-layout touch. They read the object's **live** tags at execution time
  (read-modify-write in `SchemaManager`).
- The differ (`schema-differ.ts`) is **unchanged** — it continues to emit whole-set
  `SET TAGS` only. Do not teach it merge/drop.

## Design (each layer is determined by the prereq)

### AST — `packages/quereus/src/parser/ast.ts`

Replace the single-member `AlterObjectTagsAction` with a discriminated union mirroring
the ALTER TABLE `setTags`/`dropTags` shape, **minus** the `target` field (the object is
the statement's own `name`, not a sub-site):

```ts
export type AlterObjectTagsAction =
	| { type: 'setTags'; mode: 'replace' | 'merge'; tags: Record<string, SqlValue> }
	| { type: 'dropTags'; keys: string[] };
```

`SET TAGS` → `mode:'replace'`, `ADD TAGS` → `mode:'merge'`, `DROP TAGS` → `dropTags`.
Carry the same doc-comment intent as the ALTER TABLE union (replace empty = clear;
merge empty = no-op; drop atomic NOTFOUND; catalog-only; no value validation on drop).
`AlterViewStmt` / `AlterMaterializedViewStmt` / `AlterIndexStmt` keep `action: AlterObjectTagsAction`.

### Parser — `packages/quereus/src/parser/parser.ts` (~2872)

Rename `parseSetObjectTagsAction` → `parseObjectTagsAction` and branch on the leading
keyword. **No `(` look-ahead guard is needed here** (unlike the table level): after
`ALTER VIEW <name>` the only legal grammar is a tag op, so `SET`/`ADD`/`DROP` + `TAGS`
is unambiguous. Reuse the existing `parseTags()` / `parseTagKeys()` helpers:

```ts
private parseObjectTagsAction(): AST.AlterObjectTagsAction {
	if (this.matchKeyword('SET')) {
		this.consumeKeyword('TAGS', "Expected 'TAGS' after SET.");
		return { type: 'setTags', mode: 'replace', tags: this.parseTags() };
	}
	if (this.matchKeyword('ADD')) {
		this.consumeKeyword('TAGS', "Expected 'TAGS' after ADD.");
		return { type: 'setTags', mode: 'merge', tags: this.parseTags() };
	}
	if (this.matchKeyword('DROP')) {
		this.consumeKeyword('TAGS', "Expected 'TAGS' after DROP.");
		return { type: 'dropTags', keys: this.parseTagKeys() };
	}
	throw this.error(this.peek(), "Expected SET, ADD, or DROP TAGS after object name.");
}
```

The three call sites (`alterViewStatement` / `alterMaterializedViewStatement` /
`alterIndexStatement`) just call the renamed helper — no other change.

### Plan node — `packages/quereus/src/planner/nodes/set-object-tags-node.ts`

The node currently stores a bare `tags: Record<string, SqlValue>`. Extend it to carry
the discriminated mutation so the emitter can dispatch. Add:

```ts
export type SetObjectTagsMutation =
	| { op: 'replace' | 'merge'; tags: Record<string, SqlValue> }
	| { op: 'drop'; keys: readonly string[] };
```

Replace the constructor's `tags` param with `mutation: SetObjectTagsMutation`. Update
`toString()` to render the verb (`SET TAGS` / `ADD TAGS` / `DROP TAGS`) and
`getLogicalAttributes()` to surface `op` plus `tags`/`keys` (so EXPLAIN shows the op).

### Builder — `packages/quereus/src/planner/building/set-object-tags.ts`

`buildSetObjectTags` currently always validates reserved tags. Branch on the AST action:

- `setTags` (both `replace` and `merge`) → `validateReservedTags(action.tags, site)` →
  `raiseReservedTagDiagnostics(...)` exactly as today, then build the node with
  `{ op: action.mode, tags: action.tags }`.
- `dropTags` → **no** validation; build the node with `{ op: 'drop', keys: action.keys }`.

The per-statement builders (`buildAlterViewStmt` / `buildAlterMaterializedViewStmt` /
`buildAlterIndexStmt`) pass `stmt.action` through instead of `stmt.action.tags`. Keep the
existing site mapping (view & MV → `view-ddl`, index → `physical-index`) and the
default-schema resolution.

### SchemaManager — `packages/quereus/src/schema/manager.ts`

The view/MV/index setters currently **inline** their read-modify-write (unlike the
table/column/constraint setters, which already share private `update*Tags(name, compute,
schemaName)` helpers + `mutateTagRecord`). DRY them the same way:

- Extract `private updateViewTags(viewName, compute: TagCompute, schemaName?)` from the
  body of `setViewTags`, preserving the canonical-stored-name `view_modified` event.
- Extract `private updateMaterializedViewTags(name, compute, schemaName?)` from
  `setMaterializedViewTags`, preserving `materialized_view_modified` (never re-registers
  maintenance, never re-materializes — `_modified` ≠ `_added`) and the body-hash invariant.
- Extract `private updateIndexTags(indexName, compute, schemaName?)` from `setIndexTags`,
  preserving the owning-table resolution, the `isHiddenImplicitIndex` NOTFOUND guard, and
  the `table_modified` event on the owning table.

Then rewrite the three `set*Tags` as one-liners over the helper and add the six new public
setters, exactly mirroring the table-level `mergeTableTags` / `dropTableTags`:

```ts
setViewTags(name, tags, schemaName?)            // updateViewTags(name, () => this.freezeTags(tags), schemaName)
mergeViewTags(name, tags, schemaName?)          // ... current => mutateTagRecord(current, { op:'merge', tags })
dropViewTags(name, keys, schemaName?)           // ... current => mutateTagRecord(current, { op:'drop',  keys })
setMaterializedViewTags / mergeMaterializedViewTags / dropMaterializedViewTags   // same shape
setIndexTags / mergeIndexTags / dropIndexTags                                    // same shape
```

`mutateTagRecord` and `freezeTags` already exist and need no change.

### Emit — `packages/quereus/src/runtime/emit/set-object-tags.ts`

Dispatch on `objectKind × op`. For each kind, `op:'replace'` → `set*Tags(name, tags, …)`,
`op:'merge'` → `merge*Tags(name, tags, …)`, `op:'drop'` → `drop*Tags(name, keys, …)`.
Keep the lazy `_ensureTransaction()` and the NOTFOUND-surfaces-from-setter behavior.
Update the `note` to include the op.

### Round-trip — `packages/quereus/src/emit/ast-stringify.ts`

`alterViewToString` / `alterMaterializedViewToString` / `alterIndexToString` currently
hard-code `set tags`. Branch on `stmt.action`:

- `setTags` → verb `add tags` if `mode === 'merge'` else `set tags`, body via the
  existing `tagsBodyToString(action.tags)`.
- `dropTags` → `drop tags` + `tagKeysBodyToString(action.keys)` (both already exported).

### Docs — `docs/sql.md` §2.7

Extend the "SET TAGS on views, materialized views, and indexes" subsection with the
ADD/DROP forms and the merge/drop/atomic-NOTFOUND/empty-list semantics, cross-referencing
the ALTER TABLE ADD/DROP TAGS prose so the two stay DRY (one canonical semantics
paragraph, referenced from both).

## Edge cases & interactions (write these as tests up front)

- **DROP absent key** on view / MV / index → `NOTFOUND`, **atomic** (tags unchanged).
  Unit-test all three setters; sqllogic-test at least one per object kind.
- **Empty-list distinction**: `ADD TAGS ()` is a no-op (keeps existing tags); `SET TAGS ()`
  clears; `DROP TAGS ()` is a no-op. Pin all three for at least the view kind.
- **Drop last key → `tags IS NULL`** for each object kind (same end-state as `SET TAGS ()`).
- **MV is metadata-only**: `ADD`/`DROP TAGS` on an MV must **not** re-materialize or touch
  the backing table — assert the backing row-count / `bodyHash` is unchanged across the
  mutation (mirror the existing SET-TAGS MV test in Phase 19 and the `bodyHash` assertion
  in `schema-manager.spec.ts`).
- **Behavioral tag changes** (`quereus.update.*`) via ADD/DROP must fire the right
  `*_modified` event so a cached write-through plan is invalidated — same path as SET TAGS.
  (Covered structurally by reusing the extracted `update*Tags` helpers, which fire the
  events; no behavioral test required beyond the existing SET-TAGS coverage, but note it.)
- **ADD validates reserved, DROP does not**: `alter view v add tags ("quereus.bogus" = 1)`
  → plan-build rejection (same diagnostic as SET on the `view-ddl` site);
  `alter index ix add tags ("quereus.bogus" = 1)` → rejection on `physical-index`;
  but `alter … drop tags ("quereus.<reserved>")` **succeeds** (removes the key).
- **Hidden implicit covering index**: `alter index <uq-name> add tags (…)` and
  `… drop tags (…)` on the auto-built covering structure of a UNIQUE constraint both raise
  `NOTFOUND` (tags live on the constraint) — reuse the `isHiddenImplicitIndex` guard via the
  shared `updateIndexTags` helper; the prereq already pins this for SET via Phase 22.
- **Exposed implicit index** (`quereus.expose_implicit_index = true`): ADD/DROP become
  addressable, mirroring the existing SET test in `schema-manager.spec.ts`.
- **NOTFOUND object**: `alter view NoSuch add tags (a=1)` / `drop tags (a)` and the MV /
  index equivalents → NOTFOUND from the setter.
- **Unqualified name under a switched current schema** resolves against the current
  default schema (already handled by `buildSetObjectTags`; do not regress).
- **Round-trip** of all nine new forms (3 kinds × {add, drop} plus the unchanged set)
  through `astToString` → re-parse, including a quoted reserved-looking key
  (e.g. `"quereus.id"`) to confirm `tagKeysBodyToString` quotes keys.

## TODO

- [ ] AST: make `AlterObjectTagsAction` the discriminated `setTags(mode)` / `dropTags` union.
- [ ] Parser: rename to `parseObjectTagsAction`, branch SET/ADD/DROP TAGS, reuse
      `parseTags` / `parseTagKeys`; update the three call sites.
- [ ] Plan node: carry `SetObjectTagsMutation`; update `toString` / `getLogicalAttributes`.
- [ ] Builder: validate reserved on `setTags` only (replace + merge); thread mutation; skip
      validation on `dropTags`.
- [ ] SchemaManager: extract `update{View,MaterializedView,Index}Tags(name, compute, schemaName?)`
      from the current setters (preserve each object's existing event semantics + guards),
      then add `merge*`/`drop*` for all three kinds over `mutateTagRecord`.
- [ ] Emit: dispatch `objectKind × op` → matching setter; update `note`.
- [ ] ast-stringify: render set / add / drop for view / MV / index.
- [ ] Tests: sqllogic Phases 32+ (ADD/DROP on view, MV, index; empty-list, drop-last,
      drop-absent NOTFOUND, MV no-rebuild, reserved ADD-rejects/DROP-allows, hidden +
      exposed implicit index, NOTFOUND object); `schema-manager.spec.ts` unit tests for the
      6 new setters; `parser.spec.ts` parse + round-trip.
- [ ] Docs: extend `docs/sql.md` §2.7 with ADD/DROP forms (reference the ALTER TABLE
      semantics paragraph; stay DRY).
- [ ] Validate: `yarn workspace @quereus/quereus run build` (EXIT 0),
      `lint` (EXIT 0), `test` (0 failing). Stream output via `tee` per AGENTS.md; do not run
      `test:store` (out of scope — the store re-persist path rides the same
      `table_modified`/`view_modified` events already covered).
