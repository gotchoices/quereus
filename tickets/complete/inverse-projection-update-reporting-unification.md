description: Unify the inverse-projection arm's same-key real-change reporting to a single `update` (upsert-only when old/new projected images share the backing key) instead of delete+insert, matching the residual arms' post-suppression shape.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # applyInverseProjection UPDATE branch (lines ~822-853), backingPkEqual (~2288)
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts  # flipped pin + new NOCASE suite + strengthened cascade assertion
  - docs/materialized-views.md   # update-arm table row + prose
----

# Inverse-projection same-key changes: report one `update` — COMPLETE

The covering-index (`inverse-projection`) maintenance arm now reports a real,
both-in-scope, same-backing-key payload change as a **single `upsert`** (host →
one `update`) instead of the prior unconditional `delete-key(old) + upsert(new)`
pair. Key-changing updates and predicate-scope transitions remain genuinely
two-sided (delete + upsert). This brings the dominant arm in line with the
residual arms (aggregate, join forward/lookup, prefix-delete) after
`mv-noop-upsert-suppression`.

## Implementation summary

`applyInverseProjection` UPDATE branch: after the byte-faithful equal-image
short-circuit (`rowsValueIdentical` → no ops), when both images are in scope it
now consults `backingPkEqual(plan.backingPkDefinition, oldImage, newImage)` —
per-PK-component `compareSqlValues` under each column's collation. Equal backing
key (including a collation-equal / byte-different key, e.g. a NOCASE case-only
rewrite) ⇒ emit the `upsert` alone; the host's memory-layer `applyMaintenanceToLayer`
finds the existing row at the collation-equal key, skips it iff value-identical,
else records an `update` and re-keys the stored bytes. Unequal key ⇒ the prior
delete + upsert pairing. `backingPkEqual` is the existing private comparator
already used by the prefix-delete arm — no new helper.

## Review findings

**Diff reviewed:** the ticket's changes were swept into commit `c04e512e`
("ticket(implement): maintained-table-attach-detach-verbs") alongside ticket 6.2.
Reviewed the three relevant files within that commit with fresh eyes before the
handoff note.

- **Correctness / behavioral verification — checked, sound.** Traced the new
  single-upsert path end to end into the host (`memory/layer/manager.ts`
  `applyMaintenanceToLayer` `case 'upsert'`): `extractFromRow` produces the
  collation-aware key, `lookupEffectiveRow` finds the existing row at a
  collation-equal key, `rowsValueIdentical` (BINARY/byte-faithful) does NOT
  suppress a byte-different image, and `recordUpsert(existing)` → `{op:'update'}`
  while re-keying the stored bytes. The backing contract in `vtab/backing-host.ts`
  documents exactly this ("a collation-equal / byte-different upsert … must …
  report an `update`"). The reported shape changes; final backing state does not,
  so the byte-exact equivalence oracle stays green.

- **Index alignment — checked, correct.** `backingPkEqual` indexes
  `oldImage[d.index] / newImage[d.index]` with `backingPkDefinition`, whose
  `index` is the backing/projected column position (built from
  `backing.primaryKeyDefinition`, line ~1125) — the same indexing `keyOf` uses on
  `project(row)`. Both operands are projected images, so the comparator reads the
  intended columns. No source-vs-projected index confusion.

- **Edge cases / interactions — covered.** Value-identical no-op (nothing),
  unprojected-column update (nothing), real same-key change (`['update']`),
  key-changing update (`['delete','insert']`), partial-WHERE scope exit/entry
  (`['delete']`/`['insert']`), and NOCASE collation-equal key re-key
  (`['update']` + stored-byte re-key) are all pinned. White-box guard
  (`registeredPlanKind === 'inverse-projection'`) ensures the NOCASE case really
  exercises the covering-index arm, not the full-rebuild floor.

- **Test gap found and fixed inline (minor).** The MV-over-MV cascade regression
  test — which guards the ticket's *headline* motivation (a consumer dispatched
  twice for one semantic update) — only asserted `consumer.changes.length > 0`
  and final state, so it would not catch a regression back to delete+insert
  propagation. Strengthened it to assert the consumer's reported ops equal
  `['update']`. Passes.

- **DRY / SPP / reuse — clean.** Reuses the existing `backingPkEqual` comparator;
  no duplicated key-equality logic. The branch is a single readable conditional
  with an accurate explanatory comment.

- **Docs — checked, accurate.** `docs/materialized-views.md` update-arm table row
  and the following prose now describe the same-backing-key single-upsert path and
  its collation-aware key identity; consistent with the code and the residual-arm
  framing. No other doc references the old delete+insert shape for this arm.

- **Composite-PK collation-equal key — checked, not filed (low risk).** Only a
  single-component NOCASE key exercises the re-key path in tests. `backingPkEqual`
  iterates every PK component with the same per-component comparator, so a
  composite key behaves identically component-by-component; the marginal coverage
  value did not warrant a new ticket.

**Lint:** clean (exit 0). **Tests:** full `@quereus/quereus` suite — 5910 passing,
9 pending, 0 failing. The no-op-suppression suite (26 tests) passes including the
flipped pin, the new NOCASE suite, and the strengthened cascade assertion.

**Pre-existing failures:** none surfaced by this run. (A `tickets/.pre-existing-error.md`
committed by ticket 6.2 in `c04e512e` is unrelated to this arm and out of scope —
the runner's triage pass owns it.)
