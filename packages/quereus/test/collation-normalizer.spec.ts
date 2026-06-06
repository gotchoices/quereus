/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database } from '../src/index.js';
import { resolveKeyNormalizer, BUILTIN_NORMALIZERS } from '../src/util/key-serializer.js';
import {
	BINARY_COLLATION,
	NOCASE_COLLATION,
	RTRIM_COLLATION,
} from '../src/util/comparison.js';

// Conformance corpus shared with the cellstore-side conformance test —
// mixed-case ASCII, Unicode case-fold, ASCII vs other whitespace, etc.
const CORPUS: readonly string[] = [
	'', 'a', 'A', 'aa', 'ab', 'b', 'B',
	'Hello', 'hello', 'HELLO', 'heLLo',
	'élise', 'ÉLISE', 'É', 'é', 'ß', 'SS',
	'日本語', '中文',
	'foo', 'foo ', 'foo  ', 'foo\t', 'foo\t ', 'foo \t', 'foo​',
	'a b', 'a\tb', 'a b',
];

type Cmp = (a: string, b: string) => number;

/** Probe-set assertion: for every (a,b) in the corpus, normalizer-equality
 *  must agree with comparator-equality (modulo total order). */
function assertNormalizerMatchesComparator(
	name: string,
	normalize: (s: string) => string,
	cmp: Cmp,
): void {
	for (const a of CORPUS) {
		for (const b of CORPUS) {
			const cmpEq = cmp(a, b) === 0;
			const normEq = normalize(a) === normalize(b);
			if (cmpEq !== normEq) {
				throw new Error(
					`${name}: disagreement for (${JSON.stringify(a)}, ${JSON.stringify(b)}): ` +
						`comparator-eq=${cmpEq}, normalizer-eq=${normEq}`,
				);
			}
		}
	}
}

describe('Collation key normalizers', () => {
	describe('resolveKeyNormalizer + comparator agreement', () => {
		it('BINARY normalizer outputs equivalence-equal iff comparator equal', () => {
			assertNormalizerMatchesComparator('BINARY', resolveKeyNormalizer('BINARY'), BINARY_COLLATION);
		});

		it('NOCASE normalizer outputs equivalence-equal iff comparator equal', () => {
			assertNormalizerMatchesComparator('NOCASE', resolveKeyNormalizer('NOCASE'), NOCASE_COLLATION);
		});

		it('RTRIM normalizer outputs equivalence-equal iff comparator equal (only ASCII space stripped)', () => {
			assertNormalizerMatchesComparator('RTRIM', resolveKeyNormalizer('RTRIM'), RTRIM_COLLATION);
		});

		it('RTRIM normalizer preserves trailing tab/NBSP (not just trimEnd)', () => {
			const norm = resolveKeyNormalizer('RTRIM');
			expect(norm('foo\t')).to.equal('foo\t');
			expect(norm('foo ')).to.equal('foo ');
			expect(norm('foo  ')).to.equal('foo');
			expect(norm('foo\t ')).to.equal('foo\t');
		});
	});

	describe('Database._getCollationNormalizer', () => {
		it('returns the built-in normalizer for BINARY / NOCASE / RTRIM on a fresh database', () => {
			const db = new Database();
			expect(db._getCollationNormalizer('BINARY')).to.equal(BUILTIN_NORMALIZERS.BINARY);
			expect(db._getCollationNormalizer('NOCASE')).to.equal(BUILTIN_NORMALIZERS.NOCASE);
			expect(db._getCollationNormalizer('RTRIM')).to.equal(BUILTIN_NORMALIZERS.RTRIM);
			expect(db._getCollationNormalizer('binary')).to.equal(BUILTIN_NORMALIZERS.BINARY); // case-insensitive
		});

		it('returns undefined for unknown collation', () => {
			const db = new Database();
			expect(db._getCollationNormalizer('NOPE')).to.equal(undefined);
		});

		it('returns the user-supplied normalizer when registerCollation is given one', () => {
			const db = new Database();
			const myNorm = (s: string): string => s.replace(/\D/g, '');
			db.registerCollation('PHONE', (a, b) => myNorm(a).localeCompare(myNorm(b)), myNorm);
			expect(db._getCollationNormalizer('PHONE')).to.equal(myNorm);
		});

		it('returns undefined for comparator-only user collations (no normalizer)', () => {
			const db = new Database();
			db.registerCollation('CMPONLY', (a, b) => (a < b ? -1 : a > b ? 1 : 0));
			expect(db._getCollationNormalizer('CMPONLY')).to.equal(undefined);
		});

		it('overriding a built-in collation without a normalizer still falls back to the built-in normalizer', () => {
			// Built-in fallback path: even if the user re-registers NOCASE without
			// a normalizer (deprecated but allowed), _getCollationNormalizer
			// resolves to BUILTIN_NORMALIZERS.NOCASE so persisted indexes keep working.
			const db = new Database();
			db.registerCollation('NOCASE', (a, b) => a.localeCompare(b));
			// Entry now has no normalizer; built-in fallback kicks in.
			expect(db._getCollationNormalizer('NOCASE')).to.equal(BUILTIN_NORMALIZERS.NOCASE);
		});
	});

	describe('registerCollation validation', () => {
		it('rejects non-function normalizer', () => {
			const db = new Database();
			expect(() => db.registerCollation('X', () => 0, 'not-a-fn' as any))
				.to.throw(/normalizer must be a function/);
		});
	});
});
