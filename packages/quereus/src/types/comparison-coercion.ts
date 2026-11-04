import type { LogicalType } from './logical-type.js';
import { PhysicalType } from './logical-type.js';
import { ANY_TYPE, INTEGER_TYPE, NULL_TYPE, NUMERIC_TYPE } from './builtin-types.js';

/**
 * THE type-level decision behind every comparison-site coercion: given the
 * declared types of the operands, which of them must be converted, and to what.
 * Purely about `LogicalType` — no plan nodes, no values — so both consumers read
 * the same rule and cannot drift:
 *
 * - **Plan-time** (`planner/building/coercion.ts`) maps the answer onto synthetic
 *   `CastNode` wrappers, for `=` and friends, BETWEEN, IN value lists and simple
 *   CASE.
 * - **Emit-time** (`runtime/emit/operand-comparator.ts` `makeComparisonGroup`)
 *   maps the same answer onto per-row {@link import('./cast-semantics.js').comparandConverter}
 *   calls, for the comparison builtins that *return* one of their arguments
 *   (`nullif`, `greatest`, `least`) and therefore cannot have that argument
 *   replaced by its cast.
 *
 * Both paths convert identically: a synthetic `CastNode` runs `comparandConverter`
 * per row too (`runtime/emit/cast.ts`), so "compare the converted copy" and "compare
 * the cast operand" are the same comparison.
 */

/**
 * The argument positions a function's `comparesArgs` declaration
 * ({@link import('../schema/function.js').BaseFunctionSchema.comparesArgs}) names,
 * clamped to the call's actual arity. Index 0 of the result is the group's probe.
 * Shared by the plan-time rewrite and the emit-time group builder so they cannot
 * disagree about which positions form the group.
 */
export function comparisonGroupIndices(
	comparesArgs: 'all' | readonly number[],
	argCount: number,
): readonly number[] {
	return comparesArgs === 'all'
		? Array.from({ length: argCount }, (_, i) => i)
		: comparesArgs.filter(i => i >= 0 && i < argCount);
}

/** Which side of a pairwise comparison converts, and to what. */
export interface CrossTypeCoercion {
	readonly side: 'left' | 'right';
	readonly target: LogicalType;
}

const isObject = (type: LogicalType): boolean => type.physicalType === PhysicalType.OBJECT;

/**
 * Can this operand hold text that a type's `normalizeComparand` should convert? ANY
 * counts because an untyped `?` announces it, and a bound parameter is the most common
 * way an application hands in a timestamp. By NAME, for the reason on
 * {@link textCoercionTarget}.
 */
export const isComparandSource = (type: LogicalType): boolean =>
	type.isTextual === true || type.name === ANY_TYPE.name;

/**
 * Reconcile two operand types that cannot be compared meaningfully as-is.
 * Returns `null` when neither side converts.
 *
 * Three pairings are handled, in this order:
 *
 * 1. **Object-physical vs anything else.** JSON is the engine's only logical type
 *    whose `physicalType` is `PhysicalType.OBJECT`: its runtime values are native
 *    JS objects/arrays, which `compareSqlValuesFast` short-circuits against any
 *    other storage class — so `json_col = '{"a":1}'` was unconditionally false,
 *    even for byte-identical text. The non-object side converts to the object
 *    side's type, never the reverse: converting the JSON side to text would make
 *    equality depend on spelling and put `=` out of step with the index, which
 *    compares structurally.
 *
 *    The gate is deliberately `physicalType === OBJECT`, **not** `semanticOrdering`:
 *    TIMESPAN also carries semantic ordering but is physically text, and the runtime's
 *    `tryTemporalComparison` already reconciles it. The other temporals take arm 2 below.
 *
 *    A conversion to JSON is lenient (see `types/cast-semantics.ts`): text that
 *    does not parse comes back unchanged, so `json_col = 'not json'` is false
 *    rather than an error. Note the consequence for JSON *string scalars*, which
 *    are stored as plain JS strings: a column holding `"hello"` matches BOTH the
 *    SQL literal `'"hello"'` (parses to the JSON string `hello`) and the bare
 *    `'hello'` (does not parse, falls back to the raw string `hello`, which
 *    `JSON_TYPE.compare` then compares as text). Only the first form generalizes —
 *    `'[1,2]'` matches the JSON array while a bare `[1,2]` is not SQL text at all.
 *
 *    A NULL-typed operand is left alone: the comparison is UNKNOWN regardless, so
 *    the conversion would only add a runtime hop.
 *
 * 2. **A type with `normalizeComparand` vs textual or ANY.** DATE, TIME, DATETIME and
 *    TIMESTAMP are stored in one form, so the text a query spells must convert to that form
 *    before comparison: `t = '2020-01-01T00:00:00Z'` has to find the row that literal created.
 *    The conversion is the type's own hook rather than a cast (see
 *    `types/cast-semantics.ts` `comparandConverter`), so unparseable text and non-text values
 *    survive and compare as they would unconverted. A NULL-typed operand is left alone,
 *    as in arm 1.
 *
 * 3. **Numeric vs textual.** The textual operand converts to the numeric side's
 *    type so the runtime can take the fast path — except an INTEGER side targets
 *    NUMERIC: text names its numeric value in full (`'1e3'` is 1000, `'1.5'` is
 *    1.5), and `INTEGER_TYPE.parse`'s leading-digit-prefix reading (`'1e3'` → 1,
 *    `'1.5'` → 1) turned `1000 = '1e3'` false and `int_col = '1.5'` true.
 *    NUMERIC parses the whole spelling and compares fine against INTEGER values.
 */
export function crossTypeCoercion(left: LogicalType, right: LogicalType): CrossTypeCoercion | null {
	const leftObject = isObject(left);
	const rightObject = isObject(right);

	// NOTE: two object-physical operands of DIFFERENT logical types fall through both
	// arms onto the generic runtime path. Unreachable while JSON is the only
	// PhysicalType.OBJECT type; adding a second one means deciding which side converts.
	if (leftObject !== rightObject) {
		if (leftObject && right !== NULL_TYPE) return { side: 'right', target: left };
		if (rightObject && left !== NULL_TYPE) return { side: 'left', target: right };
		return null;
	}

	// NOTE: wrapping a join key in this cast takes `dt_col = text_col` out of
	// `extractEquiPairs` and into the join's residual, so it no longer plans as a hash
	// join (same-type joins are unaffected). Fine now; if joining one of these types to
	// text shows up as slow, canonicalize the key instead.
	if (left.normalizeComparand && isComparandSource(right)) return { side: 'right', target: left };
	if (right.normalizeComparand && isComparandSource(left)) return { side: 'left', target: right };

	if (left.isNumeric && right.isTextual) return { side: 'right', target: textCoercionTarget(left) };
	if (right.isNumeric && left.isTextual) return { side: 'left', target: textCoercionTarget(right) };
	return null;
}

/**
 * The conversion target for a TEXT operand compared against a numeric one — the
 * numeric side's own type, except INTEGER widens to NUMERIC (arm 3 above: the
 * prefix parse must not decide a comparison). Matched by NAME: a schema
 * round-tripped through persistence may hold a non-singleton instance.
 */
function textCoercionTarget(numeric: LogicalType): LogicalType {
	return numeric.name === INTEGER_TYPE.name ? NUMERIC_TYPE : numeric;
}

/**
 * Per-operand conversion target for a "one probe against many values" comparison
 * group — an IN value list, a simple CASE, or a comparison builtin's argument
 * group. Index 0 is the probe, the rest the value list. The result is aligned with
 * the input array; `null` at a position means "leave that operand alone".
 *
 * This is more than a `map` over {@link crossTypeCoercion} because the probe is a
 * SINGLE operand shared by every value, so it can convert at most once:
 *
 * - **A value-side conversion is per value** and never conflicts: an
 *   object-physical or numeric probe leaves the probe alone and converts each
 *   value independently, so a mixed list (`case i when '1' when 2 …`) gets a
 *   per-clause decision for free.
 * - **A probe-side conversion is hoisted** and therefore has to be unambiguous.
 *   For the object arm it always is: a conversion to JSON is lenient, so a textual
 *   value that is not JSON source survives as itself and still compares as text.
 *   For the numeric arm it is NOT — `cast('abc' as real)` is `0`, so hoisting a
 *   probe conversion over a MIXED list would make `t in (1, 'abc')` true for the
 *   stored text `'0'`, which `t = 1 or t = 'abc'` is not. So the numeric probe
 *   conversion applies only when every non-NULL value is numeric. A probe converting
 *   by `normalizeComparand` is held to the same rule: it converts only when every
 *   non-NULL value has that one type.
 *
 * NOTE: the leftover gap is a textual probe against a list mixing numeric and
 * textual values (`text_col in (1, 'abc')`), which stays unconverted and so still
 * disagrees with the `=` disjunction on the numeric member. A list mixing a normalizing
 * type and text has the same gap: hoisting would make `text_col in (dt_col, '…Z')` miss an
 * exact text match that the `=` disjunction finds, so that probe stays unconverted and
 * disagrees on the normalizing member instead. Closing it needs a per-value probe, which
 * `IN` cannot express — its members live in ONE key space
 * (a BTree keyed under one collation, `runtime/emit/subquery.ts`). If that shape
 * ever matters, desugar a mixed `IN` list into an `OR` of `=` comparisons at build
 * time rather than widening the hoist here.
 */
export function comparisonGroupCoercions(
	logicals: readonly LogicalType[],
): readonly (LogicalType | null)[] {
	const none = logicals.map(() => null);
	if (logicals.length < 2) return none;

	const probe = logicals[0];
	const values = logicals.slice(1);

	/** The value-side half of a pairwise decision against an already-settled probe type. */
	const valueTarget = (probeType: LogicalType, value: LogicalType): LogicalType | null => {
		const coercion = crossTypeCoercion(probeType, value);
		return coercion?.side === 'right' ? coercion.target : null;
	};

	// Object arm: the non-object side converts, exactly as the pairwise function decides.
	const objectValue = values.find(isObject);
	if (isObject(probe) || objectValue) {
		const effectiveProbe = isObject(probe) ? probe : objectValue!;
		return [
			isObject(probe) ? null : effectiveProbe,
			...values.map(value => valueTarget(effectiveProbe, value)),
		];
	}

	// Numeric or normalizing probe: each convertible value converts to the probe's type,
	// independently.
	if (probe.isNumeric || probe.normalizeComparand) {
		return [null, ...values.map(value => valueTarget(probe, value))];
	}

	const nonNull = values.filter(type => type !== NULL_TYPE);

	// Textual or ANY probe over values of one normalizing type: one hoisted conversion.
	const normalizing = nonNull[0]?.normalizeComparand ? nonNull[0] : undefined;
	if (normalizing && isComparandSource(probe) && nonNull.every(type => type === normalizing)) {
		return [normalizing, ...values.map(() => null)];
	}

	// Textual probe: one hoisted conversion, but only over an all-numeric value list.
	if (probe.isTextual && nonNull.length > 0 && nonNull.every(type => type.isNumeric)) {
		return [commonNumericType(nonNull), ...values.map(() => null)];
	}

	return none;
}

/**
 * The conversion target for a hoisted probe over an all-numeric value list. One
 * shared type means one key space; NUMERIC is the fallback because its value
 * space (`number | bigint`) covers INTEGER and REAL together, so a list mixing a
 * bigint literal with a real one does not have to pick a lossy winner.
 */
function commonNumericType(valueTypes: readonly LogicalType[]): LogicalType {
	const first = valueTypes[0];
	// The hoisted cast lands on the TEXTUAL probe, so an all-INTEGER list still
	// widens to NUMERIC (textCoercionTarget) — the prefix parse must not decide
	// `text_col in (1, 2)` any more than it may decide `text_col = 1`.
	return valueTypes.every(type => type === first) ? textCoercionTarget(first) : NUMERIC_TYPE;
}
