description: Collation-name case-insensitive normalization. `columnDefToSchema` normalizes a column's COLLATE name to canonical uppercase and validates the whitelist case-insensitively, so `collate nocase` is accepted and enforces identically to `collate NOCASE`; unknown collations are rejected with new "Unknown collation" wording. `SchemaManager.buildIndexSchema` normalizes the index-column collation too. Shared `normalizeCollationName` helper in util/comparison.ts.
files: packages/quereus/src/util/comparison.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/07.3-group-by-extras.sqllogic, packages/quereus/test/logic/11.1-join-using.sqllogic, packages/quereus/test/logic/41-fk-extended-targets.sqllogic, packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic, packages/quereus/test/logic/102.2-unique-collation.sqllogic, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic
----

## Summary of implemented work

DDL-side collation-name validation was case-sensitive (`Array.includes` of the as-written
name against the canonical-uppercase `supportedCollations` whitelist), so a lowercase
`collate nocase` column was rejected with a misleading "not supported" error even though every
lookup/resolution/normalization layer is already case-insensitive.

- **util/comparison.ts** — new exported `normalizeCollationName(name)` (`name.trim().toUpperCase()`).
- **schema/table.ts** (`columnDefToSchema`, `collate` case) — normalize once, validate
  `supportedCollations` membership against the **normalized** name, store the **normalized**
  value on `ColumnSchema.collation`, reword rejection to
  `Unknown collation '<original>' for type '<TEXT>' on column '<col>' (expected one of: BINARY, NOCASE, RTRIM)`.
- **schema/manager.ts** (`buildIndexSchema`) — normalize the resolved index-column collation
  (`indexedCol.collation || tableColSchema.collation || 'BINARY'`); no whitelist check (preserves
  custom-collation indexes).

UNIQUE enforcement reads `ColumnSchema.collation`, so inline `text collate nocase unique` and
table-level `unique (x)` are fixed automatically. ALTER ADD COLUMN / RENAME COLUMN route through
`columnDefToSchema` in **both** the memory module (`vtab/memory/layer/manager.ts`) and the store
module (`quereus-store/.../store-module.ts`), so the lowercase spelling is normalized on those
paths too.

## Review findings

### What was checked

- **Source diff (3 files), fresh-eyes pass.** `normalizeCollationName` (uppercase) is consistent
  with the collation registry (`registerCollation`/`getCollation`/`resolveCollation` all key on
  `toUpperCase()`) and with `TEXT_TYPE.supportedCollations = ['BINARY','NOCASE','RTRIM']` (canonical
  uppercase). The `manager.ts` `|| 'BINARY'` fallback guarantees a non-undefined arg. Error message
  reports the **original** spelling while validating the **normalized** form — correct UX.
- **ALTER path coverage (the implementer left it unverified).** Traced 41.4's removed `-- error:`:
  `runAddColumn` → `module.alterTable` → `columnDefToSchema` in both memory and store modules. The
  removed directive is correct *and* the column collation gets normalized to `NOCASE` there.
- **Every removed `-- error:` directive** (41-fk, 41.4) confirmed to have been gated *only* by the
  lowercase-collation rejection — the blocks now create successfully with no other latent
  limitation (full suite green without the directives).
- **GROUP BY + NOCASE (flagged unverified in the handoff).** Empirically: GROUP BY, DISTINCT, and
  `count(distinct)` over a `collate nocase` column **do** honor the column collation (case-variant
  values fold into one group). The group-key comparator in `runtime/emit/aggregate.ts` resolves
  from `exprType.collationName`, which `type-utils.columnSchemaToDef` propagates from
  `ColumnSchema.collation`.
- **JOIN USING + NOCASE.** Empirically honors the column collation (`'BOB'` matches `'bob'`).
- **Docs.** `docs/sql.md` examples already used lowercase `collate nocase` — they were *ahead* of
  the old code and are now correct; no stale "case-sensitive / must be uppercase" claim exists for
  column DDL. `docs/plugins.md`'s "collation name must be uppercase" is about custom-collation
  *registration* (still true), not column DDL.
- **Validation.** typecheck `0`, lint `0`, full `packages/quereus` suite `0` (4130 passing, 9
  pending). The three test files I touched also pass under **store mode** (`QUEREUS_TEST_STORE=true`).

### Findings and dispositions (all minor — fixed in this pass)

- **GROUP BY / DISTINCT NOCASE was untested** (the handoff called this out and the section in
  07.3 was originally titled "...not supported"). Added real coverage to
  **07.3-group-by-extras.sqllogic**: a `group by` over a `collate nocase` column folding
  `'Hello'/'HELLO'` (asserted via `lower(name)` + `count`/`sum` so it is independent of which
  case-variant the engine picks as the group representative) and a `count(distinct)` assertion.
- **Stale comment in a *touched* file.** `41-fk-extended-targets.sqllogic` still read
  "Quereus rejects NOCASE on TEXT" above a block that the implementer had just made *succeed*.
  Reworded to state NOCASE is accepted at DDL.
- **Stale comment + dropped coverage in a *related* file.** `11.1-join-using.sqllogic:70` read
  "COLLATE NOCASE on TEXT columns isn't supported by Quereus; that branch removed." Since the fix
  enables it (verified: JOIN USING folds case under the column's NOCASE collation), restored the
  branch as a real test (`cn_a join cn_b using (name)` matching `'BOB'`/`'bob'`) and removed the
  false comment.

### Verified-good (no change needed)

- 102.1 §1 (accept + enforce + `frobnicate` unknown-collation), 102.2 §8 (lowercase parity), and
  41.4 (ALTER add-column normalization) read correctly.
- The implementer's revert of **06.4.2-collation-extras** is correct: its remaining `-- error:
  Indices on expressions are not supported` is about EXPRESSION indices, unaffected by this change.

### Out of scope (latent, not a regression — no ticket filed)

- A **custom** collation named on a TEXT *column* (`x text collate unicode_ci`) is still rejected
  by the `supportedCollations` whitelist (such collations still work via `CREATE INDEX`, which has
  no whitelist check). Pre-existing limitation, unchanged by this work; flagged here for visibility.

### Pre-existing (out of scope) behavior observed

- A `group by <col>` whose SELECT list omits the group-key column still **emits the group-key
  column** in `db.eval` output rows. Reproduces with a plain BINARY column, so it is unrelated to
  this ticket — not chased. The added 07.3 assertions are written to be insensitive to it.

### No `.pre-existing-error.md` filed — the suite is fully green.
