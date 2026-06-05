import type { SetObjectTagsNode } from '../../planner/nodes/set-object-tags-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { type SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:set-object-tags');

/**
 * Emits `ALTER VIEW / MATERIALIZED VIEW / INDEX … SET TAGS`. Tags touch no
 * stored row and no physical layout, so this is a pure catalog mutation: it
 * delegates to the matching SchemaManager setter (which re-registers the schema
 * object, clearing tags on an empty set, and fires `table_modified` for an index
 * so optimizer caches invalidate). Reserved-tag validation already ran at
 * plan-build time. NOTFOUND on a missing object surfaces from the setter.
 */
export function emitSetObjectTags(plan: SetObjectTagsNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start).
		await rctx.db._ensureTransaction();

		const sm = rctx.db.schemaManager;
		switch (plan.objectKind) {
			case 'view':
				sm.setViewTags(plan.name, plan.tags, plan.schemaName);
				break;
			case 'materializedView':
				sm.setMaterializedViewTags(plan.name, plan.tags, plan.schemaName);
				break;
			case 'index':
				sm.setIndexTags(plan.name, plan.tags, plan.schemaName);
				break;
		}
		log('Set tags on %s %s.%s', plan.objectKind, plan.schemaName, plan.name);
		return null;
	}

	return {
		params: [],
		run,
		note: `setObjectTags(${plan.objectKind} ${plan.schemaName}.${plan.name})`,
	};
}
