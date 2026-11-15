description: Three shared SQL test files used index statements without announcing it, with the index use woven through each file, so a backend without stand-alone index statements lost almost all of each. The index-using parts now live in sibling files that announce the need, and the rest of each file runs on every backend.
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic/15.1.4-datetime-comparison-normalization.sqllogic # `di` shape removed; header points at sibling
  - packages/quereus/test/logic/15.1.4.1-datetime-comparison-normalization-index.sqllogic # new
  - packages/quereus/test/logic/15.1.5-date-time-timestamp-comparison-normalization.sqllogic # `di`/`ti`/`mi`/`bi` shapes removed; header points at sibling
  - packages/quereus/test/logic/15.1.5.1-date-time-timestamp-comparison-normalization-index.sqllogic # new
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # step 38 index members, steps 45–48, `decl_uniq` section removed
  - packages/quereus/test/logic/50.0.2-declare-schema-indexes.sqllogic # new
----

# Review: index-using parts of `15.1.4`, `15.1.5` and `50-declarative-schema` split into capability-declaring siblings

## What changed

Rule being applied (`test/README.md` § `-- requires-capability:` directive): a `.sqllogic` file that runs `create index` / `create unique index` / `drop index`, or declares an `index` member in a non-logical `declare schema`, must declare `-- requires-capability: standalone-index-ddl`; the directive is whole-file, so a file whose index use is incidental gets split.

- **`15.1.4` → `15.1.4.1-datetime-comparison-normalization-index`.** Every statement against the secondary-index table `di` (its create table, `create index di_t`, insert, and all 17 `di` assertions, including the `di`-only "Other spellings of the same instant" pair) moved to the sibling. The parent keeps the scan (`dn`) and primary-key (`dp`) shapes and every non-seek comparison site. Sibling sections use the parent's numbers (1–3); sections 4–6 have no index shape.
- **`15.1.5` → `15.1.5.1-date-time-timestamp-comparison-normalization-index`.** Same for `di`/`di_d` (DATE), `ti`/`ti_t` (TIME), `mi`/`mi_m` (TIMESTAMP) and `bi`/`bi_t` (`date(col) = <text>`): 57 SQL lines plus their `-- params:` and expectation lines. Index-only assertions (e.g. `mi where m <> '   '`, the `mi` range-seek params block) moved with the shape. Sibling sections 1, 2, 3, 5 match the parent; § 4 has no index shape and stays whole in the parent. One parent comment changed wording: "a seek over an index or a primary key does not" → "a primary-key seek does not (15.1.5.1 pins the index seek)".
- **`50-declarative-schema` → `50.0.2-declare-schema-indexes`.**
  - Step 38 now declares `products_with_indexes` with no index members (name kept so step 55's `DROP TABLE IF EXISTS products_with_indexes` still applies). Step 39's expected diff lost its two `create index` entries; step 55's lost `DROP INDEX IF EXISTS idx_products_name`. No other expectation in the file changed when it ran.
  - Steps 45–48 deleted, with a one-line pointer to `50.0.2`. Note: old step 48's `diff schema main;` had no expectation of its own, so it ran as part of the next block (`declare schema check_not_exists …` / `-- run`); it now simply doesn't run, and `check_not_exists` is its own block.
  - The "Declarative `unique index`" section (`decl_uniq`) moved verbatim to `50.0.2` § 2, replaced by a pointer line.
  - `50.0.2` § 1 rebuilds the index lifecycle against a fresh database on a table named `products` (the old "unique table name to avoid DROP TABLE bug" note no longer applies): declare table + two indexes → diff shows create table + two create index → apply → insert/select → diff `[]` → redeclare with one index → diff is exactly `DROP INDEX IF EXISTS idx_products_category` → apply → diff `[]`. The final `diff → []` is new coverage; the old step 48 never asserted it.
- `51-lens-foundation`'s logical-schema `index ix` was left alone, as the ticket said.

## Validation done

- Group-for-group check of `15.1.4` and `15.1.5` (scratch script; it treats each params + SQL + end-marker as one group and compares them as multisets): old file = new parent + new sibling, 79 = 79 and 179 = 179, no missing or extra groups.
- `node packages/quereus/test-runner.mjs --grep "15.1.4|15.1.5|50-declarative|50.0.2|51-lens|capability"`: all pass (the 7 logic files plus the capability-directive spec).
- `node packages/quereus/test-runner.mjs --store --grep "15.1.4|15.1.5|50.0.2"`: all 5 files pass under the LevelDB store, so the index-seek shape still has store coverage.
- `yarn test` (whole workspace): green, 0 failing.

No new tests. The moved scenarios are the tests.

## For the reviewer

- `logic-capabilities.spec.ts`'s hand-written "declares standalone-index-ddl on every file whose subject is index DDL" list was **not** extended with the three new files. The follow-on `sqllogic-capability-usage-guard` ticket replaces that list with a parser-derived check, which should flag all three as users that declare the capability. Add them to the list if you would rather pin them now.
- Header prose in each sibling mentions the directive mid-line (`` the `-- requires-capability:` directive is whole-file ``). The near-miss guard only matches at line start, and the corpus test that parses every file passes.
- Cross-references from `98-temporal-edge-cases` and `15.1.3` still point at the parents `15.1.4` / `15.1.5` for "the full rule". The parents still state it, and their headers now name the sibling, so these were left as they are.
