description: Nothing today stops a design document from quietly growing until nobody can check it against the code, and nothing catches a doc link that points at a file or section that no longer exists. Add a written convention for what belongs in a design doc, plus a script that fails the build when a doc link breaks or a doc grows past its recorded size.
files:
  - scripts/check-docs.js (new — the checker)
  - docs/.doc-budget.json (new — size ratchet data)
  - docs/doc-conventions.md (new — the written convention)
  - package.json (root — add `docs:check`, wire into `check`)
  - docs/architecture.md (link to the conventions doc)
  - docs/sql.md, docs/view-updateability.md (two dead anchors to repair)
difficulty: medium
----

## Why this exists

Two design docs (`docs/optimizer.md`, `docs/materialized-views.md`) grew to 38,000
and 28,500 words respectively. At that size nobody re-reads them against the code,
so they drift. Splitting them is the follow-on work (tickets
`docs-optimizer-extract-fd`, `docs-optimizer-split-satellites`, `docs-mv-split`).
This ticket lands the two things that must exist **before** that split, and that
keep the split from silently undoing itself afterwards:

1. **A checker.** Splitting a doc moves ~60 cross-document anchor links and
   invalidates some of the 59 `docs/*.md` references sitting in source comments.
   Doing that by hand without a verifier is how you get the drift class that
   ticket `docs-fix-verified-drift` had to clean up (a doc telling a developer to
   edit `planner/framework/registry.ts` when rules are registered in
   `planner/optimizer.ts`). The checker is the acceptance gate every later ticket
   in this chain runs.

2. **A convention.** Without a written rule about what belongs in a normative doc
   and a mechanical size ceiling, the docs re-grow. The ceiling is a **ratchet**:
   each doc's current size is recorded, a doc may shrink but never grow past its
   record, and any doc without a record must come in under a global cap.

No documents are split or rewritten in this ticket. It must land green with the
docs exactly as they are today (modulo the two dead-anchor repairs below).

## The three vocabularies

`docs/doc-conventions.md` names three kinds of content that today sit shuffled
together in every topic doc. Every later ticket in this chain sorts prose into
exactly one of these buckets.

- **Normative invariant** — a statement the *code* must satisfy, whose violation is
  a bug rather than a missed optimization. "Every registered optimizer rule
  declares `sideEffectMode`, and the registry throws on one that does not."
  Checkable against the implementation by reading one file.
- **Rationale** — why the design is shaped the way it is, including *why not* the
  alternatives. "There is exactly one materialized-view maintenance model because
  a lagging model would be a semantic switch the user has to reason about." Not
  checkable against code; still load-bearing, because it stops the next person
  re-litigating a settled call.
- **Narrative history** — how the code got here. "Phase 2 (ticket
  `fd-determination-reader-side-rule`) removed every producer-side drop gate."
  Reads as current truth to someone who does not know it is a changelog entry.

## Decisions already made (do not re-open)

- **Narrative history is deleted from docs, not archived to a new folder.** The
  project already keeps two archives: `git log` and `tickets/complete/` (300+
  files, each a full account of one change). A third copy under `docs/archive/`
  would be a third thing to keep true. The convention doc states this explicitly
  so a future author does not "helpfully" create the archive folder.
- **The one exception is a rejected alternative.** When a passage says "we now do
  X; we used to do Y" *and* gives a reason Y was wrong, that reason is rationale,
  not history — nobody will ever recover it by grepping deleted text. Condense it
  to a single bullet under a `### Rejected alternatives` heading in the topic doc
  and delete the rest of the passage.
- **Future/planned work leaves the docs.** A doc that describes an unimplemented
  capability is indistinguishable, to a reader, from a doc that has drifted. Such
  passages move to `docs/todo.md` or an existing `tickets/backlog/` entry; the doc
  keeps at most a one-line pointer under `## Current limitations`.
- **Normative invariants get a single repo-wide register, `docs/invariants.md`.**
  Not a slim section at the top of each topic doc (nothing stops it being
  re-buried as the doc grows, and it does not shrink the doc), and not folded into
  `architecture.md` (whose "Key Design Decisions" bullets are already
  1,200-word paragraphs — it would become the next mega-doc). One file, read
  end-to-end against the code in one sitting, is the whole point. It is created by
  ticket `docs-invariants-optimizer`; this ticket only teaches the checker its
  format so that later ticket lands green.
- **The checker validates pointers, not semantics.** It asserts that every
  invariant still names a file that exists and a symbol that still appears in it.
  It does not attempt to verify the invariant holds. Pointer rot is the drift class
  that actually happens; semantic verification is what tests are for.

## `scripts/check-docs.js`

Plain Node ESM, no build step, no dependencies beyond `node:fs` / `node:path`.
Sibling of the existing `scripts/gh-release.js` and `scripts/publish-package.js`.
Exits non-zero on any failure, printing every failure (not just the first) as
`path:line: <message>`.

Wire as root `"docs:check": "node scripts/check-docs.js"`, and prepend to the
existing aggregate: `"check": "yarn docs:check && yarn lint && yarn build && yarn test:full && yarn test:fork-strict"`.
It goes first because it is the cheapest gate in the chain.

### Check A — link integrity

Corpus:

| Scanned | What is extracted |
| --- | --- |
| `docs/**/*.md` | markdown links `](target.md)` / `](target.md#anchor)` / `](#anchor)`, outside fenced code blocks |
| `packages/*/README.md` and `packages/*/src/**/README.md` | same |
| `packages/*/src/**/*.ts`, `packages/*/test/**/*.ts` | bare `docs/<name>.md` and `docs/<name>.md#<anchor>` strings in comments |

For each extracted reference: the target file must exist (resolved relative to the
referring file's directory for markdown links; relative to the repo root for the
bare `docs/…` form in source). When an `#anchor` is present, it must match a
heading in the target, slugified GitHub-style: lowercase; strip backticks,
asterisks, and underscores; drop every character that is not `[a-z0-9 -]`; replace
spaces with hyphens; append `-1`, `-2`, … for repeat slugs within one file.

Two references are **already dead** and this ticket repairs them (they are the
proof the check earns its keep):

- `docs/architecture.md:142` → `sql.md#conflict-resolution-or-clause`
- `docs/view-updateability.md:971` → `sql.md#conflict-resolution-or-clause`

`docs/sql.md` has no such heading; its nearest is `#### UPSERT (ON CONFLICT
clause)`, which is a different feature. Locate the passage in `sql.md` that
documents the statement-level `insert or <action>` clause, give it a heading whose
slug is `conflict-resolution-or-clause` (or repoint both links at whatever heading
actually covers it), and confirm the checker goes green.

### Check B — invariant-block format

Applies only to `docs/invariants.md`. That file does not exist yet, so the check
must be a no-op — and green — when it is absent. Land the check now so the later
invariant tickets have a gate.

Format (this is the spec the later tickets write against):

```md
### OPT-014 — Every registered optimizer rule declares `sideEffectMode`

- code: `packages/quereus/src/planner/framework/registry.ts` — `validateSideEffectMode`
- code: `packages/quereus/src/planner/framework/pass.ts` — `addRuleToPass`
- guard: `packages/quereus/src/planner/framework/registry.ts` — `quereusError` (registration throws)
- doc: [Optimizer § Audit discipline](optimizer.md#audit-discipline-sideeffectmode)

A rule handle reaching `addRuleToPass` without `sideEffectMode: 'safe' | 'aware'`
is rejected at registration time. `'aware'` rules — those that move, duplicate,
drop, or merge subtrees — must consult `subtreeHasSideEffects` and refuse or
weaken when a participating subtree carries a write.
```

The checker asserts:

- Heading matches `^### (OPT|MV|RT|SCH|SYNC|LENS)-\d{3} — .+$`. IDs unique across
  the file; ascending within an area (gaps allowed — a retired invariant's number
  is never reused).
- At least one `code:` line. Each `code:` / `guard:` / `doc:` line names a path
  that exists. When a line carries a ` — \`symbol\`` suffix, that symbol must
  appear as a literal substring somewhere in the named file.
- Exactly one `guard:` line. `guard: none — <reason>` is legal and explicit; a
  bare `guard: none` is not (the reason is the point).
- Body ≤ 120 words. An invariant you cannot state in 120 words is two invariants,
  or is rationale wearing an invariant's clothes.

### Check C — size ratchet

`docs/.doc-budget.json`:

```json
{
  "maxWords": 12000,
  "note": "Ratchet entries record a doc's size at the time it was grandfathered in. A doc may shrink; it may never grow past its recorded size. New docs must come in under maxWords. Lower an entry with --update-ratchet after a doc shrinks.",
  "ratchet": {
    "docs/optimizer.md": 37998,
    "docs/materialized-views.md": 28575,
    "docs/sql.md": 28654,
    "docs/view-updateability.md": 28017,
    "docs/lens.md": 17932
  }
}
```

Word count = whitespace-separated tokens over the whole file, fenced code blocks
included. (Counting prose-only is more principled and less predictable; a doc
whose bulk is code samples is just as unreviewable. Consistency beats precision
here — the number only has to be comparable to itself over time.)

Rule: a doc listed in `ratchet` must be `≤` its recorded value. A doc not listed
must be `≤ maxWords`. Seed the ratchet by measuring the docs as they stand —
every doc currently over 12,000 words gets an entry, and the numbers above are the
measured values as of this ticket's writing; **re-measure rather than trusting
them**, since `docs-fix-verified-drift` and neighbours may have moved them.

`node scripts/check-docs.js --update-ratchet` rewrites the entries to current
measurements but **only downward**; it refuses to raise one without `--force`, and
prints what it changed. `12000` is chosen so that the seven-to-eight satellite docs
this chain produces all land comfortably under it, and so that a doc at the cap is
still readable end-to-end in one sitting (~75 minutes at careful-reading pace).

## `docs/doc-conventions.md`

Short — under 1,200 words. Sections:

- The three vocabularies above, each with one real example lifted from a current
  doc.
- Where each goes: invariants → `docs/invariants.md`; rationale → the topic doc
  (including `### Rejected alternatives`); history → nowhere (git +
  `tickets/complete/`); future work → `docs/todo.md` or a backlog ticket.
- The size ratchet and how to lower an entry.
- The invariant-block format, by reference to a live entry rather than a restated
  grammar (one source of truth).
- A note that `docs/review.html` and `docs/review.md` are frozen review artifacts:
  they describe a past state on purpose, are exempt from every check, and must not
  be "corrected."

Link it from `docs/architecture.md` — one line in the `## Docs` area or beside the
existing optimizer-conventions link. Do not restate its content there.

## Edge cases & interactions

- **Duplicate headings within a file.** GitHub's slugger appends `-1`, `-2`. Both
  mega-docs have repeated `### Overview` / `### Registration` headings. Get this
  right or the checker will report false breakage the moment a doc is split.
- **Unicode in headings.** `optimizer.md` has `## Row‑specific vs Global
  Classification for Assertions` with a U+2011 non-breaking hyphen, and several
  headings contain `→`, `≡`, `∅`, backticks, parentheses, and `&`. The slugifier
  must handle these without throwing; `materialized-views.md` heading
  `### Rename propagation ("MV ≡ faster view")` currently resolves as
  `rename-propagation-mv--faster-view` (double hyphen) and two live links depend
  on that exact form. Pin it with a unit assertion.
- **Anchors inside fenced code blocks.** Several docs show example markdown. Strip
  fences before extracting links from `.md`, or the checker reports phantom links.
- **Same-page anchors** (`](#some-heading)`) must be validated against the
  containing file, not skipped.
- **Non-`.md` link targets** — `../packages/quereus/README.md` (valid, check it),
  `docs/images/*.svg` (exists-check only), `http(s)://` and `mailto:` (skip).
- **Windows path separators.** The repo is developed on win32. Normalize to `/`
  before comparing or the ratchet keys never match.
- **Source-comment references that are examples, not links.** `registry.ts`
  contains the string `See docs/optimizer.md § Audit discipline` — a file
  reference with a *prose* section marker, not an anchor. Extract the file part,
  ignore the ` § …` tail. Do not try to resolve prose section names.
- **`packages/quereus/src/planner/framework/README.md`** is a nested source-tree
  README containing doc links. It is in the corpus; confirm it passes.
- **`--update-ratchet` on a growing doc.** Must refuse and exit non-zero, naming
  the doc and the delta. A ratchet you can silently raise is not a ratchet.
- **Empty / absent `docs/invariants.md`.** Green. A zero-invariant register is the
  starting state, not a failure.
- **Interaction with `docs-stability-tiers`** (separate plan ticket): it will add a
  tier label to each topic doc's header. Adding a header line grows a doc's word
  count by ~15 words. The ratchet must not make that ticket impossible — mention
  in `doc-conventions.md` that lowering a ratchet entry after a shrink is expected
  routine, and that a small justified raise via `--force` needs a line in the
  commit message saying why.

## TODO

### Phase 1 — checker

- Write `scripts/check-docs.js`: corpus walk, fence-aware link extraction,
  GitHub-compatible slugifier (with `-1` disambiguation), source-comment `docs/*.md`
  extraction, invariant-block parser, ratchet comparison, `--update-ratchet` /
  `--force` flags.
- Report every failure with `path:line: message`; exit 1 if any.
- Add root `docs:check` script; prepend to root `check`.

### Phase 2 — seed + repair

- Measure every `docs/*.md`; write `docs/.doc-budget.json` with `maxWords: 12000`
  and a ratchet entry for each doc currently above it.
- Repair the two dead `sql.md#conflict-resolution-or-clause` links (see Check A).
- Run `yarn docs:check`. It must be green with no other doc edits. If it reports
  further dead links, fix them here — they are the same drift class, and leaving
  them means the later tickets cannot tell their own breakage from pre-existing
  breakage.

### Phase 3 — convention

- Write `docs/doc-conventions.md` (< 1,200 words) per the outline above.
- Link it once from `docs/architecture.md`.

### Phase 4 — verify

- `yarn docs:check` green.
- `yarn lint` green (the script is plain JS outside any package's lint scope;
  confirm it does not trip the root `lint` fan-out).
- Hand-verify the checker actually fails: temporarily break one anchor, one
  ratchet entry, and one invariant `code:` pointer; confirm three distinct
  non-zero exits with useful messages. Revert the three.
- Do **not** run `yarn test:full` — nothing under `packages/*/src` changes.
  Say so in the review handoff rather than silently skipping it.
