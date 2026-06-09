/**
 * Key encoding utilities for persistent storage.
 *
 * Encodes SQL values into byte arrays that preserve sort order when compared
 * lexicographically. Supports composite keys and collation-aware encoding.
 *
 * Type prefixes ensure correct cross-type ordering:
 *   0x00 - NULL (sorts first)
 *   0x01 - INTEGER (signed, big-endian with sign flip)
 *   0x02 - REAL (IEEE 754 with sign flip)
 *   0x03 - TEXT (UTF-8, null-terminated, NOCASE by default)
 *   0x04 - BLOB (length-prefixed)
 *
 * Collation support:
 *   Collations can register a CollationEncoder to transform strings before
 *   binary encoding, preserving their sort semantics in the key-value store.
 */

import type { SqlValue } from '@quereus/quereus';

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
const TYPE_INTEGER = 0x01;
const TYPE_REAL = 0x02;
const TYPE_TEXT = 0x03;
const TYPE_BLOB = 0x04;
const TYPE_OBJECT = 0x05;

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

  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
    return encodeInteger(typeof value === 'bigint' ? value : BigInt(value));
  }

  if (typeof value === 'number') {
    return encodeReal(value);
  }

  if (typeof value === 'string') {
    return encodeText(value, collation);
  }

  if (value instanceof Uint8Array) {
    return encodeBlob(value);
  }

  if (typeof value === 'boolean') {
    return encodeInteger(value ? 1n : 0n);
  }

  // JSON objects/arrays — serialize to JSON string and encode as text with OBJECT prefix
  if (typeof value === 'object') {
    return encodeObject(JSON.stringify(value), collation);
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
 * Encode an integer with sign-preserving byte ordering.
 * Uses big-endian with XOR on sign bit so negative < positive.
 */
function encodeInteger(value: bigint): Uint8Array {
  const buffer = new Uint8Array(9);
  buffer[0] = TYPE_INTEGER;

  // Convert to 64-bit signed representation
  const view = new DataView(buffer.buffer);

  // Write as big-endian int64
  view.setBigInt64(1, value, false);

  // Flip sign bit so negative numbers sort before positive
  buffer[1] ^= 0x80;

  return buffer;
}

/**
 * Encode a floating-point number with proper sort ordering.
 * IEEE 754 with sign manipulation for correct ordering.
 */
function encodeReal(value: number): Uint8Array {
  const buffer = new Uint8Array(9);
  buffer[0] = TYPE_REAL;

  const view = new DataView(buffer.buffer);
  view.setFloat64(1, value, false); // big-endian

  // Flip all bits for negative, just sign bit for positive
  // This makes: -Inf < -1 < -0 < +0 < +1 < +Inf < NaN
  if (value < 0 || Object.is(value, -0)) {
    for (let i = 1; i < 9; i++) {
      buffer[i] ^= 0xff;
    }
  } else {
    buffer[1] ^= 0x80;
  }

  return buffer;
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
  const encoder = new TextEncoder();
  const utf8 = encoder.encode(sortValue);

  // Count bytes needing escape (null bytes and escape bytes)
  let escapeCount = 0;
  for (const byte of utf8) {
    if (byte === NULL_BYTE || byte === ESCAPE_BYTE) {
      escapeCount++;
    }
  }

  // Allocate: type prefix + escaped content + null terminator
  const result = new Uint8Array(1 + utf8.length + escapeCount + 1);
  result[0] = TYPE_TEXT;

  let writePos = 1;
  for (const byte of utf8) {
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
 * Encode a blob with length prefix.
 * Length is encoded as a variable-length integer for compact storage.
 */
function encodeBlob(value: Uint8Array): Uint8Array {
  const lengthBytes = encodeVarInt(value.length);
  const result = new Uint8Array(1 + lengthBytes.length + value.length);
  result[0] = TYPE_BLOB;
  result.set(lengthBytes, 1);
  result.set(value, 1 + lengthBytes.length);
  return result;
}

/**
 * Encode a JSON object/array as text with TYPE_OBJECT prefix.
 * Uses the same encoding as TEXT for sort order (by JSON string representation).
 */
function encodeObject(jsonString: string, collation: string): Uint8Array {
  const collationEncoder = getCollationEncoder(collation) ?? NOCASE_ENCODER;
  const sortValue = collationEncoder.encode(jsonString);
  const encoder = new TextEncoder();
  const utf8 = encoder.encode(sortValue);

  let escapeCount = 0;
  for (const byte of utf8) {
    if (byte === NULL_BYTE || byte === ESCAPE_BYTE) escapeCount++;
  }

  const result = new Uint8Array(1 + utf8.length + escapeCount + 1);
  result[0] = TYPE_OBJECT;

  let writePos = 1;
  for (const byte of utf8) {
    if (byte === NULL_BYTE) {
      result[writePos++] = ESCAPE_BYTE;
      result[writePos++] = 0x01;
    } else if (byte === ESCAPE_BYTE) {
      result[writePos++] = ESCAPE_BYTE;
      result[writePos++] = 0x02;
    } else {
      result[writePos++] = byte;
    }
  }
  result[writePos] = NULL_BYTE;

  return result;
}

/**
 * Encode an unsigned integer as a variable-length byte sequence.
 * Uses high bit continuation: 1xxxxxxx means more bytes follow.
 */
function encodeVarInt(value: number): Uint8Array {
  if (value < 0) throw new Error('VarInt must be non-negative');

  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);

  return new Uint8Array(bytes);
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

    case TYPE_INTEGER:
      return decodeInteger(buffer, offset);

    case TYPE_REAL:
      return decodeReal(buffer, offset);

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

function decodeInteger(buffer: Uint8Array, offset: number): { value: bigint; bytesRead: number } {
  if (offset + 9 > buffer.length) {
    throw new Error('Buffer underflow: expected 9 bytes for INTEGER');
  }

  // Copy and flip sign bit back
  const copy = buffer.slice(offset + 1, offset + 9);
  copy[0] ^= 0x80;

  const view = new DataView(copy.buffer, copy.byteOffset, 8);
  const value = view.getBigInt64(0, false);

  return { value, bytesRead: 9 };
}

function decodeReal(buffer: Uint8Array, offset: number): { value: number; bytesRead: number } {
  if (offset + 9 > buffer.length) {
    throw new Error('Buffer underflow: expected 9 bytes for REAL');
  }

  const copy = buffer.slice(offset + 1, offset + 9);

  // Check sign bit (before any flipping)
  const isNegative = (buffer[offset + 1] & 0x80) === 0;

  if (isNegative) {
    // Was negative: flip all bits back
    for (let i = 0; i < 8; i++) {
      copy[i] ^= 0xff;
    }
  } else {
    // Was positive: flip just sign bit back
    copy[0] ^= 0x80;
  }

  const view = new DataView(copy.buffer, copy.byteOffset, 8);
  const value = view.getFloat64(0, false);

  return { value, bytesRead: 9 };
}

function decodeText(
  buffer: Uint8Array,
  offset: number,
  _collation: string
): { value: string; bytesRead: number } {
  // Find null terminator, handling escapes
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

  const decoder = new TextDecoder();
  const value = decoder.decode(new Uint8Array(bytes));

  // Note: We return the lowercase version if NOCASE was used during encoding.
  // The original case is preserved in the row value, not the key.
  return { value, bytesRead: i - offset };
}

function decodeBlob(buffer: Uint8Array, offset: number): { value: Uint8Array; bytesRead: number } {
  const { value: length, bytesRead: lengthBytes } = decodeVarInt(buffer, offset + 1);
  const dataStart = offset + 1 + lengthBytes;

  if (dataStart + length > buffer.length) {
    throw new Error('Buffer underflow: BLOB data truncated');
  }

  const value = buffer.slice(dataStart, dataStart + length);
  return { value, bytesRead: 1 + lengthBytes + length };
}

function decodeObject(buffer: Uint8Array, offset: number): { value: SqlValue; bytesRead: number } {
  // Decode like TEXT (null-terminated with escapes) then parse JSON
  const bytes: number[] = [];
  let i = offset + 1;

  while (i < buffer.length) {
    const byte = buffer[i];
    if (byte === NULL_BYTE) { i++; break; }
    if (byte === ESCAPE_BYTE && i + 1 < buffer.length) {
      const next = buffer[i + 1];
      if (next === 0x01) { bytes.push(NULL_BYTE); i += 2; }
      else if (next === 0x02) { bytes.push(ESCAPE_BYTE); i += 2; }
      else { bytes.push(byte); i++; }
    } else {
      bytes.push(byte);
      i++;
    }
  }

  const decoder = new TextDecoder();
  const jsonString = decoder.decode(new Uint8Array(bytes));
  const value = JSON.parse(jsonString) as SqlValue;
  return { value, bytesRead: i - offset };
}

function decodeVarInt(buffer: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    bytesRead++;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { value, bytesRead };
}

