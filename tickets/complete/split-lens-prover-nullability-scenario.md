description: Moved the one lens-prover test scenario that some storage backends legitimately pass differently into its own test file, so backends that diverge on it still run the rest of the lens-prover tests.
files:
  - packages/quereus/test/logic/55-lens-prover.sqllogic
  - packages/quereus/test/logic/55.0.1-lens-prover-nullability.sqllogic
----

# Split § 3 (nullability mismatch) out of `55-lens-prover.sqllogic`

## What changed

- New `packages/quereus/test/logic/55.0.1-lens-prover-nullability.sqllogic`: header comment explaining the split (a module declaring `permitsGrandfatheredNotNullViolators` demotes `lens.nullability-mismatch` to a warning; pointer to `docs/lens-prover.md`), then the former § 3 verbatim (`basis3` / `app3`, ending `-- error: lens.nullability-mismatch`). Banner number "3." dropped. No `-- requires-capability:` directive, per `test/README.md`.
- `55-lens-prover.sqllogic`: § 3 removed; §§ 1, 2, 4, 5 unchanged (banners not renumbered). Header comment gains a pointer to the new file and the reason.

## Testing

- `yarn workspace @quereus/quereus test` (memory backend): 11149 passing, 26 pending, 0 failing — both files pass.
- `yarn test:store` not run; the store module does not declare the capability, so § 3 should still error there.
- No new tests (corpus reorganization only). Downstream (Lamina) is expected to list the new file as a known failure.
