description: Extract repeated contextualKeywords array to a module-level constant
prereq: none
files:
  packages/quereus/src/parser/parser.ts
----
The array `['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like']` is re-allocated as a local `const` in ~15 methods: `columnList`, `tableIdentifier`, `tableSource`, `standardTableSource`, `functionSource`, `joinClause`, `subquerySource`, `mutatingSubquerySource`, `primary`, `createViewStatement`, `identifierList`, `identifierListWithDirection`, `columnDefinition`, `alterTableStatement`, `declareTableItem`, etc.

Some methods add extra keywords (e.g., `'temp'`, `'temporary'`, `'replace'`).

### Proposal
Define a module-level constant for the base set and extend it where needed:

```typescript
const CONTEXTUAL_KEYWORDS = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'] as const;
```

Methods needing extras can spread: `[...CONTEXTUAL_KEYWORDS, 'replace']`.

This is a DRY improvement and avoids ~15 array allocations per parse.

### TODO
- Define `CONTEXTUAL_KEYWORDS` at module scope
- Replace all local `contextualKeywords` definitions with the constant
- For methods needing extras, use spread syntax
- Verify build and tests pass
