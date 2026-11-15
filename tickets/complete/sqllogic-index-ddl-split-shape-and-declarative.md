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

# Complete: index-using parts of `15.1.4`, `15.1.5` and `50-declarative-schema` split into capability-declaring siblings

## What landed

Applies the rule in `test/README.md` § `-- requires-capability:` directive: a `.sqllogic` file that runs `create index` / `drop index` or declares an `index` member in a non-logical `declare schema` must declare `-- requires-capability: standalone-index-ddl`, and since the directive covers the whole file, a file whose index use is incidental gets split.

- `15.1.4` → `15.1.4.1-datetime-comparison-normalization-index`: every statement against the secondary-index table `di` moved to the sibling. The parent keeps the scan (`dn`) and primary-key (`dp`) shapes. Section numbers match.
- `15.1.5` → `15.1.5.1-date-time-timestamp-comparison-normalization-index`: same for `di`, `ti`, `mi` and `bi`. § 4 has no index shape and stays whole in the parent.
- `50-declarative-schema` → `50.0.2-declare-schema-indexes`: step 38 declares `products_with_indexes` with no index members, so steps 39 and 55 lost their index DDL entries. Steps 45–48 and the `decl_uniq` "declarative `unique index`" section moved to the sibling. `50.0.2` § 1 rebuilds the index lifecycle against a fresh database and adds a final converged `diff → []` that old step 48 never asserted.

## Review findings

Read the `ticket(implement): sqllogic-index-ddl-split-shape-and-declarative` diff before the handoff.

- **Completeness of the split (checked, clean).** Grepped the three parents for `create index`, `create unique index`, `drop index`, declared `index` members, and the `di`/`ti`/`mi`/`bi` table names. The only hits are header prose and the `50-declarative-schema` regression comment at ~line 1145 about a *phantom* `DROP INDEX` that the diff must not emit (a table-level UNIQUE constraint, not index DDL). Nothing that needs the capability is left in the parents. `decl_uniq` has no references left in `50-declarative-schema`, so moving it broke no later steps.
- **Coverage lost on non-index backends (found, fixed).** Two assertions had only ever run on the index shape, so after the split a backend without standalone index DDL lost them completely. (1) 15.1.4's "Other spellings of the same instant" (`t = '2020-01-01'` and `t = '2020-01-01T00:00:00.000'`) ran only on `di`. I added `dn` and `dp` versions to the parent. (2) 15.1.5's whitespace-only blank (`m <> '   '`) ran only on `mi`; the scan and primary-key shapes only tested `''`. I added `mn` and `mp` versions of it to the parent. All of them pass under the memory and store modules.
- **Header hygiene (found, fixed).** 15.1.4.1's "THE RULE" line was one long line among wrapped comment lines. I rewrapped it to match the parent.
- **Sequencing in `50-declarative-schema` (checked, clean).** Steps 40–44 still run against `products_with_indexes`, and step 55's `DROP TABLE IF EXISTS products_with_indexes` still applies. Old step 48's `diff schema main;` had no expectation and ran inside the next block; dropping it changes no assertion.
- **Capability-subject list in `logic-capabilities.spec.ts` (considered, left).** The three new siblings are not in its hand-written list. `tickets/implement/sqllogic-capability-usage-guard` (which lists this ticket as a prereq) replaces that list with a check derived from the parser, which will cover them. Pinning them now would only add churn to a list that is about to be deleted.
- **Docs (checked).** `test/README.md` describes the directive in general terms and names no individual files, so it needs no change. `docs/sqlite-test-crosscheck.md` lists `50-declarative-schema` under declarative schema but already omits the other `50.x` siblings. Adding only `50.0.2` there would make that list inconsistent, so I left it alone. Cross-references from `98-temporal-edge-cases` and `15.1.3` still point at the parents, which still state the rule and now name their siblings.
- **Tests as code under review.** The moved scenarios are the tests. I cut none, because each moved assertion pins a separate input or shape. The only new assertions are the coverage restorations above.
- **Tripwires / filed tickets:** none. None of the findings were conditional, and none met the bar for a ticket.

## Validation

- `node packages/quereus/test-runner.mjs --grep "15.1.4|15.1.5|50-declarative|50.0.2|capability"`: 57 passing.
- `node packages/quereus/test-runner.mjs --store --grep "15.1.4|15.1.5"`: 4 passing (LevelDB store).
- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn workspace @quereus/quereus run test`: 11155 passing, 26 pending, 0 failing. Only `.sqllogic` files changed, so I did not re-run the other workspaces.
