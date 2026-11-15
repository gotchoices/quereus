/**
 * What each `-- requires-capability:` token means in terms of parsed SQL, so quereus's own suite can
 * check that a `.sqllogic` file declares exactly the capabilities its statements use
 * (`logic-capabilities.spec.ts` § the real corpus).
 *
 * Kept apart from `logic-capabilities.ts`, which stays engine-free because downstream harnesses
 * mirror it; this module needs the engine's parser. Downstream harnesses do not need it — they only
 * read the directive.
 */

import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import { QuereusError } from '../src/common/errors.js';
import { readSqllogicBlocks, splitBlockStatements } from './sqllogic-blocks.js';
import type { SqllogicCapability } from './logic-capabilities.js';

type UsageDetector = (statement: AST.Statement) => boolean;

// NOTE: sees top-level statements only. That is right while no statement kind executes a nested
// index statement (`explain` describes one without running it). If such a kind is ever added, this
// detector must look inside it.
function usesStandaloneIndexDdl(statement: AST.Statement): boolean {
	switch (statement.type) {
		case 'createIndex':
			return true;
		case 'drop':
			return statement.objectType === 'index';
		case 'declareSchema':
			// `apply schema` lowers a physical schema's index members to `create index` / `drop index`.
			// A logical schema's are refused at apply before anything is lowered.
			return !statement.isLogical && statement.items.some(item => item.type === 'declaredIndex');
		default:
			return false;
	}
}

/** One detector per capability token. `Record` makes the compiler refuse a token without one. */
export const CAPABILITY_USAGE: Readonly<Record<SqllogicCapability, UsageDetector>> = {
	'standalone-index-ddl': usesStandaloneIndexDdl,
};

const DETECTORS = Object.entries(CAPABILITY_USAGE) as [SqllogicCapability, UsageDetector][];

/** The statements `sql` parses to, or null when the parser refuses it. */
function tryParse(sql: string): AST.Statement[] | null {
	try {
		return new Parser().parseAll(sql);
	} catch (error) {
		// The parser reports every refusal (lexer, syntax, unterminated paren) as a QuereusError;
		// anything else is a parser bug and must surface.
		if (error instanceof QuereusError) return null;
		throw error;
	}
}

/**
 * The statements a block can run. `Database.exec` parses a whole batch before running any of it,
 * but the harness hands `→` and `-- error:` blocks to the engine one `;`-separated piece at a time
 * (setup pieces of an `-- error:` block as one batch, the final piece on its own), so a block whose
 * whole text fails to parse may still run the pieces before the bad one. Each piece that parses on
 * its own therefore counts. That over-counts a `-- run` block, which goes to one `exec` whole and so
 * runs nothing; no corpus block is affected.
 */
function blockStatements(sql: string): AST.Statement[] {
	return tryParse(sql) ?? splitBlockStatements(sql).flatMap(piece => tryParse(piece) ?? []);
}

/** Each capability the file's SQL uses, with the start line of the first block that uses it. */
export function findCapabilityUses(content: string): ReadonlyMap<SqllogicCapability, number> {
	const uses = new Map<SqllogicCapability, number>();
	for (const block of readSqllogicBlocks(content)) {
		for (const statement of blockStatements(block.sql)) {
			for (const [capability, detects] of DETECTORS) {
				if (!uses.has(capability) && detects(statement)) uses.set(capability, block.startLine);
			}
		}
	}
	return uses;
}
