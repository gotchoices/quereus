description: The repo's documentation-convention checker is failing on two entries in the invariants document — one entry has a duplicate field and two entries are too wordy — so the project-wide `yarn check` gate is red.
files: docs/invariants.md, docs/doc-conventions.md, scripts/check-docs.mjs
difficulty: easy
----

## Symptom

`yarn docs:check` (run standalone, and as the first step of `yarn check`) exits 1:

```
docs/invariants.md:47: invariant 'OPT-002' has 2 'guard:' lines — expected exactly one
docs/invariants.md:47: invariant 'OPT-002' body is 148 words (max 120) — it is two invariants, or it is rationale wearing an invariant's clothes
docs/invariants.md:343: invariant 'OPT-046' body is 155 words (max 120) — it is two invariants, or it is rationale wearing an invariant's clothes
```

## Why this is pre-existing (not caused by the ticket that found it)

Found while running `yarn docs:check` during `debt-tighten-asrun-run-signatures`,
whose diff is confined to `packages/quereus/src/runtime/` and `docs/runtime.md`.
`docs/invariants.md` is unmodified in that working tree, so the failure reproduces
at HEAD. The entries were most likely introduced by the immediately preceding
`debt-mechanical-guards-for-optimizer-invariants` work.

## Expected behavior

`yarn docs:check` passes. Per `docs/doc-conventions.md`, each invariant entry has
exactly one `guard:` line and a body of at most 120 words.

## What the fix probably looks like

The checker's own error text names the likely cause: an over-long invariant body is
"two invariants, or it is rationale wearing an invariant's clothes". So for each of
`OPT-002` and `OPT-046`, decide whether the entry is genuinely two separate
invariants (split it, giving the second its own id and `guard:`) or whether the
excess words are rationale that belongs in the surrounding prose rather than in the
invariant body (move it out). `OPT-002`'s second `guard:` line is the strongest hint
that it is the split case.

Do not raise the word cap or relax the checker to make this pass — the cap is the
convention the entries are meant to satisfy.
