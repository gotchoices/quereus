description: Sealed the guard-activation producer of the FD bag-as-set over-claim. When `FilterNode.activateGuardedFds` strips the guard off an implication-form CHECK whose body activates a single↔single determination FD, that now-unconditional `{a}→{b}` is gated on endpoint-superkey-ness against the filter's input keys; a genuine value-equality body additionally lifts an EC. Review HARDENED the implement-stage fix: the implementer gated only `valueEquality`-tagged FDs, but `shiftFds`/`projectFds` DROP the marker, so a value-equality FD activated through a join/subquery folded ungated and returned WRONG results (DISTINCT eliminated, duplicate rows leaked). Fix relocated the gate to key off the FD SHAPE (all single↔single activated FDs), making soundness independent of marker plumbing — which ALSO sealed the one-way guarded-determination hole that had been split out as a separate fix ticket. Build + full suite (5523) + lint green.
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/conditional-fds.spec.ts, docs/optimizer.md
----

## What shipped (implement stage)

`FilterNode.activateGuardedFds` (`filter.ts`) returns `{ fds, activatedEquivPairs }`.
When a guarded FD's guard is entailed by the predicate it is `stripGuard`-ed, and a
**value-equality** single↔single FD's pair `[a,b]` is collected for unconditional EC lift
while the stripped determination FD is folded only when an endpoint is a superkey of the
filter's input keys. `computePhysical` merges `activatedEquivPairs` into `equivClasses`
and re-closes `constantBindings`.

Producer tagging: `recognizeGuardedBody` (`check-extraction.ts`) sets `valueEquality: true`
on the mirror pair it emits **only** for a bare `col = col` body; the one-way `col = expr`
branch and index-derived guarded FDs are NOT tagged. New optional field
`FunctionalDependency.valueEquality?: boolean` (ignored by dedup, like `source`).

This prevents an implication-form CHECK's activated `{a}↔{b}` from being read by
`deriveKeysFromFds` as a phantom all-columns key once a narrow projection drops the
table's real key (which would drop a REQUIRED DISTINCT and leak duplicate rows). The EC
(value-equality, never read by `keysOf`) preserves the fact soundly.

## Review findings

Read the implement diff (`c8076271`) with fresh eyes first, then the handoff. Scrutinized
soundness, marker survival, the EC-lift argument, type safety, and the test surface; ran
lint + full suite + build.

### MAJOR (fixed inline) — bi-directional producer was NOT sealed: wrong results through join / subquery

The implement handoff claimed "the bi-directional value-equality producer is sealed" and
that marker-loss was a benign fail-safe under-claim ("never unsound"). **Both claims were
false.** `shiftFds` (join) and `projectFds` (subquery) reconstruct FD objects and DROP the
`valueEquality` marker (verified at `fd-utils.ts` `shiftFds`/`projectFds` — they emit fresh
`{determinants, dependents[, guard]}` literals, no `valueEquality`/`source`). Because the
implement gate fired only for `fd.valueEquality === true`, an unmarked value-equality Fd
reaching the Filter fell straight through to `out.push(stripGuard(fd))` **ungated** — the
exact bag-as-set over-claim, i.e. WRONG RESULTS, not an under-claim.

Reproduced empirically (throwaway probe, then promoted to permanent regression tests):

```sql
-- cross join: tgact's value-equality FD shifted by shiftFds (marker dropped)
select distinct t.a, t.b from other o cross join tgact t where t.status = 'active';
--   BEFORE fix: DistinctNode count 0, 3 rows  (DISTINCT wrongly eliminated)
--   AFTER  fix: DISTINCT retained, 2 rows
-- subquery: projectFds drops the marker, same over-claim
select distinct a, b from (select a, b, status from tgact) where status = 'active';
--   BEFORE fix: 3 rows;  AFTER fix: 2 rows
```

**Fix (minor, one gate relocation):** in `activateGuardedFds`, gate the fold on
endpoint-superkey-ness for **every** `determinants.length === 1 && dependents.length === 1`
activated FD, keying off the FD **shape** rather than the `valueEquality` marker. The
`activatedEquivPairs.push` (EC lift) stays inside the `valueEquality` branch — only the EC
lift is marker-gated now, never the fold. This makes soundness **independent of marker
plumbing across all 8 FD-constructing sites** (rather than relying on the marker surviving
every reconstruction path — the fragile invariant that caused the bug). Multi-dependent key
FDs (`{c}→{id,…}` from a partial UNIQUE) are not single↔single and pass through untouched (a
genuinely unique determinant). Losing the marker now loses only the EC optimization through
a join/projection (a genuine, sound under-claim), never correctness. This is precisely the
"option A" the implementer's own gap-#1 note recommended.

### MAJOR→folded — one-way guarded determination hole sealed by the same gate

The implementer had filed `tickets/fix/fd-oneway-guard-activation-key-bag-overclaim.md` for
the twin bug: `check (status <> 'active' or b = a + 1)` emits a one-way `{a}→{b}` (no
`valueEquality` tag) that folded ungated after activation (confirmed wrong results: 3 rows
instead of 2). The shape-based gate above covers single↔single FDs **regardless of origin**,
so it seals this case in the same pass. **Deleted that fix ticket** (bug eliminated +
regression-tested as site 8). Its prereq `fd-oneway-determination-key-bag-overclaim` (the
UNGUARDED `TableReferenceNode` determination site — a different producer, not touched by
`activateGuardedFds`) remains open and correctly scoped; if it later chooses the reader-side
"option B" fix, this Filter gate becomes redundant-but-harmless and can be simplified.

### Tests added (regression)

`test/fd-derived-key-bag-overclaim.spec.ts` (now 39 passing in the combined grep, was 35):
- **Site 7 marker-loss / join** — `cross join` routes the value-equality FD through
  `shiftFds`; DISTINCT must survive (2 rows). Would FAIL on the implement code.
- **Site 7 marker-loss / subquery** — subquery `projectFds` path; 2 rows.
- **Site 8 one-way** — `b = a + 1` guarded FD, non-keyed table, DISTINCT survives (2 rows).
- **Site 8 control** — one-way determinant `a` IS the PK ⇒ DISTINCT eliminated.

### Checked, no change needed

- **EC-lift soundness** — `valueEquality` set at exactly one producer site (`col = col`
  body) and never copied onto another FD; `stripGuard`/`shiftFds`/`projectFds` only DROP it.
  When the guard is entailed, the CHECK forces `a = b` on surviving rows, so the EC is sound.
  Confirmed re-running the implementer's two soundness probes (two-one-way-checks,
  two-partial-uniques): no EC over `{a,b}`, and those FDs are multi-dependent (`{a}→{b,status}`)
  so doubly safe.
- **Partial-UNIQUE activation** (`conditional-fds.spec.ts`) — the activated `{c}→{id,region,amt}`
  is multi-dependent (not single↔single), so the shape gate leaves it folded — correct (a
  genuinely unique determinant). Verified the test still passes.
- **`isUnique` closure branch (`fd-utils.ts:840`)** — unchanged; sound by construction once
  the producer keeps the over-claim out of the FD set. The deeper reader-side fix that would
  close ALL sites at once stays deferred to `fd-oneway-determination-key-bag-overclaim`.
- **Type safety / lint / build** — `valueEquality?: boolean` optional, `=== true` guards;
  lint exit 0, `tsc` build exit 0.

### Known residual (sound, documented)

- **EC-lift through a join/projection is not recovered** (marker dropped). This is now a
  pure optimization loss (under-claim) with no correctness impact — the equality is simply
  not surfaced as an EC when the value-equality FD passes through `shiftFds`/`projectFds`
  before the Filter. Threading `valueEquality` (and `source`) through those two helpers
  would recover it; deliberately deferred as it touches shared helpers used broadly and buys
  only completeness. Documented in `activateGuardedFds` and `docs/optimizer.md`.

## Commands

- `node packages/quereus/test-runner.mjs --grep "FD-derived key bag over-claim|Conditional FDs"` → 39 passing.
- `yarn workspace @quereus/quereus test` → **5523 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → exit 0. `… build` (tsc) → exit 0.
- `test:store` NOT run — pure planner logic, no store path touched.
