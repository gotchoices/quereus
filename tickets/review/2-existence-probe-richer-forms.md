description: Review of the existence-flag probe matcher extension — `classifyProbe` in `rule-semijoin-existence-recovery` now recognizes the four `IS [NOT] TRUE/FALSE` probe normal forms (semi: `is true`/`is not false`; anti: `is false`/`is not true`), widening the set of `left join … exists … as` queries that recover a semi/anti access path. `IS [NOT] NULL` over the never-null flag is deliberately NOT a probe (constant), and CASE-wrapped probes are out of scope.
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts (classifyProbe new UnaryOpNode branch ~L347-380; Q2 doc table ~L59-77), packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts (IS-test happy-path loop, is-null rejections, is-true fan-out abstain), packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic (new probe-form + rejection rows)
----

## What landed

A single new branch in `classifyProbe` (the only behavioral change), matching a
`UnaryOpNode` whose operand is the flag `ColumnReferenceNode`:

```ts
if (n instanceof UnaryOpNode && isFlagColRef(n.operand, flagId)) {
    switch (n.expression.operator) {
        case 'IS TRUE':
        case 'IS NOT FALSE': return 'semi';
        case 'IS FALSE':
        case 'IS NOT TRUE': return 'anti';
    }
}
```

placed AFTER the existing `NOT`-over-colref branch (which returns for every `NOT`
operator first, so this branch never sees `NOT`) and before the `= true|false`
binary branch. Any other unary operator over the flag (`IS NULL`, `IS NOT NULL`,
`-`, `+`, `~`) enters the `if`, matches no `case`, and falls through to the final
`return null` ⇒ the rule abstains. The Q2 header doc table gained four rows plus a
note that the `is not …` collapses depend on the flag being non-null.

No change to the fan-out guard, the demand-shape analysis, `analyzeChain`,
`referencesAttr`, or the chain rebuild — the new forms ride the *existing*
machinery. SEMI forms (`is true`/`is not false`) flow through the same
`rightMatchesAtMostOne` guard; ANTI forms (`is false`/`is not true`) are fan-out
immune as before.

## Why it is correct (the load-bearing assumption to scrutinize)

The exactness of `f is not false` ≡ `f = true` and `f is not true` ≡ `f = false`
rests **entirely** on the flag being provably non-null
(`EXISTENCE_FLAG_TYPE.nullable === false` in `join-utils.ts`; `emitLoopJoin`
pre-computes matched=true / unmatched=false). With a NULL row present, `is not
false`/`is not true` would admit it into a third bucket and the polarity mapping
would be wrong. **If a reviewer can find any path where an `exists right as` flag
becomes nullable, this rewrite is unsound for the two `is not …` forms** — that is
the one invariant worth attacking. Confirmed today: `buildJoinAttributes` /
`buildJoinRelationType` append the flag with `EXISTENCE_FLAG_TYPE` (never marked
nullable), and the rule already requires the sole-existence-spec `left … right`
shape.

For the same reason, `f is not null` is a constant `true` and `f is null` a
constant `false` over this flag — neither partitions rows, so both correctly
abstain (and the always-true/always-false filter is left intact above the
surviving `left join`).

## Validation done (treat as a floor)

All green: `yarn typecheck`, `yarn lint`, `yarn build`, full `yarn test` (5105
passing / 9 pre-existing pending / 0 failing). Memory vtab only — the ticket
established the rewrite is byte-identical rows so `test:store` was not run.

Tests added:
- **`08.2-existence-flag-semijoin-recovery.sqllogic`** — end-to-end result rows for
  `is true`, `is not false`, `is false`, `is not true`; rejection rows for `is not
  null` (all left rows survive) and `is null` (zero rows); a fan-out `is true` row
  asserting the SEMI guard still keeps all 3 fanned-out rows.
- **`rule-semijoin-existence-recovery.spec.ts`** — a parameterized loop asserting
  each of the four forms produces the right `joinType` (semi/anti), drops the flag
  (`joinExistence === undefined`), returns the right rows, and equals the
  no-recovery baseline; two rejection specs (`is not null` / `is null`) asserting
  the flag is retained and `joinType === 'left'`; a fan-out spec for `is true`
  asserting abstention (flag retained, `joinType === 'left'`, 3 duplicate rows).

## Known gaps / deliberate omissions (per ticket scope — verify these are acceptable, not bugs)

- **CASE-wrapped probes** (`where case when flag then 1 else 0 end`) are dropped
  from scope by an explicit decision in the source ticket (truthiness-of-integer,
  not a boolean probe; constant folding does not reduce it; poor value/complexity
  ratio). No code or test owed. If a real workload produces them, the ticket says
  file a fresh backlog ticket — do **not** treat the absence as a defect here.
- **`not (f is true)`** (a prefix `NOT` wrapping the `IS TRUE` unary — which a user
  *can* write; the parser binds prefix NOT looser than IS, and `normalizePredicate`
  re-wraps it as `NOT(f IS TRUE)` rather than pushing into the IS form) is NOT one
  of the accepted forms ⇒ the rule abstains. This is correct, just unoptimized; the
  ticket explicitly says no test is owed. A reviewer may want to confirm the
  abstention (it is still byte-correct via the surviving `left join`).
- **No dedicated fan-out test for the ANTI `is false`/`is not true` forms.** ANTI is
  fan-out-immune by construction (unmatched rows never duplicate) and the new ANTI
  forms share the identical code path as bare `where not f`, which already has a
  fan-out spec. Adding one would be belt-and-suspenders; flagged so the omission is
  a conscious choice, not an oversight.

## Suggested reviewer focus

1. The non-null invariant argument above — the only place unsoundness could hide.
2. That the new branch cannot accidentally classify a non-probe shape: confirm a
   second flag reference (`f is true and f = something`) still disqualifies via
   `analyzeChain`'s sole-conjunct check, and that `referencesAttr` descends the
   unary operand (it does — generic `getChildren()` recursion).
3. Doc/code agreement: the Q2 table now lists 8 forms; verify it matches
   `classifyProbe` exactly.
