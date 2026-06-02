description: Implement the doc's maximal **lenient** multi-side delete fan-out for join views — an ambiguous join delete (two candidate sides, no provable FK, no resolving tag) deletes from **every** candidate side ("make this joined row not exist") instead of being rejected. Reuse the existing both-sides-UPDATE up-front identity capture (`__vmupd_keys` / `IdentityCapture`) so the second side's delete is not invalidated by the first side's delete.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Background

Under the default `lenient` policy an *ambiguous* multi-source join delete (two
candidate sides after `target`/`exclude` narrowing, no provable FK to pick the
FK-many child, no `delete_via`) is today **rejected** with the structured
`delete-ambiguous` diagnostic (`chooseDeleteSide` in
`planner/mutation/multi-source.ts:976`). The doc's maximal-lenient reading —
*fan out: delete from every candidate side*, the predicate-honest "make this row
not exist" — was deferred in Phase 3.4 because the view-mutation substrate runs
base ops **sequentially against live state**: deleting one side empties the join
before the second side's identifying subquery (`<pk> in (select <pk> from <join>
where <pred>)`) runs, so the second delete would see zero matching rows.

## Key realization — the plumbing already exists

The **both-sides UPDATE** path already solved the identical hazard. When an
update assigns both join sides, it captures each affected view row's base-PK
identities `(k0, k1)` **once, up-front, before any base op fires**, materializes
them into `rctx.tableContexts` under a shared descriptor, and routes each
per-side op through the captured set (`<pk> in (select k<side> from
__vmupd_keys)`) — a mutation-order-independent identity. This is exactly the
ticket's "eager key materialization." The delete fan-out is the same shape with
a delete-shaped `where` predicate and no `set`.

Reusable pieces (all in `planner/mutation/multi-source.ts` unless noted):
- `MS_UPDATE_KEYS_CTE` (`'__vmupd_keys'`), `MS_UPDATE_KEY_COLUMNS` (`['k0','k1']`).
- `buildMultiSourceUpdateKeyCapture(ctx, view, stmt)` — builds the `select
  s0.pk0 as k0, s1.pk1 as k1 from <body> where <idPredicate>` capture. Update-
  specific only in that it reads `stmt.where` off an `UpdateStmt`.
- `MultiSourceUpdateKeyCapture` / `makeMultiSourceUpdateKeyRef` / the
  `IdentityCapture` node field (`planner/nodes/view-mutation-node.ts`).
- `buildCapturedKeySubquery(sideIndex)` — `select k<side> from __vmupd_keys`.
- The builder wiring in `view-mutation-builder.ts`: `buildViewMutation` already
  builds the capture, sets `injectKeyRef = !!keyCapture && baseOps.length > 1`,
  and threads `withKeyCapture` into each both-sides base op's planning context;
  `emitViewMutation` already materializes `identityCapture.source` into context
  before draining the base ops and removes it in a `finally`.

## Design

```
delete from <ambiguous join view> where <pred>            (lenient, 2 candidates)
   ── capture (k0,k1) for all matching joined rows, up-front ──
   ──►  delete from side0 where pk0 in (select k0 from __vmupd_keys)
        delete from side1 where pk1 in (select k1 from __vmupd_keys)
```

Resolution semantics (unchanged except the final lenient branch):
- `delete_via` / `target` that pin a **single** side → single-side live-subquery
  delete (no capture), exactly as today.
- `target`/`exclude` leaving **one** candidate → single-side, as today.
- `policy=strict` with residual ambiguity → `policy-strict-ambiguity`, as today.
- FK provable → FK-many (child) **single** side, as today (NOT a fan-out — the FK
  resolves the ambiguity, so it stays the documented one-side default).
- **lenient + 2 residual candidates + no FK + no side tag → FAN OUT to both**
  (new — replaces the `delete-ambiguous` reject).

Because the fan-out branch is reached **only when no single-direction FK is
provable** (`fkChildIndex === undefined`), and each base delete is a
**predicate-scan** over the live table (not a key-addressed delete that errors on
a missing key), the FK-cascade concern resolves itself: if some other declared FK
cascade (or a mutual-FK edge) removes a row before its own side's predicate-delete
runs, that row simply falls out of the scan — a natural no-op, never a
double-delete error. No cascade-aware special-casing is needed. (Verify this
"cascade-removed row is a silent no-op" claim with the `dvp_*` ON DELETE CASCADE
test shape, extended to a 2-candidate fan-out, during implementation.)

### Why single-side keeps the live subquery

Mirror the update's both-sides-vs-single-side split: a single-side delete has no
ordering hazard (the lone op re-queries before it mutates), so it keeps the live
join-body subquery — preserving all the nested-subquery-descent correctness the
(j)/(g)-style delete cases lock in. Only the ≥2-side fan-out swaps to the
captured-key subquery.

## TODO

Phase 1 — generalize the capture for delete

- Rename `MultiSourceUpdateKeyCapture` → `MultiSourceKeyCapture` and
  `buildMultiSourceUpdateKeyCapture` → a shared core that takes the `where`
  expression (or keep thin `…Update…`/`…Delete…` wrappers over a private
  `buildMultiSourceKeyCapture(ctx, view, where)`); update the single import in
  `view-mutation-builder.ts`. Keep it DRY — the capture body is identical
  (`requireSingleColumnPk` on **both** sides, `buildIdentifyingPredicate` from
  the statement's `where`, project `k0`/`k1`).
- `makeMultiSourceUpdateKeyRef` / `buildCapturedKeySubquery` are op-agnostic
  already — reuse verbatim.

Phase 2 — multi-side delete decomposition (`decomposeDelete`)

- Replace `chooseDeleteSide` (returns one `number`) with `chooseDeleteSides`
  (returns `number[]`, length 1 or 2). The new lenient branch returns **all**
  residual candidates (after `target`/`exclude`) instead of raising
  `delete-ambiguous`. Every earlier resolution rule (delete_via, single
  candidate, strict reject, FK-child) still returns a single-element array.
- Emit one base `delete` per chosen side, ordered by `orderSides`. For a
  multi-side (`sides.length > 1`) result, each op's `where` is the captured-key
  subquery `pk<side> in (select k<side> from __vmupd_keys)`
  (`buildCapturedKeySubquery`); for a single side keep the live
  `buildIdentifyingSubquery` (no behavior change).

Phase 3 — builder + node wiring (`view-mutation-builder.ts`)

- Generalize `buildUpdateIdentityCapture` → `buildIdentityCapture` so it also
  builds the capture for a **multi-side delete** (`req.op === 'delete'`,
  `isJoinBody`, not decomposition-backed, `baseOps.length > 1`). The existing
  `injectKeyRef = !!keyCapture && baseOps.length > 1` then threads the key ref
  into both delete base ops with no further change.
- Confirm the delete **RETURNING** `pre` re-query (`buildMultiSourceReturning`,
  timing `'pre'`) coexists with the new `identityCapture`: both materialize
  before the base ops; the RETURNING path re-queries the *view* by user predicate
  (independent of `__vmupd_keys`), the base ops read `__vmupd_keys`. A fan-out
  delete *with* RETURNING should both return the deleted view rows and delete
  from both sides. Add a test.

Phase 4 — diagnostics cleanup

- The `delete-ambiguous` reason is now unreachable under lenient (the only raise
  site is the branch being replaced; the composite-PK-on-the-other-side edge now
  surfaces as `unsupported-join` from `requireSingleColumnPk` inside the capture).
  Remove the `'delete-ambiguous'` member from `MutationDiagnosticReason`
  (`planner/mutation/mutation-diagnostic.ts:33`) and its sole raise site, OR, if
  any residual path still needs it, document why. (Grep confirms only
  `multi-source.ts` + the type def reference the literal; no test asserts it.)

Phase 5 — tests (`test/logic/93.4-view-mutation.sqllogic`)

- **Change** the existing `ax_nofk` ambiguous-delete case (lines ~324–333): it
  currently expects `-- error: cannot delete through view`. Under fan-out
  `delete from ax_nofk where xid = 1` must now **succeed**, deleting the joined
  row's contribution from **both** `ax_x` and `ax_y`. Expected after:
  `select xid from ax_x` → `[]` for the matched parent row; `select yid from
  ax_y` → the matched `y.yid` (=5) gone. Keep the unmatched rows.
- **Keep** the strict reject (line ~469) and the `target`/`exclude`/`delete_via`
  single-side cases (lines ~380–429) unchanged — they must still pin one side.
- Add a fan-out case that asserts **both** sides lose exactly the joined row and
  unmatched base rows on either side survive (the inner join hides them).
- Add a fan-out + ON DELETE CASCADE case (extend the `dvp_*` shape to a no-FK or
  mutual-FK pair) proving the cascade-removed row is a silent no-op, not a
  double-delete error.
- Add a fan-out + RETURNING case (returns the deleted view rows; both sides
  deleted).
- Consider a property-test arm in `test/property.spec.ts` mirroring the existing
  multi-source PutGet block (the `jv`/`dvv` shapes around lines 2657/2865): a
  no-FK two-table join delete fans out and the post-delete view image excludes
  the row, with no unjoined base row perturbed.

Phase 6 — docs (`docs/view-updateability.md`)

- § Inner Join — Deletes: replace the "**Shipped behavior vs. intent**" deferred
  caveat (lines ~356–367) with the shipped fan-out description; update the
  resolution bullet's final "else the delete is **ambiguous**" to "else (lenient)
  fan out to every candidate side; strict rejects."
- Status table Phase 3.4 row footnote (line ~13): drop "(the lenient
  predicate-honest *multi-side delete fan-out* is deferred — see § Inner Join)".
- § Multi-Base-Table Mutations note (lines ~528–536): the two-table inner-join
  delete fan-out is now shipped via the same eager key materialization; keep the
  **n-base decomposition** delete fan-out deferral (that is the separate
  `decomposition.ts` path, `unsupported-decomposition-predicate`).
- § Diagnostics: if `delete-ambiguous` is removed, ensure no doc text relies on
  it (the structured `MutationDiagnostic` union in the doc does not list it).

## Validation

- `yarn workspace @quereus/quereus test` (Mocha logic + property suites). Stream:
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/vm.log; tail -n 80 /tmp/vm.log`.
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
- Spot-check the both-sides UPDATE goldens are untouched (the shared capture
  helper rename must not change update behavior).
