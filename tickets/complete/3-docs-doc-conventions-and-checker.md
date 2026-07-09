description: A script now fails the build when a documentation link points at a file or heading that no longer exists, or when a design document grows past its recorded size. A companion document spells out what belongs in a design doc in the first place.
files:
  - scripts/check-docs.mjs (new — the checker)
  - docs/.doc-budget.json (new — size ratchet, 8 entries)
  - docs/doc-conventions.md (new)
  - package.json (root — `docs:check`, prepended to `check`)
  - README.md, docs/architecture.md (links to the new conventions doc)
  - docs/sql.md, docs/materialized-views.md, docs/migration.md, docs/runtime.md, docs/sync.md (dead links repaired)
  - packages/sync-coordinator/test/service.spec.ts, packages/sync-coordinator/test/websocket.spec.ts (dead doc pointer removed from a comment)
----

## What shipped

`yarn docs:check` (`node scripts/check-docs.mjs`) runs three checks and exits non-zero on any
failure, printing every failure as `path:line: message`:

- **Check A — link integrity.** Markdown links in `docs/**/*.md`, the repo `README.md`, and
  every package README; plus bare `docs/<name>.md` references in package READMEs and in
  `packages/*/{src,test}/**/*.ts`. The target file must exist, and an `#anchor` must match a
  heading slugified the way GitHub does it.
- **Check B — invariant-block format.** Applies to `docs/invariants.md`, which does not exist
  yet, so the check is a green no-op today. It is landed now so the later invariant tickets
  have a gate on day one.
- **Check C — size ratchet.** `docs/.doc-budget.json` records each large doc's word count. A
  doc may shrink, never grow past its record. An unlisted doc must be under `maxWords`
  (12,000). `--update-ratchet` only lowers; raising or adding needs `--force`.

`docs/doc-conventions.md` names the three kinds of content a design doc can hold (normative
invariant, rationale, narrative history), says where each belongs, and states that history is
deleted rather than archived.

## Review findings

### Checked

I read the implement diff (`dd8b5ad4`) in full before the handoff summary, then re-derived its
claims rather than trusting them.

**The gate actually fails.** The handoff's own advice — "a gate nobody has watched fail is not
a gate" — is right, and its verification harness was deleted, so I rebuilt the failure cases by
hand (backup, mutate, run, restore; the tree ended clean each time). A dead anchor appended to
`docs/architecture.md`, an `optimizer.md` ratchet entry lowered to 100, and `--update-ratchet`
against that lowered entry all produced exactly the documented messages and exit 1;
`--update-ratchet --force` raised it as documented.

**Check B has never run against a real file, so I gave it one.** With a throwaway
`docs/invariants.md`, a well-formed `OPT-014` block exits 0, and each of these fails with the
intended message: a `code:` path that does not exist, a `code:` symbol that no longer appears in
the file, a dead `doc:` anchor, a bare `guard: none`, zero `guard:` lines, two `guard:` lines, a
missing `code:` line, a heading that is not `### <AREA>-<NNN> — <title>`, a duplicate invariant
id, a descending id within an area, and a 130-word body. `guard: none — <reason>` passes. The
later invariant tickets can be written against this checker as it stands.

**The slugifier matches the corpus.** No doc uses a closing-ATX heading (`## Foo ##`), a setext
underline heading, a fence indented four or more spaces, a reference-style link, or a
parenthesis inside an anchor — the four shapes this slugifier and fence-stripper would get
wrong. The `selfTest()` cases are real headings from real docs.

**The ratchet numbers are right.** I recomputed all eight entries independently of the checker;
every one matches to the word. No unratcheted doc exceeds 12,000 — the next largest is
`module-authoring.md` at 8,553 — so the cap sits in open space, as the handoff claimed.

**The two deletions the implementer flagged as judgement calls are correct.**
`docs/recursive-cte.md` and `docs/database-sync.md` have never existed on any ref
(`git log --all --diff-filter=A` returns nothing for either), so both pointers were dead on
arrival. Recursive CTEs are documented in `sql.md` and `usage.md`, so `runtime.md` lost nothing.
The `<org_id>:<type>_<id>` database-id format has no validator anywhere in
`packages/sync-coordinator/src` and no mention in `docs/sync-coordinator.md` — it is a
test-fixture convention, not a wire contract. Removing the pointer and keeping the format
description in the comment is the right call; no replacement doc is owed.

**The three deviations from the source ticket are all sound.** Root `package.json` has no
`"type"` field and the sibling scripts use `require`, so `.mjs` is the only way to get ESM.
`docs/view-updateability.md:151` really does link `#selection-σ`, which the ticket's literal
`[a-z0-9 -]` rule would have broken — implementing what GitHub actually does was necessary, not
a liberty. And extracting bare refs from package READMEs is what makes
`planner/framework/README.md` (which contains no markdown links at all) covered.

**Tests.** `yarn lint` green (57s). `yarn workspace @quereus/sync-coordinator run test` — 128
passing. `Documentation Validation` in `packages/quereus` — 6 passing. `yarn docs:check` green.
No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
`scripts/` is outside every package's lint scope, so the checker itself has no eslint coverage —
acceptable for a build script, but worth knowing.

### Found and fixed in this pass (minor)

**One breakage was reported twice.** A README link written as `[text](docs/foo.md)` matches both
the markdown-link extractor and the bare-`docs/*.md` extractor, and a `doc:` line in the
invariant register is a markdown link that Check A has already resolved before Check B resolves
it again. I reproduced both (a bad link in `README.md` printed two identical lines; a dead
`doc:` anchor printed two). `fail()` now suppresses an exact-duplicate message — the message
carries its own `path:line`, so identical strings are the same defect.

**The repo `README.md` was not being checked at all.** It carries the documentation index and is
the most link-dense file in the tree, and nothing validated it; `packages/quereus/test/README.md`
was likewise outside the corpus (only `src/**` READMEs were walked). Both are now included. Both
pass as they stand, so this cost nothing and closes the gap that matters most to a newcomer.

**The two reference extractors disagreed about fenced code.** Markdown links inside a fence were
ignored, but a bare `docs/foo.md` inside the same fence was resolved as if it were a real
pointer — so a shell example in a README could fail the build for naming a doc that does not
exist. Fences are now stripped for markdown inputs and left alone for TypeScript (which has
none). I confirmed no README currently has a fenced `docs/*.md` ref, so no coverage was lost.

**`docs/doc-conventions.md` was reachable only from `architecture.md`.** Added to the root
README's documentation index.

### Filed as new tickets (major)

None. Nothing in the diff is wrong in a way that survives this pass, and nothing it left undone
is large enough to need its own ticket. The known gaps the implementer listed are all either
conditional (below) or accurate statements of deliberate scope.

### Recorded as tripwires, not tickets

Each of these is fine today and only becomes work if a stated condition trips. All are `NOTE:`
comments at the exact site in `scripts/check-docs.mjs`.

- `parseInvariantBlocks` — a `## <Area>` group heading in the invariant register is absorbed
  into the preceding block's body, spending ~3 words of its 120-word budget. Negligible now; if
  section prose ever appears between blocks, end a block at the next heading of any level.
- `checkRatchet` — a ratchet entry naming a deleted doc is inert and goes unreported.
  `--update-ratchet` removes it. Only matters if a stale entry ever masks a re-added doc's size.
- `walk` — the tree is re-walked and every file re-read on each run (~1s). If it ever shows up
  as slow, cache by mtime rather than trimming the corpus.
- Pre-existing, verified accurate: inline code spans are not blanked; duplicate-heading `-1`
  suffixes are positional; the invariant symbol check is a substring match. Each has a `NOTE:`
  explaining why the naive fix is wrong.

### Noted, no action taken

- **The gate is not wired to CI.** `.github/workflows` does not exist, so `docs:check` runs only
  when someone runs `yarn check`. This repo has no CI at all, so it is not a regression and not
  this ticket's job — but "fails the build" means "fails `yarn check`", not "fails a pull
  request."
- **`--update-ratchet --force` can raise and add entries**, restrained only by the
  commit-message discipline written into `doc-conventions.md`. The implementer asked for a
  second opinion and flagged it as the ratchet's weakest point. I agree with shipping it: the
  refusal path is loud, `--force` appears in no `package.json` script, and the `docs-stability-tiers`
  work needs the escape hatch. Leave it.
- **`packages/quereus/test/documentation.spec.ts` ("README Markdown Links")** is now a strict
  subset of Check A — it validates file existence in one README, where Check A validates
  existence and anchors across every README. Harmless duplication running in a different gate.
  Folding it in is out of scope here.
