import type { Scope } from '../scopes/scope.js';
import { VoidNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';

/**
 * Represents dropping a global integrity assertion.
 * This is a DDL operation that removes an assertion from the schema.
 */
export class DropAssertionNode extends VoidNode {
  override readonly nodeType = PlanNodeType.DropAssertion;

  constructor(
    scope: Scope,
    public readonly name: string,
    public readonly ifExists: boolean,
  ) {
    super(scope);
  }

  override toString(): string {
    return `DROP ASSERTION ${this.name}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      name: this.name,
      ifExists: this.ifExists,
    };
  }

  override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
    return { readonly: false };
  }
}
