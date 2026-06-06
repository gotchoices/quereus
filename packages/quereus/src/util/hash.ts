/**
 * Hash and encoding utilities
 */

/**
 * Computes FNV-1a hash of a string (64-bit variant)
 * Returns an 8-byte array representing the hash
 * 
 * FNV-1a is a fast, non-cryptographic hash function with good distribution.
 * See: http://www.isthe.com/chongo/tech/comp/fnv/
 */
export function fnv1aHash(str: string): Uint8Array {
	// FNV-1a 64-bit parameters
	// Using two 32-bit integers to represent 64-bit hash (JavaScript limitation)
	let hashHigh = 0xcbf29ce4; // Upper 32 bits of FNV offset basis
	let hashLow = 0x84222325;  // Lower 32 bits of FNV offset basis
	
	const fnvPrimeHigh = 0x00000100; // Upper 32 bits of FNV prime
	const fnvPrimeLow = 0x000001b3;  // Lower 32 bits of FNV prime

	for (let i = 0; i < str.length; i++) {
		const charCode = str.charCodeAt(i);
		
		// XOR with byte (handle multi-byte characters)
		hashLow ^= charCode & 0xff;
		
		// Multiply by FNV prime (64-bit multiplication using 32-bit parts)
		const aHigh = hashHigh;
		const aLow = hashLow;
		
		const fullLow = aLow * fnvPrimeLow;
		hashLow = fullLow >>> 0;
		hashHigh = (aHigh * fnvPrimeLow + aLow * fnvPrimeHigh + Math.floor(fullLow / 0x100000000)) >>> 0;
		
		// Handle high byte of character if present
		if (charCode > 0xff) {
			hashLow ^= (charCode >>> 8) & 0xff;
			const bHigh = hashHigh;
			const bLow = hashLow;
			const fullLow2 = bLow * fnvPrimeLow;
			hashLow = fullLow2 >>> 0;
			hashHigh = (bHigh * fnvPrimeLow + bLow * fnvPrimeHigh + Math.floor(fullLow2 / 0x100000000)) >>> 0;
		}
	}

	// Convert to 8-byte array
	const bytes = new Uint8Array(8);
	bytes[0] = (hashHigh >>> 24) & 0xff;
	bytes[1] = (hashHigh >>> 16) & 0xff;
	bytes[2] = (hashHigh >>> 8) & 0xff;
	bytes[3] = hashHigh & 0xff;
	bytes[4] = (hashLow >>> 24) & 0xff;
	bytes[5] = (hashLow >>> 16) & 0xff;
	bytes[6] = (hashLow >>> 8) & 0xff;
	bytes[7] = hashLow & 0xff;
	
	return bytes;
}

/**
 * Converts a byte array to base64url encoding
 * (URL-safe base64 without padding: uses - and _ instead of + and /, no = padding)
 * 
 * Base64url is defined in RFC 4648 Section 5.
 */
export function toBase64Url(bytes: Uint8Array): string {
	const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	let result = '';
	
	for (let i = 0; i < bytes.length; i += 3) {
		// Get 3 bytes (24 bits) and convert to 4 base64 characters (6 bits each)
		const byte1 = bytes[i];
		const byte2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
		const byte3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
		
		const triplet = (byte1 << 16) | (byte2 << 8) | byte3;
		
		result += base64Chars[(triplet >>> 18) & 0x3f];
		result += base64Chars[(triplet >>> 12) & 0x3f];
		if (i + 1 < bytes.length) {
			result += base64Chars[(triplet >>> 6) & 0x3f];
		}
		if (i + 2 < bytes.length) {
			result += base64Chars[triplet & 0x3f];
		}
	}
	
	return result;
}

