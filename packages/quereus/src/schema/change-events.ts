import type { TableSchema } from './table.js';
import type { FunctionSchema } from './function.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import type { ViewSchema } from './view.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

const log = createLogger('schema:change-events');

// ── Base event shapes ──────────────────────────────────────────────

interface SchemaObjectAdded<Type extends string, T> {
	type: Type;
	schemaName: string;
	objectName: string;
	newObject: T;
}

interface SchemaObjectRemoved<Type extends string, T> {
	type: Type;
	schemaName: string;
	objectName: string;
	oldObject: T;
}

interface SchemaObjectModified<Type extends string, T> {
	type: Type;
	schemaName: string;
	objectName: string;
	oldObject: T;
	newObject: T;
}

// ── Table events ───────────────────────────────────────────────────

export type TableAddedEvent = SchemaObjectAdded<'table_added', TableSchema>;
export type TableRemovedEvent = SchemaObjectRemoved<'table_removed', TableSchema>;
export type TableModifiedEvent = SchemaObjectModified<'table_modified', TableSchema>;

// ── Function events ────────────────────────────────────────────────

export type FunctionAddedEvent = SchemaObjectAdded<'function_added', FunctionSchema>;
export type FunctionRemovedEvent = SchemaObjectRemoved<'function_removed', FunctionSchema>;
export type FunctionModifiedEvent = SchemaObjectModified<'function_modified', FunctionSchema>;

// ── Assertion events ───────────────────────────────────────────────

export type AssertionAddedEvent = SchemaObjectAdded<'assertion_added', IntegrityAssertionSchema>;
export type AssertionRemovedEvent = SchemaObjectRemoved<'assertion_removed', IntegrityAssertionSchema>;
export type AssertionModifiedEvent = SchemaObjectModified<'assertion_modified', IntegrityAssertionSchema>;

// ── View events ────────────────────────────────────────────────────

/**
 * Emitted after a plain `CREATE VIEW` / `DROP VIEW` (fired from the runtime
 * emitters, NOT from `Schema.addView`/`removeView`). Scoping the event to the
 * DDL emitters deliberately excludes internally-registered views (lens effective
 * bodies, any other direct `schema.addView` caller) which must NOT be persisted
 * to a store-backed catalog — they are re-derived, not stored. A store catalog
 * subscribes to these to persist/forget a view incrementally. Mirrors how the MV
 * emitters fire `materialized_view_added`/`_removed`. A lens redeploy announces
 * its view replacement on the separate `lens_view_*` events below, which a
 * persisting consumer ignores.
 */
export type ViewAddedEvent = SchemaObjectAdded<'view_added', ViewSchema>;
export type ViewRemovedEvent = SchemaObjectRemoved<'view_removed', ViewSchema>;

/**
 * Emitted after an in-place change to an existing (non-materialized) view. Two
 * sources fire it: `ALTER VIEW … SET TAGS`, and an `ALTER TABLE/COLUMN RENAME`
 * that rewrites a dependent view's body in place (propagating the new
 * table/column name into `selectAst` + `sql`). Distinct from `view_added`
 * (which a fresh create fires) so a cached write-through plan that recorded a
 * `view` dependency invalidates when the view changes, and so a store-backed
 * catalog re-persists the (re-generated) view DDL — both without re-triggering
 * a persistence re-create.
 */
export type ViewModifiedEvent = SchemaObjectModified<'view_modified', ViewSchema>;

// ── Lens view events ───────────────────────────────────────────────
// Fired by `deployLogicalSchema` after it replaces a logical schema's views, so a
// prepared statement or materialized view that inlined the old get-body can
// invalidate. Separate from `view_*` because lens views are recompiled on every
// deploy and must never be persisted as `create view` DDL. No added event: nothing
// can hold a dependency on a lens view that did not exist before the deploy.

/** A lens view present before the deploy and absent after it (its logical table left the declaration). */
export type LensViewRemovedEvent = SchemaObjectRemoved<'lens_view_removed', ViewSchema>;

/**
 * A lens view present before and after the deploy (matched case-insensitively by
 * name). Fired for every surviving view, whether or not its body changed: a cached
 * write-through plan also depends on the lens slot (constraints, inverse,
 * provenance), which can change while the get-body does not.
 */
export type LensViewReplacedEvent = SchemaObjectModified<'lens_view_replaced', ViewSchema>;

// ── Materialized view events ───────────────────────────────────────
// Keyed by the maintained table's own name (unified model: one `TableSchema`
// carrying a `derivation`); payloads are that table. The channel survives so
// store catalog persistence keeps re-saving the `create materialized view`
// DDL on derivation changes, distinct from the table-bundle channel.

export type MaterializedViewAddedEvent = SchemaObjectAdded<'materialized_view_added', TableSchema>;
export type MaterializedViewRemovedEvent = SchemaObjectRemoved<'materialized_view_removed', TableSchema>;

/**
 * Emitted after an in-place change to an existing materialized view — currently
 * only `ALTER MATERIALIZED VIEW … SET TAGS`. Deliberately **distinct** from
 * `materialized_view_added` (which the MV maintenance manager treats as a
 * re-registration trigger): a tag change must invalidate dependent cached
 * write-through plans WITHOUT re-registering maintenance or rebuilding the
 * backing. No maintenance listener subscribes to this event.
 */
export type MaterializedViewModifiedEvent = SchemaObjectModified<'materialized_view_modified', TableSchema>;

/** Emitted after a successful `REFRESH MATERIALIZED VIEW`. Carries the current schema. */
export interface MaterializedViewRefreshedEvent {
	type: 'materialized_view_refreshed';
	schemaName: string;
	objectName: string;
	object: TableSchema;
}

// ── Module / collation events (name-only payload) ──────────────────

interface SchemaNameEvent<Type extends string> {
	type: Type;
	schemaName: string;
	objectName: string;
}

export type ModuleAddedEvent = SchemaNameEvent<'module_added'>;
export type ModuleRemovedEvent = SchemaNameEvent<'module_removed'>;
export type CollationAddedEvent = SchemaNameEvent<'collation_added'>;
export type CollationRemovedEvent = SchemaNameEvent<'collation_removed'>;

// ── Discriminated union ────────────────────────────────────────────

export type SchemaChangeEvent =
	| TableAddedEvent
	| TableRemovedEvent
	| TableModifiedEvent
	| FunctionAddedEvent
	| FunctionRemovedEvent
	| FunctionModifiedEvent
	| AssertionAddedEvent
	| AssertionRemovedEvent
	| AssertionModifiedEvent
	| ViewAddedEvent
	| ViewRemovedEvent
	| ViewModifiedEvent
	| LensViewRemovedEvent
	| LensViewReplacedEvent
	| MaterializedViewAddedEvent
	| MaterializedViewRemovedEvent
	| MaterializedViewModifiedEvent
	| MaterializedViewRefreshedEvent
	| ModuleAddedEvent
	| ModuleRemovedEvent
	| CollationAddedEvent
	| CollationRemovedEvent;

/**
 * Function that handles schema change events.
 */
export type SchemaChangeListener = (event: SchemaChangeEvent) => void;

/** Looks up the catalog's current table entry; `undefined` when none is registered. */
export type RegisteredTableLookup = (schemaName: string, tableName: string) => TableSchema | undefined;

/**
 * The table definition an event claims the catalog now holds, or `undefined` for an
 * event that makes no such claim. Removal events are excluded on purpose: their payload
 * is leaving the catalog, and a detach re-registers the table without its derivation,
 * so the departing object is legitimately not the registered one.
 */
function announcedRegisteredTable(event: SchemaChangeEvent): TableSchema | undefined {
	switch (event.type) {
		case 'table_added':
		case 'table_modified':
		case 'materialized_view_added':
		case 'materialized_view_modified':
			return event.newObject;
		case 'materialized_view_refreshed':
			return event.object;
		default:
			return undefined;
	}
}

/**
 * Every announced table definition must be the very object the catalog holds under
 * that name (docs/schema.md § Event Types, "Registered-object contract"). Listeners
 * cache the payload — the store module keeps it as its working copy and builds later
 * ALTER results from it — so announcing anything else (typically the pre-
 * `Schema.addTable` object, when registration corrected it) puts the uncorrected
 * definition back into the catalog on the next ALTER.
 *
 * Reference equality, not a structural compare: it is the exact property listeners
 * rely on, and needs no deep compare of ASTs and maps.
 *
 * @throws QuereusError (`INTERNAL`) when no table is registered under the event's name,
 *   or a different object is — either is a bug in the announcing path
 */
export function assertAnnouncedTableIsRegistered(event: SchemaChangeEvent, lookup: RegisteredTableLookup): void {
	const announced = announcedRegisteredTable(event);
	if (!announced) return;
	const registered = lookup(event.schemaName, event.objectName);
	if (registered === announced) return;
	const problem = registered
		? 'a different object is registered under that name; announce the value Schema.addTable returned'
		: 'no table is registered under that name';
	throw new QuereusError(
		`Schema change '${event.type}' for '${event.schemaName}.${event.objectName}' announces a table definition the catalog does not hold: ${problem}`,
		StatusCode.INTERNAL,
	);
}

/**
 * Manages schema change listeners and notifications.
 */
export class SchemaChangeNotifier {
	private listeners = new Set<SchemaChangeListener>();

	/**
	 * @param verify Run on every event before any listener sees it, outside the
	 *   per-listener error trap, so a violation throws to the announcing code.
	 */
	constructor(private readonly verify?: (event: SchemaChangeEvent) => void) {}

	/**
	 * Adds a schema change listener.
	 * @returns A function to unsubscribe the listener.
	 */
	addListener(listener: SchemaChangeListener): () => void {
		this.listeners.add(listener);
		log('Added schema change listener, total listeners: %d', this.listeners.size);
		return () => this.removeListener(listener);
	}

	/**
	 * Removes a schema change listener.
	 */
	removeListener(listener: SchemaChangeListener): void {
		const removed = this.listeners.delete(listener);
		if (removed) {
			log('Removed schema change listener, total listeners: %d', this.listeners.size);
		}
	}

	/**
	 * Notifies all listeners of a schema change event. Listener errors are logged and
	 * swallowed; only the constructor's `verify` hook can throw.
	 */
	notifyChange(event: SchemaChangeEvent): void {
		// NOTE: checked once before dispatch; if a listener ever re-registers the announced
		// table, later listeners receive a superseded object.
		this.verify?.(event);
		log('Notifying %d listeners of schema change: %s %s',
			this.listeners.size, event.type, event.objectName);

		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				// NOTE: this trap also catches a `verify` failure raised by an announcement a
				// listener makes (e.g. emitBackingInvalidation, which re-fetches the registered
				// table and so cannot fail it); if a listener ever announces a table it built
				// itself, rethrow INTERNAL here so the violation is not reduced to a debug log.
				log('Error in schema change listener: %s', error);
			}
		}
	}

	/**
	 * Gets the number of active listeners.
	 */
	getListenerCount(): number {
		return this.listeners.size;
	}

	/**
	 * Clears all listeners.
	 */
	clearListeners(): void {
		const count = this.listeners.size;
		this.listeners.clear();
		log('Cleared all %d schema change listeners', count);
	}
}
