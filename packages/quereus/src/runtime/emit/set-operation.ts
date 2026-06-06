import type { SetOperationNode } from '../../planner/nodes/set-operation-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import { BTree } from 'inheritree';
import { createCollationRowComparator, BINARY_COLLATION } from '../../util/comparison.js';

export function emitSetOperation(plan: SetOperationNode, ctx: EmissionContext): Instruction {
  const leftInst = emitPlanNode(plan.left, ctx);
  const rightInst = emitPlanNode(plan.right, ctx);

  // Pre-resolve collation-based row comparator (safe for mixed-type rows in set
  // operations). The comparator runs over the DATA columns only — membership flags
  // are appended after, but dedup / probe identity is on data columns alone, so set
  // identity is never perturbed by the flags.
  const attributes = plan.getAttributes();
  const dataColCount = plan.left.getType().columns.length;
  const dataComparator = createCollationRowComparator(
    attributes.slice(0, dataColCount).map(attr => attr.type.collationName ? ctx.resolveCollation(attr.type.collationName) : BINARY_COLLATION)
  );

  // Helper function to create a properly structured DATA row (flags excluded; the
  // membership runner appends them after the operator produces its rows).
  function createOutputRow(inputRow: Row): Row {
    const outputRow: Row = [];
    for (let i = 0; i < dataColCount; i++) {
      outputRow[i] = inputRow[i]; // Map by position since columns should align
    }
    return outputRow;
  }

  async function* runUnionAll(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Process left rows - let SortNode handle row context
    for await (const row of leftRows) {
      yield createOutputRow(row);
    }

    // Process right rows - let SortNode handle row context
    for await (const row of rightRows) {
      yield createOutputRow(row);
    }
  }

  async function* runUnionDistinct(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison instead of JSON.stringify
    const distinctTree = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      const newPath = distinctTree.insert(outputRow);
      if (newPath.on) {
        // This is a new distinct row
        yield outputRow; // Let SortNode handle row context
      }
    }
    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const newPath = distinctTree.insert(outputRow);
      if (newPath.on) {
        // This is a new distinct row
        yield outputRow; // Let SortNode handle row context
      }
    }
  }

  async function* runIntersect(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison
    const leftTree = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    // Build left set
    for await (const row of leftRows) {
      const outputRow = createOutputRow(row);
      leftTree.insert(outputRow);
    }

    // Check right rows against left set
    const yielded = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    for await (const row of rightRows) {
      const outputRow = createOutputRow(row);
      const leftPath = leftTree.find(outputRow);
      if (leftPath.on) {
        // This row exists in left set - yield the LEFT row to preserve left-side types
        const leftRow = leftTree.get(outputRow)!;
        const yieldedPath = yielded.insert(leftRow);
        if (yieldedPath.on) {
          // Haven't yielded this row yet (handles duplicates in right)
          yield leftRow; // Let SortNode handle row context
        }
      }
    }
  }

  async function* runExcept(rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    // Use BTree for proper SQL value comparison
    const rightTree = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );
    const leftRowsArray: Row[] = [];

    // Collect left rows
    for await (const row of leftRows) {
      leftRowsArray.push(createOutputRow(row));
    }

    // Build right set
    for await (const row of rightRows) {
      rightTree.insert(createOutputRow(row));
    }

    // Track already-yielded rows to deduplicate (EXCEPT returns distinct rows)
    const yielded = new BTree<Row, Row>(
      (row: Row) => row,
      dataComparator
    );

    // Yield left rows that are not in right set
    for (const outputRow of leftRowsArray) {
      const rightPath = rightTree.find(outputRow);
      if (!rightPath.on) {
        const yieldedPath = yielded.insert(outputRow);
        if (yieldedPath.on) {
          yield outputRow; // Let SortNode handle row context
        }
      }
    }
  }

  // Membership-flag runner (`<setop> exists <branch> as <name>`, read half). Uniform
  // across the four operators: buffer each branch's DATA rows into a set (semijoin
  // probe surface), produce the operator's normal output rows, and append one boolean
  // per requested flag = `data-tuple ∈ <that branch's set>`. Dedup / multiplicity is
  // still decided on data columns only, so set identity is unchanged by the flags.
  async function* runWithMembership(_rctx: RuntimeContext, leftRows: AsyncIterable<Row>, rightRows: AsyncIterable<Row>): AsyncIterable<Row> {
    const membership = plan.membership!;
    const leftSet = new BTree<Row, Row>((row: Row) => row, dataComparator);
    const rightSet = new BTree<Row, Row>((row: Row) => row, dataComparator);
    const leftBuf: Row[] = [];
    const rightBuf: Row[] = [];

    for await (const row of leftRows) {
      const d = createOutputRow(row);
      leftBuf.push(d);
      leftSet.insert(d);
    }
    for await (const row of rightRows) {
      const d = createOutputRow(row);
      rightBuf.push(d);
      rightSet.insert(d);
    }

    // Append one boolean per flag: `tuple ∈ <branch set>`. A clean {true,false}.
    const appendFlags = (data: Row): Row => {
      const out = data.slice();
      for (const spec of membership) {
        const set = spec.branch === 'left' ? leftSet : rightSet;
        out.push(set.find(data).on ? true : false);
      }
      return out;
    };

    if (plan.op === 'unionAll') {
      // Bag: preserve multiplicity — every input row yields one output row.
      for (const d of leftBuf) yield appendFlags(d);
      for (const d of rightBuf) yield appendFlags(d);
      return;
    }

    // Distinct operators: dedup the output on DATA columns only.
    const yielded = new BTree<Row, Row>((row: Row) => row, dataComparator);
    switch (plan.op) {
      case 'union': {
        for (const d of leftBuf) { if (yielded.insert(d).on) yield appendFlags(d); }
        for (const d of rightBuf) { if (yielded.insert(d).on) yield appendFlags(d); }
        break;
      }
      case 'intersect': {
        // Rows present in BOTH branches (deduped). Every visible row probes all-true.
        for (const d of leftBuf) {
          if (rightSet.find(d).on && yielded.insert(d).on) yield appendFlags(d);
        }
        break;
      }
      case 'except': {
        // Rows in left and NOT in right (deduped). A left flag probes true, a right
        // flag probes false — exactly the A∖B membership, no special-casing needed.
        for (const d of leftBuf) {
          if (!rightSet.find(d).on && yielded.insert(d).on) yield appendFlags(d);
        }
        break;
      }
    }
  }

  let run: InstructionRun;
  if (plan.hasMembershipColumns) {
    run = runWithMembership as InstructionRun;
  } else {
    switch (plan.op) {
      case 'unionAll':
        run = runUnionAll as InstructionRun;
        break;
      case 'union':
        run = runUnionDistinct as InstructionRun;
        break;
      case 'intersect':
        run = runIntersect as InstructionRun;
        break;
      case 'except':
        run = runExcept as InstructionRun;
        break;
    }
  }

  return {
    params: [leftInst, rightInst],
    run,
    note: plan.op
  };
}
