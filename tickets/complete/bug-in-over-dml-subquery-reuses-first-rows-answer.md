description: An `x in (insert ... returning ...)` test used to work out its answer for the first row and reuse it for every row, so queries over more than one row returned wrong results. It now stores the values the insert returned and checks each row against them; the insert still runs exactly once.
architecture: docs/runtime.md#impure-subquery-emitters-full-drain--run-once
files:
  - packages/quereus/src/runtime/emit/subquery.ts   # emitIn: membershipKey / drainMembershipSet / membershipSetFor / probeMembership shared by runImpure and runSetProbe
  - packages/quereus/src/runtime/types.ts           # InMembershipSet; inSetProbes / executionMemo doc comments
  - packages/quereus/src/runtime/parallel-driver.ts # fork comments
  - packages/quereus/test/runtime/fork-contract.spec.ts # inSetProbes policy comment
  - packages/quereus/test/logic/01.9-query-expr-dml.sqllogic # section 2 multi-row cases
  - docs/runtime.md, docs/runtime-caching.md, docs/runtime-parallel.md
repro: verified
----

## Summary

`emitIn`'s impure branch (an `IN` whose right-hand side contains a write) used to memoize the three-valued answer computed for the first probe value in `rctx.executionMemo` and return it for every later outer row. It now drains the inner once per execution into a membership set (`{ tree, hasNull }`, new exported type `InMembershipSet`) stored in `rctx.inSetProbes` under its own per-site symbol, and probes that set with each call's own condition. The drain, store, and probe logic is shared with the uncorrelated set-probe path through four small helpers in `subquery.ts`. The impure path builds the set before checking for a NULL condition, so the write fires even when the first probe is NULL; the pure set probe keeps its skip-the-build short-circuit. Scalar and `EXISTS` impure paths keep using `executionMemo`. Docs and fork-policy comments were updated to say which emitter uses which slot.

Tests added to section 2 of `01.9-query-expr-dml.sqllogic`: first row hits / second misses, first misses / second hits, per-row three-valued result against a set holding NULL, and a NULL first probe that still fires the write once. Landed in `ticket(implement): bug-in-over-dml-subquery-reuses-first-rows-answer`.

## Review findings

Checked by reading the implement diff, the surrounding `emitIn` / `emitScalarSubquery` / `emitExists` code, every doc the change touches, and running lint and the full quereus suite.

- **Correctness.** The new impure path compares through the same BTree comparator (`compareSqlValuesFast` under the membership collation) and the same probe/member key transforms the old linear loop used, so match semantics are unchanged; only the memoized value changed. The old path's "drain every row" behaviour is kept (`drainMembershipSet` has no early exit). The asymmetric object-arm key transform is still covered by `06.9.2-json-structural-equality.sqllogic:243`, and re-execution of a prepared statement re-firing the DML once per run is covered by `prepared-statement-amortization.spec.ts:187`; both pass. Verified statically that the first two new tests fail on the old code (the old memo returns the first row's answer for every row); I did not re-run them against the pre-fix build.
- **Refactor of the other `emitIn` paths.** The streaming, constant value-list and dynamic value-list paths now call `membershipKey` instead of an inline `x === null ? null : key(x)`; behaviour is identical. No finding.
- **Concurrency (tripwire).** `membershipSetFor` writes the slot only after the drain finishes, so two overlapping evaluations of one site would both drain, firing the DML twice. The old `executionMemo` path had the same window and nothing in the runtime evaluates one site concurrently today. Parked as a `NOTE:` in `membershipSetFor` (fix if it trips: store the in-flight Promise, as `cteMaterializations` does).
- **Parallel forks.** The lazily created `inSetProbes` map would be made per branch if a forked query ran impure `IN`; already documented by the implementer in `parallel-driver.ts` alongside the identical `executionMemo` caveat. ParallelDriver has no query consumers, so no ticket.
- **Correlated impure inner** runs once with the first outer row's values. This is the existing scalar/`EXISTS` contract, now stated in `docs/runtime.md`; not a change and not a defect of this ticket.
- **Docs.** `docs/runtime.md`, `docs/runtime-caching.md`, `docs/runtime-parallel.md` match the new behaviour. Minor fix: in `docs/runtime-caching.md` the new sentence's link had been joined onto the following sentence in this hard-wrapped file; split it back onto its own line.
- **Tests.** The four new sqllogic cases each pin a distinct behaviour (the reported bug in both directions, per-row three-valued result, build-before-NULL ordering). None restate the implementation; none cut. No new tests added in review — no new defect was found that needs one.
- **Type safety / hygiene.** No `any`; `InMembershipSet` replaces an inline type. `subquery.ts` is 595 lines (`wc -l`), acceptable. Comments explain why (ordering of build vs NULL check), not what.
- **Validation.** `yarn workspace @quereus/quereus lint`: exit 0. `yarn workspace @quereus/quereus test`: 11097 passing, 26 pending, 0 failing. Store leg (`yarn test:store`) not run — the change is confined to the runtime emitter and touches no storage code.
- **Major findings / tickets filed:** none.
