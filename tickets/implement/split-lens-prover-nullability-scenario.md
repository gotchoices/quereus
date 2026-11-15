description: Move the one lens-prover test scenario that some storage backends legitimately pass differently into its own test file, so backends that diverge on it still run the rest of the lens-prover tests.
files:
  - packages/quereus/test/logic/55-lens-prover.sqllogic            # § 3 (`basis3` / `app3`, lines 86-117) moves out; §§ 1, 2, 4, 5 stay
  - packages/quereus/test/logic/55.0.1-lens-prover-nullability.sqllogic   # new
  - packages/quereus/test/README.md                               # § `-- requires-capability:` directive — the "split the file" rule this applies (read only)
  - docs/lens-prover.md                                           # Type / nullability conformance + Grandfathered NOT NULL rows (context only)
difficulty: easy
review: skip
----

# Split § 3 (nullability mismatch) out of `55-lens-prover.sqllogic`

Filed from the Lamina board (`debt-lens-prover-corpus-sections-4-5-unexercised`).

## Why

`packages/quereus/test/logic/*.sqllogic` is a shared corpus that downstream projects run against their own storage modules (see `test/README.md` § `-- requires-capability:` directive). Lamina's module declares the `permitsGrandfatheredNotNullViolators` capability, so the lens prover demotes `lens.nullability-mismatch` to a warning (documented in `docs/lens-prover.md`, rows *Type / nullability conformance* and *Grandfathered NOT NULL*). On Lamina, § 3's `apply schema app3` therefore succeeds instead of erroring. That is intended behaviour, not a prover bug.

The harness stops a file at its first failed assertion, so on Lamina §§ 4 and 5 of `55-lens-prover.sqllogic` never run. § 5 (non-reconstructible primary key deploys read-only; `insert` fails with `read-only`) is the only end-to-end SQL check of that write refusal over a non-memory backend.

`test/README.md` already settles the remedy: `-- requires-capability:` is whole-file only, and when part of a file is worth running elsewhere, split the file with a decimal sub-number. Lamina verified on 4.20.2 with hand-cut copies that §§ 1, 2, 4, 5 pass on Lamina and § 3 alone fails at `apply schema app3`.

## Design (settled)

- New file `packages/quereus/test/logic/55.0.1-lens-prover-nullability.sqllogic`, following the `50.0.1-…` / `99.0.1-…` naming pattern. (The Quereus harness reads the directory unsorted via `fs.readdirSync`; file order does not matter for correctness, and § 3 shares no state with the other sections — `basis3` / `app3` appear nowhere else in the file.)
- Its leading comment block: one short paragraph saying it is the nullability-mismatch scenario split from `55-lens-prover.sqllogic`, and why it stands alone — a backend whose module declares `permitsGrandfatheredNotNullViolators` admits this deploy with a warning-severity advisory instead of the error, and the other lens-prover scenarios are worth running on such a backend. Point at `docs/lens-prover.md` for the demotion rule.
- Body: § 3 verbatim, from the `-- 3. Nullability mismatch blocks the deploy …` banner block through `-- error: lens.nullability-mismatch`. No assertion changes. Drop the "3." number from the banner (or keep it — cosmetic).
- `55-lens-prover.sqllogic` keeps §§ 1, 2, 4, 5 in their current order, otherwise unchanged. Renumbering banners 4 → 3 and 5 → 4 is optional; leaving them is fine. Add one line to its header comment noting that the nullability-mismatch scenario lives in `55.0.1-lens-prover-nullability.sqllogic` and why, so a reader of the main file can find it. `debt-announced-nullability-disagrees-with-produced-nulls` (backlog) cites § 5's `v + 1` column, which stays in this file.
- **No `-- requires-capability:` token** on the new file. The README wants tokens that group features a backend omits wholesale, not per-test tokens; Lamina tracks the new file in its known-failures list.

## Edge cases & interactions

- Header comment of the new file must not contain a line beginning `-- requires-capability:` — the harness would parse it as a directive (README § grammar). Verified by inspection.
- The new file must be self-contained: it declares and applies `basis3` itself before `app3`. Verified by running the logic suite.
- No other file, doc or spec references `55-lens-prover.sqllogic` by section number except the backlog ticket above (checked with grep across `packages/`, `docs/`, `tickets/`). No doc update needed beyond the header comments.
- No new tests; this is a corpus reorganization. Existing coverage of the demoted form lives in `test/lens-prover.spec.ts`.

## TODO

- Create `55.0.1-lens-prover-nullability.sqllogic` with the header comment and § 3 verbatim.
- Remove § 3 (banner through `-- error: lens.nullability-mismatch` and the separating blank line) from `55-lens-prover.sqllogic`; add the pointer line to its header comment.
- Run `yarn workspace @quereus/quereus test` (memory backend) and confirm both files pass. Optionally `yarn test:store` to confirm the store path still errors on § 3 (the LevelDB store module does not declare the capability).
