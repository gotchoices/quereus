description: Fixed a planner bug where a column declared as JSON was wrongly assumed to never hold a text string, which could let the query planner over-claim that a filter matches at most one row when it actually matches several.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # isNonTextualLogicalType (~296) now delegates to logicalTypeCanHoldText
  - packages/quereus/test/planner/collation-soundness.spec.ts       # repro shape 5 (~89-98)
difficulty: easy
----

# Summary

`isNonTextualLogicalType` answered "can this logical type never hold a text
string?" and answered **yes** for `JSON`, because JSON's physical
representation is tagged `OBJECT`. That's false — `JSON_TYPE.parse` runs
input through `JSON.parse`, so a JSON scalar string round-trips to an
ordinary JS string (`'"Bob"'` stores as `Bob`). The predicate gates
`isValueDiscriminatingEquality`, which decides whether an equality is safe to
mint plan-time value-level facts from (constant pins, equivalence classes,
mirror FDs, join equi-pairs). With JSON wrongly exempted, a `NOCASE` equality
over two JSON operands could mint a false "at most one row" claim even though
`'Bob'` and `'bob'` are genuinely distinct storage values that both match
under `NOCASE`.

## The fix

Collapsed `isNonTextualLogicalType` into the negation of the already-correct,
already-exported `logicalTypeCanHoldText` (an allow-list over physical
representation: `INTEGER`/`REAL`/`BLOB`/`BOOLEAN` provably never hold a
string; everything else — including `OBJECT`/JSON — may):

```ts
function isNonTextualLogicalType(lt: LogicalType | undefined): boolean {
	return !logicalTypeCanHoldText(lt);
}
```

Two conservative (safe-direction) behaviour changes fall out:
- `JSON` is now treated as potentially textual — the bug fix itself.
- `NULL_TYPE` (physical `NULL`) is now potentially textual too, losing a
  theoretical optimization on an operand whose static type is exactly
  `NULL`. Nothing in the codebase currently mints a `NULL_TYPE`-typed
  comparison operand, so this is inert in practice.
- `ANY` was previously special-cased by name; the allow-list now catches it
  by physical representation (`NULL`) instead, so the name check is gone
  but the classification (potentially textual) is unchanged.

Also removed a stale `NOTE:` comment above `NEVER_TEXT_PHYSICAL_TYPES` that
forward-referenced this ticket and predicted the collapse — now true, so the
note is gone.

`columnCanHoldText` in `packages/quereus-store/src/common/store-table.ts`
was **not** touched — it's a thin `ColumnSchema`-shaped wrapper over the
same `logicalTypeCanHoldText` (not a divergent copy), and its doc comment
didn't reference this ticket or claim a divergence, so nothing there was
stale.

## Reproduction (fails before fix, passes after)

```sql
create table tj (j json, x integer, primary key (j, x)) using memory;
insert into tj values ('"Bob"',1), ('"bob"',1);
select * from tj where j = cast('"bob"' as json) collate nocase and x = 1;
```

Both rows are correctly returned either way (constant folding collapses the
`cast(... as json)` literal to plain TEXT before the optimizer rules
consume the fact, so no query in the wild was ever observed returning wrong
**rows** — see "What was not found" in the original ticket). The bug lived
in the logical plan's metadata: before the fix, `isAtMostOneRow(root)` was
`true` and `keysOf(root)` contained an empty key (claiming ≤1 row); after
the fix, `isAtMostOneRow(root)` is `false` and the real composite key
`[[0,1]]` is reported instead. That's exactly what regression test 5 in
`collation-soundness.spec.ts` pins.

Reaching the bug needs a JSON-typed operand on **both sides** of the
comparison plus a non-`BINARY` collation — a column-level `collate nocase`
on a JSON column is rejected at `CREATE TABLE` time
(`JSON_TYPE.supportedCollations` is `[]`), so the collation has to arrive
via an explicit `COLLATE` wrapper (as in the repro above) or the `json(...)`
function, with the constant side also cast/coerced to JSON.

## Testing done

- `yarn workspace @quereus/quereus run test`: **6734 passing, 9 pending**
  (was ~6733 before the new test; no regressions, one more test than before
  the ticket predicted since the count includes the new one).
- `yarn lint` (run directly for `packages/quereus`, which is the only
  package with a real lint config — eslint + `tsc -p tsconfig.test.json
  --noEmit`): clean, exit 0, no output.
- New regression test: `collation-soundness.spec.ts` → describe('repro
  shapes (must stay fixed)') → `'5: a NOCASE pin on a JSON column makes no
  ≤1-row claim'`. Confirmed it fails on pre-fix code (`isAtMostOneRow` was
  `true`) before applying the source fix, and passes after.

## Known gaps / things the reviewer should double-check

- No test exercises the fix against **actual wrong rows** returned to the
  user (as opposed to the internal `isAtMostOneRow`/`keysOf` metadata) —
  because, per the original ticket's investigation, no such case currently
  exists (constant folding intervenes first). If the reviewer wants extra
  confidence, a correlated-subquery or JSON-returning-UDF shaped repro that
  can't constant-fold would be the next escalation, but the ticket
  explicitly scoped this out as future/latent, not required here.
- I did not audit every other caller of `isNonTextualLogicalType` /
  `isStaticallyNonTextual` for behavior beyond what the ticket flagged
  (`astOperandContribution`, called twice) — only ran the full test suite
  and trusted it as the safety net for those call sites. Worth a quick
  grep-and-skim during review if time allows.
- The `NULL_TYPE`-loses-an-optimization side effect is asserted safe by
  reasoning ("nothing mints a `NULL_TYPE`-typed comparison operand today"),
  not by a dedicated test — matches the ticket's own framing of this as a
  non-issue, but flagging since it's an assertion rather than a proof.

## Review findings

(none yet — first pass)
