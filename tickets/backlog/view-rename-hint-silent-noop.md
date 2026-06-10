description: A hint-matched view rename (quereus.previous_name / quereus.id on a declared view) diffs empty and apply is a silent no-op — the old view name stays live, the declared new name never materializes. Indexes likely share the gap (unverified).
files:
  - packages/quereus/src/schema/schema-differ.ts        # viewRenames feed diff.renames (~331) but generateMigrationDDL emits DDL only for kind 'table' (~1675-1681); rename-matched views are consumed (no drop) and matched (no create)
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic  # rename-hint coverage exists for tables/columns only — zero view (or index) rename cases
----

# Hint-matched view rename is a silent no-op at apply

## Verified reproduction (live engine, 2026-06-10)

```sql
declare schema main {
  table t3 (id INTEGER PRIMARY KEY)
  view v_old as select id from t3
}
apply schema main;

declare schema main {
  table t3 (id INTEGER PRIMARY KEY)
  view v_new as select id from t3 with tags ("quereus.previous_name" = 'v_old')
}
diff schema main;    -- → []                      (expected: something that renames)
apply schema main;   -- schema() still lists only v_old; v_new does not exist
```

## Mechanism

`resolveRenames` pairs `v_new` (declared) with `v_old` (actual) via the hint: the
declared view is matched (no entry in `viewsToCreate`), the actual is consumed (no
entry in `viewsToDrop`), and the rename op lands in `diff.renames` with
`kind: 'view'` — but `generateMigrationDDL` emits rename DDL only for
`kind === 'table'`; the comment says non-table renames "fall back to drop+recreate …
via the standard buckets", which is only true for UNHINTED renames (no pair forms, so
the new name creates and the old name drops). With hints, nothing is emitted at all.

The same structure exists for hint-matched **index** renames (pairs consumed, no DDL
for `kind: 'index'`) — needs verification.

## Expected behavior

A hint-matched view rename should converge the catalog to the declared name. There is
no `ALTER VIEW … RENAME TO` primitive, so the natural shape is drop(old) +
recreate(declared) — data-free and cheap — emitted from the views block when the
matched pair's names differ (and excluded from the `require-hint` create/drop counts,
like body recreates). Alternatively, add the rename primitive. Either way,
50.2-declare-schema-renames.sqllogic gains view (and, if affected, index) rename
cases: diff renders the convergence, apply leaves exactly the new name, re-diff is
empty.

Note: ticket `view-insert-defaults-declarative-drift-undetected` (implement) adds a
canonical definition compare to the views block, under which a body-changed
rename-matched view already resolves to drop+recreate; this ticket covers the
body-UNCHANGED hint-rename, which remains a no-op after that lands.
