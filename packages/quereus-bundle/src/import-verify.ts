import {
	validateForeignKeyOverExistingRows,
	type Database,
	type ForeignKeyConstraintSchema,
	type TableSchema,
} from '@quereus/quereus';
import { tableKey } from './bundle-documents.js';
import { BundleError, notifyProgress } from './hooks.js';
import { messageOf, type ImportRun } from './import-run.js';

interface ForeignKeyCheck {
	child: TableSchema;
	fk: ForeignKeyConstraintSchema;
}

/**
 * Checks every foreign key whose child or parent table received rows, since the load ran
 * with `foreign_keys` off. A parent counts too: `onConflict: 'update'` can change a
 * parent's unique non-key column and orphan rows in a table the bundle never touched.
 * Violations are reported, not rolled back. Call with `foreign_keys` on again.
 */
export async function verifyForeignKeys(run: ImportRun, loaded: ReadonlySet<string>): Promise<void> {
	for (const { child, fk } of foreignKeysToCheck(run.db, loaded)) {
		if (run.isCancelled('verify') || run.abortRequested) return;
		const error = await checkForeignKey(run.db, child, fk);
		if (error) run.report(error);
		notifyProgress(run.settings.hooks, { phase: 'verify', schema: child.schemaName, table: child.name, rowsDone: 0, totalRowsDone: run.totalRowsApplied });
	}
}

function foreignKeysToCheck(db: Database, loaded: ReadonlySet<string>): ForeignKeyCheck[] {
	const checks: ForeignKeyCheck[] = [];
	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const child of schema.getAllTables()) {
			const childLoaded = loaded.has(tableKey({ schema: child.schemaName, table: child.name }));
			for (const fk of child.foreignKeys ?? []) {
				const parent = { schema: fk.referencedSchema ?? child.schemaName, table: fk.referencedTable };
				if (childLoaded || loaded.has(tableKey(parent))) checks.push({ child, fk });
			}
		}
	}
	return checks;
}

async function checkForeignKey(db: Database, child: TableSchema, fk: ForeignKeyConstraintSchema): Promise<BundleError | undefined> {
	try {
		await withoutDeclaredForeignKeys(db, child, () => validateForeignKeyOverExistingRows(db, child, fk));
		return undefined;
	} catch (e) {
		const name = fk.name ?? `to ${fk.referencedTable}`;
		return new BundleError(`Foreign key ${name} of ${child.schemaName}.${child.name} does not hold after the import: ${messageOf(e)}`, {
			phase: 'verify', kind: 'foreign-key', schema: child.schemaName, table: child.name, cause: e,
		});
	}
}

/**
 * The optimizer treats a declared foreign key as proven, and would fold the orphan scan's
 * `not exists` away (`ruleAntiJoinFkEmpty`) when the child is non-null. So, as
 * `validateForeignKeyOverExistingRows` requires of a caller whose child already declares
 * the key, the scan runs while the catalog holds the child without its foreign keys.
 *
 * NOTE: the same strip-scan-restore runs in `runtime/emit/materialized-view-helpers.ts`;
 * if a third caller needs it, export an engine helper that validates a declared foreign
 * key so callers outside the engine stop writing the catalog.
 */
async function withoutDeclaredForeignKeys(db: Database, child: TableSchema, scan: () => Promise<void>): Promise<void> {
	const schema = db.schemaManager.getSchema(child.schemaName);
	if (!schema) return scan();
	schema.addTable({ ...child, foreignKeys: undefined });
	try {
		await scan();
	} finally {
		schema.addTable(child);
	}
}
