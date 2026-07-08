/**
 * Tests for key encoding utilities.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import {
  encodeValue,
  encodeCompositeKey,
  decodeValue,
  decodeCompositeKey,
  registerCollationEncoder,
  getCollationEncoder,
  type CollationEncoder,
} from '../src/common/encoding.js';

describe('Key Encoding', () => {
  describe('encodeValue / decodeValue', () => {
    it('should encode and decode NULL', () => {
      const encoded = encodeValue(null);
      expect(encoded).to.deep.equal(new Uint8Array([0x00]));

      const { value, bytesRead } = decodeValue(encoded);
      expect(value).to.be.null;
      expect(bytesRead).to.equal(1);
    });

    it('should encode and decode positive integers', () => {
      const testCases = [0n, 1n, 127n, 128n, 255n, 256n, 65535n, 2147483647n, 9007199254740991n];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should encode and decode negative integers', () => {
      const testCases = [-1n, -127n, -128n, -255n, -256n, -65535n, -2147483648n];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should preserve integer sort order', () => {
      const values = [-1000n, -1n, 0n, 1n, 1000n];
      const encoded = values.map(v => encodeValue(v));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `${values[i]} should sort before ${values[i + 1]}`);
      }
    });

    it('should encode and decode floating point numbers', () => {
      // Note: Integer-valued floats like 0.0 are encoded as integers
      // Only test actual non-integer floats here
      const testCases = [0.5, 1.5, -1.5, 3.14159, -3.14159];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should preserve float sort order', () => {
      // Use non-integer floats to ensure they're encoded as REAL
      const values = [-1000.5, -1.5, -0.5, 0.5, 1.5, 1000.5];
      const encoded = values.map(v => encodeValue(v));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `${values[i]} should sort before ${values[i + 1]}`);
      }
    });

    it('should encode and decode strings with NOCASE', () => {
      const testCases = ['', 'hello', 'Hello World', 'UPPERCASE', 'MixedCase'];

      for (const str of testCases) {
        const encoded = encodeValue(str, { collation: 'NOCASE' });
        const { value } = decodeValue(encoded, 0, { collation: 'NOCASE' });
        // NOCASE stores lowercase
        expect(value).to.equal(str.toLowerCase(), `Failed for "${str}"`);
      }
    });

    it('should encode and decode strings with BINARY', () => {
      const testCases = ['', 'hello', 'Hello World', 'UPPERCASE'];

      for (const str of testCases) {
        const encoded = encodeValue(str, { collation: 'BINARY' });
        const { value } = decodeValue(encoded, 0, { collation: 'BINARY' });
        expect(value).to.equal(str, `Failed for "${str}"`);
      }
    });

    it('should preserve NOCASE string sort order', () => {
      const values = ['apple', 'Banana', 'CHERRY', 'date'];

      // Sort by encoded bytes
      const sorted = [...values].sort((a, b) => {
        const ea = encodeValue(a, { collation: 'NOCASE' });
        const eb = encodeValue(b, { collation: 'NOCASE' });
        return compareBytes(ea, eb);
      });

      expect(sorted).to.deep.equal(['apple', 'Banana', 'CHERRY', 'date']);
    });

    it('should handle strings with null bytes', () => {
      const str = 'hello\x00world';
      const encoded = encodeValue(str, { collation: 'BINARY' });
      const { value } = decodeValue(encoded, 0, { collation: 'BINARY' });
      expect(value).to.equal(str);
    });

    it('should encode and decode blobs', () => {
      const testCases = [
        new Uint8Array([]),
        new Uint8Array([0, 1, 2, 3]),
        new Uint8Array([255, 254, 253]),
        new Uint8Array(1000).fill(42),
      ];

      for (const blob of testCases) {
        const encoded = encodeValue(blob);
        const { value } = decodeValue(encoded);
        expect(value).to.deep.equal(blob);
      }
    });

    it('should preserve blob sort order (element-wise, matching SQL)', () => {
      // Regression for store-blob-key-varint-not-memcmp-ordered: the encoded
      // bytes must memcmp in element-wise blob order, not by length. Covers the
      // exact bug (x'0102' < x'03' though shorter), prefix < extension, empty <
      // non-empty, and the escaped content bytes 0x00/0x01/0x02 in order.
      const blobs = [
        new Uint8Array([]),          // empty sorts first
        new Uint8Array([0x00]),      // escaped 0x00
        new Uint8Array([0x00, 0x00]),
        new Uint8Array([0x01]),      // escaped 0x01
        new Uint8Array([0x01, 0x02]),
        new Uint8Array([0x01, 0x02, 0xff]), // prefix < extension
        new Uint8Array([0x02]),      // raw byte
        new Uint8Array([0x03]),      // x'0102' (above) must sort before this
        new Uint8Array([0xff]),
      ];
      const encoded = blobs.map(b => encodeValue(b));
      for (let i = 0; i < encoded.length - 1; i++) {
        expect(compareBytes(encoded[i], encoded[i + 1])).to.be.lessThan(
          0, `blob ${i} should sort before blob ${i + 1}`);
      }
    });

    describe('JSON object canonical key encoding', () => {
      it('encodes reorder-equal objects to identical bytes', () => {
        // {a:1,b:2} and {b:2,a:1} compare equal (deepCompareJson sorts keys), so
        // their persisted byte keys MUST match — otherwise a JSON PK stores two rows.
        const a = encodeValue({ a: 1, b: 2 } as unknown as SqlValue);
        const b = encodeValue({ b: 2, a: 1 } as unknown as SqlValue);
        expect(compareBytes(a, b)).to.equal(0);
      });

      it('encodes reorder-equal nested objects to identical bytes', () => {
        const a = encodeValue({ outer: { z: 1, a: 2 }, list: [{ q: 1, p: 2 }] } as unknown as SqlValue);
        const b = encodeValue({ list: [{ p: 2, q: 1 }], outer: { a: 2, z: 1 } } as unknown as SqlValue);
        expect(compareBytes(a, b)).to.equal(0);
      });

      it('encodes structurally distinct objects to different bytes', () => {
        const a = encodeValue({ a: 1 } as unknown as SqlValue);
        const b = encodeValue({ a: 2 } as unknown as SqlValue);
        expect(compareBytes(a, b)).to.not.equal(0);
      });

      it('keeps array element order significant', () => {
        const a = encodeValue([1, 2] as unknown as SqlValue);
        const b = encodeValue([2, 1] as unknown as SqlValue);
        expect(compareBytes(a, b)).to.not.equal(0);
      });
    });
  });

  describe('encodeCompositeKey / decodeCompositeKey', () => {
    it('should encode and decode composite keys', () => {
      const values = [1n, 'hello', 3.14];
      const encoded = encodeCompositeKey(values, { collation: 'NOCASE' });
      const decoded = decodeCompositeKey(encoded, 3, { collation: 'NOCASE' });

      expect(decoded[0]).to.equal(1n);
      expect(decoded[1]).to.equal('hello'); // lowercase due to NOCASE
      expect(decoded[2]).to.equal(3.14);
    });

    it('should preserve composite key sort order', () => {
      const keys = [
        [1n, 'a'],
        [1n, 'b'],
        [2n, 'a'],
        [2n, 'b'],
      ];

      const encoded = keys.map(k => encodeCompositeKey(k, { collation: 'NOCASE' }));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `Key ${i} should sort before key ${i + 1}`);
      }
    });

    describe('DESC direction (per-component bit inversion)', () => {
      it('single DESC INTEGER inverts byte order', () => {
        const values = [1n, 2n, 3n];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('single DESC TEXT inverts byte order', () => {
        const values = ['apple', 'banana', 'cherry'];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('single DESC REAL inverts byte order', () => {
        const values = [1.5, 2.1, 3.7];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('single DESC BLOB inverts variable-length order under bit inversion', () => {
        // The escape+terminator scheme must stay order-correct after ^0xff. Uses
        // a prefix pair (x'0102' < x'0102ff') and the length-vs-content pair
        // (x'0102' < x'03') to exercise the terminator under inversion.
        const values = [
          new Uint8Array([0x01, 0x02]),
          new Uint8Array([0x01, 0x02, 0xff]),
          new Uint8Array([0x03]),
        ];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        // DESC: larger blobs sort first, so ASC index 2 > 1 > 0 reverses.
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('ASC then DESC: ASC preserved across groups, DESC within group', () => {
        const pairs: Array<[string, bigint]> = [
          ['a', 1n], ['a', 2n], ['a', 3n],
          ['b', 1n], ['b', 2n], ['b', 3n],
        ];
        const encoded = pairs.map(p =>
          encodeCompositeKey(p, { collation: 'NOCASE' }, [false, true]),
        );
        const sorted = pairs
          .map((p, i) => ({ p, bytes: encoded[i] }))
          .sort((a, b) => compareBytes(a.bytes, b.bytes))
          .map(x => x.p);
        expect(sorted).to.deep.equal([
          ['a', 3n], ['a', 2n], ['a', 1n],
          ['b', 3n], ['b', 2n], ['b', 1n],
        ]);
      });

      it('DESC then ASC: primary DESC group, secondary ASC within group', () => {
        const pairs: Array<[string, bigint]> = [
          ['a', 1n], ['a', 2n],
          ['b', 1n], ['b', 2n],
        ];
        const encoded = pairs.map(p =>
          encodeCompositeKey(p, { collation: 'NOCASE' }, [true, false]),
        );
        const sorted = pairs
          .map((p, i) => ({ p, bytes: encoded[i] }))
          .sort((a, b) => compareBytes(a.bytes, b.bytes))
          .map(x => x.p);
        expect(sorted).to.deep.equal([
          ['b', 1n], ['b', 2n],
          ['a', 1n], ['a', 2n],
        ]);
      });

      it('omitted directions is equivalent to all-false ASC', () => {
        const values: Array<bigint | string | number> = [1n, 'x', 2.5];
        const a = encodeCompositeKey(values, { collation: 'NOCASE' });
        const b = encodeCompositeKey(values, { collation: 'NOCASE' }, [false, false, false]);
        expect(a).to.deep.equal(b);
      });
    });
  });

  describe('CollationEncoder infrastructure', () => {
    it('should have built-in NOCASE encoder', () => {
      const encoder = getCollationEncoder('NOCASE');
      expect(encoder).to.exist;
      expect(encoder!.encode('HELLO')).to.equal('hello');
    });

    it('should have built-in BINARY encoder', () => {
      const encoder = getCollationEncoder('BINARY');
      expect(encoder).to.exist;
      expect(encoder!.encode('HELLO')).to.equal('HELLO');
    });

    it('should have built-in RTRIM encoder', () => {
      const encoder = getCollationEncoder('RTRIM');
      expect(encoder).to.exist;
      expect(encoder!.encode('hello   ')).to.equal('hello');
    });

    it('should preserve RTRIM sort order', () => {
      const values = ['a', 'a  ', 'a   ', 'b', 'b '];
      const sorted = [...values].sort((a, b) => {
        const ea = encodeValue(a, { collation: 'RTRIM' });
        const eb = encodeValue(b, { collation: 'RTRIM' });
        return compareBytes(ea, eb);
      });
      // With RTRIM, 'a', 'a  ', 'a   ' all sort the same, then 'b', 'b '
      expect(sorted[0]).to.match(/^a/);
      expect(sorted[1]).to.match(/^a/);
      expect(sorted[2]).to.match(/^a/);
      expect(sorted[3]).to.match(/^b/);
      expect(sorted[4]).to.match(/^b/);
    });

    it('should allow registering custom collation encoder', () => {
      const reverseEncoder: CollationEncoder = {
        encode: (value: string) => value.split('').reverse().join(''),
      };
      registerCollationEncoder('REVERSE', reverseEncoder);

      const encoder = getCollationEncoder('REVERSE');
      expect(encoder).to.exist;
      expect(encoder!.encode('abc')).to.equal('cba');
    });

    it('should be case-insensitive for encoder lookup', () => {
      expect(getCollationEncoder('nocase')).to.exist;
      expect(getCollationEncoder('NOCASE')).to.exist;
      expect(getCollationEncoder('NoCase')).to.exist;
    });

    it('should use custom encoder for key encoding', () => {
      // Register a custom encoder that uppercases
      const upperEncoder: CollationEncoder = {
        encode: (value: string) => value.toUpperCase(),
      };
      registerCollationEncoder('UPPER', upperEncoder);

      const encoded = encodeValue('hello', { collation: 'UPPER' });
      const { value } = decodeValue(encoded);
      expect(value).to.equal('HELLO');
    });
  });
});

/**
 * Compare two byte arrays lexicographically.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

