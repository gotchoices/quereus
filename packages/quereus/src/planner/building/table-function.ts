import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { TableFunctionCallNode } from '../nodes/table-function-call.js';
import { buildExpression } from './expression.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { isTableValuedFunctionSchema } from '../../schema/function.js';
import { resolveFunctionSchema } from './schema-resolution.js';

export function buildTableFunctionCall(
  functionSource: AST.FunctionSource,
  ctx: PlanningContext
): TableFunctionCallNode {
  const functionName = functionSource.name.name;
  const args = functionSource.args.map(arg => buildExpression(ctx, arg));

  // Resolve function schema at build time
  const functionSchema = resolveFunctionSchema(ctx, functionName, args.length);

  if (!isTableValuedFunctionSchema(functionSchema)) {
    throw new QuereusError(
      `Function ${functionName}/${args.length} is not a table-valued function`,
      StatusCode.ERROR,
      undefined,
      functionSource.loc?.start.line,
      functionSource.loc?.start.column
    );
  }

	// Validate argument count
	if (functionSchema.numArgs >= 0 && args.length !== functionSchema.numArgs) {
		throw new QuereusError(
			`Function ${functionName} called with ${args.length} arguments, expected ${functionSchema.numArgs}`,
			StatusCode.ERROR,
			undefined,
			functionSource.loc?.start.line,
			functionSource.loc?.start.column
		);
	}

  return new TableFunctionCallNode(
    ctx.scope,
    functionName,
    functionSchema,
    args,
    functionSource.alias,
    functionSource.columns
  );
}
