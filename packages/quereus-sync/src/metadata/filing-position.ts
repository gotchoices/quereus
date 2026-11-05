/**
 * Filing position: where a replica filed a fact in its own change log.
 *
 * Every fact has two timestamps, on two axes (docs/sync-protocol.md § Delta Sync
 * Optimization):
 *
 * - its **origin timestamp** (`hlc`): when it was written and by whom. Last-writer-wins,
 *   transaction identity, before-images and the sent watermark (`pt:`) all compare this.
 * - its **filing position**: the place this replica gave it in its change log (`cl:`),
 *   which is the order a peer reads the log in. The received watermark (`ps:`), the
 *   `getChangesSince` argument, the delta floor (`df:`) and a snapshot's header are
 *   positions.
 *
 * A position is an HLC value from the filing replica's own clock, so it has an HLC's
 * type and encoding, but it only means something to the replica that issued it. A fact
 * written here is filed at its own origin timestamp; a fact received from elsewhere is
 * filed at a clock tick taken when it is committed, so positions rise in the order facts
 * are filed and a position is never below its fact's origin timestamp. A record stores
 * its position only when the two differ.
 */

import { type HLC, MAX_OPSEQ, compareHLC, createHLC, serializeHLC, deserializeHLC } from '../clock/hlc.js';
import { toBase64Url, fromBase64Url } from '../clock/site.js';

/**
 * The two timestamps of a filed fact, as every `cv:` / `tb:` / `sm:` record and every
 * change-log entry carries them. The change log's writers and deleters take this rather
 * than a bare HLC, so an entry cannot be addressed by its origin timestamp by mistake.
 */
export interface FiledAt {
	/** Origin timestamp. */
	readonly hlc: HLC;
	/** Filing position; absent when it equals `hlc`. */
	readonly position?: HLC;
}

/** Where a fact is filed: the key its change-log entry sorts under. */
export function filingPosition(filed: FiledAt): HLC {
	return filed.position ?? filed.hlc;
}

/** The `position` field to store beside `hlc`: present only when the two differ. */
export function positionField(hlc: HLC, position: HLC | undefined): { position?: HLC } {
	return position !== undefined && compareHLC(position, hlc) !== 0 ? { position } : {};
}

/**
 * The positions of one filing tick, issued in order: `(tick, 0)`, `(tick, 1)`, …
 * Throws rather than wrap the uint32 `opSeq` (4 billion facts in one tick).
 */
export function positionsFrom(tick: HLC): () => HLC {
	let opSeq = 0;
	return () => {
		if (opSeq > MAX_OPSEQ) throw new Error(`A filing tick holds at most ${MAX_OPSEQ + 1} facts`);
		return createHLC(tick.wallTime, tick.counter, tick.siteId, opSeq++);
	};
}

/** A position as a JSON string: base64url of its 30-byte form, 40 characters. */
export function encodePosition(position: HLC): string {
	return toBase64Url(serializeHLC(position));
}

export function decodePosition(encoded: string): HLC {
	return deserializeHLC(fromBase64Url(encoded));
}
