description: Five shared SQL test files use stand-alone index statements without announcing it, so a storage backend that lacks them dies partway through each file. Announce it in the one file that is about indexes, and move the index-using sections of the other four into small sibling files that announce it, so the rest keeps running everywhere.
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic # add the directive
  - packages/quereus/test/logic/03.6-type-system.sqllogic # lines ~478–533 move out
  - packages/quereus/test/logic/03.6.4-real-bigint-secondary-index.sqllogic # new
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic # `ckp` scenario, lines ~400–420, moves out
  - packages/quereus/test/logic/15.1.2-semantic-ordering-index.sqllogic # receives `ckp`
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic # sections A, E, F, H move out
  - packages/quereus/test/logic/41.2.4.1-ddl-rollback-states-unique-index.sqllogic # new
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic # section 12's `index r_p_u` member moves out
  - packages/quereus/test/logic/50.4.1-declare-schema-apply-restore-index.sqllogic # new
  - packages/quereus/test/README.md # § `-- requires-capability:` directive (format spec; read, likely no edit)
difficulty: easy
----

# Bring five `.sqllogic` files in line with the `standalone-index-ddl` capability

## Background

`packages/quereus/test/logic/*.sqllogic` is a shared corpus: sibling projects run the same files against their own storage engine. A file that uses `create index` / `create unique index` / `drop index` as its own statement — or an `index` / `unique index` member inside a (non-logical) `declare schema` block, which `apply schema` lowers to those statements — must carry `-- requires-capability: standalone-index-ddl` in its leading comment block. A backend without that feature then skips the file instead of dying at the first index statement and losing every unrelated section after it. The format and the "split the file rather than annotate wholesale" rule are in `packages/quereus/test/README.md` § `-- requires-capability:` directive. Precedent splits: `15.1.2-semantic-ordering-index` (carved out of `15.1`), `10.1.2.1-add-constraint-in-transaction`, `41.2.3.1-…-secondary-index`.

Quereus's own two backends support the feature, so none of this changes what runs locally — every scenario still runs, just in a different file. The payoff is downstream.

A follow-on ticket (`sqllogic-capability-usage-guard`) adds a corpus test that fails any file whose SQL uses the feature without declaring it; it depends on this ticket and on `sqllogic-index-ddl-split-shape-and-declarative` having cleared every current offender. The full offender list was measured by parsing every corpus block with the engine's real `Parser` (same block rules as `test/logic.spec.ts`): exactly eight files, five of them here.

## Per-file decisions

**`11.3-index-nested-loop-join`** — its subject is index-driven joins; every scenario creates indexes. Add `-- requires-capability: standalone-index-ddl` to the header block (before the first SQL line). Nothing to preserve for a backend without indexes.

**`03.6-type-system`** — the section headed `-- === REAL comparator against a bigint operand past 2^53 (regression) ===` creates `real_big` + `real_big_ir` and `real_big_null` + `real_big_null_ir` (through `DROP TABLE real_big_null;`). Move those two tables' scenarios into new `03.6.4-real-bigint-secondary-index.sqllogic`, with a header that says where it came from (pattern: the `15.1.2` header) and declares the capability. Keep the `real_pk` scenario ("REAL primary key, no secondary index in sight") in `03.6` — it needs no index; keep a one-line pointer comment to `03.6.4` above it, and keep the section heading so the regression note still reads correctly. Rejected alternative: replacing the index with an inline `unique (r)` constraint — it changes the access path being tested (implicit unique index, not a secondary index) and assumes the downstream backend's handling of UNIQUE, which we don't know.

**`15.1-semantic-ordering`** — the `ckp` scenario (comment starting "A partial UNIQUE index in play", the `create unique index ckp_v … where s = 'PT60M'`, through `drop table ckp;`) moves to the end of the existing `15.1.2-semantic-ordering-index.sqllogic`, which already declares the capability and exists for exactly this. Its comment refers to "the false {d, s} class" set up by the surrounding mixed-type `check (d = s)` discussion in `15.1`; rewrite the moved comment so it stands alone (say what the class is: a `check (d = s)` between a TIMESPAN and a TEXT column used to put `d` and `s` in one equivalence class, which inferred `s = 'PT60M'` from a pin on `d`). Update the `15.1.2` header's "Two scenarios reached the same rule…" sentence to account for the third. Leave a one-line pointer in `15.1` where the scenario was.

**`41.2.4-ddl-rollback-states`** — sections A (`ra`, line ~19), E (`re`, ~179), F (`rf`, ~203) and H (`rh`, ~228) build `create unique index`; the other sections (B–D', I–S: collation, type, NOT NULL, CHECK, FOREIGN KEY) do not. Move A, E, F, H verbatim (keeping their letters, so cross-references in comments still resolve) into new `41.2.4.1-ddl-rollback-states-unique-index.sqllogic`. Its header: one short paragraph restating the rule (pointing at `41.2.4` for the full statement rather than copying it) plus the directive. In `41.2.4`, add a line in the header saying the unique-index cases live in `41.2.4.1`. Check that no remaining section in `41.2.4` relies on a table created in A/E/F/H (each section appears self-contained, creating and dropping its own table — confirm by inspection).

**`50.4-declare-schema-apply-restore`** — section 12's second `declare schema main` (line ~768) adds `index r_p_u on r_p (u)` deliberately: it proves an index can be built in the stretch of the migration where the view a CHECK reads has been dropped (see `docs/schema-declarative.md`, the "the same, plus `add column` and a new index on the table | applies" row). So it must not simply be deleted. In `50.4`, remove only the `index r_p_u` member, leaving the `add column w default 3` alteration as the in-the-gap proof. Create `50.4.1-declare-schema-apply-restore-index.sqllogic` (declares the capability) that rebuilds section 12's setup self-contained (`r_t`, `r_v`, `r_p` with its CHECK, one row) and applies a declaration that redefines the view and adds `index r_p_u` in the same plan, then asserts the apply succeeds, `diff schema main` is `[]`, and the index exists (`select name from schema() where type = 'index' and name = 'r_p_u'` or equivalent the corpus already uses). If `docs/schema-declarative.md` cites `50.4` as the test for that row, point it at both files.

## Edge cases & interactions

- **Directive position** — the directive must be in the leading comment block, before the first SQL line, or `parseRequiredCapabilities` hard-errors. Verified by `test/logic-capabilities.spec.ts` ("parses every .sqllogic file without error"), which already runs over the whole corpus.
- **Header prose naming the directive** — a header comment line that *starts* with "requires capability" (no backticks) trips the near-miss guard (`NEAR_MISS_RE` in `test/logic-capabilities.ts`). When header prose mentions the directive, backtick-quote it, as the existing split files do. Verified by the same spec.
- **State carried across sections** — a moved section must not depend on tables/rows left by an earlier section of its old file, and the remaining file must not depend on the moved one. Verified by running both files (below).
- **Sibling file run order** — new files are named so they sort right after their parent (`03.6.4` after `03.6.3`, `41.2.4.1` after `41.2.4`, `50.4.1` after `50.4`). Inspection.
- **Store backend** — the moved scenarios ran under `yarn test:store` in their old files and will in the new ones; nothing here is store-specific. Running `test:store` for the touched files is optional (it is slow); do it if any moved scenario fails under memory.
- **Overlapping open ticket** — `tickets/backlog/bug-real-to-text-formatting-differs-from-sqlite.md` names `03.6` for its cast-to-text assertions, a different section; no conflict.

## Verification

No new test — the moved scenarios are themselves the tests. Run, from the repo root:

```
node packages/quereus/test-runner.mjs --grep "03.6|11.3-index|15.1|41.2.4|50.4|capability"
```

and confirm every touched and new file passes, the scenario count is preserved (every moved `→` / `-- error:` assertion exists exactly once across old + new file), and `logic-capabilities.spec.ts` passes. Then `yarn test` for the full suite.

## TODO

- Add the directive to `11.3-index-nested-loop-join.sqllogic`
- Move the `real_big` / `real_big_null` scenarios from `03.6` into new `03.6.4-real-bigint-secondary-index.sqllogic`; leave `real_pk` and a pointer
- Move the `ckp` scenario from `15.1` to the end of `15.1.2`; make its comment stand alone; update the `15.1.2` header; leave a pointer
- Move sections A, E, F, H of `41.2.4` into new `41.2.4.1-ddl-rollback-states-unique-index.sqllogic`; header pointer both ways
- Drop the `index r_p_u` member from `50.4` section 12; add `50.4.1-declare-schema-apply-restore-index.sqllogic` carrying a self-contained copy of the "index added while the view is gone" case; update any doc citation
- Run the grep'd logic tests, then `yarn test`
