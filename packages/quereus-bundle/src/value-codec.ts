import { Pair, Scalar, YAMLMap, YAMLSeq, isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { DocumentOptions, Node, ParseOptions, ScalarTag, SchemaOptions, ToJSOptions, ToStringOptions } from 'yaml';
import { canonicalizeSqlValue, type SqlValue } from '@quereus/quereus';

/**
 * Converts between `SqlValue`s and YAML nodes. The engine's numeric rule R1
 * (`docs/types.md` § Physical representation: a value is a `bigint` only outside the
 * safe-integer range) is what lets an integer and a float be told apart on the way back:
 * a safe integer is written as a YAML int, every other `number` as a YAML float, and
 * ints are read as `bigint` and narrowed again.
 */

/** A JSON value as `JSON.parse` produces it. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const YAML_TAG = 'tag:yaml.org,2002:';
const BINARY_TAG = `${YAML_TAG}binary`;

/**
 * `!!binary`, replacing the `yaml` library's own: that one base64-encodes a typed array's
 * whole backing buffer rather than its view, reads into a Node `Buffer`, and accepts
 * malformed base64 silently. This one reads into a plain `Uint8Array` and refuses
 * malformed text, which a bundle from an untrusted source may hold.
 */
const binaryTag: ScalarTag = {
	tag: BINARY_TAG,
	default: false,
	identify: value => value instanceof Uint8Array,
	resolve(text, onError) {
		const bytes = base64ToBytes(text);
		if (bytes) return bytes;
		onError('!!binary value is not valid base64');
		return text;
	},
	// An empty plain scalar after a tag reads as null, so empty bytes are quoted.
	stringify: item => bytesToBase64(item.value as Uint8Array) || '""',
};

/** Options for every `Document` the bundle writer builds. */
export const DOCUMENT_OPTIONS: DocumentOptions & SchemaOptions = {
	version: '1.2',
	customTags: [binaryTag],
};

/**
 * Options for `Document.toString`. `lineWidth: 0` and the unbounded multi-line length keep
 * every scalar, and so every data row, on one line.
 */
export const STRINGIFY_OPTIONS: ToStringOptions = {
	lineWidth: 0,
	blockQuote: 'literal',
	flowCollectionPadding: false,
	doubleQuotedMinMultiLineLength: Number.POSITIVE_INFINITY,
};

/**
 * Options for parsing a bundle document. `intAsBigInt` is the only way a large integer
 * survives the read without losing precision; {@link decodeValue} narrows it again.
 */
export const PARSE_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
	version: '1.2',
	customTags: [binaryTag],
	intAsBigInt: true,
	uniqueKeys: true,
};

/**
 * Options for `Document.toJS` on a parsed bundle document. A bundle never contains
 * aliases, and refusing them closes alias-expansion attacks from untrusted files.
 */
export const TO_JS_OPTIONS: ToJSOptions = {
	maxAliasCount: 0,
};

/** Explicit tags a bundle may carry. Anything else (`!!timestamp`, `!!set`, a local tag) is refused. */
const ALLOWED_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'binary', 'seq', 'map'].map(name => YAML_TAG + name));

/**
 * The YAML node for `value`.
 *
 * @throws TypeError for a value that has no lossless encoding: a `Date`, `Map`, class
 *   instance, or a JSON-shaped value holding anything but JSON.
 */
export function encodeValue(value: SqlValue): Node {
	if (value instanceof Uint8Array) return new Scalar(value);
	if (Array.isArray(value) || isPlainObject(value)) return encodeJson(value);
	return encodeScalar(value);
}

/**
 * A string scalar. A line break of any YAML version is written escaped in double quotes,
 * so the text stays on one line. The `yaml` library already quotes text that would read
 * back as another type (`"true"`, `"1"`, `""`), and escapes unpaired surrogates, which
 * would otherwise become invalid UTF-8 on disk.
 */
export function encodeString(text: string): Scalar {
	// NOTE: `yaml` escapes only C0 controls and unpaired surrogates; DEL, C1 controls, U+FEFF and
	// U+FFFE/U+FFFF stay raw. That is valid UTF-8 and `yaml` reads it back, but a strict YAML 1.2
	// parser rejects non-printable characters. If bundles must be read by other YAML tools, escape them here.
	const node = new Scalar(text);
	if (LINE_BREAK.test(text)) node.type = Scalar.QUOTE_DOUBLE;
	return node;
}

const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

function encodeScalar(value: unknown): Node {
	switch (typeof value) {
		case 'string': return encodeString(value);
		case 'number': return encodeNumber(value);
		case 'bigint':
		case 'boolean':
			return new Scalar(value);
		default:
			if (value === null) return new Scalar(null);
			throw new TypeError(`cannot encode a ${describe(value)} value`);
	}
}

/**
 * A safe integer other than `-0` is written as a YAML int. Every other number is written so
 * it reads back as a float: `-0.0`, exponent form for a whole number past the safe range
 * (decimal digits alone would read as an int), `.nan` / `.inf`, and the shortest
 * round-trip form for a fraction.
 */
function encodeNumber(value: number): Scalar {
	const node = new Scalar(value);
	if (Number.isSafeInteger(value) && !Object.is(value, -0)) return node;
	if (Object.is(value, -0)) node.minFractionDigits = 1;
	else if (Number.isInteger(value)) node.format = 'EXP';
	return node;
}

function encodeJson(value: unknown): Node {
	if (Array.isArray(value)) {
		const seq = new YAMLSeq();
		seq.flow = true;
		seq.items = value.map(encodeJson);
		return seq;
	}
	if (isPlainObject(value)) {
		const map = new YAMLMap();
		map.flow = true;
		for (const key of Object.keys(value)) {
			map.items.push(new Pair(encodeString(key), encodeJson(value[key])));
		}
		return map;
	}
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return encodeScalar(value);
	}
	throw new TypeError(`cannot encode a ${describe(value)} inside a JSON value`);
}

/**
 * The `SqlValue` a bundle node holds: scalars as their own type (an int narrowed by
 * `canonicalizeSqlValue`), `!!binary` as a `Uint8Array`, and a sequence or map as a JSON
 * array or object with JSON semantics (numbers, string keys).
 *
 * @throws TypeError for an alias, a tag the format does not use, a scalar of another type
 *   (a `!!timestamp` date, say), or a map with a non-scalar key.
 */
export function decodeValue(node: unknown): SqlValue {
	checkNode(node);
	if (isScalar(node)) {
		const value = node.value;
		if (value instanceof Uint8Array) return value;
		if (node.tag === BINARY_TAG) throw new TypeError('!!binary value is not valid base64');
		return canonicalizeSqlValue(decodeScalarValue(value));
	}
	return decodeJson(node) as SqlValue;
}

function decodeScalarValue(value: unknown): string | number | bigint | boolean | null {
	if (value === null) return null;
	switch (typeof value) {
		case 'string':
		case 'number':
		case 'bigint':
		case 'boolean':
			return value;
		default:
			throw new TypeError(`unexpected ${describe(value)} scalar`);
	}
}

function decodeJson(node: unknown): JsonValue {
	checkNode(node);
	if (isSeq(node)) return node.items.map(decodeJson);
	if (isMap(node)) return decodeJsonObject(node);
	if (!isScalar(node)) throw new TypeError('unexpected YAML node');
	if (node.value instanceof Uint8Array || node.tag === BINARY_TAG) throw new TypeError('!!binary inside a JSON value');
	const value = decodeScalarValue(node.value);
	return typeof value === 'bigint' ? Number(value) : value;
}

function decodeJsonObject(node: YAMLMap): { [key: string]: JsonValue } {
	const result: { [key: string]: JsonValue } = {};
	for (const pair of node.items) {
		checkNode(pair.key);
		if (!isScalar(pair.key) || pair.key.value instanceof Uint8Array) {
			throw new TypeError('a JSON object key must be a scalar');
		}
		// defineProperty, as JSON.parse does: assigning a `__proto__` key would replace the prototype.
		Object.defineProperty(result, String(pair.key.value), {
			value: decodeJson(pair.value),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return result;
}

function checkNode(node: unknown): void {
	if (isAlias(node)) throw new TypeError('aliases are not allowed in a bundle');
	if (!isScalar(node) && !isSeq(node) && !isMap(node)) throw new TypeError('unexpected YAML node');
	if (node.tag !== undefined && !ALLOWED_TAGS.has(node.tag)) throw new TypeError(`tag ${node.tag} is not allowed in a bundle`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (typeof value === 'object' && value !== null) return value.constructor?.name ?? 'object';
	return typeof value;
}

/** Bytes per `String.fromCharCode` call, under every engine's argument-count limit. */
const BASE64_CHUNK = 0x8000;
const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
	}
	return btoa(binary);
}

/** The bytes `text` encodes, or undefined when it is not padded base64. Whitespace is ignored: another writer may wrap it. */
function base64ToBytes(text: string): Uint8Array | undefined {
	const compact = text.replace(/[ \t\r\n]/g, '');
	if (!BASE64_TEXT.test(compact)) return undefined;
	const binary = atob(compact);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
