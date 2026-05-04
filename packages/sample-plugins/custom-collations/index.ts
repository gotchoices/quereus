/**
 * Custom Collations Plugin for Quereus
 *
 * This plugin demonstrates how to register custom collation functions in Quereus.
 * Collations control how text is sorted and compared in ORDER BY clauses and comparisons.
 *
 * Collations provided:
 * - NUMERIC - Natural numeric sorting ("file2.txt" < "file10.txt")
 * - LENGTH - Sort by string length, then lexicographically
 * - REVERSE - Reverse lexicographic order
 * - ALPHANUM - Alphanumeric sorting (handles mixed text and numbers)
 * - PHONETIC - Simple phonetic-like sorting (vowels treated as equivalent)
 */

import type { Database, SqlValue, CollationFunction, PluginRegistrations } from '@quereus/quereus';

export const manifest = {
	name: 'Custom Collations',
	version: '1.0.0',
	author: 'Quereus Team',
	description: 'Custom collation functions for specialized text sorting',
	provides: {
		collations: ['NUMERIC', 'LENGTH', 'REVERSE', 'ALPHANUM', 'PHONETIC']
	}
};

interface Token {
	type: 'text' | 'number';
	value: string | number;
}

function tokenize(str: string, caseSensitive: boolean): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < str.length) {
		if (str[i] >= '0' && str[i] <= '9') {
			let num = '';
			while (i < str.length && str[i] >= '0' && str[i] <= '9') {
				num += str[i++];
			}
			tokens.push({ type: 'number', value: parseInt(num, 10) });
		} else {
			let text = '';
			while (i < str.length && (str[i] < '0' || str[i] > '9')) {
				text += str[i++];
			}
			tokens.push({ type: 'text', value: caseSensitive ? text : text.toLowerCase() });
		}
	}

	return tokens;
}

function compareTokens(tokensA: Token[], tokensB: Token[], textBeforeNumbers: boolean): number {
	const maxLen = Math.max(tokensA.length, tokensB.length);

	for (let i = 0; i < maxLen; i++) {
		const tokenA = tokensA[i];
		const tokenB = tokensB[i];

		if (!tokenA) return -1;
		if (!tokenB) return 1;

		if (textBeforeNumbers && tokenA.type !== tokenB.type) {
			return tokenA.type === 'text' ? -1 : 1;
		}

		if (typeof tokenA.value === 'number' && typeof tokenB.value === 'number') {
			if (tokenA.value !== tokenB.value) return tokenA.value < tokenB.value ? -1 : 1;
		} else {
			const strA = String(tokenA.value);
			const strB = String(tokenB.value);
			if (strA !== strB) return strA < strB ? -1 : 1;
		}
	}

	return 0;
}

const numericCollation: CollationFunction = (a: string, b: string): number => {
	const tokensA = tokenize(a, true);
	const tokensB = tokenize(b, true);
	return compareTokens(tokensA, tokensB, false);
};

const lengthCollation: CollationFunction = (a: string, b: string): number => {
	if (a.length !== b.length) {
		return a.length - b.length;
	}
	return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Normalizer for LENGTH: produces a string that, under byte-lex equality,
 * partitions inputs into the same equivalence classes as `lengthCollation`.
 * Two strings are equal under LENGTH iff they have identical bytes (length tie
 * is broken by the original byte comparison), so the identity function works.
 * The 4-digit length prefix would also work and demonstrates the lookup-key
 * shape for collations whose equivalence is coarser than `===`. We use the
 * prefix form so the test suite has a non-trivial normalizer to verify against.
 */
const lengthNormalizer = (s: string): string => {
	const len = s.length.toString().padStart(8, '0');
	return `${len}:${s}`;
};

const reverseCollation: CollationFunction = (a: string, b: string): number => {
	return a < b ? 1 : a > b ? -1 : 0;
};

const alphanumCollation: CollationFunction = (a: string, b: string): number => {
	const tokensA = tokenize(a, false);
	const tokensB = tokenize(b, false);
	return compareTokens(tokensA, tokensB, true);
};

const phoneticCollation: CollationFunction = (a: string, b: string): number => {
	const normalize = (str: string): string => {
		return str.toLowerCase()
			.replace(/[aeiou]/g, 'a')
			.replace(/[bp]/g, 'b')
			.replace(/[fv]/g, 'f')
			.replace(/[kg]/g, 'k')
			.replace(/[sz]/g, 's')
			.replace(/[td]/g, 't')
			.replace(/h/g, '')
			.replace(/(.)\1+/g, '$1');
	};

	const normA = normalize(a);
	const normB = normalize(b);

	if (normA !== normB) {
		return normA < normB ? -1 : 1;
	}

	return a < b ? -1 : a > b ? 1 : 0;
};

export default function register(_db: Database, _config: Record<string, SqlValue> = {}): PluginRegistrations {
	return {
		collations: [
			// LENGTH ships with a normalizer so it can be used as a compound-index key.
			{ name: 'LENGTH', func: lengthCollation, normalizer: lengthNormalizer },
			// Comparator-only registrations — usable in ORDER BY but not as
			// compound-index keys. Index creation referencing one of these throws
			// `CollationNotIndexableError` at the cellstore boundary.
			{ name: 'NUMERIC', func: numericCollation },
			{ name: 'REVERSE', func: reverseCollation },
			{ name: 'ALPHANUM', func: alphanumCollation },
			{ name: 'PHONETIC', func: phoneticCollation }
		]
	};
}
