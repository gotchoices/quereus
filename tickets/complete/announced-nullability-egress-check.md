description: In the strict test mode, every query result column the engine promises can never be null is now checked row by row, so a null in such a column fails the test run instead of silently breaking the promise.
prereq: builtin-results-announce-honest-nullability, scalar-subquery-nullability, grandfathered-not-null-columns-read-as-nullable
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/runtime/strict-representation.ts   # assertAnnouncedNonNull, columnSite helper
  - packages/quereus/src/core/statement.ts                  # _iterateWithSignal + egressReprCheck()
  - packages/quereus/src/runtime/strict-flags.ts            # REPR_STRICT doc comment
  - docs/types.md                                           # § Enforcement: QUEREUS_REPR_STRICT
  - docs/types-inference.md                                 # "Arithmetic nullability" closing sentence
  - docs/plugins.md                                         # § Returning values in the right JavaScript form
  - docs/runtime.md                                         # REPR_STRICT harness summary
----

# Strict-mode egress check: announced non-null ⇒ no NULL cell

## What was built

Under `QUEREUS_REPR_STRICT=1`, the statement egress seam (`Statement._iterateWithSignal` in `core/statement.ts`) now checks, besides R1/R2 against each result column's announced type, that a column announced NOT NULL (`type.nullable === false`) never yields a null cell. The check is `assertAnnouncedNonNull` in `runtime/strict-representation.ts`; it throws a `RepresentationError` (StatusCode.INTERNAL) naming the column ordinal and name, the announced type, and the ways the fault can arise. The per-execution setup lives in the private `Statement.egressReprCheck()`, which precomputes names, types and the non-null column indices once from `columnDefCache` and returns a per-row closure. Off strict mode nothing is built and the `yield* source` fast path is unchanged.

Docs (`types.md`, `types-inference.md`, `plugins.md`, `runtime.md`, `strict-flags.ts`, the `strict-representation.ts` header) state the check and what it means for module and function authors: a `nullable: false` return type or a NOT NULL column is a promise, and strict mode fails a result row that breaks it.

No tests were added: the check is itself a test-mode net, run by `yarn check` through `test:repr-strict`, and `REPR_STRICT` is a module-level constant read at import, so a spec cannot toggle it.

## Review findings

Read the `ticket(implement): announced-nullability-egress-check` diff first, then the handoff.

- **Correctness — checked, no defect.** The check reads the same `columnDefCache` (last statement of the block's relation type) that R1/R2 already used, so it shares their plan-alignment; `getColumnDefs` is cleared on recompile. A short row (`undefined` cell) is not flagged, matching R1/R2's tolerance. The `exec()` drain path in `database.ts` yields no rows to a caller and is correctly outside the seam.
- **TVF case (handoff gap) — verified.** A throwaway spec (deleted) registered a table-valued function declaring `v INTEGER NOT NULL` and yielding `[1]`, `[null]`: under strict, `select v from liar_tvf()` returned the first row and then threw `repr-strict: null at the statement result row column 0 (v) …`; `getColumnDefs()` reported `nullable: false`. The `plugins.md` claim holds. Reworded the error message to name a table-valued function's NOT NULL column explicitly, since that case surfaces here and not at the TVF seam.
- **Store backend under strict (handoff gap) — run.** `node test-runner.mjs --store --repr-strict`: 11194 passing, 0 failing. No store-only nullability violations exist. `yarn check` still runs strict on the memory backend only; not a ticket — the store run is clean today and the store path is covered by `test:full` for everything else.
- **COLUMNS_STRICT + REPR_STRICT together (handoff gap) — run.** `node test-runner.mjs --repr-strict --columns-strict`: 11201 passing, 0 failing.
- **Docs accuracy — fixed.** `types.md` said a `not null` lens column over a computed expression "deploys only if" the expression is announced non-null. The lens prover (`schema/lens-prover.ts`, the `lens.nullability-mismatch` check) rejects only when the column also has no default, and only warns when the basis permits grandfathered NOT NULL violators. Reworded to what the prover does. `docs/runtime.md`'s summary of the REPR_STRICT harness listed only the representation check; added the egress nullability check. Re-wrapped the edited `types.md` paragraph to the file's existing hard wrap. No stale references to the retired `debt-announced-nullability-disagrees-with-produced-nulls` ticket remain.
- **DRY — fixed.** `assertRowConforms` and `assertAnnouncedNonNull` built the "`<where>` column i (name)" text identically; extracted a private `columnSite` helper used by both.
- **Performance / resource cleanup — checked, no issue.** All new work is gated by `REPR_STRICT`; per row it loops over the non-null indices only; the closure holds nothing that needs disposal.
- **Type safety / error handling — checked, no issue.** No `any`; the thrown error uses the existing `RepresentationError` class like the other strict checks.
- **Tests — none added, none cut.** The implementer added none, correctly (see above); no defect found that needs a reproduction.
- **Tripwires — none.** Nothing conditional found worth parking.
- **Size note (not acted on):** `yarn docs:check` reports `docs/types.md` at 11639 words, 361 under its 12000-word cap; the next section added there will need a split. The checker already warns about this, so no ticket.

Validation after the review edits: `yarn workspace @quereus/quereus lint` exit 0; `yarn docs:check` OK; `node test-runner.mjs --repr-strict` 11201 passing (the same suite as `yarn test` for this package, with the flag on); store + strict and columns + strict as above.
