description: The repo's documentation-convention checker was failing on two entries in the invariants document — one had a duplicate field and two were too wordy — so the project-wide check was red; this ticket applies the fix.
files: docs/invariants.md, docs/doc-conventions.md, docs/optimizer.md, scripts/check-docs.mjs, packages/quereus/test/optimizer/side-effect-audit.spec.ts
difficulty: easy
----

## Status: fix already applied in this working tree, verified, needs review-stage promotion

The `fix/docs-invariants-conventions` ticket's diagnosis was precise enough that the
correction was made directly rather than deferred. Both `yarn docs:check` failures named in
that ticket are resolved:

```
docs/invariants.md:47: invariant 'OPT-002' has 2 'guard:' lines — expected exactly one
docs/invariants.md:47: invariant 'OPT-002' body is 148 words (max 120) — ...
docs/invariants.md:343: invariant 'OPT-046' body is 155 words (max 120) — ...
```

## What changed

**`OPT-002`** (`docs/invariants.md`) had two `guard:` lines because it was actually two
invariants glued together: the behavioural fold-rule guard, and a separate static-analysis
guard that closes the audit gap for every other `'aware'` rule. Split:

- `OPT-002` keeps the core claim ("an `'aware'` rule consults the side-effect signal") and
  its one behavioural `guard:` (`side-effect-audit.spec.ts` — `Side-effect audit: rules must
  refuse on impure subtrees`).
- New `OPT-003` — "A static guard checks every `'aware'` rule's source for a purity signal"
  — carries the static-guard mechanism and its `guard:` line. Renamed the corresponding
  `describe(...)` title in `packages/quereus/test/optimizer/side-effect-audit.spec.ts` from
  `"OPT-002 static guard: ..."` to `"OPT-003 static guard: ..."` (and the section comment
  above it) so the guard's own name matches the invariant it now belongs to.
- `docs/optimizer.md`'s existing back-link (`§ The two declarations` →
  `invariants.md#opt-002--an-aware-rule-consults-the-side-effect-signal`) still resolves
  unchanged — `OPT-002`'s heading text didn't change, so its slug didn't either.

**`OPT-046`** (`docs/invariants.md`) was one invariant at 155 words covering two distinct
claims: that `addFd`/`mergeFds` is the *only* accumulation path (statically guarded), and
*how* `addFd` behaves internally (subsumption dedup + cap eviction preference order). Split:

- `OPT-046` keeps "the only accumulation path" claim and its existing static `guard:`
  (`fd-propagation.spec.ts` — `OPT-046 static guard: addFd is the only FD accumulation
  path`, left unrenamed since it didn't move).
- New `OPT-047` — "`addFd` deduplicates by subsumption and evicts by key/kind preference" —
  carries the subsumption/cap-eviction/logging behaviour. No existing test exercises that
  ordering directly, so it's `guard: none — <reason>` (the honest state — a wrong
  preference silently drops a uniqueness witness rather than crashing).

No invariant IDs were reused or reordered outside their area; both new IDs (`OPT-003`,
`OPT-047`) sit in the existing numeric gaps and ascend correctly per-area.

## Verification

- `node scripts/check-docs.mjs` (repo root): the three invariant-format failures above are
  gone. Two *unrelated* pre-existing failures remain (`docs/schema.md`, `docs/sql.md` over
  their word-count ratchet) — confirmed via `git stash` to reproduce on a clean `main`
  checkout with no changes at all, logged to `tickets/.pre-existing-error.md` per the
  pre-existing-failure protocol. Not touched by this ticket.
- `yarn test:single packages/quereus/test/optimizer/side-effect-audit.spec.ts
  packages/quereus/test/optimizer/fd-propagation.spec.ts` (from `packages/quereus`): 63
  passing, including the renamed `OPT-003 static guard` describe block and the untouched
  `OPT-046 static guard`.

## Gaps for the reviewer

- Full `yarn check` / `yarn lint` / full test suite were not run in this pass (only the docs
  checker and the two directly-relevant spec files) — worth a full `yarn test` pass before
  final promotion, though the diff is docs + two renamed strings, not runtime code.
- No new back-link was added under `docs/optimizer.md § The two declarations` for the new
  `OPT-003`; only `OPT-002` is back-linked there. `doc-conventions.md` says a topic-doc
  section "carries a ... back-link" for the invariant it summarizes — `OPT-003` is more of
  an audit-mechanism fact than a declaration-semantics fact, so I judged it didn't need its
  own back-link, but a reviewer may disagree.

## TODO

- Run full `yarn check` (or at least `yarn test` + `yarn lint` for `packages/quereus`) to
  confirm no incidental breakage from the two-line rename in `side-effect-audit.spec.ts`.
- Decide whether `OPT-003` warrants its own back-link in `docs/optimizer.md`.
