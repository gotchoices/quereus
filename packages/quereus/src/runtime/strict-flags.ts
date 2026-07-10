/**
 * Env-flag reads for the runtime's Node-only strict test harnesses.
 *
 * This is a **leaf module** (no imports) so both `context-helpers.ts` and
 * `strict-fork.ts` can read the flags without forming an import cycle
 * (`context-helpers` → flags ← `strict-fork` → `context-helpers`).
 *
 * Cross-platform guard: `process` is unavailable in browser / RN / edge workers,
 * where these harnesses are simply disabled. Read once at module load — the flags
 * are constant for the process lifetime.
 */

function readFlag(name: string): boolean {
	const value = typeof process !== 'undefined' ? process.env?.[name] : undefined;
	return value === '1' || value === 'true';
}

/** `QUEREUS_FORK_STRICT` — parallel fork-contract assertions (see strict-fork.ts). */
export const FORK_STRICT = readFlag('QUEREUS_FORK_STRICT');

/**
 * `QUEREUS_CONTEXT_STRICT` — stale-shadow attribute-index assertions. Detects a
 * streaming operator that leaves a row context built from its source's attribute
 * IDs winning the `attributeIndex` while a child updates a newer row for the same
 * IDs. See strict-fork.ts (`StrictRowContextMap`) and docs/runtime.md
 * § Invariant: source-attr contexts and child pulls.
 */
export const CONTEXT_STRICT = readFlag('QUEREUS_CONTEXT_STRICT');
