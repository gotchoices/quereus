import { BaseScope } from "./base.js";
import type { SchemaManager } from "../../schema/manager.js";
import type { PlanNode } from "../nodes/plan-node.js";
import * as AST from "../../parser/ast.js";
import { FunctionReferenceNode, TableReferenceNode } from "../nodes/reference.js";
import { Ambiguous } from "./scope.js";
import type { ScalarType } from "../../common/datatype.js";
import { type FunctionSchema, isScalarFunctionSchema } from "../../schema/function.js";
import { REAL_TYPE } from "../../types/builtin-types.js";

function getFunctionScalarType(func: FunctionSchema): ScalarType {
	return isScalarFunctionSchema(func)
		? func.returnType
		: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true };
}

export class GlobalScope extends BaseScope {
	constructor(public readonly manager: SchemaManager) {
		super();
	}

	resolveSymbol(symbolKey: string, _expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		if (symbolKey.includes('/')) {// Function: [schema.]name/nArgs
			const [name, nArgsStr] = symbolKey.split('/');
			const nArgs = parseInt(nArgsStr);
			const func = this.manager.findFunction(name, nArgs);
			if (!func) {
				return undefined;
			}

			return new FunctionReferenceNode(this, func, getFunctionScalarType(func));
		}
		// Table: [schema.]table
		const [first, second] = symbolKey.split('.');
		const schema = second ? first : undefined;
		const table = second ? second : first;
		const tableSchema = this.manager.findTable(table, schema);
		if (!tableSchema) {
			return undefined;
		}
		// Note: GlobalScope can't resolve vtab modules without a planning context
		// This path is mainly used for constraint checking where we don't need full resolution
		const vtabModule = this.manager.getModule(tableSchema.vtabModuleName);
		if (!vtabModule) {
			return undefined;
		}
		return new TableReferenceNode(this, tableSchema, vtabModule.module, vtabModule.auxData, undefined, false, this.manager);
	}

	findUnqualifiedName(name: string): PlanNode | typeof Ambiguous | undefined {
		// Functions have priority over tables.
		// Check for zero-argument functions first
		const func = this.manager.findFunction(name, 0);
		if (func) {
			return new FunctionReferenceNode(this, func, getFunctionScalarType(func));
		}
		// Table: [schema.]table
		const table = this.manager.findTable(name);
		if (table) {
			// TODO: Create a proper ColumnScope to allow column references
			const vtabModule = this.manager.getModule(table.vtabModuleName);
			if (!vtabModule) {
				return undefined;
			}
			return new TableReferenceNode(this, table, vtabModule.module, vtabModule.auxData, undefined, false, this.manager);
		}
		return undefined;
	}
}
