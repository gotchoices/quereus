description: Documented the intentional store↔memory collation-default divergence for an undecorated single-column text PRIMARY KEY (memory → BINARY, store → NOCASE). Added a cross-reference breadcrumb at the memory-side resolution site, a cross-backend contrast paragraph in docs/schema.md, and a memory-side BINARY assertion. Review fixed a store-lane test regression the implement stage introduced.
files:
  - packages/quereus/src/schema/table.ts                                  # resolveDefaultCollation JSDoc — cross-backend divergence note
  - docs/schema.md                                                        # §"Per-column PK key collation" CREATE bullet — cross-backend contrast paragraph
  - packages/quereus/test/logic/10.2-column-features.sqllogic             # §2e replaced with a pointer comment (block moved out)
  - packages/quereus/test/logic/10.2.2-default-collation-memory.sqllogic  # NEW memory-only file holding the BINARY text-PK assertion
  - packages/quereus/test/logic.spec.ts                                   # registered new file in MEMORY_ONLY_FILES

# Complete: store-text-pk-nocase-default-document

## What shipped

Documentation/breadcrumb work confirming the store↔memory collation-default
divergence for an undecorated single-column text PRIMARY KEY is **intentional**, not a
bug:

- **`table.ts`** — `resolveDefaultCollation` JSDoc gained a "Cross-backend divergence
  (intentional)" paragraph: this function resolves the engine/memory default only; the
  store overrides an implicit-default text PK to its key collation K (NOCASE default) via
  `reconcilePkCollations`. Same DDL → BINARY under memory, NOCASE under store. Points to
  `docs/schema.md`.
- **`docs/schema.md`** §"Per-column PK key collation" CREATE bullet — concrete
  cross-backend contrast (`'a'`/`'A'` distinct under memory, collide under store), which
  function owns each side, and the consequence for authored-lens bijection proofs.
- **Memory-side BINARY assertion** — an undecorated text PK reports BINARY and keeps
  `'a'`/`'A'` distinct. The store leg is already covered by
  `create-table-conformance.spec.ts`.

No behavior change, no schema change, no new collation logic.

## Review findings

Reviewed against the implement diff (commit b35533d3) with fresh eyes before reading the
handoff. Scrutinized: correctness of the prose claims, accuracy of the code/file
references in both comments, cross-backend test placement, and resource/test-lane
interactions.

### MAJOR — store-lane test regression introduced by the implement stage (FIXED inline)

The implement stage added the new §2e block to `10.2-column-features.sqllogic`, which is
**not** in `MEMORY_ONLY_FILES`, so it also runs under `yarn test:store`. There is no
per-block store-skip directive in the sqllogic harness (`logic.spec.ts` only supports
`-- error:`, `-- params:`, `-- run`; the only store-skip is the file-level
`MEMORY_ONLY_FILES` set). The block asserts BINARY + distinct `'a'`/`'A'`, but under the
store the default is NOCASE — so `table_info` reports NOCASE (≠ BINARY) and the second
insert would raise UNIQUE. Empirically reproduced:

```
node packages/quereus/test-runner.mjs --store --grep "10.2-column-features"
  → [10.2-column-features.sqllogic:168] row 0 mismatch.
    Actual: {"name":"x","collation":"NOCASE"}  Expected: {"name":"x","collation":"BINARY"}
```

The implementer's handoff explicitly skipped the store lane ("run the memory lane only"),
which is exactly why this escaped — and is ironic given the ticket is *about* this very
divergence. Not pre-existing: the break was introduced by this ticket's own implement
commit, so it was fixed in this pass rather than filed.

**Fix (test-only):** extracted the assertion to a new memory-only file
`10.2.2-default-collation-memory.sqllogic` (self-contained, with a header explaining why
it must be memory-only), registered it in `MEMORY_ONLY_FILES`, and left a pointer comment
in §2e of `10.2-column-features.sqllogic`. Named `10.2.2-` to avoid colliding with the
pre-existing `10.2.1-table-options-rejection.sqllogic` prefix.

Verified:
- memory `--grep "10.2.2"` → passing; store `--grep "10.2.2"` → skipped (pending).
- store `--grep "10.2-column-features"` → now passing (block removed).
- full memory suite → 6274 passing, 9 pending (was 6273; +1 from the file split).
- `yarn workspace @quereus/quereus run lint` → exit 0.

### Prose accuracy — checked, accepted

- `table.ts` JSDoc references (`reconcilePkCollations`, `quereus-store/store-module.ts`,
  K = `config.collation || 'NOCASE'`) all verified against the live store code. Accurate.
- `docs/schema.md` lens read-only-vs-writable claim (flagged by the implementer as review
  focus): matches the fix-stage investigation's conclusion verbatim (the
  value-discrimination gate in `extractCheckConstraints` drops the enum domain under
  NOCASE `'a' ≡ 'A'`, so an authored text-PK lens stays read-only under store, writable
  under memory). It is an appropriately hedged breadcrumb pointing readers at the
  authoritative prose; accepted as-is.

### Other dimensions

- **Docs accuracy** — read every file the change touches plus the store-side
  counterparts; the new prose reflects current reality (per-column physical re-keying,
  K-as-default-only). No stale claims found.
- **DRY** — the divergence prose lives authoritatively in `docs/schema.md`; the `table.ts`
  comment links rather than duplicates. Good.
- **Coverage** — happy path (memory BINARY default, store NOCASE default) covered on both
  legs; explicit-COLLATE override and composite/ALTER cases already covered by the store
  conformance specs. No new gaps introduced.
- **Error paths / type safety / resource cleanup** — N/A; doc + test-placement only.

### Not done (deliberate)

- Full `yarn test:store` end-to-end not run: wall-clock risks the runner idle timeout, and
  this change only touches `10.2-column-features.sqllogic` (now passing under store) plus a
  store-skipped new file — the rest of the store lane is untouched. The affected file was
  verified directly under store mode.
