/**
 * What reading a module's tables costs, declared by the module
 * (`VirtualTableModule.costProfile`) and lifted onto the leaf's physical
 * properties by `TableReferenceNode.computePhysical`.
 *
 * Every field is optional; an omitted field is 0, so a module that declares
 * nothing plans exactly like in-process memory. Both fields are wall-clock
 * milliseconds, converted to engine cost units at `tuning.latencyCostPerMs`.
 * A hint only — correctness must never depend on it.
 *
 * Pick the {@link COST_PRESETS preset} for the category of storage the module
 * sits on and spread it to override a field you have measured:
 * `readonly costProfile = { ...COST_PRESETS.network, perRowLatencyMs: 0.02 }`.
 */
export interface ModuleCostProfile {
	/** Wall-clock milliseconds before a freshly opened iterator hands back its first row. */
	readonly firstRowLatencyMs?: number;
	/** Wall-clock milliseconds per row after the first, in a sequential read (the full-scan rate). */
	readonly perRowLatencyMs?: number;
}

/** A {@link ModuleCostProfile} with every field filled in — what the planner reads. */
export type ResolvedModuleCostProfile = Required<ModuleCostProfile>;

/**
 * Cost profiles by storage category. The numbers are CATEGORIES, not
 * measurements of any one device: plans are sensitive to the order of magnitude
 * only. Sources and the bands behind each are in `docs/optimizer-costing.md`
 * § Module cost profile.
 *
 * The in-process categories (`memory`, `localDisk`, `browserIdb`) sit below the
 * 25 ms parallel gates (`tuning.parallel.*ThresholdMs`); the network categories
 * clear them.
 *
 * Each preset is frozen so a module that mutates one fails loudly instead of
 * editing every other module's copy, and typed as plain numbers (not literals)
 * so a subclass can redeclare its parent's preset field with another preset.
 */
export const COST_PRESETS = Object.freeze({
	/** In-process memory. Identical to declaring nothing. */
	memory: Object.freeze<ResolvedModuleCostProfile>({ firstRowLatencyMs: 0, perRowLatencyMs: 0 }),
	/** A file on local disk read in-process through a block cache (LevelDB, SQLite). */
	localDisk: Object.freeze<ResolvedModuleCostProfile>({ firstRowLatencyMs: 0.05, perRowLatencyMs: 0.004 }),
	/** Browser storage reached across the renderer's IPC boundary (IndexedDB). */
	browserIdb: Object.freeze<ResolvedModuleCostProfile>({ firstRowLatencyMs: 1, perRowLatencyMs: 0.01 }),
	/** A service one network round trip away; each request returns a page of rows. */
	network: Object.freeze<ResolvedModuleCostProfile>({ firstRowLatencyMs: 40, perRowLatencyMs: 0.04 }),
	/** A distributed store where a request may consult several nodes before answering. */
	distributed: Object.freeze<ResolvedModuleCostProfile>({ firstRowLatencyMs: 100, perRowLatencyMs: 0.2 }),
});

/**
 * Fill a declared profile in, reading an omitted field as 0 and replacing a
 * negative or non-finite field with 0 — calling `warn` once per replaced field
 * when given. `0` is a valid latency and is accepted silently.
 *
 * `costProfile` is an optional member of a public interface, so a third-party
 * module can declare anything; a `NaN` here would poison every cost sum the
 * leaf feeds. `SchemaManager.registerModule` resolves with a warning sink so a
 * bad declaration is reported once, where the module is named; the planner
 * resolves silently on every plan.
 */
export function resolveModuleCostProfile(
	declared: ModuleCostProfile | undefined,
	warn?: (message: string) => void,
): ResolvedModuleCostProfile {
	return {
		firstRowLatencyMs: resolveLatencyField(declared?.firstRowLatencyMs, 'firstRowLatencyMs', warn),
		perRowLatencyMs: resolveLatencyField(declared?.perRowLatencyMs, 'perRowLatencyMs', warn),
	};
}

function resolveLatencyField(
	value: number | undefined,
	field: keyof ResolvedModuleCostProfile,
	warn: ((message: string) => void) | undefined,
): number {
	if (value === undefined) return 0;
	if (Number.isFinite(value) && value >= 0) return value;
	warn?.(`cost profile declares an unusable ${field} (${value}); falling back to 0`);
	return 0;
}
