description: Three more shared SQL test files use index statements without announcing it, and in each the index use is woven through the file, so a backend without stand-alone index statements loses almost all of the file. Move the index-using parts into sibling files that announce the need, so the rest of each file runs on every backend.
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic/15.1.4-datetime-comparison-normalization.sqllogic # the `di` (secondary-index) shape moves out
  - packages/quereus/test/logic/15.1.4.1-datetime-comparison-normalization-index.sqllogic # new
  - packages/quereus/test/logic/15.1.5-date-time-timestamp-comparison-normalization.sqllogic # the `di`/`ti`/`mi`/`bi` index shapes move out
  - packages/quereus/test/logic/15.1.5.1-date-time-timestamp-comparison-normalization-index.sqllogic # new
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # steps 38–48 index members, and the "Declarative `unique index`" section
  - packages/quereus/test/logic/50.0.2-declare-schema-indexes.sqllogic # new
  - packages/quereus/test/README.md # § `-- requires-capability:` directive (format spec; read, likely no edit)
----

# Split the index-using parts out of `15.1.4`, `15.1.5` and `50-declarative-schema`

## Background

Same rule and motivation as `sqllogic-index-ddl-split-incidental-sections` (read its Background): a `.sqllogic` file that runs `create index` / `create unique index` / `drop index`, or declares an `index` / `unique index` member in a non-logical `declare schema` block, must declare `-- requires-capability: standalone-index-ddl`; when only part of a file needs it, split the file (`test/README.md` § `-- requires-capability:` directive). These three files are separated from that ticket because the index use is not one tidy section — it is interleaved with, or feeds state into, the rest of the file — so each split needs more care. The follow-on `sqllogic-capability-usage-guard` ticket depends on this one.

Measured downstream impact today (from the lamina project, which has no standalone index DDL): `15.1.4` stops at line 19 and `15.1.5` at line 24, i.e. the whole of both comparison-normalization files is lost; `50-declarative-schema` stops at the step-40 `apply schema main;` (line ~437), losing ~2,100 lines of unrelated rename, assertion and view coverage.

## Per-file decisions

### `15.1.4` and `15.1.5` — move the secondary-index shape out

Both files run each seekable predicate over three table shapes — a scan filter (`dn`), a secondary-index seek (`di`, indexed by `create index di_t` / `di_d`), and a primary-key seek (`dp`) — because each reaches the comparison by a different route. `15.1.5` repeats this per type: DATE (`dn`/`di`/`dp`), TIME (`ti` index at ~120), TIMESTAMP (`mi` index at ~188), and a later section with `bi` (~465). Lines naming an index-shape table: 17 in `15.1.4`, 57 in `15.1.5` (`grep -cw`).

Move every statement and assertion against an indexed table (and its `create table` / `create index` / inserts) into the new sibling — `15.1.4.1-datetime-comparison-normalization-index.sqllogic` and `15.1.5.1-date-time-timestamp-comparison-normalization-index.sqllogic` — keeping the section structure and headings so a reader can line up the three shapes across the two files. Each sibling's header restates the rule in one or two sentences, names the parent file, says it carries the secondary-index-seek shape, declares the capability, and keeps the "runs under memory and store, whose seeks encode keys differently" note (that is most of why the index shape exists). Update each parent header's "three shapes" paragraph to say the secondary-index shape lives in the sibling.

Assertions that only exist for the index shape (e.g. `15.1.4`'s "Other spellings of the same instant" run only against `di`) move with it. If any assertion in a parent compares or joins *across* shapes (an indexed table on one side), it moves to the sibling, which then also needs the other table's setup.

Rejected: declaring the capability on the parents wholesale — it would drop the scan and primary-key coverage of the DATE/TIME/DATETIME/TIMESTAMP-versus-text rule on any backend without index DDL, which is the bulk of the file and has nothing to do with indexes.

### `50-declarative-schema` — move the two index sections out

Two places declare index members:

- **Steps 38–48** (lines ~416–476): declare `products_with_indexes` with `index idx_products_name` and `index idx_products_category`, diff, apply, insert, re-diff, then redeclare with one index and diff/apply the `DROP INDEX`. These steps are part of the running `main` schema sequence: step 39's expected diff also carries `DROP TABLE IF EXISTS users` (left from earlier steps), and step 55's expected diff (line ~671) carries `DROP TABLE IF EXISTS products_with_indexes` and `DROP INDEX IF EXISTS idx_products_name`. So the steps cannot be lifted out wholesale without disturbing the sequence.
  - In `50`, keep steps 38–44 but **remove the two `index` members** from step 38's declaration (keep the table, so the sequence's later steps see the same table), remove the step-39 expected `create index …` entries, and **delete steps 45–48** (index removal), renumbering nothing (step numbers are comment labels; leave a one-line note where 45–48 were, pointing at `50.0.2`). Update step 55's expected diff to drop the `DROP INDEX IF EXISTS idx_products_name` entry. Those are the only expectation changes that follow from removing the indexes; if running the file shows any other diff change, stop and understand it rather than pasting the new output.
  - In the new `50.0.2-declare-schema-indexes.sqllogic`, rebuild the index lifecycle self-contained against a fresh database: declare a table with the two indexes, `diff schema main` shows create table + two create index, apply, insert, re-diff `[]`, redeclare with one index, diff shows exactly `DROP INDEX IF EXISTS idx_products_category`, apply, re-diff `[]`. Drop the "unique table name to avoid DROP TABLE bug" note unless it still applies.
- **"Declarative `unique index`"** section (lines ~943–995, its own `decl_uniq` schema): self-contained — move it verbatim into `50.0.2`.

`50.0.2` declares the capability; its header says it holds the declarative-schema index cases carved out of `50-declarative-schema` (and that `50.2.1-declare-schema-index-renames` holds index renames). `50.0.1-metadata-tags-index` is the existing neighbour, so `50.0.2` sorts right after it.

Do not touch `51-lens-foundation.sqllogic`'s `index ix` member inside `declare logical schema badidx` — its apply is expected to error ("index 'ix' is not allowed in logical schema") before anything is lowered, so it needs no capability.

## Edge cases & interactions

- **Directive position and near-miss prose** — as in the sibling ticket: directive before the first SQL line; backtick-quote the directive when header prose mentions it. Verified by `test/logic-capabilities.spec.ts`.
- **`50`'s running `main` sequence** — removing the indexes changes later diffs only where the indexes appeared (steps 39 and 55). Verified by running the file; any other changed expectation is a signal, not something to paste.
- **Implicit drops** — in step 55, dropping `products_with_indexes` currently lists `DROP INDEX IF EXISTS idx_products_name` separately; with no index declared, that entry must simply vanish, not be replaced. Verified by running the file.
- **Assertion count preserved** — every `→` / `-- error:` assertion in the old files exists exactly once across parent + sibling (except the deliberately deleted steps 45–48, whose coverage `50.0.2` reproduces). Inspection.
- **Store backend** — the index-shape seeks in `15.1.4`/`15.1.5` exist specifically because the store encodes seek keys differently. Run `yarn test:store` restricted to the two new siblings (`QUEREUS_TEST_STORE=true node packages/quereus/test-runner.mjs --grep "15.1.4|15.1.5"` or `yarn test:store --grep …`) once — they are short — to confirm the move kept the store path covered.

## Verification

No new test — the moved scenarios are the tests. From the repo root:

```
node packages/quereus/test-runner.mjs --grep "15.1.4|15.1.5|50-declarative|50.0.2|51-lens|capability"
```

then the store run above for `15.1.4|15.1.5`, then `yarn test`.

## TODO

- Split the `di` shape of `15.1.4` into new `15.1.4.1-datetime-comparison-normalization-index.sqllogic`; update both headers
- Split the `di`/`ti`/`mi`/`bi` shapes of `15.1.5` into new `15.1.5.1-date-time-timestamp-comparison-normalization-index.sqllogic`; update both headers
- In `50-declarative-schema`, remove the index members from step 38, delete steps 45–48, fix the step-39 and step-55 expected diffs; move the "Declarative `unique index`" section out
- Create `50.0.2-declare-schema-indexes.sqllogic` with the self-contained index lifecycle and the `decl_uniq` section; declare the capability
- Run the grep'd memory tests, the store run for `15.1.4|15.1.5`, then `yarn test`
