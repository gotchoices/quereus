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

// ============================================================================
// WebSocket Protocol Messages
// ============================================================================

/** Client → Server: Handshake */
export interface HandshakeMessage {
  type: 'handshake';
  databaseId: string;   // Database ID for multi-tenant routing
  siteId: string;       // Base64-encoded site ID
  token?: string;       // Optional auth token
}

/** Client → Server: Request changes */
export interface GetChangesMessage {
  type: 'get_changes';
  sinceHLC?: string;    // Base64-encoded HLC
}

/** Client → Server: Apply local changes */
export interface ApplyChangesMessage {
  type: 'apply_changes';
  changes: SerializedChangeSet[];
}

/** Client → Server: Request snapshot */
export interface GetSnapshotMessage {
  type: 'get_snapshot';
}

/** Client → Server: Heartbeat */
export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | HandshakeMessage
  | GetChangesMessage
  | ApplyChangesMessage
  | GetSnapshotMessage
  | PingMessage;

/** Server → Client: Handshake acknowledgment */
export interface HandshakeAckMessage {
  type: 'handshake_ack';
  serverSiteId: string;
  connectionId?: string;
}

/** Server → Client: Changes response */
export interface ChangesMessage {
  type: 'changes';
  changeSets: SerializedChangeSet[];
}

/** Server → Client: Pushed changes from another peer */
export interface PushChangesMessage {
  type: 'push_changes';
  changeSets: SerializedChangeSet[];
}

/** Server → Client: Apply result */
export interface ApplyResultMessage {
  type: 'apply_result';
  applied: number;
  skipped: number;
  conflicts: number;
  transactions: number;
  rejected?: Array<{
    reason: string;
    code?: string;
    table?: string;
    column?: string;
  }>;
}

/** Server → Client: Error */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  /**
   * When true, the error is fatal: the server rejected the session
   * unrecoverably (and typically closed the socket), so the client stops
   * auto-reconnecting. Absent or false means a transient per-request error —
   * the session and its auto-reconnect stay intact.
   */
  fatal?: boolean;
}

/** Server → Client: Heartbeat response */
export interface PongMessage {
  type: 'pong';
}

export type ServerMessage =
  | HandshakeAckMessage
  | ChangesMessage
  | PushChangesMessage
  | ApplyResultMessage
  | ErrorMessage
  | PongMessage;

// ============================================================================
// Serialized Types for JSON Transport
// ============================================================================

/**
 * A ChangeSet serialized for JSON transport.
 * SiteIds are base64url-encoded, HLCs are base64-encoded.
 */
export interface SerializedChangeSet {
  siteId: string;
  transactionId: string;
  hlc: string;
  changes: SerializedChange[];
  schemaMigrations: SerializedSchemaMigration[];
}

export interface SerializedChange {
  type: 'column' | 'delete';
  schema: string;
  table: string;
  pk: unknown[];
  column?: string;
  value?: unknown;
  hlc: string;
  priorValue?: unknown;   // encodeSqlValue(priorValue) — column, present iff priorHlc
  priorHlc?: string;      // base64-binary HLC — column, present iff priorValue
  priorRow?: unknown[];   // encodeSqlValue per cell — delete, present-only ([] is present)
}

export interface SerializedSchemaMigration {
  type: string;
  schema: string;
  table: string;
  ddl: string;
  hlc: string;
  schemaVersion: number;
}

