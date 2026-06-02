description: Relaxed the plan-time `mutual-fk-restrict-delete` reject so it only fires when the view's join provably correlates a mutual-FK edge. A join on non-FK columns (joined rows not proven to cross-reference) now falls back to the fixed `[0,1]` fan-out and defers to runtime FK enforcement, fixing the data-independent over-rejection. Ready for adversarial review.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What shipped

`decomposeDelete` (`multi-source.ts`) previously raised `mutual-fk-restrict-delete` at
plan time **whenever** `orderDeleteFanout(analysis.sides) === undefined`. That predicate
is **schema-only** — it inspects only the two base tables' declared `foreignKeys`, never
the join predicate or the rows — so a view over a mutual `restrict`/`restrict` (or
`restrict`/`cascade`) FK pair was rejected up front *regardless of the data*, even when
the specific joined rows do not cross-reference via the FK and the delete would succeed.

The fix (option (a) from the ticket — gate the reject on join-FK correlation at the
**whole-reject** level):

- `orderDeleteFanout` / `inboundDeleteAction` / `deletableFirst` are **unchanged** — they
  still choose a feasible order from the schema.
- New helper **`joinCorrelatesMutualFk(analysis)`** decides whether the join *provably*
  correlates at least one mutual FK edge. When `orderDeleteFanout` returns `undefined`,
  the reject now fires **only if** `joinCorrelatesMutualFk` is true; otherwise the planner
  sets `order = [0, 1]` (the deferred-to-runtime fixed fan-out). The diagnostic message is
  byte-identical to before on the reject path.

### `joinCorrelatesMutualFk` algorithm (multi-source.ts)

1. Collect cross-side equalities from the join ON condition (`sel.from[0].condition`) **and**
   the body WHERE (`sel.where`), flattened on `AND` (reuses `flattenAnd`, now **exported**
   from `single-source.ts`). Keep each conjunct that is `column = column`.
2. Resolve each operand to side 0/1 (`resolveColumnSide`): by explicit `.table` qualifier
   matching a side's `alias` or `schema.name`, else by **unique** ownership of the
   unqualified column name. Ambiguous/unresolved/same-side ⇒ skip (conservative).
3. Build a set of canonical `(side,col)↔(side,col)` keys (`crossEqualityKey`, order-independent).
4. Per mutual edge (edgeA = FK on side0→side1, edgeB = FK on side1→side0): the edge is
   *correlated* iff some matching FK has **every** `(childCol, refCol)` pair equated
   cross-side. `refCol` comes from `resolveReferencedColumns(fk, parent.schema)` (reused,
   not modified, from `schema/table.ts`). Generalizes to composite FKs (all-pairs).
5. Return true iff **at least one** edge is correlated.

### Why "at least one edge", whole-reject level (the load-bearing design choice)

- (fo-g)/(fo-h) join `on b.aref = a.aid`, which correlates exactly **one** edge
  (`b.aref → a.aid`). They must keep rejecting (else a raw transitive-FK runtime error
  surfaces instead of the actionable diagnostic). "At least one edge" keeps them rejecting.
- The over-rejection repro joins on a **non-FK column** (`a.lbl = b.lbl`) → correlates
  **neither** edge → falls back and runs.
- Only when *neither* edge is correlated can the planner say no direction's RESTRICT is
  provable — the sole condition under which the plan-time reject is unjustified. This is a
  strict **reduction** of over-rejection, not perfect precision.

## Use cases for testing / validation

New goldens in `test/logic/93.4-view-mutation.sqllogic` (after fo-j):

- **(fo-k)** — the repro. Mutual `restrict`/`restrict` FK, view join on a **non-FK
  column** (`a.lbl = b.lbl`), FK columns left NULL. `orderDeleteFanout` still returns
  undefined, but the reject no longer fires; `delete from k_jv where aid = 1` **succeeds**
  (runtime FK check finds no referencing row — MATCH SIMPLE on NULL), removing both base
  rows of the joined identity and leaving the non-joining siblings.
- **(fo-l)** — the accepted residual tradeoff. Same non-FK join, but FK columns
  back-filled so the joined rows *do* cross-reference. The deferred `[0,1]` fan-out's
  per-base-op parent-side FK check raises the **raw** FK-constraint error
  (`CHECK constraint failed: _fk_l_b_aref`) instead of the actionable diagnostic — both
  base rows survive the rejected delete.

Regression coverage (unchanged goldens, confirmed still green):

- **(fo-g)/(fo-h)** still reject at plan time (`-- error: mutual foreign key`) — the join
  `on b.aref = a.aid` correlates edge B.
- **(fo-i)/(fo-j)** still succeed — they return a valid order from `orderDeleteFanout`, so
  they never reach the reject branch at all.

### Validation run (all green)

- `yarn workspace @quereus/quereus build` — exit 0 (clean tsc).
- `yarn workspace @quereus/quereus lint` — exit 0.
- `yarn workspace @quereus/quereus test` — **4411 passing, 9 pending** (the
  `[property-planner] Rule '…' never fired` lines are pre-existing informational notes, not
  failures).

## ⚠ Deviation from the ticket spec — reviewer please confirm intent

The ticket anticipated (fo-l) would surface the **runtime RESTRICT pre-check** message
(`violates RESTRICT`, from `runtime/foreign-key-actions.ts`). In practice the per-base-op
**plan-time parent-side FK NOT EXISTS check** fires first when deleting `l_a` aid=1, so the
observed error is `CHECK constraint failed: _fk_l_b_aref (not exists (select 1 from l_b
where l_b.aref = OLD.aid))`. The golden pins `CHECK constraint failed: _fk_l_b_aref`
accordingly (the sqllogic runner matches `-- error:` as a case-insensitive substring). The
*demonstration intent* is identical — a non-correlated join trades the actionable
plan-time diagnostic for a raw FK-constraint error when the data references — but the exact
enforcement site differs from the ticket's prose. Reviewer: confirm the pinned substring is
the desired one (alternatives: `CHECK constraint failed`, `_fk_l_b_aref`).

## Known gaps / things for the reviewer to probe

- **Conservative skips in correlation detection.** `resolveColumnSide` returns `undefined`
  (term skipped) for an **unqualified** join column whose name exists on *both* sides
  (ambiguous), and for any non-`column = column` conjunct. A genuinely-correlated edge
  written ambiguously would therefore *under*-detect → fall back to `[0,1]` → raw runtime
  FK error instead of the actionable diagnostic. Views normally qualify join columns, so
  this is believed rare, but it widens the (fo-l)-class residual. Worth a sanity check on
  whether any realistic ambiguous-but-correlated shape is reachable.
- **Composite-PK / composite-FK ordering vs `requireSingleColumnPk`.** `joinCorrelatesMutualFk`
  runs *before* `requireSingleColumnPk` (which fires when ops are built). It generalizes to
  composite via all-pairs; in the non-correlated fall-back path a composite-PK side is then
  rejected with `unsupported-join` when the op is built. In the correlated path the
  mutual-fk reject fires first. No composite golden was added (composite-PK sides are
  rejected upstream) — reviewer may want to confirm there's no shape that reaches the new
  helper with a composite PK and behaves surprisingly.
- **WHERE-correlation.** The helper folds `sel.where` conjuncts into the cross-equality set
  (per ticket step 1), so a correlation expressed in the body WHERE rather than ON is
  detected. No dedicated golden exercises that path — the shipped goldens all correlate (or
  not) via the ON condition. A `join ... on true where a.aid = b.aref`-style fixture would
  pin it if the reviewer wants belt-and-suspenders.
- **`flattenAnd` operator casing.** Relies on `operator === 'AND'` (uppercase), consistent
  with the existing single-source usage on view WHERE clauses. Composite ON conditions
  (`a.x = b.y and a.z = b.w`) depend on the parser emitting uppercase `AND`; not directly
  golden-tested here (no composite-FK fixture), but the same assumption already backs
  `extractFilterConstants`.

## Docs

`docs/view-updateability.md` § Inner Join — Deletes (the long blockquote) now documents the
correlation gate, the non-FK-join fall-back to runtime enforcement, and the accepted
residual conservatism (both directions: an over-reject when one edge's FK columns are NULL,
and the raw runtime error when a non-correlated join's data does reference).
