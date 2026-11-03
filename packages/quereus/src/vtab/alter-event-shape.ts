/**
 * The per-arm shape of an `ALTER TABLE` schema-change announcement, derived from the
 * {@link SchemaChangeInfo} the arm was called with. One derivation, shared by every
 * emitter-backed module, so a subscriber sees the same facts regardless of backend.
 */

import type { SchemaChangeInfo } from './module.js';
import type { VTableSchemaChangeEvent } from './events.js';
import type { TableSchema } from '../schema/table.js';

/** The fields of a schema-change event that an ALTER TABLE arm decides. */
export type AlterEventShape = Pick<
	VTableSchemaChangeEvent,
	'type' | 'objectType' | 'columnName' | 'oldColumnName' | 'oldKeyColumns'
>;

/** What {@link alterEventShape} reads off the pre-ALTER schema: the key an ALTER PRIMARY KEY retires. */
export type AlterEventShapeBefore = Pick<TableSchema, 'columns' | 'primaryKeyDefinition'>;

/**
 * Derive the `type` / `objectType` / column naming of an `ALTER TABLE` announcement:
 * `alter`/`column` naming the touched column for the column arms (`drop`/`column` for
 * DROP COLUMN), `alter`/`table` for the whole-table ones. Matches what the engine's own
 * no-emitter path reports for the same statements (`runtime/emit/alter-table.ts`) and
 * what `docs/usage.md` § What each `ALTER TABLE` arm reports promises.
 *
 * The caller supplies the rest of the event (`schemaName`, `objectName`, `ddl`) and owns
 * the emit-iff-`change.ddl` gate. `RENAME TO` is not an arm of this union — it goes
 * through `renameTable` and reports `alter`/`table` with `oldObjectName`.
 *
 * `before` is the table's schema as it was when the arm was called. Only the
 * `alterPrimaryKey` arm reads it — the event names the key being RETIRED
 * (`oldKeyColumns`), which nothing else can recover once the catalog swaps. Omitting it
 * leaves that field off, and a subscriber keyed by the row key (the sync engine) can then
 * not re-file the table's bookkeeping; every in-tree producer passes it.
 *
 * The `switch` is exhaustive over the union so a new arm fails the build here rather
 * than silently announcing the wrong shape.
 *
 * NOTE: this unifies the two EMITTER-BACKED producers (the memory module and the store).
 * The engine's own fallback path is a third producer that still writes the same triples out
 * by hand, one per arm, in `runtime/emit/alter-table.ts` — it emits at each arm's tail from
 * per-arm locals, with no `SchemaChangeInfo` in scope to derive from. Drift between the two
 * derivations is caught by the cross-backend parity spec (`@quereus/store`'s
 * `test/alter-events.spec.ts`), so this is a duplication with a guard, not an open hole. If a
 * fourth producer appears, or the arm union grows enough that the parity spec stops covering
 * every arm, thread the `SchemaChangeInfo` down to those emit sites and delete the hand-written
 * triples.
 */
export function alterEventShape(change: SchemaChangeInfo, before?: AlterEventShapeBefore): AlterEventShape {
	switch (change.type) {
		case 'addColumn':
			return { type: 'alter', objectType: 'column', columnName: change.columnDef.name };
		case 'dropColumn':
			return { type: 'drop', objectType: 'column', columnName: change.columnName };
		case 'renameColumn':
			return { type: 'alter', objectType: 'column', columnName: change.newName, oldColumnName: change.oldName };
		case 'alterColumn':
			return { type: 'alter', objectType: 'column', columnName: change.columnName };
		case 'alterPrimaryKey':
			return {
				type: 'alter', objectType: 'table',
				...(before ? { oldKeyColumns: before.primaryKeyDefinition.map(def => before.columns[def.index].name) } : {}),
			};
		case 'addConstraint':
		case 'dropConstraint':
		case 'renameConstraint':
			return { type: 'alter', objectType: 'table' };
	}
}
