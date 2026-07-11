/**
 * Types for the WebSocket sync client.
 */

import type { ApplyResult, ChangeSet, SyncManager, SyncEventEmitter } from '@quereus/sync';

// ============================================================================
// Connection Status
// ============================================================================

/**
 * Sync connection status.
 */
export type SyncStatus =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'syncing'; progress: number }
  | { status: 'synced'; lastSyncTime: number }
  | { status: 'error'; message: string };

/**
 * Sync event types for logging/UI notifications.
 */
export type SyncEventType = 'remote-change' | 'local-change' | 'conflict' | 'state-change' | 'error' | 'info' | 'rejected';

/**
 * Sync event for logging/UI display.
 */
export interface SyncEvent {
  type: SyncEventType;
  timestamp: number;
  message: string;
  details?: {
    table?: string;
    changeCount?: number;
    conflicts?: number;
    skipped?: number;
    rejections?: Array<{ reason: string; code?: string }>;
  };
}

// ============================================================================
// Client Options
// ============================================================================

/**
 * Options for configuring the SyncClient.
 */
export interface SyncClientOptions {
  /**
   * The SyncManager instance to use for sync operations.
   */
  syncManager: SyncManager;

  /**
   * The SyncEventEmitter to subscribe to local change events.
   * Required for automatic pushing of local changes to the server.
   */
  syncEvents: SyncEventEmitter;

  /**
   * Callback when connection status changes.
   */
  onStatusChange?: (status: SyncStatus) => void;

  /**
   * Callback when remote changes are applied.
   */
  onRemoteChanges?: (result: ApplyResult, changeSets: ChangeSet[]) => void;

  /**
   * Callback when a sync event occurs (for logging/UI).
   */
  onSyncEvent?: (event: SyncEvent) => void;

  /**
   * Callback when an error occurs.
   */
  onError?: (error: Error) => void;

  /**
   * Callback for messages the client doesn't handle (e.g., topology).
   * Receives the raw parsed JSON message object.
   */
  onUnhandledMessage?: (message: Record<string, unknown>) => void;

  /**
   * Whether to automatically reconnect on disconnect.
   * @default true
   */
  autoReconnect?: boolean;

  /**
   * Initial delay for reconnection (milliseconds).
   * @default 1000
   */
  reconnectDelayMs?: number;

  /**
   * Maximum delay for reconnection (milliseconds).
   * @default 60000
   */
  maxReconnectDelayMs?: number;

  /**
   * Debounce delay for batching local changes (milliseconds).
   * @default 50
   */
  localChangeDebounceMs?: number;

  /**
   * When true, the client operates in pull-only mode: it receives remote
   * changes but never pushes local changes to the server. Useful for
   * read-only / view-permission shared scenarios.
   * @default false
   */
  readOnly?: boolean;
}

// The WebSocket message unions (ClientMessage / ServerMessage and their
// per-message interfaces) and the Serialized* JSON-transport types formerly
// declared here now live in @quereus/sync (`sync/wire.ts`) — the single wire
// definition shared with the coordinator. Import them from '@quereus/sync';
// index.ts re-exports them so the client's public API is unchanged.

