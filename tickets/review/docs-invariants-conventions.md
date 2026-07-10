description: The repo's documentation-convention checker was failing because two entries in the invariants document broke the style rules (one had a duplicate field, two were too long); this ticket's fix splits those entries and the fix is now fully verified — ready for review.
files: docs/invariants.md, docs/doc-conventions.md, docs/optimizer.md, scripts/check-docs.mjs, packages/quereus/test/optimizer/side-effect-audit.spec.ts, packages/quereus/test/optimizer/fd-propagation.spec.ts
difficulty: easy
----

## Summary

`yarn docs:check` was failing on `docs/invariants.md`:

```
docs/invariants.md:47: invariant 'OPT-002' has 2 'guard:' lines — expected exactly one
docs/invariants.md:47: invariant 'OPT-002' body is 148 words (max 120) — ...
docs/invariants.md:343: invariant 'OPT-046' body is 155 words (max 120) — ...
```

Both entries were doing double duty — each stated two distinct claims under one ID. Fix
splits each into two invariants so each has exactly one `guard:` line and fits the word
budget.

## What changed

**`OPT-002` → `OPT-002` + `OPT-003`** (`docs/invariants.md`):
- `OPT-002` (unchanged heading/slug) keeps the core claim — an `'aware'` optimizer rule
  consults the side-effect signal before firing — with its one behavioural `guard:`
  (`side-effect-audit.spec.ts`, `"Side-effect audit: rules must refuse on impure subtrees"`).
- New `OPT-003` — a static guard checks every `'aware'` rule's source for a purity signal —
  carries the static-analysis mechanism. Its guard test was renamed from
  `"OPT-002 static guard: ..."` to `"OPT-003 static guard: ..."` in
  `packages/quereus/test/optimizer/side-effect-audit.spec.ts:341` (plus the section comment
  at line 223) so the test name matches the invariant it now documents.
- `docs/optimizer.md:615` back-links to `OPT-002` under "§ The two declarations" — heading
  text/slug for `OPT-002` didn't change, so that link still resolves. `OPT-003` has no
  back-link from `optimizer.md`; the implementer judged it's an audit-mechanism detail
  rather than a declaration-semantics fact and didn't add one. **Worth a second look** — if
  a reader would expect to jump from the "two declarations" section to the static-guard
  invariant, add one.

**`OPT-046` → `OPT-046` + `OPT-047`** (`docs/invariants.md`):
- `OPT-046` (unchanged heading/slug) keeps "‌`addFd`/`mergeFds` is the only FD accumulation
  path", with its existing static `guard:` (`fd-propagation.spec.ts:600`,
  `"OPT-046 static guard: addFd is the only FD accumulation path"` — test itself wasn't
  renamed since it didn't move to a new ID).
- New `OPT-047` — `addFd` deduplicates by subsumption and evicts by key/kind preference —
  carries the internal dedup/eviction behaviour. **No test guards this directly** — it's
  `guard: none — <reason>`, an honest gap: a wrong eviction-preference order would silently
  drop a uniqueness witness rather than error. Flagging for reviewer: decide whether this
  gap is acceptable as filed, or whether it should spin out a `debt-` ticket to add a
  regression test for eviction ordering.

No invariant IDs were reused or renumbered outside their area — `OPT-003` and `OPT-047`
both landed in existing numeric gaps, ascending correctly within their sections.

## Verification (all re-run and confirmed clean this pass)

- `node scripts/check-docs.mjs` (repo root) → `Docs OK: links resolve, invariants
  well-formed, sizes within ratchet.` Zero failures, including the two ratchet-only
  failures (`docs/schema.md`, `docs/sql.md`) noted as pre-existing/unrelated in the prior
  handoff — those were independently triaged and fixed by commit `15874567` ("tess: triage
  pre-existing test failure"), unrelated to this ticket's diff.
- `yarn test:single packages/quereus/test/optimizer/side-effect-audit.spec.ts
  packages/quereus/test/optimizer/fd-propagation.spec.ts` (from `packages/quereus`) → 63
  passing, including the renamed `OPT-003 static guard` describe block and the untouched
  `OPT-046 static guard`.
- **Full `yarn test` from repo root** → all workspaces green, no failures: quereus core
  6799 passing (up from the isolated 63 above — this is the whole suite, confirming no
  incidental breakage from the spec-file rename), plus every other package's suite
  (quoomb-web 74, quereus-sync 128, quereus-isolation, etc.) — full log tail showed no
  `failing`/`✗` anywhere.
- **`yarn lint` from `packages/quereus`** → exit 0, no output (eslint + `tsc -p
  tsconfig.test.json --noEmit` both clean). Confirms the spec-file rename didn't break
  type-checking of the test file.

## Use cases / how to re-validate

- `node scripts/check-docs.mjs` from repo root is the actual convention checker this ticket
  exists to satisfy — quick to re-run, ~1s.
- The two renamed-test guard names are the load-bearing link between doc and code:
  `docs/invariants.md`'s `guard:` line for `OPT-002` and `OPT-003` must string-match a
  `describe`/`it` title in `side-effect-audit.spec.ts` (the checker likely greps for this —
  worth confirming `scripts/check-docs.mjs` actually validates guard-line-to-test-name
  matching, not just line-count/word-count, since that's the mechanism that would catch a
  future drift).
- To sanity-check the split reads coherently on its own (not just passes the linter), read
  `docs/invariants.md:47-90` (OPT-002/003) and `docs/invariants.md:350-395` (OPT-046/047)
  side by side with the two spec files' matching `describe` blocks.

## Gaps / open questions for reviewer

1. `OPT-047`'s `guard: none` — is an untested eviction-preference order acceptable to ship
   as documented debt, or does it warrant a `debt-` backlog ticket for a regression test?
2. `OPT-003` has no back-link from `docs/optimizer.md`'s "§ The two declarations" section —
   confirm this is the right call per `docs/doc-conventions.md`'s back-link rule, or add one.
3. Diff is docs (`docs/invariants.md`) plus two renamed test-suite titles in
   `side-effect-audit.spec.ts` (describe title + one comment) — no runtime source touched.
