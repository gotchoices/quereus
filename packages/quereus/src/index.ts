/**
 * Quereus - A TypeScript SQL Engine
 *
 * This module provides a TypeScript implementation of a SQL database engine
 * with support for virtual tables and the full SQL query language.
 */

// Core database functionality
export { Database } from './core/database.js';
export type { DatabaseInternal } from './core/database-internal.js';
export { Statement } from './core/statement.js';
export { Table } from './core/table-handle.js';

// Common data types and constants
export { StatusCode, SqlDataType } from './common/types.js';
export type { SqlValue, JsonSqlValue, SqlParameters, Row, MaybePromise, RowOp, ConstraintType, UpdateResult } from './common/types.js';
export { isUpdateOk, isConstraintViolation, isSqlValue } from './common/types.js';
export { ConflictResolution, IndexConstraintOp, VTabConfig, FunctionFlags } from './common/constants.js';
export { QuereusError, MisuseError, ConstraintError, unwrapError, formatErrorChain, getPrimaryError } from './common/errors.js';
export type { ErrorInfo } from './common/errors.js';

// Virtual Table API
export { VirtualTable } from './vtab/table.js';
export type { UpdateArgs } from './vtab/table.js';
export type { VirtualTableConnection } from './vtab/connection.js';
export { MemoryTableModule } from './vtab/memory/module.js';
export type { IndexInfo, IndexConstraint, IndexConstraintUsage, IndexOrderBy } from './vtab/index-info.js';
export { IndexScanFlags } from './vtab/index-info.js';
export type { FilterInfo } from './vtab/filter-info.js';
export type { BaseModuleConfig, SchemaChangeInfo, VtabConcurrencyMode } from './vtab/module.js';
export { getModuleConcurrencyMode, acquireConnectionLock } from './vtab/concurrency.js';

// Virtual Table Event Hooks
export type {
	VTableDataChangeEvent,
	VTableDataChangeListener,
	VTableSchemaChangeEvent,
	VTableSchemaChangeListener,
	VTableEventEmitter
} from './vtab/events.js';
export { DefaultVTableEventEmitter } from './vtab/events.js';

// Database-Level Event System (unified reactivity)
export type {
	DatabaseDataChangeEvent,
	DatabaseSchemaChangeEvent,
	DataChangeSubscriptionOptions,
	SchemaChangeSubscriptionOptions,
} from './core/database-events.js';
export { DatabaseEventEmitter } from './core/database-events.js';

// Best Access Plan API (modern vtable planning interface)
export type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ConstraintOp,
	ColumnMeta,
	PredicateConstraint,
	OrderingSpec
} from './vtab/best-access-plan.js';
export { AccessPlanBuilder, validateAccessPlan } from './vtab/best-access-plan.js';

// Collation and comparison functions
export type { CollationFunction } from './util/comparison.js';
export {
	// Collation registration and lookup
	BINARY_COLLATION,
	NOCASE_COLLATION,
	RTRIM_COLLATION,
	registerCollation,
	getCollation,
	resolveCollation,
	// Core comparison functions (critical for module implementations)
	compareSqlValues,
	compareSqlValuesFast,
	compareRows,
	compareTypedValues,
	createTypedComparator,
	// ORDER BY comparison utilities
	compareWithOrderBy,
	compareWithOrderByFast,
	createOrderByComparator,
	createOrderByComparatorFast,
	SortDirection,
	NullsOrdering,
	// Truthiness evaluation
	isTruthy,
	// Type introspection
	getSqlDataTypeName
} from './util/comparison.js';

// Type system
export type { LogicalType, CollationFunction as TypeCollationFunction } from './types/logical-type.js';
export { PhysicalType } from './types/logical-type.js';
export {
	NULL_TYPE,
	INTEGER_TYPE,
	REAL_TYPE,
	TEXT_TYPE,
	BLOB_TYPE,
	BOOLEAN_TYPE,
	NUMERIC_TYPE,
	ANY_TYPE
} from './types/builtin-types.js';
export {
	DATE_TYPE,
	TIME_TYPE,
	DATETIME_TYPE,
	TIMESPAN_TYPE
} from './types/temporal-types.js';
export { JSON_TYPE } from './types/json-type.js';
export {
	typeRegistry,
	registerType,
	getType,
	getTypeOrDefault,
	inferType
} from './types/registry.js';
export {
	validateValue,
	parseValue,
	validateAndParse,
	isValidForType,
	tryParse
} from './types/validation.js';

// SQL Parser and Compiler
export { Parser } from './parser/parser.js';
export { Lexer, TokenType, KEYWORDS } from './parser/lexer.js';
export { ParseError } from './parser/parser.js';
export { tryFoldLiteral } from './parser/utils.js';
export { quoteIdentifier } from './emit/ast-stringify.js';

// Schema management
export { SchemaManager } from './schema/manager.js';
export { buildColumnIndexMap, columnDefToSchema, resolveNamedConstraintClass, validateCollationForType } from './schema/table.js';
export type { TableSchema, IndexSchema as TableIndexSchema, UniqueConstraintSchema, NamedConstraintClass } from './schema/table.js';
export type { ColumnSchema } from './schema/column.js';
export type { MaterializedViewSchema, ViewSchema } from './schema/view.js';
export { generateTableDDL, generateIndexDDL } from './schema/ddl-generator.js';

// Partial-index predicate compilation (used by store modules to honor partial UNIQUE)
export { compilePredicate } from './vtab/memory/utils/predicate.js';
export type { CompiledPredicate } from './vtab/memory/utils/predicate.js';

// Runtime utilities
export { isAsyncIterable, getAsyncIterator, asyncIterableToArray } from './runtime/utils.js';
export { CollectingInstructionTracer } from './runtime/types.js';
export type { InstructionTracer, InstructionTraceEvent } from './runtime/types.js';

// Function registration utilities
export {
	createScalarFunction,
	createTableValuedFunction,
	createAggregateFunction
} from './func/registration.js';

export type {
	ScalarFunc,
	TableValuedFunc,
	AggregateReducer,
	AggregateFinalizer,
	FunctionSchema
} from './schema/function.js';

// Coercion utilities (for module implementations)
export {
	tryCoerceToNumber,
	coerceToNumberForArithmetic,
	coerceForComparison,
	coerceForAggregate,
	isNumericValue
} from './util/coercion.js';

// Utility functions
export { Latches } from './util/latches.js';

// Plugin helper for static loading (React Native, etc.)
export { registerPlugin } from './util/plugin-helper.js';
export type { PluginFunction } from './util/plugin-helper.js';

// Initialize runtime emitters (this ensures they are registered)
import './runtime/register.js';

// Re-export virtual table framework
export type { VirtualTableModule } from './vtab/module.js';
export type { ModuleCapabilities, IsolationCapableTable } from './vtab/capabilities.js';

// Schema type (needed by external modules implementing getMappingAdvertisements)
export type { Schema } from './schema/schema.js';

// Module mapping-advertisement protocol (lens default mapper — docs/lens.md)
export type {
	MappingAdvertisement,
	StorageShape,
	BasisRelationRef,
	DecompositionMember,
	LogicalColumnMapping,
	SharedKey,
	AccessForm,
	AccessShape,
	AttributePivot,
} from './vtab/mapping-advertisement.js';
export { buildAdvertisementsFromTags } from './schema/mapping-advertisement-tags.js';

// Lens-deployment surface (logical-schema → basis; docs/lens.md § Deployment).
// `deployLogicalSchema` is the `apply schema X` compile step for a logical
// schema; it produces a `LensDeploymentSnapshot` (the deployed basis
// representation) that the module deployment-notification hook
// (`VirtualTableModule.notifyLensDeployment`) hands to every registered module,
// so a host adapter backing the basis can reconcile its storage against the
// freshly deployed lens. The AST types these reference (`SelectStmt`,
// `DeclareSchemaStmt`) are available from `@quereus/quereus/parser`.
export { deployLogicalSchema } from './schema/lens-compiler.js';
export type {
	LensDeploymentSnapshot,
	LensTableSnapshot,
	LensRelationBacking,
} from './schema/lens.js';
export type { LensDeployReport } from './schema/lens-prover.js';

// Re-export plugin manifest types (for plugin authors, but not the loader)
export type {
	PluginManifest,
	PluginRecord,
	PluginSetting,
	VTablePluginInfo,
	FunctionPluginInfo,
	CollationPluginInfo,
	TypePluginInfo,
	PluginRegistrations
} from './vtab/manifest.js';

// Change-scope introspection
export type {
	ChangeScope,
	TableWatch,
	WatchScope,
	ScopeValue,
	ParamScopeValue,
	PortableScalarType,
	NonDetSource,
	QualifiedName,
	SerializedChangeScope,
	Subscription,
	WatchEvent,
	MatchedWatch,
	WatchHandler,
} from './planner/analysis/change-scope.js';
export {
	analyzeChangeScope,
	unionScopes,
	intersectScopes,
	bindParameters,
	isEmpty,
	describesEverything,
	serializeChangeScope,
	deserializeChangeScope,
	scalarTypeFromPortable,
} from './planner/analysis/change-scope.js';

// Debug and development utilities
export { serializePlanTree, formatPlanTree, formatPlanSummary, serializePlanTreeWithOptions } from './planner/debug.js';
export type { PlanDisplayOptions } from './planner/debug.js';

// Logging control (for environments like React Native where env vars aren't available)
export { enableLogging, disableLogging, isLoggingEnabled } from './common/logger.js';
