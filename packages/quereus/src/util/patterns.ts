import { createLogger } from '../common/logger.js';

const log = createLogger('util:patterns');
const errorLog = log.extend('error');

/**
 * Simple LIKE pattern matching implementation.
 * Supports SQL LIKE patterns:
 * - % matches any sequence of characters (including empty sequence)
 * - _ matches any single character
 *
 * @param pattern The LIKE pattern
 * @param text The text to match against
 * @returns true if the text matches the pattern, false otherwise
 */
export function simpleLike(pattern: string, text: string): boolean {
	// Escape regex special characters except % and _
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
	// Convert SQL LIKE wildcards to regex equivalents
	const regexPattern = escapedPattern.replace(/%/g, '.*').replace(/_/g, '.');

	try {
		// 'u' flag: match by Unicode code point so `_` matches one code point (incl. non-BMP)
		const regex = new RegExp(`^${regexPattern}$`, 'u');
		return regex.test(text);
	} catch (e) {
		errorLog('Invalid LIKE pattern converted to regex: ^%s$, %O', regexPattern, e);
		return false;
	}
}

/**
 * Simple GLOB pattern matching implementation.
 * Supports SQL GLOB patterns:
 * - * matches any sequence of characters (including empty sequence)
 * - ? matches any single character
 *
 * @param pattern The GLOB pattern
 * @param text The text to match against
 * @returns true if the text matches the pattern, false otherwise
 */
export function simpleGlob(pattern: string, text: string): boolean {
	const chars = [...pattern]; // iterate by Unicode code point so non-BMP chars survive intact
	const regexMeta = '\\^$.|?*+()[]{}';
	let regex = '';
	let i = 0;

	while (i < chars.length) {
		const c = chars[i];

		if (c === '*') { regex += '.*'; i++; continue; }
		if (c === '?') { regex += '.'; i++; continue; }

		if (c === '[') {
			// Try to consume a character class. SQLite/glob: `]` immediately after `[` or `[^`
			// is a literal class member (handled here by emitting an escaped `]`).
			let j = i + 1;
			let cls = '[';
			if (j < chars.length && chars[j] === '^') { cls += '^'; j++; }
			let first = true;
			let closed = false;
			while (j < chars.length) {
				const cc = chars[j];
				if (cc === ']' && !first) { closed = true; break; }
				if (cc === '\\' || cc === ']') cls += '\\' + cc;
				else cls += cc;
				first = false;
				j++;
			}
			if (closed) { regex += cls + ']'; i = j + 1; continue; }
			// Unclosed `[` — fall through and treat as a literal `[`.
		}

		if (regexMeta.includes(c)) regex += '\\' + c;
		else regex += c;
		i++;
	}

	try {
		// 'u' flag: code-point ranges like `[😀-😎]` and `?`/`.` matching by code point.
		return new RegExp(`^${regex}$`, 'u').test(text);
	} catch (e) {
		errorLog('Invalid GLOB pattern compiled to regex: ^%s$, %O', regex, e);
		return false;
	}
}
