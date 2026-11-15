---
description: One scenario in the lens-prover conformance test file expects a deploy to fail that a storage backend may legitimately allow, and because a test file stops at its first mismatch, such a backend never runs the two scenarios after it. Move that one scenario into its own test file so the rest of the file can run everywhere.
files:
  - packages/quereus/test/logic/55-lens-prover.sqllogic   # § 3 (`basis3` / `app3`, lines 86-117 at 4.20.2) moves out; §§ 1, 2, 4, 5 stay
  - packages/quereus/test/README.md                      # § `-- requires-capability:` — "split the file (decimal sub-numbering)" is the rule this applies
tradeoffs: It changes the corpus layout only to suit a downstream backend; the two scenarios it frees up (§ 4 unrealizable CHECK, § 5 read-only deploy) are already covered by Quereus's own memory-backend run and by `test/lens-prover.spec.ts`, so Quereus itself gains no coverage.
---

# Split § 3 (nullability mismatch) out of `55-lens-prover.sqllogic`

Filed from the Lamina board (`debt-lens-prover-corpus-sections-4-5-unexercised`).

## Why

Lamina runs the published `.sqllogic` corpus against its own storage module. Lamina declares the `permitsGrandfatheredNotNullViolators` module capability, so the lens prover's `checkTypeAndNullability` (`src/schema/lens-prover.ts`) demotes `lens.nullability-mismatch` to a warning-severity advisory, and § 3's `apply schema app3` succeeds on Lamina instead of failing. That is an intended, permanent difference on Lamina's side and not a request to change the prover.

The harness stops a file at its first failed assertion. On Lamina, § 4 (a `CHECK` over a computed column is rejected with `lens.unrealizable-constraint`) and § 5 (a logical table whose primary key cannot be reconstructed deploys read-only: reads work, `insert` fails with `read-only`) therefore never run. § 5 is the only end-to-end SQL check of the read-only write refusal over a non-memory backend.

`test/README.md` already settles how to handle this: `-- requires-capability:` applies to a whole file, there is no section-scoped form, and when only part of a file is worth running elsewhere the fix is to split the file with a decimal sub-number.

Lamina measured the effect on 4.20.2 using hand-cut copies of the file: §§ 1, 2, 4, 5 together pass end to end on Lamina, and § 3 alone fails at its `apply schema app3` as expected.

## What to change

- Move § 3 of `test/logic/55-lens-prover.sqllogic` (the `basis3` / `app3` scenario, from its `-- 3. Nullability mismatch…` banner through `-- error: lens.nullability-mismatch`) into its own file. The name is yours; one option is `55.0.1-lens-prover-nullability.sqllogic`, which follows the existing `50.0.1-…` / `99.0.1-…` pattern and sorts after `55-lens-prover` and before `55.1-eviction-restrict-fk`.
- Give the new file a short header comment saying why it stands alone: a backend that declares `permitsGrandfatheredNotNullViolators` admits this deploy with an advisory, and the other lens-prover scenarios are worth running on such a backend.
- Keep the content the same: no assertion changes. The remaining file keeps §§ 1, 2, 4, 5 in their current order (renumbering the banners is optional). `debt-announced-nullability-disagrees-with-produced-nulls` cites § 5's `v + 1` column, which this leaves where it is.
- Do not add a `-- requires-capability:` token to the new file. The README asks for tokens that group features a backend would omit wholesale, not one token per test, and Lamina keeps the new file in its known-failures list, which records exactly where it diverges.

## After this lands

Nothing else is needed on the Quereus side. Lamina picks it up after the next published release (it reads the corpus from the npm package, not from this checkout).
