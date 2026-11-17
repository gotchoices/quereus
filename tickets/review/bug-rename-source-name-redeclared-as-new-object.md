description: A schema declaration that renames a column (or table, view, index, constraint) and also declares a new object under the old name used to produce a broken migration; the diff now refuses it with a clear "Rename conflict" error. Review the guard, its error wording and its test.
architecture: docs/schema-rename-detection.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # resolveRenames ~1101 (new guard ~1199-1209, new optional `noun` arg); resolveColumnRenames ~2338 passes noun 'column'
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic   # new §29 at the end
  - docs/schema-rename-detection.md   # conflicts list near the top; pass-1 invariant sentence (~line 30)
----

# Refuse a rename whose old name is declared again as a new object

## What was wrong

`resolveRenames` paired each declared object with an existing one by name, then by `quereus.previous_name` / `quereus.id` hint, but never checked whether the existing object a hint resolved to was also matched by name by another declared object. So with existing column `x`, declaring `x integer` plus `y integer with tags ("quereus.previous_name" = 'x')` paired the declared `x` with the existing `x` (no ADD) while `y` renamed that same `x` away — the declared `x` went missing silently, or the plan failed mid-apply (`Column 'x' not found`) when the new `x` differed. Same shape for tables, views, indexes and named constraints.

## What changed

- `resolveRenames` (non-`'deny'` path only): when a declared object's hint resolves to a different existing object whose name is also a key in the `declared` map, throw `QuereusError` (`StatusCode.ERROR`): `Rename conflict for <noun> '<declared name>': its rename source '<old>' is also declared as a new <noun>; apply the rename first, then remove the quereus.previous_name/id hint and declare '<old>' in a later apply`. Because `declared` is the full map, the check fires in either declaration order. It sits after the existing "declared name and hint resolve to different existing objects" check (not reordered) and before the "already consumed" check.
- Refused rather than honoured, per the ticket's decision: a declaration keeping the hint beside a reused old name can never re-diff cleanly (every later diff throws the first conflict), and the reconcile passes rely on no old name being declared.
- New optional `noun` argument on `resolveRenames` (defaults to `kind`), used in all three error messages. `resolveColumnRenames` passes `noun: 'column'`, so column conflicts now say "column 'y'" instead of the misleading "constraint 'y'". `RenameKind` is unchanged. No existing test asserted the old "constraint" noun (grepped `packages/` for `Rename conflict for constraint` and `on constraints in actual`: no hits).
- Docs: the conflicts paragraph in `docs/schema-rename-detection.md` is now a two-item list with the new conflict, the two-apply path, and the note that a hint left after its old name is reused makes later diffs throw; the pass-1 invariant sentence now says every old name is present *and not declared*.

## Test added

- `50.2-declare-schema-renames.sqllogic` §29 — the bug reproduction at the user-facing layer:
  - Column case: existing `t29.x`; declared `x` placed **before** `y previous_name 'x'` → `diff schema main` errors `Rename conflict for column 'y'`. Pins order-independence (the declared `x` is visited and paired first) and the new "column" noun.
  - Table case: existing `a29`; declared `b29 previous_name 'a29'` placed before a new `a29 { id, extra }` → errors `Rename conflict for table 'b29'`.
  - Verified the section fails without the guard (temporarily disabled it: "Expected error matching \"Rename conflict for column 'y'\" but SQL block executed successfully"), then restored.

Views, indexes and named constraints go through the same `resolveRenames` code; no separate tests (per the ticket).

## Validation

- `yarn workspace @quereus/quereus test`: 11185 passing, 23 pending, 0 failing (memory backend).
- `yarn workspace @quereus/quereus lint`: exit 0.
- `yarn test:store` not run — the guard throws inside the differ before any DDL, which is backend-independent.

## Things a reviewer may want to look at

- `previous_name` lists: candidates are tried in order and the first existing one wins. If `y` carries `previous_name = 'x, w'` with both `x` and `w` existing and `x` also declared, the guard refuses rather than falling through to `w`. I judged that correct (a hint naming a declared, existing object is the conflict the ticket describes) but it is a judgment call; not tested.
- Rename chains (`b` hints `a`, `c` hints `b`, `a` and `b` existing) were already refused via the first conflict on `b`; the new guard also catches `c`. Whichever is visited first throws; both messages begin `Rename conflict`. §5 and the rest of 50.2 are unaffected.
- The `'deny'` policy path is untouched (hints are ignored there, so the bad pairing cannot arise).
