import type { Row, SqlValue } from '../common/types.js';

/** Convert a row array to an object using column names */
export function rowToObject(row: Row, columnNames: string[]): Record<string, SqlValue> {
	const obj: Record<string, SqlValue> = {};
	for (let i = 0; i < row.length; i++) {
		obj[columnNames[i] || `col_${i}`] = row[i];
	}
	return obj;
}
