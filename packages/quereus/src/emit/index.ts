/**
 * SQL Emission (AST to SQL String)
 *
 * This module provides functions to convert parsed AST nodes back into SQL strings.
 * Useful for programmatic SQL generation, query rewriting, and DDL/DML tools.
 *
 * Formatting Notes:
 * - Emits lowercase SQL keywords.
 * - Quotes identifiers (table/column names) using double quotes when necessary.
 * - String literals are properly escaped.
 */

// Main emission function (handles any AST node)
export { astToString } from './ast-stringify.js';

// Identifier quoting
export { quoteIdentifier } from './ast-stringify.js';

// Expression emission
export { expressionToString } from './ast-stringify.js';

// DML statement emission
export {
	selectToString,
	insertToString,
	updateToString,
	deleteToString,
	valuesToString,
} from './ast-stringify.js';

// DDL statement emission
export {
	createTableToString,
	createIndexToString,
	createViewToString,
} from './ast-stringify.js';

