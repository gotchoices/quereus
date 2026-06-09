description: Sealed the BI-DIRECTIONAL guard-activation producer of the FD bag-as-set over-claim (site 7). When `FilterNode.activateGuardedFds` strips the guard off an implication-form CHECK's value-equality body (`status <> 'active' or a = b`), the now-unconditional `{a}↔{b}` is gated on endpoint-superkey-ness against the filter's input keys and the equality is lifted as an EC instead. IMPLEMENTATION DEVIATES from the ticket's prescribed diff: the ticket's structural mirror-detection was found UNSOUND during implement (it lifts a false EC for non-equality mirror pairs), so a producer-side `valueEquality` marker is used instead. Build + full suite (5519) + lint green. Flags a NEW pre-existing wrong-results bug (one-way guard-activation) filed as `fd-oneway-guard-activation-key-bag-overclaim`.
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/conditional-fds.spec.ts, docs/optimizer.md
----

## What shipped

`FilterNode.activateGuardedFds` (`filter.ts`) now returns `{ fds, activatedEquivPairs }`.
When a guarded FD's guard is entailed by the predicate, it is `stripGuard`-ed as before,
**except** for a **value-equality** single↔single FD (`fd.valueEquality === true`): that
FD's pair `[a,b]` is collected for unconditional EC lift, and the stripped determination
FD is folded **only when an endpoint is a superkey** of the filter's input keys
(`isSuperkey([a]|[b], sourceFds, colCount)` — `isSuperkey`/`computeClosure` skip guarded
FDs, so only genuine unguarded PK/UNIQUE keys count). `computePhysical` merges
`activatedEquivPairs` into `equivClasses` and re-closes `constantBindings` over the
enlarged EC set (`constantBindings` and `equivClasses` made `let`; `sourceAttrs.length`
threaded into the call).

This prevents an implication-form CHECK's activated `{a}↔{b}` from being read by
`deriveKeysFromFds` as a phantom all-columns key once a narrow projection
(`select distinct a, b`) drops the table's real key — which would drop a REQUIRED DISTINCT
and leak duplicate rows. The EC (value-equality, never read by `keysOf`) preserves the
fact soundly, mirroring the table-reference gate (site 5).

### Why the implementation deviates from the ticket's prescribed diff (READ THIS)

The ticket prescribed detecting the value-equality bi-pair **structurally** — two guarded
single↔single mirror FDs (`{a}→{b}` + `{b}→{a}`) sharing a guard (via `guardsEqual`) — and
asserted the lifted EC is "unconditionally sound." **That is false, and I confirmed it
empirically during implement.** Two *non-equality* sources produce a structurally
identical guarded mirror pair:

- two partial UNIQUE indexes on a 2-col table (`unique(a) where g`, `unique(b) where g`), and
- two one-way implication checks (`… or b = a + 1` and `… or a = b - 1`) with the same guard.

For both, `a ≠ b`, yet structural detection would lift EC `{a,b}` (claiming value-equality)
— an **unsound** over-claim of the EC invariant. A throwaway probe spec reproduced the
false EC `[[0,1]]` for the two-one-way-checks case (the row-drop did not manifest for the
specific query I tried, but the EC invariant — "these columns hold equal values for every
row" — was violated, which a future EC consumer could exploit into wrong results).

The sound fix: tag genuine value-equality at the **producer**. `recognizeGuardedBody`
(`check-extraction.ts`) sets `valueEquality: true` on the mirror pair it emits **only** for
a bare `col = col` body; the one-way `col = expr` branch and index-derived guarded FDs are
NOT tagged. `FilterNode` lifts the EC only for tagged FDs — exactly how site 5 drives its
EC from the producer's `equivPairs`, never from FD shape. This also **deletes** the ticket's
fragile O(n²) structural scan and the `guardsEqual` export (reverted to private). New
optional field `FunctionalDependency.valueEquality?: boolean` (ignored by dedup, like
`source`).

**Marker-survival caveat (intentional, fail-safe):** `shiftFds` / `projectFds` /
`stripGuard` reconstruct FD objects and DROP the marker, so the marker survives only the
by-reference pass-through path TableRef → Retrieve → Filter (the in-scope case;
`addFd`/`foldGatedProducerFds` preserve the object). A value-equality guard activated
**through a join or projection before the filter** would not lift the EC — an under-claim
(lost optimization), never unsound. Acceptable per the soundness-over-completeness bar; a
reviewer wanting EC-lift through shifts must thread the marker into those helpers.

## How to validate / use cases

### End-to-end (the wrong-results floor)

`test/fd-derived-key-bag-overclaim.spec.ts` site 7 (new), mirroring sites 4–6:

```sql
-- repro (id PK ⇒ a/b NOT keys): DISTINCT must SURVIVE, 2 rows
create table tgact (id integer primary key, a integer, b integer, status text,
    check (status <> 'active' or a = b));
insert into tgact values (1,5,5,'active'),(2,5,5,'active'),(3,7,7,'active');
select distinct a, b from tgact where status = 'active';     -- 2 rows, DISTINCT retained

-- control (a IS the PK ⇒ {a}↔{b} a real key): DISTINCT must be ELIMINATED
create table tgactpk (a integer primary key, b integer, status text,
    check (status <> 'active' or a = b));
select distinct a, b from tgactpk where status = 'active';   -- DISTINCT eliminated
```

### Physical-property surface

`test/optimizer/conditional-fds.spec.ts` activation test (renamed/updated): after
`where status='active'` activation, the Filter's physical props must show the bi-FD
`{1}→{2}` / `{2}→{1}` GATED (absent) and an EC `{1,2}` lifted (columns id=0,
customer_region=1, assigned_region=2, status=3).

### Soundness regression probes the reviewer should re-run (I deleted the throwaway specs)

- **Two one-way checks** (`… or b = a + 1` and `… or a = b - 1`, same guard) → Filter
  physical props must have **no** EC over `{a,b}` (a≠b). Confirmed: `ecs = []`.
- **Two partial uniques** on a 2-col table, same guard → no EC `{a,b}`. Confirmed: `ecs = []`
  (and those FDs are multi-dependent `{a}→{b,status}`, so doubly safe).

### Commands

- `node packages/quereus/test-runner.mjs --grep "FD-derived key bag over-claim|Conditional FDs"` → 35 passing.
- Full `yarn workspace @quereus/quereus test` → **5519 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus build` (tsc type-check) → clean.
- `yarn workspace @quereus/quereus lint` → clean.
- `test:store` NOT run — pure planner logic, no store path touched.

## Known gaps / honest flags for the reviewer

1. **MAJOR, pre-existing, FILED — one-way guard activation still over-claims (WRONG RESULTS).**
   `check (status <> 'active' or b = a + 1)` emits a *one-way* guarded `{a}→{b}` (no
   `valueEquality` tag). After activation it folds **ungated**, so
   `select distinct a, b where status='active'` over a non-keyed table drops the DISTINCT
   (confirmed: 3 rows instead of 2, `DistinctNode` count 0). This is the guard-activation
   twin of the open `fd-oneway-determination-key-bag-overclaim` and shares its completeness
   tradeoff, so I did **not** expand this (bi-directional-scoped) ticket. Filed as
   `tickets/fix/fd-oneway-guard-activation-key-bag-overclaim.md` (prereq on the existing
   one-way ticket) with repro, mechanism, and a precise one-line fix (move the `isSuperkey`
   gate out from under the `valueEquality` guard so it covers all single↔single activated
   FDs; the code is already structured to make this trivial). **The ticket title's "last
   unsealed producer" is accurate only for the BI-DIRECTIONAL shape.**

2. **`isUnique` closure branch (`fd-utils.ts:840`) unchanged** — sound by construction once
   the producer keeps the over-claim out of the FD set (consistent with sites 1–6). The
   deeper reader-side fix (option B in both one-way tickets) that would close ALL sites at
   once is still deferred.

3. **Optional `property.spec.ts` Key-Soundness shape NOT added** — the ticket marked it
   optional ("only if it fits without large effort"). The general Key Soundness differential
   passes; a bespoke guarded-implication + filter + DISTINCT generator shape was not wired in.
   Worth adding when the one-way sibling lands (it would catch both classes).

4. **Marker not threaded through `shiftFds`/`projectFds`** (see caveat above) — deliberate;
   fail-safe under-claim. Reviewer may judge whether the join/project EC-lift is worth the
   extra plumbing.

## Suggested review focus

- Re-derive the soundness argument for the EC lift: is `valueEquality` set **only** on
  genuine `col = col` bodies, and is it impossible for a non-equality FD to acquire it?
  (Marker set at one producer site; never copied onto other FDs.)
- Confirm the gate (drop FD when neither endpoint a superkey) can only ever lose an
  optimization, never add a key claim — i.e. soundness is preserved even if the marker logic
  is wrong.
- Re-run the two soundness probes above (two-one-way-checks, two-partial-uniques) and the
  one-way repro from gap #1 to independently confirm the boundary.
