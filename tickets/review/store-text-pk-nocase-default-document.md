description: Cross-reference comment added at memory-side collation resolution site; docs/schema.md cross-backend contrast note added; memory-side BINARY text PK test added.
files:
  - packages/quereus/src/schema/table.ts                                  # resolveDefaultCollation JSDoc — added cross-backend divergence note
  - docs/schema.md                                                        # §"Per-column PK key collation" CREATE bullet — added concrete cross-backend contrast paragraph
  - packages/quereus/test/logic/10.2-column-features.sqllogic             # new §2e — undecorated text PK is BINARY under memory, 'a'/'A' distinct

# Review handoff: store-text-pk-nocase-default-document

## What was done

Documentation/breadcrumb only — no behavior change, no schema change, no new collation logic.

### 1. Cross-reference comment in `table.ts`

Added a "Cross-backend divergence (intentional)" paragraph to the JSDoc of
`resolveDefaultCollation` (around line 209-235). It states:

- This function resolves the *engine/memory* default only.
- The store module deliberately overrides an implicit-default text PK to NOCASE via
  `reconcilePkCollations` in `quereus-store/store-module.ts`.
- Same DDL `create table t (x text primary key)` → BINARY under memory, NOCASE under store.
- Deliberate backward-compatibility choice — not a bug. Points to `docs/schema.md`.

### 2. Cross-backend contrast note in `docs/schema.md`

Extended the CREATE bullet under §"Per-column PK key collation" (around line 358) with a
concrete contrast:
- Same DDL yields BINARY under memory ('a'/'A' distinct) and NOCASE under store ('a'/'A' collide).
- Explains which function handles each side.
- Notes the consequence for authored lens bijection proofs.

### 3. Memory-side BINARY text PK assertion in `10.2-column-features.sqllogic`

Added §2e (after 2d — ORDER BY collation) asserting:
- `create table t_text_pk (x text primary key)` → `table_info` shows BINARY collation.
- `insert 'a', 'A'` → both rows kept distinct (count = 2).
- Comment cross-references `docs/schema.md` for the store-side divergence.

## Tests

`yarn test` — 6273 passing, 9 pending, exit code 0. Lint clean.

The store side is already covered by `create-table-conformance.spec.ts` ("implicit-default
text PK reports the fixed key collation K (NOCASE), not BINARY" with 'a'/'A' collision test).

## Known gaps / review focus

- The docs note about the lens read-only-vs-writable consequence is the first prose link
  between the collation divergence and the authored-bijection behavior — verify the wording
  is accurate and not misleading.
- No sqllogic cross-backend comparison test was added (the ticket explicitly said to prefer
  extending existing coverage rather than a new cross-backend file). If a reviewer wants an
  explicit cross-backend comparison, it would need a new `test:store` sqllogic file.

## Review findings
