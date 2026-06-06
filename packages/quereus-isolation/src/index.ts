// Merge iterator types and functions
export type { MergeEntry, MergeConfig, PKComparator, PKExtractor, SortKeyComparator, SortKeyExtractor } from './merge-types.js';
export { mergeStreams, createMergeEntry, createTombstone } from './merge-iterator.js';

// Isolation layer types
export type { IsolationModuleConfig } from './isolation-types.js';
export type { UnderlyingTableState, ConnectionOverlayState } from './isolation-module.js';

// Isolation layer classes
export { IsolationModule } from './isolation-module.js';
export { IsolatedTable } from './isolated-table.js';
export { IsolatedConnection } from './isolated-connection.js';
