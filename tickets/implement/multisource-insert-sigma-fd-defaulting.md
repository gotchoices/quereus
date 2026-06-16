description: Lift the join body's σ (where-clause) equality constants into the multi-source (inner-join) INSERT envelope as per-side insert-defaults, so an omitted σ-constrained column is supplied the σ constant — the inserted row then satisfies the view predicate and is visible through the view, matching the single-source path. Also reject an explicit insert value that contradicts a σ constant at plan time.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic
difficulty: medium
----

## Problem (pinned)

The single-source insert-through path applies **constant-FD defaulting** from an
equality selection predicate: inserting through `create view GreenMen as select * from Men
where Color = 'green'` omitting `Color` defaults it to `'green'`, so the row satisfies the
view predicate and is visible through the view (`single-source.ts`
`extractFilterConstants` → `collectAppendedDefaults`, docs/view-updateability.md
§ Selection (σ), line 118).

The **multi-source inner-join** insert envelope (`analyzeMultiSourceInsert` in
`multi-source.ts`, built by `buildMultiSourceInsert` in `view-mutation-builder.ts`) does
**not** consult the join body's `where` at all. An omitted σ-constrained base column lands
at its base default / NULL, so the row is written but is **invisible** through the same
view. Repro (`93.6` JV fixture, and any standalone filtered inner-join view):

```sql
create view SV as
  select sv1.id as id, sv1.x as x, 'a' as src
  from sv1 join sv2 on sv1.id = sv2.id where sv1.color = 'red';
insert into SV (id, x, src) values (5, 50, 'a');
-- today: sv1 gets (5,50,NULL) → row INVISIBLE through SV (color NULL fails `where color='red'`)
-- wanted: sv1 gets (5,50,'red') → row visible through SV
```

This is a **pre-existing correctness asymmetry**, not a regression from the set-op join-leg
work — that path faithfully reuses this envelope (`buildMultiSourceInsert` is the single fix
point for both standalone join views and set-op join legs). The target behavior is fully
specified below; no open design question remains.

## Design

### Source of the σ constants

Re-scan the join body's `where` AST (`analysis.sel.where`) for `column = literal`
conjuncts, resolving each column to its owning join side — the side-aware analog of
single-source `extractFilterConstants`. This is the established write-path pattern (the
single-source insert rewrite re-scans the AST rather than reading the planned body's
`attributeDefaults`, because a σ-constrained column is frequently **projected away** — `color`
is not a `SV` output column — so it has no surviving output attribute to key a constant-FD
default on). Only **literal** RHS values are lifted (parity with single-source; a `where
color = :p` parameter or a `col = col` / non-equality conjunct is not a constant-FD producer
and is skipped — document the parity boundary).

New helper in `multi-source.ts`, e.g.:

```ts
interface JoinFilterConstant {
  readonly sideIndex: number;     // resolveColumnSide(colRef, sides)
  readonly baseColumn: string;    // the side's base column name (canonical case)
  readonly valueExpr: AST.Expression;  // the literal node (cloned at injection)
  readonly value: SqlValue | undefined; // for the contradiction check; undefined ⇒ unprovable
}
function extractJoinFilterConstants(where: AST.Expression | undefined, sides): JoinFilterConstant[]
```

Reuse `flattenAnd` (already imported via `single-source.ts`) and `resolveColumnSide`
(already in `multi-source.ts`, handles alias-qualified `sv1.color` AND unqualified columns,
returning `undefined` for ambiguous/unresolved — skip those conjuncts conservatively, parity
with `joinCorrelatesMutualFk`). Resolve the side's canonical base-column name via
`columnByName(sides[sideIndex].schema, colRef.name)`.

### Routing the constants in `analyzeMultiSourceInsert`

For each `JoinFilterConstant fc` (sideIndex S, baseColumn B):

1. **Supplied-and-contradicting → reject.** If some supplied entry maps to (S, B) — match a
   `baseSupplied` entry by `s.sideIndex === S && s.baseColumn.toLowerCase() === B.toLowerCase()`
   (this handles a **renamed** view column, since `supplied[i].baseColumn` is the resolved
   base column, not the view spelling) — run the single-source contradiction check against
   the VALUES literal cells: reject `predicate-contradiction` when a literal cell ≠ `fc.value`
   (skip non-literal cells and `fc.value === undefined`, exactly as single-source
   `checkContradiction`). No default is appended (the user supplies the value). The contradiction
   scan needs a `VALUES` source; for a `SELECT` source skip it (unprovable → proceed, parity).
2. **Not supplied, owning side ACTIVE → default.** If no supplied entry maps to (S, B) and
   side S is in `activeIndices`, and B is **not** the side's shared join-key column
   (`keyColumns[S]` — the EC/key thread owns that value; a σ on a join key is degenerate, skip
   the default there), append a σ-default `{ baseColumn: B, valueExpr: fc.valueExpr }` to side
   S's spec.
3. **Not supplied, owning side INACTIVE → skip.** A σ on a non-preserved side that is *not*
   active for this insert (a preserved-only insert: no row is written to that side) gets no
   default — there is no base row to default into. Accept the residual (the row reads back
   null-extended and may be invisible through a view whose σ constrains the non-preserved
   side) and document it: this is structural — no value the engine could supply without
   fabricating a non-preserved row would make it visible.

**Outer-join decision (resolved):** the constant-FD lift applies to **any active side**,
which subsumes "preserved-side σ" and additionally fixes the *both-side* insert through an
outer-join view whose σ constrains the (now active) non-preserved side — that row becomes
visible. The lift is **never** applied to an inactive non-preserved side (case 3). The σ
default is a per-row **constant** projection; it is NOT added to the side's
`presenceGateIndices`, so it never makes an otherwise-absent optional side "present" — it only
fills the σ column for rows the presence gate already admits.

### Carrying the default to the build

Extend `MsInsertSide` with a new field (constants are not envelope-sourced — they are
per-row constants, so they need no envelope column, unlike the minted key):

```ts
readonly sigmaDefaults?: readonly { readonly baseColumn: string; readonly valueExpr: AST.Expression }[];
```

Populate it in the per-side spec loop in `analyzeMultiSourceInsert`. Run σ-default routing
**before** `assertNoMissingNotNull(view, side.schema, targetColumns)` and include the
σ-default base columns in the covered set passed to that assertion — a σ default legitimately
satisfies a NOT-NULL-without-default base column (e.g. `where color='red'` covering a NOT NULL
`color`).

In `buildMultiSourceInsert` (`view-mutation-builder.ts`, the per-side `plan.orderedSides.map`
loop): after building the envelope-routed/gated-key projections, append one projection per
`side.sigmaDefaults` entry whose **node is the compiled constant** —
`buildExpression(ctx, valueExpr) as ScalarPlanNode`, alias = `baseColumn` — and append
`baseColumn` to the side AST insert's `columns`. The base-table builder (`buildInsertStmt`)
then coerces the literal to the column type and runs every constraint exactly as for the
single-source appended-VALUES cell. Because the constant projection rides the side's
`ProjectNode` (not the VALUES rows), this path supports a **`SELECT`-source** insert too — a
strict capability gain over single-source (which defers σ-defaulting for SELECT sources with
`unsupported-source`); note this in the docs as intentional.

### No new diagnostic codes

Reuse `predicate-contradiction` (already defined; `single-source.ts`/`mutation-diagnostic`).
No `keyDefault` / envelope-shape changes — σ defaults bypass the envelope entirely.

## Edge cases & interactions

- **σ column projected-away (the repro)** — `color` not a view output column; not suppliable,
  never contradicts, owning side active ⇒ defaulted ⇒ row visible. Primary positive test.
- **σ column supplied with the matching literal** — no default, no reject (idempotent).
- **σ column supplied with a contradicting literal** — reject `predicate-contradiction` at
  plan time (VALUES source). Test both a projected-and-supplied σ column and a renamed one.
- **σ column supplied via a parameter / non-literal cell, or SELECT source** — contradiction
  unprovable ⇒ proceed (no default, column is supplied); a value that violates σ yields an
  invisible row, same accepted residual as single-source. Document.
- **σ on a non-preserved side, preserved-only insert (inactive side)** — no default, row may be
  invisible (structural). Document; assert the preserved-only insert still succeeds (not
  rejected) and writes the preserved side.
- **σ on a non-preserved side, both-side insert (active side)** — defaulted ⇒ row visible.
- **σ column == the side's shared join key** — skip the default (key/EC thread owns the value);
  still contradiction-check if the key is supplied. Degenerate but must not double-write the key.
- **σ default covers a NOT NULL base column with no declared default** — must run before
  `assertNoMissingNotNull` and count toward coverage (otherwise a spurious `no-default`).
- **Multiple σ conjuncts across different sides** — each routes to its owning side independently.
- **σ conjunct resolving to no side / ambiguous** (`resolveColumnSide` → undefined) — skip
  conservatively (parity). E.g. an unqualified column present on two sides.
- **Non-equality / non-literal σ** (`qty > 0`, `color = other_col`) — not lifted (parity); the
  row may not satisfy that conjunct if the column is omitted — same single-source limitation.
- **ON-clause constants** (`a left join b on a.id=b.id and b.k='x'`) — out of scope: these are
  join-match semantics, not a post-filter σ. Only `sel.where` is consulted. Document the
  boundary (a follow-up if a use case needs it).
- **Set-op join-leg insert** — the JV/93.6 path routes through `buildMultiSourceInsert`, so the
  fix applies automatically; the leg view's body carries the leg `where`. Update the fixture.
- **Existence-flag / authored columns** — σ defaults target distinct base columns via `where`
  and are independent of existence-directive and authored-put handling; no interaction, but
  confirm a σ-defaulted column name never collides with a side's existence/authored targets in
  the per-side projection list (distinct base columns by construction).
- **Multi-row VALUES** — each row gets the same constant σ projection; the contradiction scan
  walks every row and rejects if any cell contradicts.

## Key tests (expected outputs)

Add a positive section to `93.4-view-mutation.sqllogic` near Phase 2b (the existing
shared-surrogate insert worked example, ~line 2135):

- Standalone filtered inner-join view, σ on a **projected-away** column, key **supplied**:
  ```sql
  create table sv1 (id integer primary key, x integer, color text null);
  create table sv2 (id integer primary key, y integer null);
  insert into sv1 values (1,10,'red'); insert into sv2 values (1,100);
  create view SV as select sv1.id as id, sv1.x as x from sv1 join sv2 on sv1.id = sv2.id where sv1.color = 'red';
  insert into SV (id, x) values (5, 50);
  select id, x, color from sv1 order by id;  → (1,10,'red'),(5,50,'red')   -- color DEFAULTED
  select id, x from SV order by id;           → (1,10),(5,50)               -- row VISIBLE
  ```
- σ on a **projected** column, supplied with the **matching** value ⇒ succeeds; supplied with a
  **contradicting** value ⇒ `error:` (the runner's structured-error assertion for
  `predicate-contradiction`).
- σ over a **minted** shared key (anchor `default`) — combine with the Phase 2b allocator
  pattern: a σ-constrained non-key, non-projected column on the anchor side is defaulted while
  the key is still minted once per row.
- Outer-join **both-side** insert with σ on the now-active non-preserved side ⇒ visible; the
  **preserved-only** insert with the same view ⇒ succeeds, row null-extended/invisible
  (documented residual).

Update `93.6-set-op-flagless-write.sqllogic` (the JV fixture, ~line 306-315): the join leg's
`where jv1.color='red'` IS now consulted on insert. Change the expected `jv1` row from
`(5,50,null)` to `(5,50,'red')`, replace the "σ NOT consulted" note with the σ-honoring rule,
and add a positive `select * from JV order by id;` showing the inserted `(5,50,'a')` row now
appears through the view.

## Docs

- `docs/view-updateability.md` § Inner Join — **Inserts** (~line 151): state that the body's σ
  equality constants are lifted as per-side insert-defaults (the multi-source analog of the
  § Selection rule), that an explicit value contradicting σ rejects at plan time
  (`predicate-contradiction`), and that the lift applies to any **active** side (so a both-side
  outer-join insert over a non-preserved-side σ is visible) but NOT to an inactive
  (preserved-only) side. Note the SELECT-source capability gain over single-source.
- § Outer Joins — Inserts (~line 178/186): one line that a preserved-only insert through a view
  whose σ constrains the non-preserved side yields a null-extended/invisible row (structural).
- Cross-reference § Selection (σ) line 118 so the two paths read as one rule.

## TODO

- [ ] Add `extractJoinFilterConstants(where, sides)` to `multi-source.ts` (literal-equality
      conjuncts → `{sideIndex, baseColumn, valueExpr, value}`, side-resolved via
      `resolveColumnSide` + `columnByName`; skip unresolved/ambiguous/non-literal). Import
      `sqlValuesEqual` from `../../util/comparison.js` and `SqlValue` typing as needed.
- [ ] In `analyzeMultiSourceInsert`: route each constant — contradiction-reject when supplied
      (VALUES literal cells, reusing the single-source `checkContradiction` logic, factor a
      shared helper if clean), else append a σ-default to the owning side's spec when the side
      is active and B is not the shared key. Run before `assertNoMissingNotNull` and fold the
      σ-default columns into its covered set.
- [ ] Add `sigmaDefaults?` to `MsInsertSide`; populate in the per-side spec loop.
- [ ] In `buildMultiSourceInsert` (`view-mutation-builder.ts`): append a constant
      `buildExpression(ctx, valueExpr)` projection (alias = baseColumn) and the base column to
      each side AST insert's `columns`, per `side.sigmaDefaults`.
- [ ] Tests: positive σ-defaulting + contradiction reject in `93.4`; update `93.6` JV
      assertions + add positive visibility.
- [ ] Update `docs/view-updateability.md` (§ Inner Join — Inserts, § Outer Joins — Inserts,
      cross-ref § Selection).
- [ ] `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` and
      `yarn lint` (single-quote globs on Windows). Fix any fallout in the diff; flag genuinely
      unrelated pre-existing failures per the ticket rules.
