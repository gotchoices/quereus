description: Per-key metadata-tag ergonomics on ALTER TABLE — `ADD TAGS (k = v)` (merge) and `DROP TAGS (k)` (delete keys) at the table / column / named-constraint sites, so a single tag can be added/changed/removed without restating the whole set (the v1 `SET TAGS` is whole-set-replace only).
files:
  - packages/quereus/src/parser/parser.ts                         # alterTableStatement / alterColumnAction / new parseTagKeys helper
  - packages/quereus/src/parser/ast.ts                            # AlterTableAction: add mode to setTags + new dropTags
  - packages/quereus/src/planner/nodes/alter-table-node.ts        # AlterTableAction (plan-side): mirror mode + dropTags; toString
  - packages/quereus/src/planner/building/alter-table.ts          # map mode through; build dropTags; reserved-tag validation for merge only
  - packages/quereus/src/runtime/emit/alter-table.ts              # dispatch merge/drop to new SchemaManager methods; note text
  - packages/quereus/src/schema/manager.ts                        # merge/drop tag setters (table/column/constraint), DRY shared core
  - packages/quereus/test/logic/50-metadata-tags.sqllogic         # new phases: ADD/DROP TAGS at all three sites
  - packages/quereus/test/schema-manager.spec.ts                  # unit tests for merge*/drop* setters
  - packages/quereus/test/parser.spec.ts                          # parse coverage for ADD/DROP TAGS grammar
  - docs/sql.md                                                   # §2.7 SET TAGS subsection — document ADD/DROP TAGS
prereq:
----

# ALTER TABLE … ADD TAGS / DROP TAGS — per-key tag ergonomics

## Why

`10-alter-table-tag-mutation` shipped `ALTER TABLE … SET TAGS (…)` as the single tag
primitive: **whole-set replacement** at the table / column / named-constraint sites
(an empty list clears). That is the right minimal v1 and maps 1:1 onto the declarative
differ's "emit the full desired set" target, but it is ergonomically awkward for the
common interactive case of *touch one key*: you must restate every existing tag to add
or change one, and there is no way to drop a single key at all (since `null` is a legal
stored tag value, `set k = null` cannot mean "remove `k`").

This ticket adds two **additive, imperative-only** verbs over the existing catalog-only
tag swap:

```sql
alter table t add tags (audit = true);                         -- merge: set/overwrite `audit`, keep the rest
alter table t alter column c add tags (searchable = true);     -- merge on a column
alter table t alter constraint uq add tags (msg = 'dup');      -- merge on a named constraint
alter table t drop tags (audit, legacy);                       -- delete listed keys (NOTFOUND if any absent)
alter table t alter column c drop tags (searchable);           -- drop on a column
alter table t alter constraint uq drop tags (msg);             -- drop on a named constraint
```

## Resolved design decisions

These were the open questions in the plan ticket. They are **settled** — do not re-open
them; implement as written.

### 1. DROP of an absent key → `NOTFOUND`, atomic (all-or-nothing)

`DROP TAGS (a, b)` validates that **every** listed key is currently present *before*
mutating anything. If any listed key is absent, raise `QuereusError(NOTFOUND)` naming the
missing key(s) and drop **nothing** (the catalog is untouched). Rationale: this matches the
codebase's existing DROP semantics (`DROP COLUMN` / `DROP CONSTRAINT` both raise `NOTFOUND`
on an absent target) and the namespace's "a typo must fail loudly" posture — a silent no-op
would hide `drop tags (audt)`. There is **no** `IF EXISTS` form in this ticket (parked —
see backlog note below).

- Dropping the last remaining key(s) leaves `tags` as `undefined` (i.e. `tags IS NULL`),
  exactly like `SET TAGS ()`.
- Key matching is **case-sensitive / verbatim** — tag keys are stored exactly as authored
  (`display_name`, `audit`, `quereus.update.default_for.created`), with no case-folding.
  Confirm this against `parseTags` (the key comes from `consumeIdentifier`, stored verbatim
  into the `Record`); match the same casing on drop. (Reserved keys are lowercase
  `quereus.*` by construction.)

### 2. AST shape — `mode` on `setTags` + a sibling `dropTags`

- Extend the existing `setTags` action with `mode: 'replace' | 'merge'`. `SET TAGS` →
  `replace` (current behavior, default), `ADD TAGS` → `merge`. Both carry the same
  `tags: Record<string, SqlValue>` and the same `target` discriminator
  (`table | column | constraint`).
- Add a new sibling action `{ type: 'dropTags', target, keys: string[] }`. Drop carries a
  bare key list (no `= value`), so overloading `setTags.tags` would be a hack — a separate
  action is cleaner. Same `target` shape.

Both the **parser** AST (`parser/ast.ts`) and the **plan-node** action union
(`planner/nodes/alter-table-node.ts`) carry these two unions independently — update **both**.

### 3. The read-modify-write lives in `SchemaManager`, against the *current* tags

Merge and drop must read the tag record that is **live at execution time**, not the
plan-time `tableSchema` snapshot the emitter closes over. The existing emitter already passes
only the table *name* to `schemaManager.setColumnTags(...)`, which re-fetches via
`getTable(...)`; preserve that — the merge/drop logic reads `getTable(...)`'s current tags
inside the SchemaManager. This is correctness-critical for prepared-statement reuse and for
back-to-back ALTERs in one batch.

### 4. Reserved-tag validation

- `ADD TAGS` (merge) validates the added keys at the matching site exactly as `SET TAGS`
  does — same `validateReservedTags(tags, site)` + `raiseStmtTagDiagnostics(..., stmt)` in
  `building/alter-table.ts`. A typo'd / mis-sited `quereus.*` key fails at plan-build.
- `DROP TAGS` needs **no** value validation — it removes by key. Dropping a reserved key
  (e.g. `drop tags (quereus.update.default_for.created)`) is legitimate (removing an
  override) and must succeed.

### 5. Declarative differ — unchanged

The differ stays on whole-set `SET TAGS` (it computes the full desired set); ADD/DROP are an
imperative-only convenience and are **not** emitted by `generateMigrationDDL`. No differ
changes in this ticket.

## Implementation notes

### Parser (`parser.ts`)

Add a `parseTagKeys(): string[]` helper mirroring `parseTags()` but for a bare comma-list of
identifiers — `(key [, key ...])`, no `=`. An empty list `()` yields `[]`. Reuse
`consumeIdentifier`. Place it next to `parseTags` (~line 4017).

Wire the three sites. Use the existing `checkNext(n, type)` lookahead (parser.ts:2053) to
disambiguate against a column literally named `tags` at the **table level** — gate the
table-level ADD/DROP-tags branch on `peekKeyword('TAGS') && checkNext(1, TokenType.LPAREN)`
(i.e. `TAGS` immediately followed by `(`). `ADD tags integer` / `DROP tags` (no paren) still
fall through to ADD/DROP COLUMN.

- **Table level** (`alterTableStatement`):
  - In the `ADD` branch, as the first sub-case: if `peekKeyword('TAGS') && checkNext(1, LPAREN)`
    → `consumeKeyword('TAGS')`, `tags = parseTags()`,
    `action = { type:'setTags', target:{kind:'table'}, mode:'merge', tags }`.
  - In the `DROP` branch, as the first sub-case: same `TAGS`+`(` guard →
    `action = { type:'dropTags', target:{kind:'table'}, keys: parseTagKeys() }`.
  - The existing `SET` branch sets `mode:'replace'` on its `setTags` action.
- **Column level** (`alterColumnAction`): no paren-disambiguation needed (TAGS is
  unambiguous after `ALTER COLUMN <c> ADD|SET|DROP`).
  - Add an `ADD` branch: `if matchKeyword('ADD') { consumeKeyword('TAGS'); tags = parseTags();
    return { type:'setTags', target:{kind:'column', columnName}, mode:'merge', tags } }`.
  - In the existing `DROP` branch, add: `if matchKeyword('TAGS') { return { type:'dropTags',
    target:{kind:'column', columnName}, keys: parseTagKeys() } }`.
  - The existing `SET ... TAGS` leg sets `mode:'replace'`.
- **Named constraint level** (inside the `ALTER` → `CONSTRAINT` branch of
  `alterTableStatement`): the current code hard-codes `consumeKeyword('SET')` after the
  constraint name. Replace with a branch on `SET` / `ADD` / `DROP`:
  - `SET` → `consumeKeyword('TAGS'); { setTags constraint mode:'replace', tags: parseTags() }`
  - `ADD` → `consumeKeyword('TAGS'); { setTags constraint mode:'merge',   tags: parseTags() }`
  - `DROP` → `consumeKeyword('TAGS'); { dropTags constraint keys: parseTagKeys() }`
  - else throw a clear error ("Expected SET, ADD, or DROP after ALTER CONSTRAINT <name>.").

Set `mode:'replace'` explicitly on **every** existing `setTags` action site so the field is
never `undefined` (the table-level SET branch, the ALTER COLUMN SET TAGS leg, and the ALTER
CONSTRAINT SET leg).

### AST (`parser/ast.ts`)

- Add `mode: 'replace' | 'merge'` to the `setTags` member of `AlterTableAction`.
- Add `{ type: 'dropTags', target: <same kinds>, keys: string[] }`.
- Doc-comment both, mirroring the existing `setTags` block (catalog-only, no module
  round-trip; `dropTags` raises NOTFOUND on absent keys, atomically).

### Plan node (`planner/nodes/alter-table-node.ts`)

- Mirror the AST: add `mode` to the `setTags` action; add the `dropTags` action.
- Extend `toString()` and `getLogicalAttributes()` to cover `dropTags` and to reflect
  `mode` for `setTags` (e.g. `ALTER TABLE ADD TAGS` vs `SET TAGS`).

### Building (`planner/building/alter-table.ts`)

- `setTags` case: thread `mode` through to the plan action; keep the existing reserved-tag
  validation (`validateReservedTags(stmt.action.tags, site)` + `raiseStmtTagDiagnostics`) —
  it now covers both replace and merge (same `tags` payload, same site resolution).
- Add a `dropTags` case: resolve the same `site`/`target` plumbing for the action, but **no**
  reserved-tag validation (drop removes by key). Construct `{ type:'dropTags', target, keys }`.

### Runtime emitter (`runtime/emit/alter-table.ts`)

- `setTags` case: dispatch on `target.kind` **and** `mode` — `mode === 'merge'` →
  `runMergeTableTags` / `runMergeColumnTags` / `runMergeConstraintTags`; else the existing
  `runSet*Tags`.
- Add a `dropTags` case: dispatch on `target.kind` → `runDropTableTags` /
  `runDropColumnTags` / `runDropConstraintTags`, each delegating to the matching
  SchemaManager method.
- Extend the `note` IIFE for `dropTags` and to reflect the merge mode in the `setTags` note
  (e.g. `mergeTags(...)` vs `setTags(...)`).
- These stay catalog-only (no `module.alterTable`), exactly like the existing tag setters —
  they fire `table_modified` via `commitTagUpdate`, so optimizer caches invalidate and the
  store module re-persists the catalog DDL via its existing `table_modified` subscription
  (no store changes needed; ADD/DROP ride the same event path as SET).

### SchemaManager (`schema/manager.ts`)

Add six methods, **DRY** over a shared per-site read-modify-write core (do not copy-paste the
fetch/commit three times):

- `mergeTableTags(name, tags, schema?)`, `dropTableTags(name, keys, schema?)`
- `mergeColumnTags(name, col, tags, schema?)`, `dropColumnTags(name, col, keys, schema?)`
- `mergeConstraintTags(name, con, tags, schema?)`, `dropConstraintTags(name, con, keys, schema?)`

Suggested factoring: a single private pure helper computes the next frozen record from the
current one + a mutation descriptor, reusing the existing `freezeTags` for the empty→undefined
rule:

```ts
type TagMutation =
  | { op: 'merge'; tags: Record<string, SqlValue> }
  | { op: 'drop'; keys: readonly string[] };

private mutateTagRecord(
  current: Readonly<Record<string, SqlValue>> | undefined,
  mutation: TagMutation,
): Readonly<Record<string, SqlValue>> | undefined {
  if (mutation.op === 'merge') {
    return this.freezeTags({ ...(current ?? {}), ...mutation.tags });
  }
  // drop: every key must be present (atomic) — collect missing, throw NOTFOUND, else delete
  const next = { ...(current ?? {}) };
  const missing = mutation.keys.filter(k => !(k in next));
  if (missing.length > 0) {
    throw new QuereusError(`Tag key(s) not found: ${missing.join(', ')}`, StatusCode.NOTFOUND);
  }
  for (const k of mutation.keys) delete next[k];
  return this.freezeTags(next);
}
```

Then refactor so the existing `setTableTags`/`setColumnTags`/`setConstraintTags` (replace)
and the new merge/drop wrappers all share the same per-site fetch + `commitTagUpdate` body,
differing only in how the next record is computed (replace → `freezeTags(tags)`; merge/drop →
`mutateTagRecord(current, mutation)`). For the column site, resolve `colIndex` (NOTFOUND if
absent) and read `tableSchema.columns[colIndex].tags` as `current`. For the constraint site,
reuse `resolveNamedConstraintClass` (NOTFOUND / ambiguous) and read the matching constraint's
current `tags`. Keep the existing public `set*Tags` signatures unchanged (the differ and
tests depend on them).

Note: `freezeTags({})` already collapses an empty merge result to `undefined`, but a merge of
a non-empty `tags` can never empty the set; a drop of all keys does, and `freezeTags`
collapses it correctly.

### Docs (`docs/sql.md` §2.7, the **SET TAGS** subsection, ~line 1335)

- Add the `ADD TAGS` / `DROP TAGS` syntax lines under the existing `SET TAGS` block.
- Update the **"Whole-set replacement"** bullet: `SET TAGS` is whole-set replace, while the
  new `ADD TAGS (k = v[, …])` **merges** (set/overwrite the listed keys, keep the rest) and
  `DROP TAGS (k[, …])` **deletes** the listed keys.
- Document the DROP-absent-key rule (`NOTFOUND`, atomic — names missing key(s), drops
  nothing; dropping the last key(s) yields `tags IS NULL`) and case-sensitive key matching.
- Note ADD validates reserved keys at the site like SET; DROP does no value validation.
- Note the differ stays on whole-set `SET TAGS` (ADD/DROP are imperative-only sugar).
- This subsection currently says per-key merge/delete are "a planned ergonomic follow-up" —
  update that wording to describe the now-shipped verbs.

## Edge cases & interactions

The reviewer will check these; write them as tests up front.

- **DROP absent key → NOTFOUND, atomic.** `drop tags (present, absent)` raises NOTFOUND, names
  `absent`, and leaves `present` (and all other tags) untouched. Single absent key likewise.
- **DROP all keys → `tags IS NULL`.** Dropping every current key collapses to `undefined`
  (introspection TVFs report `tags IS NULL`), identical to `SET TAGS ()`.
- **ADD onto no tags.** `add tags (k = v)` on a target whose `tags IS NULL` creates the set.
- **ADD overwrites.** `add tags (k = 2)` over an existing `k = 1` yields `k = 2`, other keys
  preserved.
- **ADD with null value.** `add tags (k = null)` stores `k` present with value null (legal
  stored value) — distinct from dropping `k`.
- **ADD reserved-key validation.** `add tags (quereus.update.taget = '…')` (typo) and a
  mis-sited reserved key fail loudly at plan-build, same as `SET TAGS`. A valid reserved key
  at the right site is stored.
- **DROP reserved key succeeds.** `drop tags (quereus.update.default_for.created)` removes the
  override with no value validation.
- **Current-tags read at execution time.** Merge/drop must read the *live* tags, not a stale
  plan-time snapshot. Test: prepare/execute an `add tags` after the target's tags changed via
  another path (or two `add tags` in sequence) — the second merges onto the first's result.
- **Empty list is a no-op.** `add tags ()` and `drop tags ()` change nothing (no clear). This
  is deliberately distinct from `set tags ()` (which clears). Document and test.
- **Column-named-`tags` disambiguation (table level).** `alter table t drop column tags` and
  `alter table t add tags_col integer` must still parse as column ops; only `ADD TAGS (` /
  `DROP TAGS (` (keyword immediately followed by `(`) routes to tag mutation. Add a parser
  test with a column literally named `tags`.
- **Named-constraint resolution.** ADD/DROP on a constraint go through the same
  `resolveNamedConstraintClass` path as SET: NOTFOUND for an unknown name, ambiguous error for
  a name in >1 class (CHECK → UNIQUE → FK), unnamed constraints not addressable.
- **Column NOTFOUND.** `alter column nope add/drop tags (…)` raises NOTFOUND on the column.
- **Schema-hash neutral.** Tags are excluded from the schema hash — `explain schema` reports
  the same hash after ADD/DROP (assert if a hash-stability test pattern already exists for
  SET TAGS; otherwise note in the sqllogic).
- **Store persistence (memory default is enough for this ticket).** ADD/DROP fire
  `table_modified` via `commitTagUpdate`, so the store's existing catalog re-persist
  subscription covers them with no store-module change. A `yarn test:store` pass is *not*
  required inside this ticket (memory-backed default test run exercises the engine path); if
  convenient, a store-side spec can be added, but it is not a gate here.

## TODO

- [ ] `parser/ast.ts`: add `mode` to `setTags`; add `dropTags` action; doc-comment both.
- [ ] `parser.ts`: `parseTagKeys()` helper; wire ADD/DROP TAGS at table, column, and named-
      constraint sites; `checkNext(1, LPAREN)` disambiguation at the table level; set
      `mode:'replace'` on all existing `setTags` sites.
- [ ] `planner/nodes/alter-table-node.ts`: mirror `mode` + `dropTags`; update `toString` /
      `getLogicalAttributes`.
- [ ] `planner/building/alter-table.ts`: thread `mode`; reserved-tag validation for merge;
      build `dropTags` (no value validation).
- [ ] `runtime/emit/alter-table.ts`: dispatch merge/drop to the new SchemaManager methods;
      extend `note`.
- [ ] `schema/manager.ts`: `mutateTagRecord` core + `merge*Tags` / `drop*Tags` for table /
      column / constraint; refactor existing replace setters to share the per-site body.
- [ ] `test/schema-manager.spec.ts`: unit tests for the six new setters incl. NOTFOUND-atomic
      drop, drop-to-empty, merge-overwrite, merge-null, case-sensitivity.
- [ ] `test/parser.spec.ts`: parse ADD/DROP TAGS at all three sites; column-named-`tags`
      disambiguation.
- [ ] `test/logic/50-metadata-tags.sqllogic`: new phases for ADD/DROP TAGS at table / column /
      constraint, covering the edge cases above (NOTFOUND, drop-to-null, empty no-op,
      add-overwrite, reserved validation).
- [ ] `docs/sql.md` §2.7 SET TAGS subsection: document ADD/DROP TAGS and update the
      "planned follow-up" wording.
- [ ] `yarn workspace @quereus/quereus run build`, `yarn test`, and lint
      (`yarn workspace @quereus/quereus run lint`) green.
