import type { ScalarType } from '../../common/datatype.js';
import type { DeepReadonly } from '../../common/types.js';
import { PhysicalType, type LogicalType } from '../../types/logical-type.js';
import { ANY_TYPE, BLOB_TYPE, BOOLEAN_TYPE, INTEGER_TYPE, NUMERIC_TYPE, REAL_TYPE, TEXT_TYPE } from '../../types/builtin-types.js';
import { JSON_TYPE } from '../../types/json-type.js';

/**
 * Shared `returnType` declarations for the built-in scalar, aggregate and window
 * functions.
 *
 * A function that declares nothing reports ANY (unknown) — safe, but it forfeits
 * comparison specialization, cross-type coercion and write-path convert-once
 * detection (see the note on `createScalarFunction`). Declaring the truth is
 * always better, so these constants exist to make declaring it a one-token edit
 * instead of a repeated four-field object literal.
 *
 * Most built-ins return SQL NULL for input they cannot use, so the plain
 * constants are nullable; the `_NOT_NULL` variants are for the handful whose
 * implementation provably cannot return null on any path. A function that is
 * null only for a NULL or unusable argument derives its answer per call with
 * {@link nullPropagatingReturn} instead of declaring either.
 *
 * NOTE: one constant object is shared by every function that names it, so a
 * `returnType` is only ever read, never mutated. Nothing mutates one today; if a
 * caller ever needs a per-function variation, build a fresh object with
 * `scalarReturn` rather than editing a shared constant in place.
 */

/** Build a scalar return-type declaration. */
export function scalarReturn(logicalType: LogicalType, nullable = true): ScalarType {
	return { typeClass: 'scalar', logicalType, nullable, isReadOnly: true };
}

export const TEXT_RETURN = scalarReturn(TEXT_TYPE);
export const TEXT_RETURN_NOT_NULL = scalarReturn(TEXT_TYPE, false);
export const INTEGER_RETURN = scalarReturn(INTEGER_TYPE);
export const INTEGER_RETURN_NOT_NULL = scalarReturn(INTEGER_TYPE, false);
export const REAL_RETURN = scalarReturn(REAL_TYPE);
export const REAL_RETURN_NOT_NULL = scalarReturn(REAL_TYPE, false);
/** For a function whose result inhabits `number | bigint` — REAL's physical type,
 *  but admitting an out-of-safe-range `bigint` by name (see `NUMERIC_TYPE`). */
export const NUMERIC_RETURN = scalarReturn(NUMERIC_TYPE);
export const BOOLEAN_RETURN = scalarReturn(BOOLEAN_TYPE);
export const BOOLEAN_RETURN_NOT_NULL = scalarReturn(BOOLEAN_TYPE, false);
export const BLOB_RETURN = scalarReturn(BLOB_TYPE);
export const JSON_RETURN = scalarReturn(JSON_TYPE);

/**
 * For a genuinely polymorphic function whose result shape depends on the data,
 * not on the argument types — declaring this explicitly says "unknown on
 * purpose" so a reader does not have to wonder whether the declaration was
 * forgotten. Equivalent to omitting `returnType`.
 */
export const ANY_RETURN = scalarReturn(ANY_TYPE);

type ArgTypes = ReadonlyArray<DeepReadonly<LogicalType>>;

/** Whether an implementation answers every non-null value of an argument type (rather than returning NULL for it). */
export type ArgTypeAccepted = (type: DeepReadonly<LogicalType>) => boolean;

/** Every value is a JS string — what a `typeof x === 'string'` check accepts. DATE/TIME/TIMESPAN qualify. */
export const isTextValued: ArgTypeAccepted = type => type.physicalType === PhysicalType.TEXT;

/** Every value is a JS string or a `Uint8Array`. */
export const isTextOrBlobValued: ArgTypeAccepted = type =>
	type.physicalType === PhysicalType.TEXT || type.physicalType === PhysicalType.BLOB;

/** Every value is a `number` or `bigint`. */
export const isNumberValued: ArgTypeAccepted = type =>
	type.physicalType === PhysicalType.INTEGER || type.physicalType === PhysicalType.REAL;

/** `Number(x)` is never NaN for a value of this type: the number/bigint and boolean physical types. */
export const convertsToNumber: ArgTypeAccepted = type =>
	isNumberValued(type) || type.physicalType === PhysicalType.BOOLEAN;

export interface NullPropagatingSpec {
	/** The result type: fixed, or computed from the argument types (abs/floor/ceil preserve their argument's). */
	readonly logicalType: LogicalType | ((argTypes: ArgTypes) => DeepReadonly<LogicalType>);
	/** Per argument position, which types the implementation answers; a position without an entry accepts every type. */
	readonly accepts?: ReadonlyArray<ArgTypeAccepted | undefined>;
	/** The fewest arguments the implementation answers for — a call supplying fewer is NULL. Default 0. */
	readonly minArgs?: number;
}

/**
 * `inferReturnType` for a function whose result is NULL exactly when an argument is
 * NULL or is a value the implementation cannot use (`lower(5)`, `length(2)`). The
 * result is non-null only when the caller passed `argNullable`, every argument is
 * announced non-null, the call supplies `minArgs` arguments, and every argument's type
 * passes its `accepts` predicate. Anything else announces nullable — including a caller
 * that does not know argument nullability.
 *
 * Treating every argument as NULL-propagating over-claims for a function that answers a
 * NULL optional argument (`trim(s, null)` trims whitespace); over-claiming nullable is
 * sound, so such functions use this anyway and say so at the call site.
 *
 * Returns a fresh object per call: `ScalarFunctionCallNode.withChildren` re-infers from
 * rewritten operands, so nothing may be cached across calls.
 */
export function nullPropagatingReturn(spec: NullPropagatingSpec): (argTypes: ArgTypes, argNullable?: ReadonlyArray<boolean>) => ScalarType {
	const { logicalType, accepts = [], minArgs = 0 } = spec;
	const refused = (type: DeepReadonly<LogicalType>, i: number): boolean => {
		const accepted = accepts[i];
		return accepted !== undefined && !accepted(type);
	};
	return (argTypes, argNullable) => ({
		typeClass: 'scalar',
		logicalType: typeof logicalType === 'function' ? logicalType(argTypes) : logicalType,
		nullable: argNullable === undefined
			|| argTypes.length < minArgs
			|| argNullable.some(nullable => nullable)
			|| argTypes.some(refused),
		isReadOnly: true,
	});
}
