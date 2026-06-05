description: When ALTER TABLE ADD COLUMN runs while the issuing connection has uncommitted staged rows in the isolation overlay, those staged rows get NULL for the new column regardless of its DEFAULT — `translateOverlayRow` appends a hardcoded `null`. This predates per-row (`new.<column>`) backfill; even a literal DEFAULT is dropped for staged overlay rows. Per-row defaults make it more visible (each staged row should get its own computed value).
files: packages/quereus-isolation/src/isolation-module.ts
----

## Problem

`migrateOverlayForAlter` → `translateOverlayRow` (in
`packages/quereus-isolation/src/isolation-module.ts`) translates the connection's
uncommitted overlay rows to the post-ALTER column layout. For `addColumn` it appends a
literal `null`:

```ts
case 'addColumn':
    // New column is always appended after existing data columns.
    newData = [...data, null];
    break;
```

So a row staged (inserted/updated but not yet committed) by the same connection that then
issues `ALTER TABLE … ADD COLUMN … DEFAULT (…)` ends up with `null` for the new column,
ignoring the DEFAULT entirely. The underlying committed rows ARE backfilled correctly (the
store/memory module applies the literal default or the per-row evaluator); only the
overlay-staged rows are wrong.

This is **pre-existing** — it affects literal defaults too — but the
`add-column-new-ref-backfill` work surfaces it: a `new.<column>` default means each staged
row should receive its *own* computed value, not a shared default, so the gap is no longer
"append one constant we happen to ignore."

## Expected behavior

A staged overlay row should receive the new column's DEFAULT value on ALTER, consistent
with how committed rows are backfilled:

- literal / NULL default → the folded value (or NULL),
- non-foldable default (e.g. `new.<column>`) → the per-row value computed from that staged
  row (the same evaluator semantics the module applies to committed rows).

## Notes / open questions

- Is ADD COLUMN even intended to be legal mid-transaction with staged writes on the same
  connection? If it should be disallowed, a clear rejection is an acceptable resolution
  instead of backfilling the overlay. Decide the policy before implementing.
- The `backfillEvaluator` is currently consumed inside the module's `alterTable`; the
  isolation layer passes `SchemaChangeInfo` through unchanged and has no access to it. If
  the overlay must apply per-row defaults, the evaluator (or an equivalent) needs to be
  reachable from `migrateOverlayForAlter`.
- Untested today: existing ALTER ADD COLUMN tests commit before the ALTER.
