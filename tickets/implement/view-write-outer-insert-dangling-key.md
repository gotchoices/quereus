description: A both-side outer-join INSERT through a view threads the minted shared key into the preserved side's join column unconditionally, even for rows whose non-preserved value is null (the per-row presence gate drops that side's insert). The preserved row then points its FK at a minted key with no partner row — a dangling reference (FK violation with enforcement on; latent spooky-join otherwise). Fix: thread the shared key into the preserved (FK-child) side conditionally per row — `<joinKey> = case when <non-preserved present> then <key> else null end`.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## Status (from fix stage)

**Reproduced and root-caused.** The repro fails today with `CHECK constraint failed: _fk_ojc_pr` (the synthesized child-side FK) at deferred-constraint commit time:

```sql
pragma foreign_keys = true;
create table ojp (pp integer primary key default (coalesce((select max(pp) from ojp),0)+mutation_ordinal()), pv integer null);
create table ojc (cc integer primary key, pr integer null references ojp(pp), cv integer null);
create view ojv as select c.cc as cc, c.cv as cv, p.pv as pv from ojc c left join ojp p on p.pp = c.pr;

insert into ojv (cc, cv, pv) values (5, 55, null);
-- today: throws CHECK constraint failed: _fk_ojc_pr (ojc.pr = minted K, no ojp row pp=K)
-- want:  ojc.pr = null, ojp empty, view reads {cc:5, cv:55, pv:null}
```

The happy path (`insert into ojv (cc, cv, pv) values (6, 66, 666)`) already works and must stay working — verified passing during the fix stage. With FK off the bug is silent today but `ojc.pr` still holds a bogus surrogate instead of null (latent spooky-join).

## Root cause (verified file/line references)

`analyzeMultiSourceInsert` in `packages/quereus/src/planner/mutation/multi-source.ts` (lines ~391–594). For each active side it builds an `MsInsertSide` (interface ~lines 337–350) with:
- `targetColumns` / `envelopeIndices` — the shared key (pushed **first** when `needsSharedKey`, lines 570–573) followed by the supplied view columns the side owns;
- `presenceGateIndices` — the per-row presence gate for a **non-preserved** active side (line 582: `if (!side.preserved) presenceGateIndices.push(idx)`), which drops that side's insert for rows supplying only nulls.

The documented v1 caveat is at lines 553–564: the **preserved** (FK-child) side threads the minted key into its join column **unconditionally**, even when the non-preserved (FK-parent) partner is dropped for that row. So `ojc.pr = K` while no `ojp` row has `pp = K`.

The builder `buildMultiSourceInsert` in `packages/quereus/src/planner/building/view-mutation-builder.ts` (lines ~456–517) consumes the spec:
- it gates a non-preserved side's whole insert through a `FilterNode` over `buildPresenceGate(...)` (lines 472–474, helper at 735–744) — that is the per-row drop;
- it projects each `targetColumn` as a plain `ColumnReferenceNode` over the `EnvelopeScanNode` (lines 475–486) — including the key column, with **no** conditional.

`__shared_key` is appended to `envelopeAttrs` when a key is minted (`buildEnvelopeShape`, lines 582–589); `keyEnvelopeIndex` (analyze, lines 538–551) is either a supplied key column index or `supplied.length` (the appended `__shared_key`). Both are valid envelope indices and both are registered by the envelope-scope construction `buildPresenceGate` already uses.

## Fix design (verified against the code)

Thread the shared key into an FK-**child** side's join column conditionally per row:
`<joinKey> = case when <parent-present predicate> then <key> else null end`.

The FK direction is already computable here: `sideDeclaresFkOnto(child, parent)` (multi-source.ts ~line 2382) and the topo `orderSides` (~line 2411) place FK-parent before FK-child. **Only** a side that declares an FK onto a *presence-gated* active partner gets the conditional — a side whose key column is its own referenced PK (the parent / anchor case, e.g. `ojp p left join ojc c on c.pr = p.pp`) stays **unconditional** (nulling a NOT NULL PK would be wrong; the parent inserts fine and the child simply doesn't materialize). A key shared only among always-active sides also stays unconditional.

This is the n-way generalization the ticket asks for: gate a side's key column on the **AND** over each presence-gated optional partner it references of that partner's presence predicate (each partner's predicate being the **OR** of its supplied columns being non-null — the same `presenceGateIndices` already built for it).

### Data-model change (`multi-source.ts`, `MsInsertSide` ~lines 337–350)

Add an optional field describing the key column's conditional gate:

```ts
export interface MsInsertSide {
  readonly table: TableReferenceNode;
  readonly schema: TableSchema;
  readonly targetColumns: readonly string[];
  readonly envelopeIndices: readonly number[];
  readonly presenceGateIndices: readonly number[];
  /**
   * Set when this side's shared-key (FK-child) column must be threaded conditionally:
   * `keyTargetIndex` is its position in `targetColumns` (0 — the key is pushed first
   * when needsSharedKey), and `groups` is an AND-of-(OR-within) list of envelope
   * indices — one inner group per presence-gated FK-parent partner — that gates the
   * key. When all referenced presence-gated partners are absent for a row, the key
   * column projects null (the correct "no partner" marker), so the FK does not dangle.
   * Absent ⇒ the key threads unconditionally (a parent/anchor side, or a key shared
   * only among always-active sides).
   */
  readonly keyGate?: { readonly keyTargetIndex: number; readonly groups: readonly (readonly number[])[] };
}
```

### Populate it in `analyzeMultiSourceInsert` (the side-spec loop ~lines 565–586)

Record each active side's presence indices as the spec is built (e.g. a `Map<number, number[]>`), then, **only when `needsSharedKey`**, post-process each active side `S`: collect the presence indices of every active partner `P` (`P !== S`) where `presence(P).length > 0` **and** `sideDeclaresFkOnto(sides[S], sides[P])`; if any, set `S.keyGate = { keyTargetIndex: 0, groups: [...presence groups...] }`. The key is at target index 0 because it is pushed first (lines 570–573).

For the repro: `S = ojc` (preserved, declares FK onto `ojp`), `P = ojp` (presence-gated, `presence = [pvIdx]`) ⇒ `ojc.keyGate = { keyTargetIndex: 0, groups: [[pvIdx]] }`. `ojp` declares no FK ⇒ no gate ⇒ its `pp` threads unconditionally. Correct.

### Apply it in `buildMultiSourceInsert` (projection loop ~lines 475–486)

When `side.keyGate` is set and the current target index `k === side.keyGate.keyTargetIndex`, replace the plain `ColumnReferenceNode` with a gated CASE expression built over the envelope scope:
`case when <pred> then "<keyColName>" else null end`, where `<pred>` = `groups.map(g => '(' + g.map(i => '"<envName_i>" is not null').join(' or ') + ')').join(' and ')` and `<keyColName>` = `envelopeAttrs[keyEnvIdx].name` (the `__shared_key` or supplied key column — already registered in the envelope scope).

Factor the scope construction shared with `buildPresenceGate` (lines 735–744) into a small `envelopeColumnScope(ctx, envelopeAttrs)` helper, then add a `buildGatedKeyProjection(ctx, envelopeAttrs, keyEnvIdx, groups)` that parses the CASE string via `parseExpressionString` (already imported, line 25) and `buildExpression`s it against that scope — the same pattern `buildPresenceGate` uses. Reuse `quoteIdent` (line 791). Confirm `parseExpressionString` accepts `case when … then … else … end` (it should — standard SQL; add a guard/early test if not).

The non-preserved side's own `FilterNode` drop (lines 472–474) is unchanged and composes with the child-side CASE independently.

## Acceptance (from the ticket)

- The repro round-trips with `pragma foreign_keys = true`: `ojc.pr` null, view reads `{cc:5, cv:55, pv:null}`, no FK violation, `ojp` empty.
- A both-side insert with a **non-null** pv still threads the real key and the parent row materializes (unchanged happy path).
- A multi-row VALUES / SELECT source mixing null and non-null non-preserved values routes each row independently (per-row CASE, not a statement-level decision).
- The parent/anchor-preserved shape (`ojp p left join ojc c on c.pr = p.pp`) is unaffected — the preserved side's key (its own PK) stays unconditional.

## TODO

- Add the `keyGate` field to `MsInsertSide` in `multi-source.ts` with the doc comment above.
- In `analyzeMultiSourceInsert`, capture per-side presence indices and populate `keyGate` for FK-child sides referencing presence-gated partners (AND-of-OR groups); guard on `needsSharedKey`.
- Update the v1-caveat comment block (multi-source.ts ~lines 553–564) to describe the now-implemented per-row conditional thread instead of the gap.
- In `buildMultiSourceInsert` (view-mutation-builder.ts), extract `envelopeColumnScope`, add `buildGatedKeyProjection`, and use it for the gated key target in the projection loop.
- Verify `parseExpressionString` parses a `case when … then … else … end` expression; if not, build the CASE plan node directly instead.
- Extend the LEFT-join INSERT coverage in `property.spec.ts` (the multi-source outer-join section near the inner-join `describe`, ~lines 3460+, and the existence/outer-join section ~lines 1968–2135): run with `pragma foreign_keys = true` and include rows where the preserved row is supplied but the non-preserved value is null (assert `pr` null, no parent minted, view null-extended), alongside non-null rows in the same multi-row insert.
- Add a `93.4-view-mutation.sqllogic` case under FK enforcement: a both-side insert with a null `pv` must leave `ojc.pr` null, mint no parent, and read back null-extended; a non-null `pv` in the same/adjacent insert still materializes the parent. Place it near the existing outer-join block (~lines 2077–2135), switching `foreign_keys` on for the new case (and restoring prior state if other cases below depend on it).
- Update `docs/view-updateability.md` § Outer Joins — Inserts (~lines 178–192): replace the implicit/explicit "dangling minted key" gap note with the per-row conditional-thread behavior (the preserved FK-child column is null when its partner is per-row absent).
- Run `yarn workspace @quereus/quereus run test` and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows); stream with `Tee-Object`/`tee`.
