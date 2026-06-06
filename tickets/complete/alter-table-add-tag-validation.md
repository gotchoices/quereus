description: Additive reserved-tag (`quereus.*`) shape/site validation wired onto the two imperative `ALTER TABLE … ADD CONSTRAINT … WITH TAGS` and `ALTER TABLE … ADD COLUMN … WITH TAGS` arms at plan-build, plus a shared `columnTagDiagnostics` / `raiseStmtTagDiagnostics` extraction reused by the direct CREATE path. Closes the last asymmetric authoring-surface gap (a typo'd / mis-sited reserved key was silently stored only via ALTER … ADD).
files:
  - packages/quereus/src/planner/building/tag-diagnostics.ts          # NEW shared helper (columnTagDiagnostics + raiseStmtTagDiagnostics)
  - packages/quereus/src/planner/building/alter-table.ts              # addConstraint/addColumn arms validate; setTags routed through shared helper
  - packages/quereus/src/planner/building/ddl.ts                      # raiseCreateTableTagDiagnostics reuses columnTagDiagnostics; local raiseStmtTagDiagnostics moved to shared module
  - packages/quereus/src/schema/reserved-tags.ts                      # validateReservedTags + TagSite (reused as-is)
  - packages/quereus/src/schema/reserved-tags-policy.ts               # raiseReservedTagDiagnostics (reused as-is)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic             # Phase 24: ALTER-ADD reserved-tag cases (+ adversarial: unnamed ADD CONSTRAINT, ADD CONSTRAINT FK)
  - docs/schema.md                                                    # § Reserved-tag validation — documents the ADD arms + shared helper
----

# Complete: ALTER TABLE ADD CONSTRAINT / ADD COLUMN reserved-tag validation

## What shipped

Reserved-tag shape/site validation now fires on the two imperative `ALTER … ADD`
arms, matching every other authoring surface (CREATE, `ALTER … SET TAGS`, the
declarative differ):

- `ALTER … ADD CONSTRAINT … WITH TAGS` validates the constraint's tags at
  `physical-constraint` before constructing `AddConstraintNode`.
- `ALTER … ADD COLUMN … WITH TAGS` validates the new column's tags
  (`physical-column`) plus each inline named constraint's tags
  (`physical-constraint`) before any backfill/check compilation (fail-fast).
- The per-column accumulation is shared with the direct CREATE TABLE path via the
  new `columnTagDiagnostics`; all plan-build tag surfaces raise through one sited
  helper `raiseStmtTagDiagnostics` (moved out of `ddl.ts`).
- `ALTER … SET TAGS` (the ALTER TABLE arm) was routed through the same shared
  helper, which additionally now threads `stmt.loc` into its sited error.

Pure additive validation: no behavior change for well-formed schemas — only a new
hard error at plan-build for a previously-silent typo / mis-site, plus source
location added to ALTER TABLE SET TAGS errors. No schema-hash / stored-row /
physical-layout effect.

## Review findings

I read the implement diff (083aad19) cold before the handoff, re-read every
touched source file plus the shared `reserved-tags.ts` / `reserved-tags-policy.ts`
and the parser's `tableConstraint` / ADD COLUMN paths, and ran build + lint +
full suite. Findings by category:

**Correctness — clean.** The validation is wired at the right sites and fires
before any side-effecting machinery on both arms. `columnTagDiagnostics`'s
no-`cc.name`-guard reasoning is sound (the parser lifts a trailing `WITH TAGS`
onto an inline constraint only when *named*; unnamed defers to the column, where
`cc.tags` is undefined and `validateReservedTags` is a no-op). The CREATE-path
`flatMap(columnTagDiagnostics)` passing extra `(index, array)` args is harmless
(the fn ignores them). No `any`, no eaten exceptions, no resource concerns (pure
build-time validation). The `setTags` reroute is behavior-equivalent to the old
inline call except for the (intended, strictly-better) added `loc`; the full
suite is green with no test asserting on a location-less SET TAGS error.

**Multi-error ordering change on CREATE (checked — benign).** Folding the
per-column leg into `columnTagDiagnostics` changed the CREATE accumulation order
from `table → all-col-own → table-cons → all-col-cons` to `table → per-col(own
+cons) → table-cons`. Under first-error-wins this is observable only for a single
statement carrying errors at *both* a column-own and a column-constraint site
whose relative order flipped; no test exercises that and the diagnostic array
order is not a documented contract. Confirmed behavior-neutral for every
single-error statement (the common case). No action.

**Test coverage — extended inline (minor, fixed in this pass).** The
implementer's Phase 24 is a solid floor (typo + mis-site rejection on both arms,
valid round-trips, free-form over-rejection guards). I added two flagged-but-
omitted adversarial cases to `50-metadata-tags.sqllogic`: (1) an **unnamed** `ADD
CHECK … WITH TAGS` with a bad tag — proves named-ness does not gate ADD
CONSTRAINT validation and that the tag check precedes constraint machinery; (2)
`ADD CONSTRAINT … FOREIGN KEY … WITH TAGS` with a bad tag — proves the leg covers
every constraint kind, not just check/unique. I verified both are genuinely
exercised (temporarily broke the FK assertion → confirmed failure with the actual
"Unknown reserved tag 'quereus.bogus' on a physical constraint" error → reverted
→ green). I did **not** add a "two bad tags in one ADD COLUMN" ordering case: a
single trailing `WITH TAGS` on an ADD COLUMN lands on *either* the column or its
named constraint, not both, so that ordering scenario is not cleanly expressible
through the parser.

**Docs — verified.** `docs/schema.md` § Reserved-tag validation accurately
describes the two ADD arms and the shared helper. One minor imprecision (not
worth a change): the new paragraph's "all build-path surfaces … raise through one
sited helper" enumerates the ALTER TABLE family; the sibling `ALTER VIEW /
MATERIALIZED VIEW / INDEX … SET TAGS` builder (`set-object-tags.ts`) still calls
`raiseReservedTagDiagnostics` inline without `loc`. That path is a different
statement family, pre-existing, and outside this ticket's scope; the doc's
adjacent paragraph already covers it separately.

**Major finding → new ticket filed.** The implementer flagged (honestly) that an
ADD COLUMN inline **named** constraint does not round-trip via
`unique_constraint_info` on the memory module. Investigating, I confirmed a real
pre-existing bug **orthogonal to this validation change**: `ALTER TABLE … ADD
COLUMN <col> … UNIQUE` **silently drops** the inline UNIQUE — it is neither
materialized, enforced, nor rejected (reproduced: two rows with the same value
insert cleanly, `unique_constraint_info` is empty). Root cause: the runtime ADD
COLUMN path (`runtime/emit/alter-table.ts:286`) extracts only CHECK + FK, not
UNIQUE; the adjacent comment claiming "the existing rejection path in the manager
handles it" is stale (that path is the CREATE-time schema builder, unreachable
from imperative ADD COLUMN). Filed as
`tickets/fix/alter-add-column-inline-unique-silently-dropped.md` with the
reproduction, root cause, and the materialize-vs-reject design question. The
tag-validation deliverable is correct regardless — Phase 24 asserts the inline-
named case is *accepted* (no over-rejection) and covers the constraint-tag
round-trip via the table-level `ADD CONSTRAINT … UNIQUE` case.

## Validation status

- `yarn workspace @quereus/quereus build` — clean (exit 0).
- `eslint` (`yarn lint`, all src + test) — clean (exit 0).
- `node test-runner.mjs` (memory vtab, full suite) — **4904 passing, 9 pending**,
  exit 0, including the extended Phase 24. Targeted re-run of
  `50-metadata-tags.sqllogic` alone also green.
- `test:store` not run — by construction this is a plan-build-time check before
  any module write, so the store path is unaffected; the only newly-discovered
  store-relevant concern (inline UNIQUE drop) is carried in its own fix ticket,
  which calls out store-mode coverage explicitly.

## Risk

Low. Additive plan-build validation; the only new observable behavior is a hard
error for a previously-silent typo / mis-site on the two ALTER … ADD arms, plus
source location added to ALTER TABLE SET TAGS sited errors.
