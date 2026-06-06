import type { LogicalType } from './logical-type.js';

/**
 * Type plugin registration info
 */
export interface TypePluginInfo {
	name: string;                  // Type name for registration
	definition: LogicalType;       // The LogicalType implementation
}

