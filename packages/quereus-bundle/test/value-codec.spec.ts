import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Document, YAMLSeq, parseDocument } from 'yaml';
import { sqlValueIdentical, type SqlValue } from '@quereus/quereus';
import { DOCUMENT_OPTIONS, PARSE_OPTIONS, STRINGIFY_OPTIONS, decodeValue, encodeValue } from '../src/value-codec.js';

/** Writes `values` as one flow-sequence row, as a data document does, and reads it back. */
function roundTrip(values: readonly SqlValue[]): { text: string; decoded: SqlValue[] } {
	const row = new YAMLSeq();
	row.flow = true;
	row.items = values.map(encodeValue);
	const doc = new Document(null, DOCUMENT_OPTIONS);
	doc.contents = row;
	const text = doc.toString(STRINGIFY_OPTIONS);
	const parsed = parseDocument(text, PARSE_OPTIONS);
	expect(parsed.errors, text).to.deep.equal([]);
	return { text, decoded: (parsed.contents as YAMLSeq).items.map(decodeValue) };
}

const char = (code: number) => String.fromCharCode(code);

describe('value codec', () => {
	it('round-trips every kind of SqlValue through YAML text, keeping its JavaScript type', () => {
		const blob = new Uint8Array(256).map((_, i) => i);
		const values: SqlValue[] = [
			null, true, false,
			0, 42, -7, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
			-0, 0.5, 1.5e-10, 1e20, 2 ** 53, -1e300, Number.MAX_VALUE, NaN, Infinity, -Infinity,
			BigInt(Number.MAX_SAFE_INTEGER) + 1n, -(2n ** 63n), 2n ** 70n,
			'', 'true', 'false', 'yes', '1', '1.5', '0x10', '~', 'null', '.nan', '.inf', ' lead', 'trail ',
			'#hash', 'a #b', 'x: y', '- x', '[a]', '{a}', '&a', '*a', '!t', '%x', '@x', '`x', '---', '...', '"q"', '\'s\'',
			'line\nbreak', '\r\n', 'tab\there', '\ttab', `${'long '.repeat(40)}\n${'more '.repeat(40)}`,
			'\uD800', 'a\uDC00b', '😀', `nel${char(0x85)}`, `ls${char(0x2028)}ps${char(0x2029)}`, '\u0000', 'del\u007f',
			new Uint8Array(0), new Uint8Array([0, 1, 2]), blob, blob.subarray(250, 253),
			{ a: [1, 2.5, null, 'x', true, { b: 'line\nbreak' }], big: 1e20 },
			[], {}, { '1': 'one', '': 'empty', 'true': false },
			JSON.parse('{"__proto__": {"x": 1}}') as SqlValue,
		];

		const { text, decoded } = roundTrip(values);

		expect(text.trimEnd().split('\n'), 'the row stays on one line').to.have.length(1);
		expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(text)), 'no unpaired surrogate is written raw').to.equal(text);
		values.forEach((value, i) => {
			const label = `value ${i}: ${String(value)}`;
			expect(typeof decoded[i], label).to.equal(typeof value);
			expect(sqlValueIdentical(decoded[i], value), label).to.equal(true);
			if (typeof value === 'number') expect(Object.is(decoded[i], value), label).to.equal(true);
			if (value instanceof Uint8Array) expect(Object.getPrototypeOf(decoded[i])).to.equal(Uint8Array.prototype);
		});
		const protoKeyed = decoded[decoded.length - 1] as object;
		expect(Object.getPrototypeOf(protoKeyed)).to.equal(Object.prototype);
	});

	it('refuses to encode a value that has no lossless form', () => {
		for (const value of [new Date(0), new Map(), new (class Point {})(), { when: new Date(0) }, [1n], { gone: undefined }]) {
			expect(() => encodeValue(value as unknown as SqlValue), String(value)).to.throw(TypeError);
		}
	});

	it('refuses YAML a bundle never holds: aliases, other tags, malformed base64', () => {
		for (const text of ['[&a x, *a]', '[!!timestamp 2001-12-14]', '[!local x]', '[!!set {a}]', '[!!binary "@@@"]', '[{[k]: v}]']) {
			const items = (parseDocument(text, PARSE_OPTIONS).contents as YAMLSeq).items;
			expect(() => items.forEach(decodeValue), text).to.throw(TypeError);
		}
	});
});
