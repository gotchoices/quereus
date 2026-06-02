description: Review the shipped **lenient multi-side delete fan-out** for two-table inner-join views — an ambiguous join delete (two candidate sides, no provable FK, no resolving tag) now deletes from **every** candidate side via the both-sides-UPDATE eager key-capture plumbing, replacing the former `delete-ambiguous` reject.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md

## What shipped

Under the default `lenient` policy, an *ambiguous* multi-source join delete — two
candidate sides after `target`/`exclude` narrowing, no provable single-direction
FK (`fkChildIndex === undefined`), no `delete_via` — now **fans out: it deletes the
joined row's contribution from both candidate sides** ("make this joined row not
exist"). This replaces the former `delete-ambiguous` reject. All other resolution
rules are unchanged (single-side via `delete_via` / `target` / single-candidate /
FK-many default; `policy=strict` still rejects residual ambiguity).

### Mechanism (reuses the both-sides-UPDATE plumbing)

The fan-out runs two base deletes sequentially against live state, so each per-side
op reads its identifying values from an **up-front identity capture** materialized
ONCE before any base op fires (`<pk> in (select k<side> from __vmupd_keys)`), exactly
as the both-sides UPDATE does. The first side's delete therefore cannot empty the
join out from under the second side's identifying subquery. A **single-side** delete
keeps the live join-body subquery (no ordering hazard).

Key edits:
- `multi-source.ts`: `chooseDeleteSide` (returns one `number`) → `chooseDeleteSides`
  (returns `number[]`, length 1 or 2); the final lenient branch returns both
  candidates instead of raising `delete-ambiguous`. `decomposeDelete` now emits one
  base delete per chosen side (ordered by `orderSides`), using the captured-key
  subquery for a fan-out (`sides.length > 1`) and the live `buildIdentifyingSubquery`
  for a single side. The capture helper was generalized op-agnostically:
  `MultiSourceUpdateKeyCapture` → `MultiSourceKeyCapture`,
  `buildMultiSourceUpdateKeyCapture(ctx, view, stmt)` →
  `buildMultiSourceKeyCapture(ctx, view, where)`, `makeMultiSourceUpdateKeyRef` →
  `makeMultiSourceKeyRef`.
- `view-mutation-builder.ts`: `buildUpdateIdentityCapture` → `buildIdentityCapture`,
  now also building the capture for a multi-side delete (`req.op === 'delete'`,
  join body, not decomposition-backed, `baseOps.length > 1`). The existing
  `injectKeyRef = !!keyCapture && baseOps.length > 1` threads the key ref into both
  delete base ops unchanged.
- `mutation-diagnostic.ts`: removed the now-unreachable `'delete-ambiguous'` reason.
- **No emitter changes were required** — `emitViewMutation` already materializes any
  `identityCapture` (op-agnostic) into context before draining the base ops and
  removes it in a `finally`. Comments in the node/emitter were broadened to mention
  the delete fan-out.

## Use cases to validate (and where covered)

All in `test/logic/93.4-view-mutation.sqllogic` unless noted:
- **`ax_nofk`** (changed): the previously-rejected no-FK ambiguous delete now succeeds
  and empties both base tables of the joined row.
- **`fo_jv` (fo-a)**: fan-out with unmatched base rows on either side — both sides lose
  exactly the joined row; the unmatched rows the inner join hides survive.
- **`cas_*` (fo-b)**: fan-out + ON DELETE CASCADE over a **mutual-FK** pair — deleting
  side0 cascades the matching side1 row away before the fan-out's own side1 delete,
  which then no-ops (predicate-scan over the live table, never a double-delete error).
  NOTE: both FK edges are `on delete cascade` (see Known gaps).
- **`fr_jv` (fo-c)**: fan-out + RETURNING — returns the deleted view rows (view re-query
  captured `pre`) AND deletes from both sides (base ops read the captured key set).
- **`property.spec.ts`** (`describe('multi-source inner join')`): a no-FK two-table
  join delete fans out; the post-delete view image excludes the row and no unjoined
  base row is perturbed (60 runs).
- **Regression floor**: full `@quereus/quereus` suite passes (4330 passing, 9 pending,
  0 failing); lint clean; build clean. The both-sides UPDATE goldens (`pc_jv`,
  `bw_jv`, `rjoin2`) are untouched by the shared-capture rename, and single-side
  delete paths (`ms_jv`, `dvp_jv`, `tg_jv`, `dv_jv`, `pol_lenient`/`pol_strict`)
  still pin one side.

## Known gaps / things to scrutinize

- **Behavior change, not just a new acceptance.** A previously-rejected delete now
  removes rows from BOTH base tables. For an inner join, deleting *either* side
  already hides the view row, so the fan-out deletes more base data than the minimal
  reading. This is the documented maximal-lenient intent; a user wanting one-side
  semantics must use `delete_via` / `target`. Confirm the doc framing (§ Inner Join —
  Deletes, § Philosophy: Predicates Rule) matches expectations.
- **Mutual-FK + asymmetric cascade actions.** The fan-out always orders sides `[0,1]`
  (because it is only reached when `fkChildIndex` is undefined). The (fo-b) cascade
  test needed **both** edges `on delete cascade`: with one edge RESTRICT the reverse
  back-reference RESTRICT-blocks the cascade's deletion (a `FOREIGN KEY constraint
  failed … violates RESTRICT` error). This is standard FK semantics (the same trap
  exists for any cascade through a mutual FK), not a fan-out-specific bug — but a
  reviewer should decide whether a fan-out over an asymmetric mutual FK ordered the
  "wrong" way (e.g. RESTRICT side first) deserves a clearer diagnostic than the raw FK
  error. No test pins the asymmetric/RESTRICT ordering.
- **Coverage gaps (tests are a floor):**
  - No dedicated fan-out + **body-WHERE** test. The capture's identifying predicate is
    `(user WHERE ∧ body WHERE)` via the shared `buildMultiSourceKeyCapture`, exercised
    by the UPDATE `bw_jv` case, but not by a delete-fan-out case specifically.
  - No dedicated **no-FK + `policy=strict`** reject test (the existing strict test
    `pol_strict` uses an FK pair). The strict branch is FK-independent, so this is low
    risk, but unpinned.
  - No test for an explicit `target = 'a,b'` naming **both** tables (→ two candidates →
    fan out). Inferred-correct but unpinned.
  - Multi-row predicates (a fan-out delete matching many joined rows at once) are only
    exercised by the property test's small arbitraries; no hand-written multi-row
    golden.
- **`> 2`-base / n-way decomposition delete fan-out remains deferred** (the separate
  `decomposition.ts` path, `unsupported-decomposition-predicate`). Only the two-table
  inner-join delete fan-out shipped here. Docs updated to keep that deferral explicit.

## Validation commands

- `yarn workspace @quereus/quereus test` (logic + property suites) — green.
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean.
- Targeted: `node test-runner.mjs --grep "93.4-view-mutation"` and
  `--grep "no-FK join delete fans out"` (from `packages/quereus`).
