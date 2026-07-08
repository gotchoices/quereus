/**
 * Key encoding utilities for persistent storage.
 *
 * Encodes SQL values into byte arrays that preserve sort order when compared
 * lexicographically. Supports composite keys and collation-aware encoding.
 *
 * Type prefixes ensure correct cross-type ordering:
 *   0x00 - NULL (sorts first)
 *   0x01 - NUMERIC (bigint + number unified; orders by value across int/real)
 *   0x03 - TEXT (UTF-8, null-terminated, NOCASE by default)
 *   0x04 - BLOB (raw bytes, escaped + null-terminated)
 *
 * Collation support:
 *   Collations can register a CollationEncoder to transform strings before
 *   binary encoding, preserving their sort semantics in the key-value store.
 */

import type { SqlValue, JsonSqlValue } from '@quereus/quereus';
import { canonicalJsonString } from '@quereus/quereus';

// ============================================================================
// Collation Encoder Infrastructure
// ============================================================================

/**
 * Interface for collation-aware string encoding.
 * Implementations transform strings to preserve collation sort order
 * when encoded as binary keys.
 */
export interface CollationEncoder {
  /** Transform a string for sort-preserving binary encoding. */
  encode(value: string): string;
}

/** Registry of collation encoders. */
const collationEncoders = new Map<string, CollationEncoder>();

/**
 * Register a collation encoder.
 * @param name Collation name (case-insensitive)
 * @param encoder The encoder implementation
 */
export function registerCollationEncoder(name: string, encoder: CollationEncoder): void {
  collationEncoders.set(name.toUpperCase(), encoder);
}

/**
 * Get a registered collation encoder.
 * @param name Collation name (case-insensitive)
 * @returns The encoder, or undefined if not registered
 */
export function getCollationEncoder(name: string): CollationEncoder | undefined {
  return collationEncoders.get(name.toUpperCase());
}

// Built-in collation encoders

/** NOCASE: Lowercase for case-insensitive ordering (default). */
const NOCASE_ENCODER: CollationEncoder = {
  encode: (value: string) => value.toLowerCase(),
};

/** BINARY: No transformation, native byte ordering. */
const BINARY_ENCODER: CollationEncoder = {
  encode: (value: string) => value,
};

/** RTRIM: Trim trailing spaces before encoding. */
const RTRIM_ENCODER: CollationEncoder = {
  encode: (value: string) => value.replace(/\s+$/, ''),
};

// Register built-in encoders
registerCollationEncoder('NOCASE', NOCASE_ENCODER);
registerCollationEncoder('BINARY', BINARY_ENCODER);
registerCollationEncoder('RTRIM', RTRIM_ENCODER);

// ============================================================================
// Encoding Options
// ============================================================================

/** Options for encoding keys. */
export interface EncodeOptions {
  /** Collation name for TEXT values. Default: 'NOCASE'. */
  collation?: string;
}

/** Type prefix bytes. */
const TYPE_NULL = 0x00;
/**
 * Unified numeric tag for BOTH bigint (INTEGER) and number (REAL). A single tag
 * is required so a whole number and a fractional number interleave by value:
 * a per-shape INTEGER/REAL tag would sort every integer-shaped value before
 * every real-shaped one (0x01 < 0x02), placing 3.0 below 2.5. See encodeNumeric.
 */
const TYPE_NUMERIC = 0x01;
const TYPE_TEXT = 0x03;
const TYPE_BLOB = 0x04;
const TYPE_OBJECT = 0x05;

/** Fixed width of a TYPE_NUMERIC key: tag + sortable double + signed tie-break. */
const NUMERIC_KEY_LENGTH = 17;

/** Escape byte for null bytes within strings. */
const ESCAPE_BYTE = 0x01;
const NULL_BYTE = 0x00;

/**
 * Encode a single SQL value into a sortable byte array.
 */
export function encodeValue(value: SqlValue, options?: EncodeOptions): Uint8Array {
  const collation = options?.collation ?? 'NOCASE';

  if (value === null) {
    return new Uint8Array([TYPE_NULL]);
  }

  if (typeof value === 'bigint' || typeof value === 'number') {
    return encodeNumeric(value);
  }

  if (typeof value === 'string') {
    return encodeText(value, collation);
  }

  if (value instanceof Uint8Array) {
    return encodeBlob(value);
  }

  if (typeof value === 'boolean') {
    return encodeNumeric(value ? 1n : 0n);
  }

  // JSON objects/arrays — serialize to a canonical (recursive object-key-sorted)
  // JSON string so reorder-equal values ({a:1,b:2} vs {b:2,a:1}) encode to the
  // same bytes, matching the in-memory JSON comparator. Arrays stay positional.
  if (typeof value === 'object') {
    return encodeObject(canonicalJsonString(value as JsonSqlValue), collation);
  }

  throw new Error(`Cannot encode value of type ${typeof value}`);
}

/**
 * Encode a composite key (multiple values) into a single byte array.
 *
 * When `directions` is provided, each position flagged `true` (DESC) has its
 * encoded bytes bit-inverted (`^0xff`). Bit-inversion of a fixed-width sortable
 * encoding preserves inverse byte-lex order, so natural iteration over the KV
 * store yields DESC order for those components.
 *
 * When `collations` is provided, each position with a defined entry encodes that
 * component under its own collation, overriding `options.collation` — so a
 * composite primary key can carry a *per-column* key collation (e.g. a BINARY
 * member alongside a NOCASE member) rather than one collation for the whole key.
 * A `undefined` entry (or no array) falls back to `options.collation`. Collation
 * only affects TEXT/OBJECT encoding; non-text components ignore it, so a
 * per-column override on an integer/real/blob member is a harmless no-op.
 */
export function encodeCompositeKey(
  values: SqlValue[],
  options?: EncodeOptions,
  directions?: ReadonlyArray<boolean>,
  collations?: ReadonlyArray<string | undefined>,
): Uint8Array {
  const parts = values.map((v, i) => {
    const colCollation = collations?.[i];
    const colOptions = colCollation !== undefined ? { ...options, collation: colCollation } : options;
    const encoded = encodeValue(v, colOptions);
    if (directions && directions[i]) {
      for (let j = 0; j < encoded.length; j++) {
        encoded[j] ^= 0xff;
      }
    }
    return encoded;
  });
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Encode any numeric value — bigint (INTEGER) OR number (REAL) — into ONE
 * order-preserving key whose memcmp order matches `compareNumbers` (the
 * in-memory NUMERIC comparator): every value orders by true magnitude across the
 * int/real boundary, with full int64 precision preserved even where a large
 * integer shares its nearest double with a neighbour.
 *
 * Layout (fixed 17 bytes so the DESC bit-inversion `encodeCompositeKey` applies
 * stays trivially order-correct, exactly as the old fixed-width int/real bodies):
 *
 *   [TYPE_NUMERIC][ 8-byte sortable double ][ 8-byte signed tie-break ]
 *
 * Primary 8 bytes: the sortable-double transform (IEEE-754 big-endian, all bits
 * flipped for negatives / sign bit only for non-negatives) of the nearest double
 * `p = Number(value)`. This alone orders every value correctly EXCEPT ties, and
 * preserves `-Inf < … < +Inf < NaN`. Two distinct finite doubles never share a
 * bit pattern, so the ONLY prefix collisions are among integers that round to the
 * same double (a contiguous run of int64s past 2^53).
 *
 * Tie-break 8 bytes: the exact signed residual `offset = value - p` (big-endian
 * with sign bit flipped, so negative < positive). Within a same-double tie-set
 * the true order is integer order, which `offset` reproduces exactly — its
 * magnitude is bounded by half the double's ulp (≤ ~2^11 for int64). A `number`
 * is its own exact double (`p === value`), so its offset is always 0 and it never
 * ties with anything.
 *
 * `-0` is normalized to `+0` so `-0`, `+0`, and `0n` collide to one key
 * (`compareNumbers` treats them equal).
 */
function encodeNumeric(value: number | bigint): Uint8Array {
  const buffer = new Uint8Array(NUMERIC_KEY_LENGTH);
  buffer[0] = TYPE_NUMERIC;
  const view = new DataView(buffer.buffer);

  // Nearest double + exact residual. A number is exact (offset 0); a bigint's
  // nearest double is always integer-valued, so the residual is an exact integer.
  let primary: number;
  let offset: bigint;
  if (typeof value === 'bigint') {
    primary = Number(value);
    offset = value - BigInt(primary);
  } else {
    primary = Object.is(value, -0) ? 0 : value;
    offset = 0n;
  }

  // Primary: sortable IEEE-754 double.
  view.setFloat64(1, primary, false); // big-endian
  if (primary < 0) {
    // Negative: flip all bits so more-negative sorts first.
    for (let i = 1; i < 9; i++) buffer[i] ^= 0xff;
  } else {
    // Non-negative (incl. +0, +Inf, NaN): flip only the sign bit.
    buffer[1] ^= 0x80;
  }

  // Tie-break: signed int64 residual, big-endian with sign bit flipped.
  view.setBigInt64(9, offset, false);
  buffer[9] ^= 0x80;

  return buffer;
}

/**
 * Encode raw bytes as an order-preserving, null-terminated sequence behind a
 * type tag. Each 0x00 content byte becomes `0x01 0x01` and each 0x01 becomes
 * `0x01 0x02`, then a single 0x00 terminator is appended. This preserves memcmp
 * order for variable-length byte strings: the terminator (0x00) sorts below any
 * escaped content continuation (which begins at 0x01, or a raw byte >= 0x02), so
 * a proper prefix always sorts before its extensions, and the escape map is
 * monotonic in the source byte. Shared by TEXT, OBJECT, and BLOB.
 */
function writeEscapedWithTerminator(typeTag: number, bytes: Uint8Array): Uint8Array {
  // Count bytes needing escape (null bytes and escape bytes)
  let escapeCount = 0;
  for (const byte of bytes) {
    if (byte === NULL_BYTE || byte === ESCAPE_BYTE) escapeCount++;
  }

  // Allocate: type prefix + escaped content + null terminator
  const result = new Uint8Array(1 + bytes.length + escapeCount + 1);
  result[0] = typeTag;

  let writePos = 1;
  for (const byte of bytes) {
    if (byte === NULL_BYTE) {
      result[writePos++] = ESCAPE_BYTE;
      result[writePos++] = 0x01; // Escaped null
    } else if (byte === ESCAPE_BYTE) {
      result[writePos++] = ESCAPE_BYTE;
      result[writePos++] = 0x02; // Escaped escape
    } else {
      result[writePos++] = byte;
    }
  }
  result[writePos] = NULL_BYTE; // Terminator

  return result;
}

/**
 * Encode text with collation support.
 * Uses null-termination with escape sequences for embedded nulls.
 */
function encodeText(value: string, collation: string): Uint8Array {
  // Apply collation transformation via encoder registry
  const collationEncoder = getCollationEncoder(collation) ?? NOCASE_ENCODER;
  const sortValue = collationEncoder.encode(value);

  // Encode as UTF-8
  const utf8 = new TextEncoder().encode(sortValue);
  return writeEscapedWithTerminator(TYPE_TEXT, utf8);
}

/**
 * Encode a blob so its stored bytes sort element-by-element (matching SQL blob
 * comparison). Emits the raw content bytes through the shared escape + 0x00
 * terminator scheme — a blob is already raw bytes, so there is no collation or
 * UTF-8 step. (The prior length-prefix layout sorted a shorter blob before a
 * longer one regardless of content, which broke leading-PK range seeks.)
 */
function encodeBlob(value: Uint8Array): Uint8Array {
  return writeEscapedWithTerminator(TYPE_BLOB, value);
}

/**
 * Encode a JSON object/array as text with TYPE_OBJECT prefix.
 * Uses the same encoding as TEXT for sort order (by JSON string representation).
 */
function encodeObject(jsonString: string, collation: string): Uint8Array {
  const collationEncoder = getCollationEncoder(collation) ?? NOCASE_ENCODER;
  const sortValue = collationEncoder.encode(jsonString);
  const utf8 = new TextEncoder().encode(sortValue);
  return writeEscapedWithTerminator(TYPE_OBJECT, utf8);
}

// ============================================================================
// Decoding functions
// ============================================================================

/**
 * Decode a single value from a byte array.
 * Returns the decoded value and the number of bytes consumed.
 */
export function decodeValue(
  buffer: Uint8Array,
  offset: number = 0,
  options?: EncodeOptions
): { value: SqlValue; bytesRead: number } {
  if (offset >= buffer.length) {
    throw new Error('Buffer underflow: no type byte');
  }

  const typePrefix = buffer[offset];

  switch (typePrefix) {
    case TYPE_NULL:
      return { value: null, bytesRead: 1 };

    case TYPE_NUMERIC:
      return decodeNumeric(buffer, offset);

    case TYPE_TEXT:
      return decodeText(buffer, offset, options?.collation ?? 'NOCASE');

    case TYPE_BLOB:
      return decodeBlob(buffer, offset);

    case TYPE_OBJECT:
      return decodeObject(buffer, offset);

    default:
      throw new Error(`Unknown type prefix: 0x${typePrefix.toString(16)}`);
  }
}

/**
 * Decode a composite key into an array of values.
 */
export function decodeCompositeKey(
  buffer: Uint8Array,
  expectedCount?: number,
  options?: EncodeOptions
): SqlValue[] {
  const values: SqlValue[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const { value, bytesRead } = decodeValue(buffer, offset, options);
    values.push(value);
    offset += bytesRead;

    if (expectedCount !== undefined && values.length >= expectedCount) {
      break;
    }
  }

  return values;
}

/**
 * Decode a {@link encodeNumeric} key: reconstruct the primary double and the
 * signed residual, then return the exact value. Integer-valued results return a
 * `bigint`, non-integers a `number` — matching the pre-existing decode contract
 * (integer-valued reals like `0.0` encode/roundtrip to `0n`). Every downstream
 * comparator is numeric-class-tolerant (`5n` equals `5.0`), so the bigint/number
 * choice never affects correctness.
 */
function decodeNumeric(buffer: Uint8Array, offset: number): { value: SqlValue; bytesRead: number } {
  if (offset + NUMERIC_KEY_LENGTH > buffer.length) {
    throw new Error(`Buffer underflow: expected ${NUMERIC_KEY_LENGTH} bytes for NUMERIC`);
  }

  // Primary double: reverse the sortable-double sign manipulation. The encoder
  // sets the top bit to 1 for non-negatives, so a cleared top bit ⇒ was negative.
  const primaryBytes = buffer.slice(offset + 1, offset + 9);
  const wasNegative = (buffer[offset + 1] & 0x80) === 0;
  if (wasNegative) {
    for (let i = 0; i < 8; i++) primaryBytes[i] ^= 0xff;
  } else {
    primaryBytes[0] ^= 0x80;
  }
  const primary = new DataView(primaryBytes.buffer, primaryBytes.byteOffset, 8).getFloat64(0, false);

  // Tie-break residual: reverse the sign-bit flip.
  const offsetBytes = buffer.slice(offset + 9, offset + NUMERIC_KEY_LENGTH);
  offsetBytes[0] ^= 0x80;
  const residual = new DataView(offsetBytes.buffer, offsetBytes.byteOffset, 8).getBigInt64(0, false);

  if (residual === 0n) {
    // Exact value == primary double. Integer-valued (incl. large whole reals) ⇒
    // bigint; fractional / non-finite ⇒ number.
    return Number.isInteger(primary)
      ? { value: BigInt(primary), bytesRead: NUMERIC_KEY_LENGTH }
      : { value: primary, bytesRead: NUMERIC_KEY_LENGTH };
  }
  // Non-zero residual ⇒ a large integer whose nearest double is `primary` (always
  // integer-valued here). Reconstruct the exact int64: primary + residual.
  return { value: BigInt(primary) + residual, bytesRead: NUMERIC_KEY_LENGTH };
}

/**
 * Decode a null-terminated escaped byte sequence written by
 * {@link writeEscapedWithTerminator}, starting at the type byte at `offset`.
 * Un-escapes `0x01 0x01` -> 0x00 and `0x01 0x02` -> 0x01, stops at the 0x00
 * terminator, and returns the content bytes plus total bytes consumed (type tag
 * and terminator included). Shared by TEXT, OBJECT, and BLOB.
 */
function readEscapedUntilTerminator(
  buffer: Uint8Array,
  offset: number
): { bytes: Uint8Array; bytesRead: number } {
  const bytes: number[] = [];
  let i = offset + 1;

  while (i < buffer.length) {
    const byte = buffer[i];

    if (byte === NULL_BYTE) {
      // Terminator found
      i++;
      break;
    }

    if (byte === ESCAPE_BYTE && i + 1 < buffer.length) {
      const next = buffer[i + 1];
      if (next === 0x01) {
        bytes.push(NULL_BYTE);
        i += 2;
      } else if (next === 0x02) {
        bytes.push(ESCAPE_BYTE);
        i += 2;
      } else {
        bytes.push(byte);
        i++;
      }
    } else {
      bytes.push(byte);
      i++;
    }
  }

  return { bytes: new Uint8Array(bytes), bytesRead: i - offset };
}

function decodeText(
  buffer: Uint8Array,
  offset: number,
  _collation: string
): { value: string; bytesRead: number } {
  const { bytes, bytesRead } = readEscapedUntilTerminator(buffer, offset);
  const value = new TextDecoder().decode(bytes);

  // Note: We return the lowercase version if NOCASE was used during encoding.
  // The original case is preserved in the row value, not the key.
  return { value, bytesRead };
}

function decodeBlob(buffer: Uint8Array, offset: number): { value: Uint8Array; bytesRead: number } {
  const { bytes, bytesRead } = readEscapedUntilTerminator(buffer, offset);
  return { value: bytes, bytesRead };
}

function decodeObject(buffer: Uint8Array, offset: number): { value: SqlValue; bytesRead: number } {
  const { bytes, bytesRead } = readEscapedUntilTerminator(buffer, offset);
  const jsonString = new TextDecoder().decode(bytes);
  const value = JSON.parse(jsonString) as SqlValue;
  return { value, bytesRead };
}

