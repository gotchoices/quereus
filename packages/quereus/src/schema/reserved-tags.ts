import type { SqlValue } from '../common/types.js';

/**
 * Typed registry for the reserved `quereus.*` tag namespace.
 *
 * Free-form user tags (`display_name = '...'`, `audit = true`) are untouched —
 * only keys under the `quereus.` prefix are governed here. The namespace is a
 * precise mini-language designed across the docs:
 *
 * - `quereus.update.{target, exclude, default_for.<column>, delete_via, policy}`
 *   — view-mutation propagation overrides (`docs/view-updateability.md`
 *   § Tags: The Override Surface).
 * - `quereus.lens.ack.<code>[:<target>]`, `quereus.lens.access.<col>`
 *   — lens advisory acknowledgments / access-pattern hints (`docs/lens.md`
 *   § Acknowledging advisories).
 *
 * This module is the single shape/site validation entry point those keys flow
 * through. It is **additive and behavior-neutral**: it reads no reserved tag's
 * *semantics* (propagation, default expressions, ack fingerprinting, escalation
 * policy all stay in their owning tickets); it only proves that a `quereus.*`
 * key is spelled correctly (matches a {@link ReservedTagSpec}), sits where it is
 * legal ({@link TagSite}), and carries a well-shaped value
 * ({@link TagValueSchema}) — surfacing a sited {@link TagDiagnostic} otherwise.
 *
 * The two downstream consumers (the lens prover's reserved-tag parser, and the
 * view-mutation `quereus.update.*` override surface) read through
 * {@link getReservedTag} / {@link getReservedTagByTemplate} rather than
 * re-parsing the namespace at scattered sites.
 */

/** The reserved namespace prefix. Keys not starting with this are user tags. */
export const RESERVED_TAG_NAMESPACE = 'quereus.';

/**
 * The declaration / statement site a tag was found at. Validation is
 * site-sensitive: a key valid in one position can be illegal in another (e.g.
 * `quereus.update.delete_via` is meaningful on an `except` branch or a join, but
 * not on a plain view DDL).
 */
export type TagSite =
	| 'view-ddl'            // CREATE VIEW / CREATE MATERIALIZED VIEW WITH TAGS
	| 'projection'          // a result-column tag (future; reserved for default_for)
	| 'join'                // a JOIN-clause tag
	| 'union-branch'        // a compound-set branch tag
	| 'dml-stmt'            // INSERT/UPDATE/DELETE ... WITH (...) statement-level tag
	| 'logical-table'       // tags on a declared logical TableSchema
	| 'logical-constraint'  // tags on a logical RowConstraint/Unique/ForeignKey schema
	| 'physical-table';     // tags on a physical (basis) TableSchema — e.g. quereus.lens.decomp.*

/** Closed value set for `quereus.update.delete_via` (docs/view-updateability.md:277). */
export const DELETE_VIA_VALUES = ['left_delete', 'right_insert', 'parent'] as const;
export type DeleteViaValue = typeof DELETE_VIA_VALUES[number];

/** Closed value set for `quereus.update.policy` (docs/view-updateability.md:278). */
export const UPDATE_POLICY_VALUES = ['strict', 'lenient'] as const;
export type UpdatePolicyValue = typeof UPDATE_POLICY_VALUES[number];

/** Closed value set for `quereus.lens.decomp.role.<id>` (docs/lens.md § The Default Mapper). */
export const DECOMP_ROLE_VALUES = ['primary-storage', 'auxiliary-access'] as const;
/** Closed value set for `quereus.lens.decomp.presence.<id>`. */
export const DECOMP_PRESENCE_VALUES = ['mandatory', 'optional'] as const;
/** Closed value set for `quereus.lens.decomp.keykind.<id>`. */
export const DECOMP_KEYKIND_VALUES = ['surrogate', 'logical-tuple'] as const;
/** Closed value set for `quereus.lens.decomp.generator.<id>` (a surrogate generator strategy). */
export const DECOMP_GENERATOR_VALUES = ['integer-auto', 'uuid7', 'callback'] as const;
/** Closed value set for `quereus.lens.decomp.gencadence.<id>`. */
export const DECOMP_CADENCE_VALUES = ['per-row', 'per-statement'] as const;

/**
 * The shape a reserved tag's value must satisfy. Validation here is purely
 * structural — e.g. an `'expression'` value must be TEXT, but its SQL validity
 * is the consuming ticket's concern, not this registry's.
 */
export type TagValueSchema =
	| 'string'
	| 'csv-of-identifiers'                 // comma-separated base-table/branch names
	| { readonly enum: readonly string[] } // closed value set, e.g. policy/delete_via
	| 'required-nonempty-rationale'        // non-empty TEXT; empty => warning
	| 'expression';                        // a SQL expression string (default_for.<col>)

/**
 * One entry in the reserved-tag spec table. `key` is either an exact key string
 * or a single-placeholder template (`{ template: 'quereus.lens.ack.<code>' }`),
 * whose placeholder captures the entire remainder after the literal prefix.
 */
export interface ReservedTagSpec {
	/** Either an exact key, or a template with one `<segment>` placeholder. */
	readonly key: string | { readonly template: string };
	/** The sites this key is legal at. A frozen list (membership via `includes`). */
	readonly sites: readonly TagSite[];
	readonly valueSchema: TagValueSchema;
	readonly description: string;
}

/** Why a reserved tag failed validation. */
export type TagDiagnosticReason =
	| 'unknown-reserved-tag'   // key in the quereus.* namespace with no matching spec
	| 'tag-not-allowed-here'   // valid spec, but not legal at this site
	| 'invalid-tag-value';     // value fails its TagValueSchema (e.g. empty ack rationale)

/**
 * A sited diagnostic for one offending reserved tag. Mirrors the
 * `MutationDiagnostic` pattern (`planner/mutation/mutation-diagnostic.ts`), with
 * an added `severity`: the docs distinguish hard-error keys (a typo or mis-site
 * must fail loudly) from advisory keys (an empty `quereus.lens.ack` rationale is
 * itself only a warning — `docs/lens.md:176`). Validation is **policy-free**: it
 * attaches severity and lets the caller decide whether a warning blocks.
 */
export interface TagDiagnostic {
	readonly reason: TagDiagnosticReason;
	readonly severity: 'error' | 'warning';
	readonly key: string;           // the offending reserved key, verbatim
	readonly site: TagSite;         // where it was found
	readonly message: string;       // human-facing, sited
	readonly suggestion?: string;   // copy-pasteable remediation when one applies
}

/**
 * The reserved-tag spec table — deeply frozen (the array, each spec entry, and
 * each entry's `sites` list are immutable, so this shared module singleton can
 * never be mutated by a consumer), transcribed directly from the doc tables.
 * Each entry cites its doc source. The two downstream tickets
 * (`3-lens-prover-and-constraint-attachment` Phase C, `view-mutation-plan-node-substrate`
 * Phase 2) consume this rather than re-declaring the namespace.
 */
const RESERVED_TAG_SPECS: ReservedTagSpec[] = [
	// --- quereus.update.* : view-mutation propagation overrides ---
	{
		// docs/view-updateability.md:284
		key: 'quereus.update.target',
		sites: siteSet('view-ddl', 'union-branch', 'join', 'dml-stmt'),
		valueSchema: 'csv-of-identifiers',
		description: 'Restrict propagation to the listed base relation(s)/branch(es).',
	},
	{
		// docs/view-updateability.md:285
		key: 'quereus.update.exclude',
		sites: siteSet('view-ddl', 'union-branch', 'join', 'dml-stmt'),
		valueSchema: 'csv-of-identifiers',
		description: 'Exclude the listed branches (the inverse of target).',
	},
	{
		// docs/view-updateability.md:286
		key: { template: 'quereus.update.default_for.<column>' },
		sites: siteSet('view-ddl', 'projection'),
		valueSchema: 'expression',
		description: 'Default expression for insert through the view when the column is omitted.',
	},
	{
		// docs/view-updateability.md:287, 165, 220
		key: 'quereus.update.delete_via',
		sites: siteSet('union-branch', 'join'),
		valueSchema: { enum: DELETE_VIA_VALUES },
		description: 'For except: left_delete (default) or right_insert; for joins: the side whose deletion realizes the view-level delete.',
	},
	{
		// docs/view-updateability.md:288
		key: 'quereus.update.policy',
		sites: siteSet('view-ddl'),
		valueSchema: { enum: UPDATE_POLICY_VALUES },
		description: 'strict (reject any ambiguity) or lenient (default; predicate-honest fan-out).',
	},
	// --- quereus.lens.* : lens advisory acknowledgments / access hints ---
	{
		// docs/lens.md:176, 190 — code is <code>[:<target>]; remainder captured whole.
		key: { template: 'quereus.lens.ack.<code>' },
		sites: siteSet('logical-table', 'logical-constraint'),
		valueSchema: 'required-nonempty-rationale',
		description: 'Acknowledge a lens advisory; the value is a required rationale.',
	},
	{
		// docs/lens.md:166, 176
		key: { template: 'quereus.lens.access.<col>' },
		sites: siteSet('logical-table'),
		valueSchema: 'string',
		description: 'Declare an expected lookup/ordering access pattern on a column.',
	},
	// --- quereus.lens.decomp.* : module mapping-advertisement facts on basis tables ---
	// A generic module (memory/store) assembles a MappingAdvertisement from these
	// reserved tags on its basis tables via `buildAdvertisementsFromTags`
	// (docs/lens.md § The Default Mapper). Each decomposition `<id>`'s facts are
	// distributed across its member basis tables. The facet leads the key so each
	// is a single-placeholder template the registry validates (shape/site only —
	// the builder does the id/facet sub-parsing and the resolver does structural
	// validation). All sit at the `physical-table` site.
	{
		key: { template: 'quereus.lens.decomp.logical.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'Logical table the decomposition <id> backs (declared on each member; resolver checks consistency).',
	},
	{
		key: { template: 'quereus.lens.decomp.role.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_ROLE_VALUES },
		description: 'Role of decomposition <id>: primary-storage (drives put) or auxiliary-access (read-path only).',
	},
	{
		key: { template: 'quereus.lens.decomp.anchor.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'Existence-anchor relationId of decomposition <id> (must equal the advertisement id and be a member).',
	},
	{
		key: { template: 'quereus.lens.decomp.member.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'This table\'s member relationId within decomposition <id> (defaults to the table name when absent).',
	},
	{
		key: { template: 'quereus.lens.decomp.presence.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_PRESENCE_VALUES },
		description: 'This member\'s presence in decomposition <id>: mandatory (inner-join) or optional (outer-join).',
	},
	{
		key: { template: 'quereus.lens.decomp.keykind.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_KEYKIND_VALUES },
		description: 'Shared-key kind of decomposition <id>: surrogate (requires a generator) or logical-tuple.',
	},
	{
		key: { template: 'quereus.lens.decomp.key.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: 'csv-of-identifiers',
		description: 'This member\'s shared-key column(s) within decomposition <id> (the equi-join columns).',
	},
	{
		key: { template: 'quereus.lens.decomp.generator.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_GENERATOR_VALUES },
		description: 'Surrogate generator strategy for decomposition <id> (required when keykind is surrogate).',
	},
	{
		key: { template: 'quereus.lens.decomp.gencadence.<id>' },
		sites: siteSet('physical-table'),
		valueSchema: { enum: DECOMP_CADENCE_VALUES },
		description: 'Surrogate generator cadence for decomposition <id>: per-row or per-statement.',
	},
	{
		// Remainder captured whole as `<id>.<logicalColumn>`; the builder sub-parses it.
		key: { template: 'quereus.lens.decomp.col.<id_dot_column>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'Basis column on THIS member backing logical column <logicalColumn> of decomposition <id>.',
	},
	{
		// Remainder captured whole as `<id>.<entity|attribute|value>`.
		key: { template: 'quereus.lens.decomp.pivot.<id_dot_facet>' },
		sites: siteSet('physical-table'),
		valueSchema: 'string',
		description: 'EAV pivot column (entity/attribute/value) on THIS member for decomposition <id>.',
	},
];

export const RESERVED_TAGS: readonly ReservedTagSpec[] = Object.freeze(
	RESERVED_TAG_SPECS.map(spec => Object.freeze(spec)),
);

/**
 * The value type a reserved key resolves to, keyed off the literal key. Enum
 * specs surface their closed union; every other reserved value is TEXT (a CSV,
 * an expression, a rationale, an access hint), so the default is `string`. Lets
 * a consumer read `delete_via` as its union, never a re-parsed bare `SqlValue`.
 */
export type TypedValueFor<K extends string> =
	K extends 'quereus.update.delete_via' ? DeleteViaValue :
	K extends 'quereus.update.policy' ? UpdatePolicyValue :
	string;

/**
 * Validates every `quereus.*` key in `tags` against the registry for the given
 * {@link TagSite}, returning a (possibly empty) list of {@link TagDiagnostic}.
 *
 * Per key: not in the namespace → skipped (free-form user tag); in the namespace
 * with no matching spec → `unknown-reserved-tag` (error); spec matches but the
 * site is illegal → `tag-not-allowed-here` (error); site OK but the value fails
 * its schema → `invalid-tag-value` (severity per {@link TagValueSchema} — an
 * empty ack rationale is a warning, all other value failures are errors).
 *
 * This function is policy-free: it never throws and never decides whether a
 * warning blocks. The caller (lens compile, the future escalation-policy parser)
 * owns that decision.
 */
export function validateReservedTags(
	tags: Record<string, SqlValue> | undefined,
	site: TagSite,
): TagDiagnostic[] {
	if (!tags) return [];
	const diagnostics: TagDiagnostic[] = [];
	for (const [key, value] of Object.entries(tags)) {
		if (!key.startsWith(RESERVED_TAG_NAMESPACE)) continue;
		const matched = matchSpec(key);
		if (!matched) {
			diagnostics.push(unknownReservedTag(key, site));
			continue;
		}
		if (!matched.spec.sites.includes(site)) {
			diagnostics.push(tagNotAllowedHere(key, site, matched.spec));
			continue;
		}
		const valueDiag = validateTagValue(key, value, site, matched.spec.valueSchema);
		if (valueDiag) diagnostics.push(valueDiag);
	}
	return diagnostics;
}

/**
 * Typed read of one reserved tag by its **exact** key. Does no validation —
 * callers run {@link validateReservedTags} first. Returns undefined when the key
 * is absent or null. For templated key families use
 * {@link getReservedTagByTemplate}.
 */
export function getReservedTag<K extends string>(
	tags: Record<string, SqlValue> | undefined,
	key: K,
): TypedValueFor<K> | undefined {
	const value = tags?.[key];
	return value == null ? undefined : (value as TypedValueFor<K>);
}

/** One enumerated instance of a templated reserved key. */
export interface TemplatedTagInstance {
	/** The captured remainder after the template's literal prefix (e.g. `created`, `no-backing-index:vin`). */
	readonly segment: string;
	/** The tag value, read verbatim (templated reserved values are all TEXT). */
	readonly value: string;
}

/**
 * Enumerates every instance of a templated reserved key family. For
 * `'quereus.lens.ack.<code>'`, a `tags` carrying
 * `quereus.lens.ack.no-backing-index:vin` yields one instance with
 * `segment === 'no-backing-index:vin'`. Like {@link getReservedTag}, this does
 * no validation; non-TEXT values are coerced to string so a mis-typed tag does
 * not crash enumeration (validate first to reject it).
 */
export function getReservedTagByTemplate(
	tags: Record<string, SqlValue> | undefined,
	template: string,
): TemplatedTagInstance[] {
	if (!tags) return [];
	const prefix = templatePrefix(template);
	const result: TemplatedTagInstance[] = [];
	for (const [key, value] of Object.entries(tags)) {
		if (!key.startsWith(prefix)) continue;
		const segment = key.slice(prefix.length);
		if (segment.length === 0) continue; // empty remainder is not an instance
		result.push({ segment, value: value == null ? '' : String(value) });
	}
	return result;
}

// === internal: matching ===

interface MatchedSpec {
	readonly spec: ReservedTagSpec;
	/** For a template spec, the captured remainder; undefined for an exact spec. */
	readonly segment?: string;
}

/**
 * Finds the spec a reserved key matches. Exact specs are tried first, then
 * single-placeholder templates (remainder captured whole, including any
 * `:target` refinement — sub-parsing is the consumer's job). A template whose
 * remainder would be empty does not match (so `quereus.update.default_for.` with
 * no column is an unknown key).
 */
function matchSpec(key: string): MatchedSpec | undefined {
	for (const spec of RESERVED_TAGS) {
		if (typeof spec.key === 'string' && spec.key === key) return { spec };
	}
	for (const spec of RESERVED_TAGS) {
		if (typeof spec.key === 'string') continue;
		const prefix = templatePrefix(spec.key.template);
		if (key.startsWith(prefix) && key.length > prefix.length) {
			return { spec, segment: key.slice(prefix.length) };
		}
	}
	return undefined;
}

/** The literal prefix of a template, up to its `<placeholder>`. */
function templatePrefix(template: string): string {
	const idx = template.indexOf('<');
	return idx < 0 ? template : template.slice(0, idx);
}

/** A frozen, genuinely-immutable list of legal sites for one spec. */
function siteSet(...sites: TagSite[]): readonly TagSite[] {
	return Object.freeze(sites);
}

// === internal: value-schema validation ===

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$.]*$/;

/** TEXT predicate — reserved tag values that must be strings. */
function isText(value: SqlValue): value is string {
	return typeof value === 'string';
}

/**
 * Validates one value against its {@link TagValueSchema}. Returns a diagnostic
 * on failure, or undefined when the value is well-shaped. Severity follows the
 * doc rule: an empty `required-nonempty-rationale` is a warning; all other value
 * failures are errors.
 */
function validateTagValue(
	key: string,
	value: SqlValue,
	site: TagSite,
	schema: TagValueSchema,
): TagDiagnostic | undefined {
	if (typeof schema === 'object') {
		return validateEnum(key, value, site, schema.enum);
	}
	switch (schema) {
		case 'string':
		case 'expression':
			return isText(value)
				? undefined
				: invalidValue(key, site, `must be a text value`, 'error');
		case 'csv-of-identifiers':
			return validateCsvOfIdentifiers(key, value, site);
		case 'required-nonempty-rationale':
			return validateRationale(key, value, site);
	}
}

function validateEnum(
	key: string,
	value: SqlValue,
	site: TagSite,
	allowed: readonly string[],
): TagDiagnostic | undefined {
	if (isText(value) && allowed.includes(value)) return undefined;
	return invalidValue(
		key,
		site,
		`has invalid value ${formatValue(value)}; expected one of: ${allowed.join(', ')}`,
		'error',
	);
}

function validateCsvOfIdentifiers(
	key: string,
	value: SqlValue,
	site: TagSite,
): TagDiagnostic | undefined {
	if (!isText(value) || value.trim().length === 0) {
		return invalidValue(key, site, `must be a non-empty comma-separated list of identifiers`, 'error');
	}
	const segments = value.split(',');
	for (const seg of segments) {
		const token = seg.trim();
		if (token.length === 0 || !IDENTIFIER_RE.test(token)) {
			return invalidValue(
				key,
				site,
				`must be a comma-separated list of identifiers (offending segment: ${formatValue(token)})`,
				'error',
			);
		}
	}
	return undefined;
}

/**
 * A `quereus.lens.ack.*` rationale. An empty / missing / whitespace / non-TEXT
 * value is a **warning** (docs/lens.md:176 — "an empty or missing rationale is
 * itself a warning"); the ack never hard-blocks a deploy.
 */
function validateRationale(
	key: string,
	value: SqlValue,
	site: TagSite,
): TagDiagnostic | undefined {
	if (isText(value) && value.trim().length > 0) return undefined;
	return invalidValue(
		key,
		site,
		`has an empty or missing acknowledgment rationale; provide a non-empty justification`,
		'warning',
		`set ${JSON.stringify(key)} = '<why this advisory is accepted>'`,
	);
}

// === internal: diagnostic constructors ===

function unknownReservedTag(key: string, site: TagSite): TagDiagnostic {
	return {
		reason: 'unknown-reserved-tag',
		severity: 'error',
		key,
		site,
		message: `Unknown reserved tag ${formatValue(key)} on ${siteLabel(site)}: no such key in the reserved 'quereus.*' namespace`,
		suggestion: `Recognized keys: quereus.update.{target, exclude, default_for.<column>, delete_via, policy}, quereus.lens.ack.<code>, quereus.lens.access.<col>, quereus.lens.decomp.{logical,role,anchor,member,presence,keykind,key,generator,gencadence}.<id>, quereus.lens.decomp.{col,pivot}.<id>.<...>`,
	};
}

function tagNotAllowedHere(key: string, site: TagSite, spec: ReservedTagSpec): TagDiagnostic {
	const allowed = spec.sites.map(siteLabel).join(', ');
	return {
		reason: 'tag-not-allowed-here',
		severity: 'error',
		key,
		site,
		message: `Reserved tag ${formatValue(key)} is not allowed on ${siteLabel(site)}; it is valid only on: ${allowed}`,
	};
}

function invalidValue(
	key: string,
	site: TagSite,
	detail: string,
	severity: 'error' | 'warning',
	suggestion?: string,
): TagDiagnostic {
	return {
		reason: 'invalid-tag-value',
		severity,
		key,
		site,
		message: `Reserved tag ${formatValue(key)} on ${siteLabel(site)} ${detail}`,
		suggestion,
	};
}

/** Human label for a {@link TagSite}, for sited messages. */
function siteLabel(site: TagSite): string {
	switch (site) {
		case 'view-ddl': return 'a view declaration';
		case 'projection': return 'a result column';
		case 'join': return 'a join clause';
		case 'union-branch': return 'a compound-set branch';
		case 'dml-stmt': return 'a DML statement';
		case 'logical-table': return 'a logical table';
		case 'logical-constraint': return 'a logical constraint';
		case 'physical-table': return 'a basis table';
	}
}

/** Render a tag key/value for a message: quote strings, stringify the rest. */
function formatValue(value: SqlValue): string {
	return typeof value === 'string' ? `'${value}'` : String(value);
}
