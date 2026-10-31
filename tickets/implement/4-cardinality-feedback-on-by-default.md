description: Turn cardinality feedback on by default once it is complete — after measuring that it costs nothing noticeable and reviewing every query plan in the test suite that changes because of it.
prereq: cardinality-feedback-commit-scoped-publication, cardinality-feedback-replan, cardinality-feedback-diagnostics
architecture: docs/progressive-optimizer.md#38-overhead-budget-and-how-it-is-verified
files: packages/quereus/src/core/database.ts, packages/quereus/bench/reference/execution.json, packages/quereus/bench/reference/mutation.json, docs/usage.md, docs/progressive-optimizer.md, docs/sql-txn.md
difficulty: medium
----

# Flip `cardinality_feedback` to on

Last of the `cardinality-feedback-*` chain. The earlier tickets land the feature behind `cardinality_feedback` (default `false`) so that their own diffs carry no plan churn. The design (`docs/progressive-optimizer.md`) intends plans to improve from execution without anyone opting in — "no manual intervention, no `ANALYZE`" — so the default flips here, as its own reviewable change, once the cost is measured and the churn is understood.

## Expected blast radius

The record floor (`max(before, observed) > cardinalityFeedback.minRows`, default 1000) keeps small tables on the numbers they plan with today, and a shift needs a 10× spread, so a never-analyzed table changes plans only once it is observed at ≥ about 10,000 rows. The sqllogic corpus generates at most 200-row tables (`grep -ohE "generate_series\([0-9]+, *[0-9]+\)" test/logic/*.sqllogic`), so it should be inert. TypeScript specs that load ≥ 10,000 rows, scan them in full and then assert a plan shape are the likely movers; `yarn test:store` can move more, because the store module honors the observed size as its sizing hint.

## Design

- Change the option's `defaultValue` to `true`. Nothing else in engine code should need to change; if something does, that is a defect in an earlier ticket — fix it here and say so in the handoff.
- **Overhead gate, before anything else.** Measure the flip alone: build the tree with the default still `false` and run `node bench/run.mjs --filter execution` (keep the JSON), flip, rebuild, run again with `--baseline <that JSON>`. Acceptance: no gated regression, and the scan-heavy rows (`full-scan-10k`, `filtered-scan-index-10k`, `join-1kx1k`, `correlated-subquery`, `hand-batched-peer-count`) inside their noise floor (`docs/benchmarking.md` § Measuring one commit's cost). If it fails, do **not** flip: leave the default `false`, file a `debt-` ticket in `tickets/backlog/` with the comparison table, and hand off with that finding.
- **Plan churn triage.** Run `yarn test` and `yarn test:store`. For every assertion that changes:
  - a changed **result** (rows, errors) is a bug — in feedback or in the plan it exposed. Never loosen a result assertion; fix the defect or file it.
  - a changed **plan shape or estimate**: confirm the new plan is the arithmetically right one for the observed size (observed sizes are exact, so it usually is), then update the expectation. Where a test deliberately pins the no-statistics plan, set `pragma cardinality_feedback = false` in that test's setup with a comment saying why — not globally in a harness.
- **Benchmark gate.** Run `yarn bench:gate`. A workload over a large never-analyzed table may re-plan after its first execution and change its exact counters. For each changed benchmark confirm the new plan is the better one, then `yarn bench:accept --reason "cardinality feedback re-plans <name> after its first full scan"`. A benchmark whose plan carries two or more joins is recorded but never gated (QuickPick's wall-clock bound), so do not chase its drift.
- **Docs.** `docs/usage.md` option default; `docs/progressive-optimizer.md` status note (feature complete and on by default) and §3.7 determinism wording; `docs/sql-txn.md` §9.5 wording if it said "off by default".

## Edge cases & interactions

- **Golden plans** (`test/plan/golden-plans.spec.ts`) move only if a fixture fully scans a ≥ 10,000-row table before planning. Verify: the test run; update snapshots only after the per-plan check above.
- **Fuzz and property suites** compare answers across plans, not plans. Verify: they pass unchanged.
- **Performance sentinels** use generous thresholds. Verify: they pass unchanged.
- **Auto-analyze** still refreshes tables a test writes; tests that already relied on its background refresh keep doing so. Verify: the test run.
- **Strict passes** — `yarn test:fork-strict`, `yarn test:context-strict`, `yarn test:repr-strict` exercise the new `RuntimeContext` field with feedback on. Verify: run them.
- **Hosts that need reproducible plans** have the escape hatch `pragma cardinality_feedback = false`. Verify: documented in `docs/usage.md`.

## TODO

- Baseline execution-suite run (default still `false`), flip, comparison run; stop and file per the gate if it fails.
- `yarn test`, `yarn test:store`: triage every change as above.
- `yarn bench:gate`; accept changed counters with reasons.
- `yarn test:fork-strict`, `yarn test:context-strict`, `yarn test:repr-strict`.
- Docs listed above.
- Handoff: the comparison table, every changed expectation with its one-line justification, and every accepted counter change.
