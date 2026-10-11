---
description: When a storage module accepts one comparison on a column but refuses another comparison on the same column, the planner can still use the refused comparison's value to look up rows in the module's index, so the module receives a value it said it could not use and either fails or returns the wrong rows.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectPhysicalNodeFromPlan — handledByCol / isHandled and the per-role pickers (eqBySeekCol, findPrefixEq, findLower, findUpper, the OR_RANGE find)
  - docs/module-authoring.md                                                # "Claiming handledFilters — the positional contract"
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Modules can work around it by refusing to advertise a seek column that carries any comparison they declined, and the current per-column rule is documented as the positional contract, so a maintainer may prefer to keep the contract and leave the guard to modules.
---

# Seek argument taken from a constraint the module did not handle

Filed from the lamina board (`seek-candidates-match-engine-argument-pick`, plan stage). Lamina works around it on its side; this ticket is the engine-side fix.

## What happens

`selectPhysicalNodeFromPlan` decides which constraint supplies each seek argument by role: the first `=` / non-empty `IN` on each advertised seek column, else (prefix-range) the first single-value equality per prefix column plus the first lower and first upper bound on the trailing column, else the first lower / upper bound on the leading column, else the first `OR_RANGE`. "Handled" is tested per **column** (`handledByCol`), not per constraint. So when a module claims `handledFilters[j]` for one comparison on column `a` and leaves `handledFilters[i]` false for another comparison on `a` that comes earlier in the constraint list, the picker can choose constraint `i` and pass its value to `xFilter` / `query()` as the seek argument.

The module said it could not enforce constraint `i`, typically because the value does not belong to the column's type. It now receives that value anyway, in a slot it laid out for constraint `j` — possibly in a different role (an equality value in the slot the module expects for a lower bound).

## Measured from lamina (quereus 4.20.2)

Table `d (id integer primary key, a integer)`, rows 1..40 with `a = id`. Lamina declines a comparison whose value would change when converted to the column's type:

- `where a = x'01' and a = 1` — lamina claims `a = 1`, the engine seeks with `X'01'`; lamina's conversion of the seek argument throws "Cannot convert object to INTEGER". The memory module returns no rows.
- `where a = true and a > 0` — lamina claims `a > 0` (a range plan), the engine's equality arm fires on `a = true` and delivers its value; lamina binds it as the range's lower bound (`a > 1`), so the row `a = 1` is lost. Lamina returns no rows; the memory module returns `[1]`.

## Expected

A seek argument comes only from a constraint whose `handledFilters` entry is true. Constraints on an advertised column that the module did not handle are skipped by every picker and re-applied above the seek, as they already are.

## Notes

- `docs/module-authoring.md` documents the first-`=` rule as the positional contract; it should say the rule is over handled constraints once this lands.
- Lamina mirrors the current pickers (`engineSeekPickFor` in lamina's `packages/lamina-quereus/src/planner.ts`, once that ticket lands); after a publish with this fix, lamina can simplify that mirror.
