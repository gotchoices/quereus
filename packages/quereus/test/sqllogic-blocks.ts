/**
 * Splits a `.sqllogic` file into the SQL blocks the logic harness executes.
 *
 * Shared by `logic.spec.ts`, which runs each block, and `logic-capability-usage.ts`, which parses
 * each block to see which capabilities a file uses — one reader, so the two cannot disagree about
 * what a block is. Pure string-in / data-out with no engine imports. The format is described in
 * `test/README.md` § Logic-test conventions.
 */

/** What ended a block, with the 1-based line of the marker (or the file's last line for `eof`). */
export type SqllogicBlockEnd =
	| { kind: 'result'; json: string; line: number }     // `→ <json>`
	| { kind: 'error'; substring: string; line: number } // `-- error: <substring>`
	| { kind: 'run'; line: number }                       // `-- run`
	| { kind: 'eof'; line: number };                      // trailing SQL, run as setup

export interface SqllogicBlock {
	/** Trimmed; exactly the text the harness hands to the engine. */
	sql: string;
	/** 1-based line of the block's first SQL line. */
	startLine: number;
	end: SqllogicBlockEnd;
	/** Raw `-- params:` payload attached to this block; the harness parses it. */
	params: { json: string; line: number } | null;
}

const ERROR_MARKER = '-- error:';
const PARAMS_MARKER = '-- params:';
const RUN_MARKER = '-- run';
const RESULT_MARKER = '→';

/** A marker line, or null for any other `--` line (directives, prose), which the reader ignores. */
function readMarker(trimmed: string, line: number): SqllogicBlockEnd | { kind: 'params'; json: string; line: number } | null {
	const lower = trimmed.toLowerCase();
	if (lower.startsWith(ERROR_MARKER)) return { kind: 'error', substring: trimmed.substring(ERROR_MARKER.length).trim(), line };
	if (lower.startsWith(PARAMS_MARKER)) return { kind: 'params', json: trimmed.substring(PARAMS_MARKER.length).trim(), line };
	if (lower === RUN_MARKER) return { kind: 'run', line };
	return null;
}

/**
 * Everything from the first `--` on is dropped — even inside a string literal. The corpus is
 * written against that rule, so it is kept rather than fixed here.
 */
function stripLineComment(line: string): string {
	const commentIndex = line.indexOf('--');
	return commentIndex === -1 ? line : line.substring(0, commentIndex);
}

/**
 * How the harness cuts a `→` or `-- error:` block into statements: at every `;`, even one inside a
 * string literal or a `declare schema` body, so those blocks are written against this rule.
 */
export function splitBlockStatements(sql: string): string[] {
	return sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
}

export function readSqllogicBlocks(content: string): SqllogicBlock[] {
	const blocks: SqllogicBlock[] = [];
	let sql = '';
	let startLine = 0;
	let params: SqllogicBlock['params'] = null;

	// A marker with no pending SQL is a no-op: it emits nothing and keeps any pending params.
	const close = (end: SqllogicBlockEnd): void => {
		if (sql === '') return;
		blocks.push({ sql: sql.trim(), startLine, end, params });
		sql = '';
		params = null;
	};

	const lines = content.split(/\r?\n/);
	lines.forEach((line, index) => {
		const lineNumber = index + 1;
		const trimmed = line.trim();
		if (trimmed === '') return;

		if (trimmed.startsWith('--')) {
			const marker = readMarker(trimmed, lineNumber);
			if (marker?.kind === 'params') params = { json: marker.json, line: marker.line };
			else if (marker) close(marker);
			return;
		}

		if (trimmed.startsWith(RESULT_MARKER)) {
			close({ kind: 'result', json: trimmed.substring(RESULT_MARKER.length).trim(), line: lineNumber });
			return;
		}

		const sqlPart = stripLineComment(line);
		if (sqlPart.trim() === '') return;
		if (sql === '') startLine = lineNumber;
		sql += sqlPart + '\n';
	});

	close({ kind: 'eof', line: lines.length });
	return blocks;
}
