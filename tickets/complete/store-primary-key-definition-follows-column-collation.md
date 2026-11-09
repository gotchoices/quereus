description: When the store module changed a text primary-key column's collation (at CREATE, and on ALTER COLUMN SET COLLATE) it left the table's primary-key definition at the old collation, so the isolation layer missed staged rows and data-change events split case-only key updates. Both producers now keep the two in step, and the engine refuses to register any table schema where they disagree.
architecture: docs/schema.md
files: packages/quereus/src/schema/table.ts (`rederivePrimaryKeyCollations`, `assertPrimaryKeyCollationsMatchColumns`), packages/quereus/src/schema/schema.ts (`Schema.addTable`), packages/quereus/src/index.ts, packages/quereus-store/src/common/store-module-schema-rewrite.ts (`reconcilePkCollations`), packages/quereus-store/src/common/store-module-alter-column.ts (`updatedSchema`), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`resolveIndexKeyCollations`), packages/quereus/src/vtab/index-descriptor.ts (`reversedIndexDescriptor`), packages/quereus-store/test/data-event-key-contract.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/invariants.md (SCH-006), docs/schema.md, docs/store-catalog-persistence.md, docs/store.md
----
## Summary

`TableSchema.primaryKeyDefinition[i].collation` must equal its member column's `collation`. The store's CREATE-time key-collation default (`reconcilePkCollations`) and its ALTER COLUMN SET COLLATE path rewrote the column but not the definition, so engine consumers that read the definition (data-change event comparators, the isolation overlay's primary-key descriptor) disagreed with the store's key bytes.

- `rederivePrimaryKeyCollations(schema)` (`schema/table.ts`, exported) re-derives each member's collation from its column; returns the input unchanged when nothing differs.
- Both store producers pass their rewritten schema through it.
- `Schema.addTable` calls `assertPrimaryKeyCollationsMatchColumns` on every registration; a mismatch or out-of-range member index throws `INTERNAL`.
- The two planner workarounds that read the column instead of the definition (`resolveIndexKeyCollations`, `reversedIndexDescriptor`) were removed.
- Docs: new invariant SCH-006, a paragraph under `docs/schema.md` § TableSchema, a sentence in `docs/store-catalog-persistence.md`, and a fixed stale link in `docs/store.md`.
- Tests: two reproductions in `data-event-key-contract.spec.ts` (undecorated text key; key altered to NOCASE) and one in `isolated-store.spec.ts` (staged row found by a case-differing equality read).

## Review findings

Read the diff of `ticket(implement): store-primary-key-definition-follows-column-collation` before the handoff.

- **Correctness of the producers:** both store call sites wrap the final schema object, after `columns` is rewritten, so the helper sees the new collation. Confirmed `Schema.addTable` is the only `tables.set` site, so the check covers every registration.
- **Consumers:** isolation's `makePkKeyShape` (`pk-probe.ts`) reads the column; the engine's primary descriptor (`primaryKeyDescriptor`) reads the definition. With the invariant held, removing the two column-reading workarounds is equivalent. `primaryKeyCollationLookup` still reads the column, which is now the same value; left alone.
- **Fixed inline (minor):** `rederivePrimaryKeyCollations` indexed `schema.columns[def.index].collation` without a guard, so an out-of-range member would throw a bare `TypeError` before the registration check could report it as `INTERNAL`. It now skips such a member and leaves the report to `assertPrimaryKeyCollationsMatchColumns`.
- **DRY:** memory's `buildAlterColumnPlan` still propagates the collation inline instead of calling the helper. Left as-is on purpose: memory's `TransactionLayer.adoptSchema` decides whether to rebuild a layer's structures by object identity, and the inline code makes a fresh definition entry whenever `collationChanged`, while the helper only does so when the effective collation differs. Switching would change which objects are fresh. The registration check covers this path either way. No ticket.
- **Unregistered cached schemas:** a module that caches a schema without registering it would not be checked. Both current store producers register their result, so this is only a concern for a hypothetical future producer. Not recorded as a tripwire because no code site holds such a cache today.
- **Tests:** the three new tests reproduce the two arms of the bug at the store layer and meet the bar. No separate test for the `addTable` check: every registration in the suite exercises it, and the implementer confirmed it fires when either producer call is bypassed. No tests cut.
- **Performance:** the check is one loop over the primary-key members per registration, which costs nothing measurable.
- **Docs:** read every doc the change touches. `docs/schema.md` lists `rederivePrimaryKeyCollations` / `rekeySchemaPrimaryKey` as the mechanisms, and memory's inline path is named in SCH-006's code list. No other doc needed updating.
- **Validation:** `yarn build`, `yarn lint` (quereus lint exit 0 after the inline fix) and `yarn test` all pass: quereus 11126 passing / 26 pending, store 1994, isolation 453, sync 878, others green. After the fix I reran the store suite (1994 passing). I did not rerun `yarn test:store`, which the implementer ran green (11119 passing). My change only affects an out-of-range index that no test produces.
