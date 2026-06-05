description: Review the per-row conditional shared-key thread that fixes a dangling FK on a both-side outer-join INSERT through a view. The preserved (FK-child) side's join column is now nulled per row when its presence-gated non-preserved (FK-parent) partner is absent, instead of unconditionally threading the minted key at a partner row that was never created.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What the bug was

A both-side outer-join INSERT through a view (`ojc c left join ojp p on p.pp = c.pr`,
exposing `cc, cv, pv`) threaded the minted shared key into the preserved (FK-child)
side's join column **unconditionally**. For a row whose non-preserved value (`pv`) is
null, the non-preserved (FK-parent) side's per-row presence gate drops that side's
insert — but the preserved child still got `pr = <minted K>`, pointing its FK at a
parent row that was never created. Under `pragma foreign_keys = on` this threw
`CHECK constraint failed: _fk_ojc_pr` at deferred-constraint commit; with FK off it
left a bogus surrogate in `pr` (a latent spooky-join) instead of null.

## The fix (per-row conditional key thread)

Thread an FK-child side's shared-key column **conditionally per row**:
`<joinKey> = case when <partner-present> then <key> else null end`, where
`<partner-present>` is the AND, over each presence-gated FK-parent partner the side
references, of that partner's presence predicate (the OR of its supplied columns being
non-null — the same gate that drops the partner's insert). When every referenced
partner is absent for a row, the key column projects **null** (the "no partner"
marker) and the row reads back cleanly null-extended.

Three core pieces:

1. **`multi-source.ts` — `MsInsertSide.keyGate`** (new optional field): `{ keyTargetIndex,
   groups }`. `keyTargetIndex` is the key column's position in `targetColumns` (always 0
   — the key is pushed first under `needsSharedKey`); `groups` is an AND-of-(OR-within)
   list of envelope indices, one inner group per presence-gated FK-parent partner.
2. **`analyzeMultiSourceInsert` populate** (post-process after `specByIndex` is built,
   guarded on `needsSharedKey`): for each active side `S`, collect the presence indices
   of every active partner `P != S` where `P.presenceGateIndices.length > 0` **and**
   `sideDeclaresFkOnto(sides[S], sides[P])`; if any, set `S.keyGate`. The v1-caveat
   comment block was rewritten to describe the now-implemented behavior.
3. **`view-mutation-builder.ts` — gated projection**: extracted `envelopeColumnScope`
   (shared by `buildPresenceGate`) + `presencePredicateSql`, added
   `buildGatedKeyProjection` (parses the CASE via `parseExpressionString` and builds it
   over the envelope scope), and the projection loop swaps the plain
   `ColumnReferenceNode` for the gated CASE when `k === side.keyGate.keyTargetIndex`.

The non-preserved side's own presence `FilterNode` (its whole-insert drop) is unchanged
and composes with the child-side CASE independently.

## Validation performed (this is the floor, not the ceiling)

- `yarn workspace @quereus/quereus run build` → clean (tsc, exit 0).
- `yarn workspace @quereus/quereus run test` → **4814 passing, 9 pending**, exit 0.
- `yarn workspace @quereus/quereus run lint` → clean, exit 0.
- Manual repro (ts-node against src) confirmed all four acceptance cases (below).

### Use cases verified

1. **Repro, FK on:** `insert into ojv (cc, cv, pv) values (5, 55, null)` → view reads
   `{cc:5, cv:55, pv:null}`, `ojc.pr` is null, `ojp` empty, **no FK violation**.
2. **Happy path:** `insert into ojv (cc, cv, pv) values (6, 66, 666)` → real key minted
   + threaded, `ojp` row materialized, view `{cc:6, cv:66, pv:666}`. Unchanged.
3. **Multi-row mixed:** `values (6, 66, null), (7, 77, 777)` → each row routes
   independently (per-row CASE): cc=6 → `pr` null, cc=7 → `pr` = minted key, one parent
   materialized (pv=777).
4. **Parent/anchor shape unaffected:** `ap p left join ac c on c.pr = p.pp` (parent
   preserved) — the preserved side's key is its own PK (`pp`), declares no FK onto the
   child, so it stays **unconditional**; both-side and preserved-only inserts round-trip
   under FK on.

### Where the new tests live

- `test/logic/93.4-view-mutation.sqllogic` (appended at EOF, ~lines 2136+): a new
  `pragma foreign_keys = true` block (`ojp2`/`ojc2`/`ojv2`) covering the null-partner
  drop, the non-null materialization, and the multi-row mix. Restores
  `foreign_keys = false` at the end.
- `test/property.spec.ts` (~line 4612, in the outer-join `describe`): `it('outer (left)
  join insert: FK-enforced per-row conditional key thread (no dangling FK)')`.
- `docs/view-updateability.md` § Outer Joins: new "Insert — the per-row conditional key
  thread (no dangling FK)" note in the Shipped (LEFT) block.

## Known gaps / what a reviewer should scrutinize

- **n-way (>2 sides) generalization is by construction, not by test.** The populate loop
  ANDs the presence groups of *all* presence-gated FK-parent partners a side references,
  which is the n-way generalization the ticket asked for — but every test (new and
  existing) is 2-side. A 3-way join where the FK-child references **two** distinct
  presence-gated optional parents (so `groups.length === 2`, an AND of two OR-groups)
  is unexercised. Worth a targeted test or a careful read of the AND-of-OR assembly in
  both `multi-source.ts` (groups) and `buildGatedKeyProjection` (the `' and '` join).
- **`sideDeclaresFkOnto` gates on the *declared* FK, but the column nulled is the *join
  key*.** For the realistic case (the join key column **is** the FK column, as in every
  decomposable shared-key view) these coincide and nulling is exactly right. If a child
  declared an FK onto the parent on a column **different** from the equi-join key, the
  gate would null the join-key column (still the correct "no partner" join marker) while
  the actual FK column is untouched — benign for the dangling-FK concern but conceptually
  worth confirming the `sideDeclaresFkOnto` heuristic is the intended trigger vs. a
  stricter "the FK is on the shared-key column" check.
- **Supplied-key case also gets gated.** When the shared key is a *supplied* view column
  (not minted) and `needsSharedKey`, an FK-child side still gets `keyGate`, so a supplied
  key is nulled for a row whose partner is absent. This is consistent with the
  both-side-create model (the partner row is created from the same insert, so "partner
  absent" means "no partner to reference"), but it is untested — no shipped test exposes
  the join key as a view column. Confirm this is the intended semantics (vs. preserving a
  user-supplied key that might reference a pre-existing parent).
- **Minted key still evaluated for dropped rows.** The envelope always appends
  `__shared_key`, so the key default (`max()+mutation_ordinal()`) is computed even for a
  row whose partner is dropped and whose `pr` ends up null. Harmless (the value is
  unused), but it means `mutation_ordinal()` still advances for those rows.
- **Pre-existing, not mine:** `test/property.spec.ts` carries TypeScript language-server
  diagnostics at lines ~210, ~249, ~1457 (unreachable-code hints + a callback-arity type
  error). They are entirely outside this diff (which only adds at line 4612), do not fail
  build/lint/test, and predate this work — flagged here only so the reviewer doesn't
  attribute them to the change.
