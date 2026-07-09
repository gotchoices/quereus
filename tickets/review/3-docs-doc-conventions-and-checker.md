description: A new script now fails the build when a documentation link points at a file or heading that no longer exists, or when a design document grows past its recorded size. A companion document spells out what belongs in a design doc in the first place.
files:
  - scripts/check-docs.mjs (new — the checker; note `.mjs`, not `.js`)
  - docs/.doc-budget.json (new — size ratchet data, 8 entries)
  - docs/doc-conventions.md (new — 909 words)
  - package.json (root — `docs:check` added, prepended to `check`)
  - docs/architecture.md (one link added, intro paragraph)
  - docs/sql.md, docs/materialized-views.md, docs/migration.md, docs/runtime.md, docs/sync.md (dead links repaired)
  - packages/sync-coordinator/test/service.spec.ts, packages/sync-coordinator/test/websocket.spec.ts (dead doc pointer removed from a comment)
difficulty: medium
----

## What landed

`yarn docs:check` runs three checks and exits non-zero on any failure, printing every
failure as `path:line: message` (not just the first):

- **Check A — link integrity.** Markdown links in `docs/**/*.md` and in package READMEs,
  plus bare `docs/<name>.md` references in `packages/*/src/**/*.ts`, `packages/*/test/**/*.ts`,
  and package READMEs. Target file must exist; an `#anchor` must match a heading, slugified
  the way GitHub does it.
- **Check B — invariant-block format.** Applies to `docs/invariants.md`. That file does not
  exist yet, so the check is a no-op and green today. It is landed now so the later
  invariant tickets have a gate on day one.
- **Check C — size ratchet.** `docs/.doc-budget.json` records each large doc's word count.
  A doc may shrink, never grow past its record. An unlisted doc must be under `maxWords`
  (12,000). `--update-ratchet` lowers entries only; it refuses to raise or add one without
  `--force`.

`docs/doc-conventions.md` names the three kinds of content (normative invariant, rationale,
narrative history), says where each goes, and states that history is deleted rather than
archived. Every example in it is quoted from a doc that exists in the tree today.

## How to validate

```bash
yarn docs:check                              # green
node scripts/check-docs.mjs --update-ratchet # "Ratchet already matches"; only ever lowers
yarn lint                                    # green (script is outside every package's lint scope)
```

To see it actually fail, break one thing at a time and re-run `yarn docs:check`:

| Break | Expected message |
| --- | --- |
| Add `[x](sql.md#no-such-heading)` to any doc | `dead anchor '#no-such-heading' in 'sql.md'` |
| Set `docs/optimizer.md` to `100` in `.doc-budget.json` | `exceeds its ratchet of 100 (+37897)` |
| Then run `--update-ratchet` | `Refusing to raise the ratchet` + exit 1 |
| Create `docs/invariants.md` with a `code:` path that does not exist | `names a file that does not exist` |
| ...with `guard: none` and no reason | `bare 'guard: none' — state the reason` |
| ...with a 130-word body | `body is 130 words (max 120)` |
| Delete `docs/invariants.md` | green again |

I ran all of the above through a throwaway harness (backup → mutate → assert → restore).
**14 of 14 behaved as specified**, and the tree restored clean. The harness is deleted; it is
not in the diff. The reviewer should re-do at least the first three by hand — a gate nobody
has watched fail is not a gate.

A **well-formed** `docs/invariants.md` also passes: I verified the exact `OPT-014` block from
the source ticket (real symbols `validateSideEffectMode`, `addRuleToPass`, `quereusError`, and
the real anchor `optimizer.md#audit-discipline-sideeffectmode`) exits 0. The later invariant
tickets can land green against this checker as written.

## Deviations from the ticket — please review these specifically

1. **`scripts/check-docs.mjs`, not `.js`.** The ticket asked for "plain Node ESM" at
   `scripts/check-docs.js`. Root `package.json` has no `"type": "module"`, so a `.js` file
   there is CommonJS — the three sibling scripts (`gh-release.js` and friends) all use
   `require`. `.mjs` is the only way to get ESM without changing the package type. The
   `docs:check` script points at `.mjs`.

2. **The slugifier keeps underscores and Unicode letters.** The ticket specified "strip
   backticks, asterisks, and underscores; drop every character that is not `[a-z0-9 -]`".
   Taken literally that breaks a link that exists today: `docs/view-updateability.md:151`
   points at `#selection-σ`, and the heading `### Selection (σ)` really does anchor as
   `selection-σ` on GitHub, which keeps letters in any script. GitHub also keeps `_`. I
   implemented what GitHub actually does (`[^\p{L}\p{N} _-]` is dropped), which is what the
   ticket's own phrase "slugified GitHub-style" asks for. This matters downstream: the split
   tickets will copy anchors out of GitHub's rendered table of contents, and a slugifier that
   disagreed with GitHub would report false breakage on correct links. `selfTest()` pins ten
   real headings, including the `rename-propagation-mv--faster-view` double hyphen the ticket
   called out.

3. **Bare `docs/*.md` refs are extracted from package READMEs too**, not only `.ts` files.
   The ticket said to confirm `planner/framework/README.md` passes; that file contains **no**
   markdown links, only a bare `see docs/optimizer.md § Audit discipline`. Under the ticket's
   literal corpus table nothing in it would have been checked. Bare refs are deliberately
   **not** extracted from `docs/**/*.md`, because design-doc prose legitimately names sibling
   docs — including planned ones such as `docs/invariants.md`.

## The bug that mattered

The working tree is CRLF. JavaScript's `.` does not match `\r` (it is a line terminator), so
`(.*)$` silently matches **no line** of a CRLF file. First run reported 64 failures: fences
never opened, headings never parsed, so every anchor in the repo looked dead. Fixed with a
single CRLF-normalizing `readText()` that every read goes through; there is a `NOTE:` on it.
Anyone extending this script must not reintroduce a raw `readFileSync`.

## Repairs beyond the two the ticket named

The ticket named two dead `sql.md#conflict-resolution-or-clause` links. Both are fixed by
promoting the bold run-in `**Conflict Resolution (OR clause):**` in `docs/sql.md` to a real
`#### Conflict Resolution (OR clause)` heading, whose slug is exactly that anchor.

The checker then found **seven more**, all genuinely dead, all fixed here (leaving them would
mean the later split tickets could not tell their own breakage from pre-existing breakage):

- `materialized-views.md:123` → store README anchor was truncated to `#atomic-multi-store-commit`;
  the heading is `#atomic-multi-store-commit-module-wide-cross-table`.
- `migration.md:17` → `#retirement-the-contract-phase` does not exist; repointed to
  `#4-contract--retire-the-old-table` (the form `lens.md` already links correctly).
- `runtime.md:1437` → `../optimizer.md` escaped `docs/`; now `optimizer.md`.
- `runtime.md:1801` → **deleted** a dangling `[Recursive CTE Execution Pattern](./recursive-cte.md)`.
  That doc has never existed in git history, and "recursive" appears nowhere else in
  `runtime.md`. It was an orphan line after a code fence. I removed it rather than invent a
  target — **flagging this as the one judgement call in the diff.**
- `sync.md:528` and `sync.md:1683` → `#future-store-isolation`; the heading is
  `### Store Isolation (Store Phase 8 - Future)`.
- `sync.md:1700` → `../../quereus-sync-client/` climbed above the repo root.
- `packages/sync-coordinator/test/{service,websocket}.spec.ts` → both comments pointed at
  `docs/database-sync.md`, which has never existed in git history and has no replacement
  (nothing in `docs/` documents the `<org_id>:<type>_<id>` format). I removed the pointer and
  kept the format description. **A reviewer may prefer to write that doc instead.**

## Ratchet: eight entries, not five

The ticket listed five docs and said to re-measure rather than trust the numbers. Correct
call — `schema.md` (15,683), `sync.md` (14,314), and `runtime.md` (13,018) are also over
12,000. All eight entries are re-measured with the checker's own `countWords`, so the file is
self-consistent by construction. `optimizer.md` measures 37,997, not the ticket's 37,998.
`sql.md` measures 28,654, matching the ticket exactly — its number was evidently taken after
the heading repair. There is a clean gap between `runtime.md` at 13,018 and the next doc down
(`module-authoring.md`, 8,553), so the 12,000 cap sits in open space and no doc is near it.

## Known gaps — treat the tests as a floor

- **Inline code spans are not blanked.** Fenced blocks are. A link written entirely inside
  backticks would be extracted and resolved as if real. No doc does this today. `NOTE:` at
  the site explains why the naive fix (blank all spans) is wrong: link *text* is frequently
  inline code and must keep resolving.
- **Duplicate-heading `-1`/`-2` suffixes are positional.** Reordering two headings that share
  a base slug silently retargets links to the suffixed one, and the checker cannot see it.
  Both mega-docs repeat `### Overview` and `### Registration`, so the split tickets are
  exactly where this could bite. `NOTE:` at the site.
- **The invariant symbol check is a substring match** over the whole file, comments included.
  A symbol surviving only in a comment passes. Deliberate — pointers, not semantics — and
  `NOTE:`d.
- Setext (`===` underline) headings are not parsed, only ATX (`#`). None exist outside the
  exempt `docs/review.md`. Reference-style links (`[a][b]`) are not resolved; none exist.
- The invariant `doc:` line validates only the first markdown link on that line.
- `--update-ratchet --force` can raise *and* add entries. The only thing stopping a silent
  raise is the commit-message discipline written into `doc-conventions.md`. That is by
  design (the `docs-stability-tiers` ticket needs an escape hatch), but it is the weakest
  point in the ratchet and worth a second opinion.
- The checker walks the tree on every run (~1s). Fine now; if it ever gets slow, cache by mtime.

## Tests

- `yarn docs:check` — green.
- `yarn lint` — green (54s). Verified the real lint actually executes:
  `yarn workspace @quereus/quereus run lint` exits 0 (it is silent on success, and the root
  fan-out prints only the other packages' `No lint configured` no-ops — worth knowing before
  you read a clean log as a skipped one).
- `yarn workspace @quereus/sync-coordinator run test` — **128 passing**. Ran because this
  ticket edits two of its `.spec.ts` files; both edits are comment-only (`git diff` confirms).
- `Documentation Validation` suite in `packages/quereus` — **6 passing**, via
  `node test-runner.mjs --grep "Documentation Validation"`. That pre-existing spec checks
  `packages/quereus/README.md` link *existence* only; the new checker is a strict superset of
  it (it also validates anchors). They do not conflict, and the reviewer may want to decide
  whether that spec's link test should now simply defer to `docs:check`.
- **`yarn test:full` deliberately not run.** Nothing under `packages/*/src` changed — the only
  non-doc edits are two comment lines in `sync-coordinator` tests, whose suite I ran in full.

No pre-existing test failures were observed, so `tickets/.pre-existing-error.md` was not written.
