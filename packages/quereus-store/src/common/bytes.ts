/**
 * Shared byte-array helpers for encoded storage keys.
 *
 * Keys are compared as unsigned bytes, matching the lexicographic ordering
 * every KVStore implementation guarantees for `iterate()`.
 */

/** Hex-encode a key for use as a Map/Set lookup. */
export function bytesToHex(key: Uint8Array): string {
	return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Byte-wise equality check for Uint8Arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Lexicographic unsigned-byte comparison — the same ordering KVStore
 * iteration yields. Negative when a < b, positive when a > b, 0 when equal.
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}
