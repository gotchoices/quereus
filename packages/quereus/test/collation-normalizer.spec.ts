/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database } from '../src/index.js';
import { BUILTIN_NORMALIZERS } from '../src/util/key-serializer.js';
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
	describe('BUILTIN_NORMALIZERS + comparator agreement', () => {
		it('BINARY normalizer outputs equivalence-equal iff comparator equal', () => {
			assertNormalizerMatchesComparator('BINARY', BUILTIN_NORMALIZERS.BINARY, BINARY_COLLATION);
		});

		it('NOCASE normalizer outputs equivalence-equal iff comparator equal', () => {
			assertNormalizerMatchesComparator('NOCASE', BUILTIN_NORMALIZERS.NOCASE, NOCASE_COLLATION);
		});

		it('RTRIM normalizer outputs equivalence-equal iff comparator equal (only ASCII space stripped)', () => {
			assertNormalizerMatchesComparator('RTRIM', BUILTIN_NORMALIZERS.RTRIM, RTRIM_COLLATION);
		});

		it('RTRIM normalizer preserves trailing tab/NBSP (not just trimEnd)', () => {
			const norm = BUILTIN_NORMALIZERS.RTRIM;
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

		it('overriding a built-in collation without a normalizer leaves it with none', () => {
			// No built-in fallback: handing back BUILTIN_NORMALIZERS.NOCASE here would
			// partition strings the way the *replaced* comparator did, not the new one,
			// so grouping would be confidently wrong. The raw accessor reports absence
			// and the resolver turns that absence into a loud error.
			const db = new Database();
			db.registerCollation('NOCASE', (a, b) => a.localeCompare(b));
			expect(db._getCollationNormalizer('NOCASE')).to.equal(undefined);
			expect(() => db.getKeyNormalizerResolver()('NOCASE'))
				.to.throw(/collation NOCASE has no key normalizer/);
		});
	});

	describe('Database.getKeyNormalizerResolver', () => {
		it('resolves undefined and BINARY to the identity normalizer', () => {
			const db = new Database();
			const resolve = db.getKeyNormalizerResolver();
			expect(resolve(undefined)).to.equal(BUILTIN_NORMALIZERS.BINARY);
			expect(resolve('BINARY')).to.equal(BUILTIN_NORMALIZERS.BINARY);
			expect(resolve('BINARY')('Foo ')).to.equal('Foo ');
		});

		it('resolves the built-in NOCASE and RTRIM normalizers on a fresh database', () => {
			const db = new Database();
			const resolve = db.getKeyNormalizerResolver();
			expect(resolve('NOCASE')('HeLLo')).to.equal('hello');
			expect(resolve('nocase')('HeLLo')).to.equal('hello');
			expect(resolve('RTRIM')('foo  ')).to.equal('foo');
		});

		it('has stable identity and reads the live registry', () => {
			const db = new Database();
			const resolve = db.getKeyNormalizerResolver();
			expect(db.getKeyNormalizerResolver()).to.equal(resolve);

			const lengthNormalizer = (s: string): string => 'x'.repeat(s.length);
			db.registerCollation('NOCASE', (a, b) => a.length - b.length, { normalizer: lengthNormalizer });
			// Registered *after* the resolver was handed out, yet visible to it.
			expect(resolve('NOCASE')).to.equal(lengthNormalizer);
		});

		it('throws on an unregistered collation name', () => {
			const db = new Database();
			expect(() => db.getKeyNormalizerResolver()('NOSUCH'))
				.to.throw(/no such collation sequence: NOSUCH/);
		});

		it('throws on a comparator-only collation, naming it', () => {
			const db = new Database();
			db.registerCollation('CMPONLY', (a, b) => (a < b ? -1 : a > b ? 1 : 0));
			expect(() => db.getKeyNormalizerResolver()('CMPONLY'))
				.to.throw(/collation CMPONLY has no key normalizer/);
		});
	});

	describe('registerCollation validation', () => {
		it('rejects non-function normalizer', () => {
			const db = new Database();
			expect(() => db.registerCollation('X', () => 0, 'not-a-fn' as any))
				.to.throw(/normalizer must be a function/);
		});
	});

	// `orderPreserving` asserts the normalizer preserves ORDER, not merely equality —
	// the precondition a persistent store's byte-range seek and byte-order advertisement
	// depend on. Like `replicable`, built-ins carry it and custom collations opt in.
	describe('orderPreserving assertion', () => {
		const noSpace = (s: string): string => s.replace(/ /g, '');
		const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

		/** memcmp of the UTF-8 encodings, the order the store's key bytes actually take. */
		const utf8Compare = (a: string, b: string): number => {
			const enc = new TextEncoder();
			const [x, y] = [enc.encode(a), enc.encode(b)];
			for (let i = 0; i < Math.min(x.length, y.length); i++) {
				if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
			}
			return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
		};

		// The assertion the built-ins claim, checked against the same corpus the equality
		// probe uses. CORPUS is free of astral-plane characters, and the assertion does NOT
		// hold for them: the comparators order by UTF-16 code unit, the key bytes by UTF-8.
		// Adding an astral character here should make this test fail — see the NOTE on
		// `Database.registerCollation` and `fix/bug-store-astral-text-keys-mis-order`.
		it('holds for each built-in comparator over the corpus', () => {
			const builtins: ReadonlyArray<[string, (s: string) => string, Cmp]> = [
				['BINARY', BUILTIN_NORMALIZERS.BINARY, BINARY_COLLATION],
				['NOCASE', BUILTIN_NORMALIZERS.NOCASE, NOCASE_COLLATION],
				['RTRIM', BUILTIN_NORMALIZERS.RTRIM, RTRIM_COLLATION],
			];
			for (const [name, normalize, cmpFn] of builtins) {
				for (const a of CORPUS) {
					for (const b of CORPUS) {
						const byComparator = Math.sign(cmpFn(a, b));
						const byBytes = Math.sign(utf8Compare(normalize(a), normalize(b)));
						expect(byBytes, `${name}: (${JSON.stringify(a)}, ${JSON.stringify(b)})`)
							.to.equal(byComparator);
					}
				}
			}
		});

		it('stamps the three built-ins', () => {
			const db = new Database();
			expect(db._isCollationOrderPreserving('BINARY')).to.be.true;
			expect(db._isCollationOrderPreserving('NOCASE')).to.be.true;
			expect(db._isCollationOrderPreserving('RTRIM')).to.be.true;
			// Name resolution is case-insensitive, matching every other collation lookup.
			expect(db._isCollationOrderPreserving('nocase')).to.be.true;
		});

		it('returns false for an unregistered collation', () => {
			const db = new Database();
			expect(db._isCollationOrderPreserving('NOSUCH')).to.be.false;
		});

		it('defaults to false for a custom collation registered with the options form', () => {
			const db = new Database();
			db.registerCollation('NOCASE', cmp, { normalizer: noSpace });
			expect(db._isCollationOrderPreserving('NOCASE')).to.be.false;
		});

		it('defaults to false for the legacy positional-normalizer form', () => {
			const db = new Database();
			db.registerCollation('NOCASE', cmp, noSpace);
			expect(db._isCollationOrderPreserving('NOCASE')).to.be.false;
		});

		it('honors orderPreserving: true in the options form', () => {
			const db = new Database();
			db.registerCollation('NOCASE', cmp, { normalizer: noSpace, orderPreserving: true });
			expect(db._isCollationOrderPreserving('NOCASE')).to.be.true;
		});

		it('overriding a built-in name drops the built-in assertion', () => {
			const db = new Database();
			db.registerCollation('RTRIM', cmp, { normalizer: noSpace });
			expect(db._isCollationOrderPreserving('RTRIM')).to.be.false;
		});

		it('is vacuous — and so false — without a normalizer', () => {
			const db = new Database();
			db.registerCollation('CMPONLY', cmp, { orderPreserving: true });
			expect(db._isCollationOrderPreserving('CMPONLY')).to.be.false;
		});

		it('is independent of the replicable assertion', () => {
			const db = new Database();
			db.registerCollation('NOCASE', cmp, { normalizer: noSpace, replicable: true });
			expect(db._isCollationReplicable('NOCASE')).to.be.true;
			expect(db._isCollationOrderPreserving('NOCASE')).to.be.false;

			db.registerCollation('RTRIM', cmp, { normalizer: noSpace, orderPreserving: true });
			expect(db._isCollationReplicable('RTRIM')).to.be.false;
			expect(db._isCollationOrderPreserving('RTRIM')).to.be.true;
		});
	});
});
