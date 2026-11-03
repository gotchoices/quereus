/**
 * Coordinator-specific metrics definitions.
 */

import { globalRegistry, type MetricsRegistry } from './registry.js';
import { DEFAULT_SIZE_BUCKETS } from './types.js';

/**
 * Create coordinator metrics on a registry.
 */
export function createCoordinatorMetrics(registry: MetricsRegistry = globalRegistry) {
  // Connection metrics
  const wsConnectionsActive = registry.registerGauge(
    'sync_websocket_connections_active',
    'Current number of active WebSocket connections'
  );

  const wsConnectionsTotal = registry.registerCounter(
    'sync_websocket_connections_total',
    'Total WebSocket connections since startup'
  );

  // HTTP request metrics
  const httpRequestsTotal = registry.registerCounter(
    'sync_http_requests_total',
    'Total HTTP requests by endpoint and status'
  );

  const httpRequestDuration = registry.registerHistogram(
    'sync_http_request_duration_seconds',
    'HTTP request duration in seconds'
  );

  // Sync operation metrics
  const changesAppliedTotal = registry.registerCounter(
    'sync_changes_applied_total',
    'Total number of changes applied'
  );

  const changesReceivedTotal = registry.registerCounter(
    'sync_changes_received_total',
    'Total number of changes received from clients'
  );

  const changesRejectedTotal = registry.registerCounter(
    'sync_changes_rejected_total',
    'Total number of changes rejected during validation'
  );

  const changesBroadcastTotal = registry.registerCounter(
    'sync_changes_broadcast_total',
    'Total number of changes broadcast to clients'
  );

  // A client refused an incremental sync because its watermark predates a
  // pruned deletion (it is told to take a snapshot instead). A steady rate
  // here is the signal that SYNC_RETENTION_HORIZON_MS is shorter than real
  // client absences.
  const deltaRefusedTotal = registry.registerCounter(
    'sync_delta_refused_total',
    'Total get_changes requests refused because the watermark predates the delta floor (snapshot required)'
  );

  const broadcastErrorsTotal = registry.registerCounter(
    'sync_broadcast_errors_total',
    'Total broadcast send failures'
  );

  // Snapshot metrics
  const snapshotRequestsTotal = registry.registerCounter(
    'sync_snapshot_requests_total',
    'Total snapshot requests'
  );

  const snapshotChunksTotal = registry.registerCounter(
    'sync_snapshot_chunks_total',
    'Total snapshot chunks sent'
  );

  // Performance metrics
  const applyChangesDuration = registry.registerHistogram(
    'sync_apply_changes_duration_seconds',
    'Time to apply a batch of changes'
  );

  const getChangesDuration = registry.registerHistogram(
    'sync_get_changes_duration_seconds',
    'Time to retrieve changes for a client'
  );

  const changeBatchSize = registry.registerHistogram(
    'sync_change_batch_size',
    'Number of changes in a batch',
    DEFAULT_SIZE_BUCKETS
  );

  // Auth metrics
  const authAttemptsTotal = registry.registerCounter(
    'sync_auth_attempts_total',
    'Total authentication attempts'
  );

  const authFailuresTotal = registry.registerCounter(
    'sync_auth_failures_total',
    'Total authentication failures'
  );

  return {
    // Connection
    wsConnectionsActive,
    wsConnectionsTotal,

    // HTTP
    httpRequestsTotal,
    httpRequestDuration,

    // Sync operations
    changesAppliedTotal,
    changesReceivedTotal,
    changesRejectedTotal,
    changesBroadcastTotal,
    broadcastErrorsTotal,
    deltaRefusedTotal,

    // Snapshots
    snapshotRequestsTotal,
    snapshotChunksTotal,

    // Performance
    applyChangesDuration,
    getChangesDuration,
    changeBatchSize,

    // Auth
    authAttemptsTotal,
    authFailuresTotal,

    // Registry reference
    registry,
  };
}

export type CoordinatorMetrics = ReturnType<typeof createCoordinatorMetrics>;

