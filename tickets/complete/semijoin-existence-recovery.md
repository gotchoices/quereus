description: Semi/anti-join existence-flag recovery optimizer rule — recovers a semi/anti join from a `left join … exists right as <flag>` whose flag is demanded ONLY as a top-level boolean probe (`where flag` ⇒ semi, `where not flag` ⇒ anti). Reviewed; a major soundness bug (semi fan-out) was found and fixed inline.
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts, packages/quereus/test/logic/08.2-existence-flag-semijoin-recovery.sqllogic, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/key-utils.ts, docs/optimizer.md, docs/view-updateability.md
----

## What shipped

A Structural optimizer rule `ruleSemijoinExistenceRecovery` (id `semijoin-existence-recovery`,
ProjectNode-anchored, priority 23) that rewrites a probe-only `exists … as` flag on a
`left join` into the equivalent semi (`where flag`) or anti (`where not flag`) join,
re-opening physical join selection and the FK IND-folding cascade. It is the
demand-SHAPE complement of `join-existence-pruning`.

Probe normal forms: `f`, `not f`, `not not f`, `f = true`/`true = f` (semi),
`f = false`/`false = f` (anti). Demand built conjunct-by-conjunct so the sole probe is
excluded; abstains when the flag is selected/sorted-on, when a right column is demanded
(deferred outer→inner case), when there are ≥2 existence specs, or when R has side effects.

## Review findings

Scope of the adversarial pass: read the implement diff (`f560eb62`) first, then the rule,
the reused chain helpers (`rule-join-elimination.ts`), the **runtime join emitter**
(`runtime/emit/join.ts` + `join-output.ts`) to verify the actual `exists right as`
semantics, the key/FD analysis surface (`key-utils.ts`, `fd-utils.ts`), the optimizer
registration/phase, and both test files. Empirically reproduced behavior against the engine
before and after the fix.

### MAJOR (fixed inline) — semi recovery was unsound under fan-out

**The rule's central premise — "`left join … where flag` is `semi(L,R,condition)` for an
arbitrary condition; rows are byte-identical" (Q5) — was false.** A plain `left join …
exists right as` is a *normal* left join with an appended flag bit, NOT existence
semantics: `emitLoopJoin` (`runtime/emit/join.ts:103`) yields **one output row per matching
right row**, each carrying flag=true. So for a left row matching K right rows, `where flag`
keeps **K rows**, whereas a semi join keeps **one**. The rule fired on arbitrary conditions
(Q5 explicitly waived the AND-of-equalities / uniqueness requirement), so any join whose
right side is non-unique on the join column produced wrong results.

Reproduced (child `cc=1`; parent has three rows with `pp=1`):
`select c.cc from child c left join parent p on p.pp=c.cc exists right as h where h`
→ recovered `[{cc:1}]` vs. correct baseline `[{cc:1},{cc:1},{cc:1}]`. Wrong row count.

Every implementer test used a PRIMARY KEY join column (`exp.pp`, `customers.id`,
`parent.pid`), so each left row matched ≤1 right row and the fan-out case was never
exercised — the bug shipped behind a green 5065-test suite.

The **anti** path is immune (verified empirically): an unmatched left row yields exactly
one null-extension regardless of fan-out, and matched rows are filtered out, so
`anti(L,R,cond)` equals `left join … where not flag` for arbitrary `cond`.

**Fix** (`rule-semijoin-existence-recovery.ts`): added fan-out guard `rightMatchesAtMostOne(join)`,
applied **only to the semi polarity** — the equi-join columns must cover a unique key of R
(`isUnique(pairs.map(p => p.right), {getType, physical})`, the same uniqueness surface
`JoinNode.computePhysical` uses, so it subsumes FK→PK, declared UNIQUE keys, FD-derived
keys, and ≤1-row R via the empty key). Anti proceeds unconditionally. Rewrote the rule's Q5
/ Q6 header docs and the `docs/optimizer.md` entry to describe the fan-out reality and the
guard (the prior text asserted the false "arbitrary condition" property). This also
incidentally closes a latent DISTINCT/LIMIT-in-chain concern: those only diverged under
fan-out, which the guard now excludes.

Disposition note: filed as a finding but fixed in-pass rather than as a new ticket because
the rule is registered and enabled — leaving it producing wrong results was not acceptable,
and the fix is contained (one guard + the existing `isUnique` machinery). Completeness, not
soundness, is the only thing the guard can cost (a genuinely-unique R the logical/FD surface
can't prove would abstain and stay nested-loop — a missed optimization, never a wrong
answer).

**Regression coverage added:**
- `rule-semijoin-existence-recovery.spec.ts` — `fan-out guard` describe: SEMI must NOT fire
  on a non-unique right join column (flag retained, joinType `left`, result `[1,1,1]` equals
  baseline); ANTI still fires under fan-out (joinType `anti`, result `[2]`).
- `08.2-existence-flag-semijoin-recovery.sqllogic` — end-to-end fan-out section asserting the
  three-row semi baseline and the one-row anti result against real data.

### Checked, no defect

- **Anti correctness under fan-out** — verified sound by construction and empirically; no
  guard needed.
- **Multi-flag / sole-spec gate (Q4)** — `existence.length === 1`; sibling-flag prune-then-
  recover ordering holds (covered).
- **Probe-shape rejections** — OR-probe, multiple flag conjuncts (`>1` or across filters),
  flag selected, flag sorted-on, non-probe conjunct shapes all abstain (covered).
- **Write-half safety (Q7)** — a writable flag is always SELECTed by its routing Project, so
  it is demanded and check (b) abstains; the rewrite cannot reach the write path. Unchanged.
- **Impure-R guard (Q7)** — `subtreeHasSideEffects(join.right)` retained; by-construction
  argument unchanged (R of a `left join` is a read-only table ref; no runtime repro path).
- **Termination** — output semi/anti has no existence spec; re-running no-ops. Unchanged.
- **The updated `rule-join-existence-pruning.spec.ts` case** (implementer's honest gap #1) —
  changing `where hasP` to `where hasP or c.cv > 150` is the right call: the recovery rule
  legitimately lifts the old probe-only-WHERE limitation, so a non-probe WHERE is the correct
  way to keep that test exercising pruning's WHERE-demand folding without overlap. Confirmed.
- **`below`-chain path** (implementer's honest gap #3) — lightly covered but symmetric and
  reuses `rebuildChain`; with the fan-out guard, pass-through chain nodes are sound. Low risk;
  left as-is.

### Documentation

`docs/optimizer.md` (rule entry + IND-folding section) and `docs/view-updateability.md`
read against the final code; the optimizer.md rule entry was corrected to drop the false
"arbitrary condition" claim and document the fan-out guard (f).

## Validation

- `yarn workspace @quereus/quereus build` → exit 0 (tsc clean).
- `yarn lint` → exit 0.
- `yarn test` (full quereus suite) → **5067 passing, 0 failing, 9 pending** (5065 pre-review
  + 2 new fan-out spec cases; sqllogic file extended in place).

## Deferred (backlog tickets already filed by the plan stage — unchanged)

- `semijoin-existence-recovery-aggregate-anchored` — `count(*) … where flag` (no enclosing Project).
- `outer-to-inner-join-under-flag-probe` — `where flag` with right columns selected ⇒ `left join` → `inner join`.
- `existence-probe-richer-forms` — `case when flag …`, `flag is [not] true/false`.
