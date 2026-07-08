/**
 * SyncClient - WebSocket-based sync client for Quereus.
 *
 * Handles:
 * - WebSocket connection and handshake
 * - Message dispatch (changes, push_changes, apply_result, error, pong)
 * - Reconnection with exponential backoff
 * - Local change debouncing
 * - Delta sync tracking (lastSentHLC + per-request pending watermarks)
 */

import {
  siteIdToBase64,
  siteIdFromBase64,
  maxHLC,
  compareHLC,
  type SyncManager,
  type SyncEventEmitter,
  type HLC,
  type SiteId,
} from '@quereus/sync';

import type {
  SyncClientOptions,
  SyncStatus,
  SyncEvent,
  ClientMessage,
  ServerMessage,
  SerializedChangeSet,
} from './types.js';

import {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from './serialization.js';

// Default configuration values
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS = 50;

/**
 * WebSocket sync client for Quereus.
 *
 * Connects to a sync server and handles bidirectional synchronization
 * of changes with automatic reconnection and local change batching.
 */
export class SyncClient {
  private readonly syncManager: SyncManager;
  private readonly syncEvents: SyncEventEmitter;
  private readonly options: Required<Pick<SyncClientOptions,
    'autoReconnect' | 'reconnectDelayMs' | 'maxReconnectDelayMs' | 'localChangeDebounceMs'
  >> & SyncClientOptions;

  // WebSocket state
  private ws: WebSocket | null = null;
  private serverSiteId: SiteId | null = null;

  // Connection state
  private _status: SyncStatus = { status: 'disconnected' };
  private connectionUrl: string | null = null;
  private connectionDatabaseId: string | null = null;
  private connectionToken: string | undefined = undefined;

  // Reconnection state
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // True only when the client itself called disconnect(). Never set by a
  // server error — see stopReconnect for server-driven shutdown.
  private intentionalDisconnect = false;
  // True when the server told us to stop reconnecting (a fatal error). Kept
  // separate from intentionalDisconnect so a transient server error can never
  // masquerade as a deliberate client disconnect.
  private stopReconnect = false;

  /**
   * Server error codes that are fatal even when the server does not send the
   * `fatal` flag (coordinators predating it). These correspond to sendError
   * calls where the coordinator also closes the socket or leaves the session
   * unrecoverable, so reconnecting as-is cannot succeed.
   */
  private static readonly FATAL_ERROR_CODES: ReadonlySet<string> = new Set([
    'AUTH_FAILED',
    'MISSING_DATABASE_ID',
    'ALREADY_AUTHENTICATED',
  ]);

  // Delta sync tracking. `lastSentHLC` is the high-water mark of local changes
  // the server has acknowledged. It is durably persisted per peer on each
  // confirmed ack (SyncManager.updatePeerSentState) and re-seeded on handshake,
  // so a process restart resumes delta-push instead of replaying local history.
  // Each in-flight push is tracked by its request id → the HLC that ack would
  // promote `lastSentHLC` to; keying by request id correlates each
  // `apply_result` to the exact batch that produced it, so a stale, duplicate,
  // or out-of-order ack can't mis-advance the watermark.
  private lastSentHLC: HLC | null = null;
  // NOTE: bounded by in-flight pushes — every successful ack prunes itself plus
  // any batch its watermark subsumes (see promoteWatermark), and disconnect
  // clears it. If a server ever accepts apply_changes but never acks them, this
  // would grow one entry per push; cap it (evict oldest) only if that shows up.
  private readonly pendingSentHLCs = new Map<string, HLC>();
  // Monotonic per-client counter backing apply-request ids. Deterministic (no
  // Date.now / Math.random) so tests can predict the ids. Intentionally NOT
  // reset on disconnect: pendingSentHLCs is cleared there instead, so a stale
  // ack redelivered after a reconnect carries an id we no longer hold (dropped)
  // rather than colliding with a freshly-reused id and crediting the wrong batch.
  private applyRequestSeq = 0;

  // Local change debouncing
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLocalChangeCount = 0;

  // Local change listener cleanup
  private localChangeUnsubscribe: (() => void) | null = null;

  // Pending connect() promise settlement — allows handshake_ack / server error
  // to resolve or reject the promise returned by connect().
  private _connectResolve: (() => void) | null = null;
  private _connectReject: ((error: Error) => void) | null = null;

  constructor(options: SyncClientOptions) {
    this.syncManager = options.syncManager;
    this.syncEvents = options.syncEvents;
    this.options = {
      ...options,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      localChangeDebounceMs: options.localChangeDebounceMs ?? DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS,
    };
  }

  /** Current connection status */
  get status(): SyncStatus {
    return this._status;
  }

  /** Whether the client is connected and synced */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Whether the client is fully synced */
  get isSynced(): boolean {
    return this._status.status === 'synced';
  }

  /**
   * Connect to a sync server.
   *
   * @param url - WebSocket URL of the sync server
   * @param databaseId - Database ID for multi-tenant routing
   * @param token - Optional authentication token
   * @returns Promise that resolves after handshake is acknowledged, rejects on
   *          WebSocket failure or server error/rejection.
   */
  async connect(url: string, databaseId: string, token?: string): Promise<void> {
    // Store connection params for reconnection
    this.connectionUrl = url;
    this.connectionDatabaseId = databaseId;
    this.connectionToken = token;
    this.intentionalDisconnect = false;
    this.stopReconnect = false;

    // Clear any pending reconnect timer
    this.clearReconnectTimer();

    // Abandon any prior unsettled connect promise
    this.settleConnect(new Error('Superseded by new connect() call'));

    // Close existing connection. Detach its handlers first so a late event
    // from the dead socket (e.g. its deferred onclose) can't drive this client
    // — only the live socket should.
    if (this.ws) {
      this.detachSocketHandlers(this.ws);
      this.ws.close();
      this.ws = null;
    }

    this.setStatus({ status: 'connecting' });

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      try {
        const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.sendHandshake(databaseId, token);
          this.setStatus({ status: 'syncing', progress: 0 });
          this.emitSyncEvent('state-change', 'Connected to sync server, handshake sent');
          // Don't resolve yet — wait for handshake_ack (or server error).
        };

        this.ws.onclose = () => {
          const wasError = this._status.status === 'error';
          if (!wasError) {
            this.setStatus({ status: 'disconnected' });
          }
          this.emitSyncEvent('state-change', 'Disconnected from sync server');
          this.settleConnect(new Error('Connection closed before handshake'));
          this.scheduleReconnect();
        };

        this.ws.onerror = () => {
          const error = new Error('WebSocket connection failed');
          this.setStatus({ status: 'error', message: error.message });
          this.emitSyncEvent('error', error.message);
          this.settleConnect(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data).catch(err => {
            console.error('Error handling sync message:', err);
            this.emitSyncEvent('error', `Sync error: ${err instanceof Error ? err.message : 'Unknown'}`);
          });
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Connection failed';
        this.setStatus({ status: 'error', message: msg });
        this.settleConnect(error instanceof Error ? error : new Error(msg));
      }
    });
  }

  /** Settle the pending connect() promise (no-op if already settled). */
  private settleConnect(error?: Error): void {
    if (error) {
      const reject = this._connectReject;
      this._connectResolve = null;
      this._connectReject = null;
      reject?.(error);
    } else {
      const resolve = this._connectResolve;
      this._connectResolve = null;
      this._connectReject = null;
      resolve?.();
    }
  }

  /**
   * Disconnect from the sync server.
   * Stops reconnection attempts.
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;

    // Reject any pending connect() promise
    this.settleConnect(new Error('Disconnected'));

    // Clear timers
    this.clearReconnectTimer();
    this.clearDebounceTimer();

    // Remove local change listener
    if (this.localChangeUnsubscribe) {
      this.localChangeUnsubscribe();
      this.localChangeUnsubscribe = null;
    }

    // Close WebSocket. Detach handlers first so its deferred onclose can't
    // fire back into the client after we've torn down.
    if (this.ws) {
      this.detachSocketHandlers(this.ws);
      this.ws.close();
      this.ws = null;
    }

    this.serverSiteId = null;
    // Clear only the in-memory watermark. The persisted per-peer sent watermark
    // (SyncManager.updatePeerSentState) is intentionally left intact so a later
    // reconnect resumes delta-push instead of replaying local history.
    this.lastSentHLC = null;
    this.pendingSentHLCs.clear();
    this.setStatus({ status: 'disconnected' });
    this.emitSyncEvent('state-change', 'Disconnected from sync server (manual)');
  }

  // ==========================================================================
  // Private: Message Handlers
  // ==========================================================================

  private async handleMessage(data: string): Promise<void> {
    const message = JSON.parse(data);

    switch (message.type) {
      case 'handshake_ack':
        await this.handleHandshakeAck(message);
        break;

      case 'changes':
        // Ordered reply to an explicit get_changes: server-ordered, gap-free.
        // Safe to advance the received watermark.
        await this.handleChanges(message.changeSets || [], true);
        break;

      case 'push_changes':
        // Fire-and-forget broadcast relaying a peer's change. Delivery is not
        // acked, so a dropped broadcast is invisible to the coordinator. Apply
        // it eagerly, but do NOT advance the watermark — otherwise a missed
        // earlier broadcast would never be redelivered on the next catch-up.
        // The change is re-fetched (and idempotently re-applied) by the next
        // get_changes since the watermark stays below it.
        await this.handleChanges(message.changeSets || [], false);
        break;

      case 'apply_result':
        await this.handleApplyResult(message);
        break;

      case 'error':
        this.handleServerError(message);
        break;

      case 'pong':
        // Heartbeat response - no action needed
        break;

      case 'request_changes':
        // Server is requesting changes (for peer-to-peer relay)
        await this.handleRequestChanges(message);
        break;

      default:
        if (this.options.onUnhandledMessage) {
          this.options.onUnhandledMessage(message);
        } else {
          console.warn('Unknown sync message type:', message.type);
        }
    }
  }

  /**
   * Handle a server `error` message.
   *
   * Default behavior keeps the session alive: a per-request (transient) error
   * is surfaced but does not stop the connection or its auto-reconnect. Only a
   * fatal error (server rejected the session and typically closed the socket)
   * flips `stopReconnect` and puts the client into a lasting `error` status.
   */
  private handleServerError(message: { code: string; message: string; fatal?: boolean }): void {
    // Always surface the error to listeners.
    this.emitSyncEvent('error', `Server error: ${message.message} (${message.code})`);
    this.options.onError?.(new Error(message.message));

    // Trust the server's `fatal` flag when present; fall back to the known
    // fatal-code set for coordinators that predate it.
    const fatal = message.fatal ?? SyncClient.FATAL_ERROR_CODES.has(message.code);

    if (fatal) {
      // Unrecoverable — a bare reconnect would just fail again. Stop reconnect
      // and settle any pending connect(). Note: NOT intentionalDisconnect,
      // which means only "the client called disconnect()".
      this.stopReconnect = true;
      this.setStatus({ status: 'error', message: message.message });
      this.settleConnect(new Error(message.message));
    }
    // Transient: keep the connection and auto-reconnect intact. Deliberately do
    // not set a lingering 'error' status — a per-request failure shouldn't
    // masquerade as connection death (onclose keys its disconnected transition
    // off status === 'error').
  }

  private async handleHandshakeAck(message: { serverSiteId?: string; connectionId?: string }): Promise<void> {
    if (message.serverSiteId) {
      this.serverSiteId = siteIdFromBase64(message.serverSiteId);
    }

    this.emitSyncEvent(
      'state-change',
      `Authenticated with server (connection: ${message.connectionId?.slice(0, 8) ?? 'unknown'})`
    );

    // Handshake accepted — resolve the connect() promise.
    this.settleConnect();

    // Request changes from server since our last sync with this peer
    await this.requestChangesFromServer();

    // Seed the sent watermark from durable per-peer state so a fresh process
    // (or a reconnect) resumes delta-push where it left off instead of
    // replaying the entire local history to the server.
    await this.seedSentWatermark();

    // In read-only (pull-only) mode, skip push entirely
    if (!this.options.readOnly) {
      // Subscribe to local changes for pushing to server
      this.subscribeToLocalChanges();

      // Push any existing local changes to server (changes made while offline)
      await this.pushLocalChanges();
    }
  }

  /**
   * Apply received changesets to the local store, optionally advancing the
   * received watermark (`lastSyncHLC`).
   *
   * @param advanceWatermark Only the ordered `changes` reply is contiguous and
   *   gap-free, so only it may advance the watermark. A `push_changes`
   *   broadcast is applied (idempotently) but must leave the watermark unmoved,
   *   so a broadcast the client never received is still redelivered by the next
   *   `get_changes sinceHLC=<watermark>`.
   */
  private async handleChanges(
    serializedChangeSets: SerializedChangeSet[],
    advanceWatermark: boolean
  ): Promise<void> {
    const changeSets = serializedChangeSets.map(cs => deserializeChangeSet(cs));
    const result = await this.syncManager.applyChanges(changeSets);

    // Advance peer sync state with the max HLC from received changes — but only
    // on the ordered path, where contiguity guarantees nothing below maxHlc was
    // missed.
    if (advanceWatermark && changeSets.length > 0 && this.serverSiteId) {
      const maxHlc = maxHLC(changeSets.map(cs => cs.hlc));
      if (maxHlc) {
        await this.syncManager.updatePeerSyncState(this.serverSiteId, maxHlc);
      }
    }

    // Emit events
    if (result.applied > 0 || result.conflicts > 0 || result.skipped > 0) {
      const conflictText = result.conflicts > 0 ? ` (${result.conflicts} conflicts resolved)` : '';
      const skippedText = result.skipped > 0 ? `, ${result.skipped} skipped` : '';
      this.emitSyncEvent(
        'remote-change',
        `Applied ${result.applied} column changes${conflictText}${skippedText}`,
        { changeCount: result.applied, conflicts: result.conflicts, skipped: result.skipped }
      );
    }

    this.options.onRemoteChanges?.(result, changeSets);
    this.setStatus({ status: 'synced', lastSyncTime: Date.now() });
  }

  private async handleApplyResult(message: {
    requestId?: string;
    applied?: number;
    rejected?: Array<{ reason: string; code?: string }>;
  }): Promise<void> {
    await this.promoteWatermark(message.requestId);

    this.emitSyncEvent('info', `Server applied ${message.applied ?? 0} change(s)`);

    if (message.rejected?.length) {
      for (const r of message.rejected) {
        this.emitSyncEvent('rejected', r.reason, { rejections: [r] });
      }
    }
  }

  /**
   * Advance `lastSentHLC` for the acknowledged push identified by `requestId`.
   *
   * Only the push whose id we recorded in {@link pushLocalChanges} promotes the
   * watermark, and only ever forward — never regressing past a newer batch a
   * later ack already promoted. Acks we can't correlate are dropped:
   *  - a `requestId` we don't hold → a stale or duplicate ack (e.g. redelivered
   *    across a reconnect, or the server double-acked); logged, then ignored.
   *  - no `requestId` → an untracked push (a peer-relay `apply_changes`) or a
   *    legacy coordinator that doesn't echo the id; nothing to promote.
   */
  private async promoteWatermark(requestId: string | undefined): Promise<void> {
    if (requestId === undefined) return;

    const promoted = this.pendingSentHLCs.get(requestId);
    if (!promoted) {
      this.emitSyncEvent('info', `Ignoring apply_result for unknown push (requestId: ${requestId})`);
      return;
    }

    this.pendingSentHLCs.delete(requestId);

    // Never move the watermark backward: an out-of-order ack for an older batch
    // must not undo a newer batch a prior ack already promoted.
    if (!this.lastSentHLC || compareHLC(promoted, this.lastSentHLC) > 0) {
      this.lastSentHLC = promoted;
      // Persist the confirmed watermark per peer so a restart resumes delta-push
      // from here instead of replaying local history. Only written on a real
      // forward advance, and only for a correlated ack (so we persist a
      // watermark we actually confirmed sent).
      if (this.serverSiteId) {
        await this.syncManager.updatePeerSentState(this.serverSiteId, this.lastSentHLC);
      }
    }

    // Drop any still-pending batches the new watermark now subsumes (a later
    // push re-sends everything since the last ack, so its range covers theirs),
    // so their late/duplicate acks can't re-promote an already-covered HLC.
    for (const [id, hlc] of this.pendingSentHLCs) {
      if (compareHLC(hlc, this.lastSentHLC) <= 0) {
        this.pendingSentHLCs.delete(id);
      }
    }
  }

  private async handleRequestChanges(message: { siteId?: string; sinceHLC?: string }): Promise<void> {
    // Server is relaying a request for changes from another peer
    if (!message.siteId) return;

    const peerSiteId = siteIdFromBase64(message.siteId);
    const sinceHLC = message.sinceHLC ? deserializeHLCFromTransport(message.sinceHLC) : undefined;

    const changes = await this.syncManager.getChangesSince(peerSiteId, sinceHLC);
    if (changes.length > 0) {
      const serialized = changes.map(cs => serializeChangeSet(cs));
      this.send({
        type: 'apply_changes',
        changes: serialized,
      });
    }
  }

  // ==========================================================================
  // Private: Message Sending
  // ==========================================================================

  private sendHandshake(databaseId: string, token?: string): void {
    const siteId = this.syncManager.getSiteId();
    this.send({
      type: 'handshake',
      databaseId,
      siteId: siteIdToBase64(siteId),
      token,
    });
  }

  private async requestChangesFromServer(): Promise<void> {
    if (!this.serverSiteId) return;

    const lastSyncHLC = await this.syncManager.getPeerSyncState(this.serverSiteId);

    if (lastSyncHLC) {
      this.send({ type: 'get_changes', sinceHLC: serializeHLCForTransport(lastSyncHLC) });
    } else {
      this.send({ type: 'get_changes' });
    }
  }

  /**
   * Seed `lastSentHLC` from the durable per-peer sent watermark. Called on every
   * handshake so a fresh process resumes delta-push from the last confirmed HLC
   * rather than re-sending its whole local history.
   *
   * Takes the persisted value only when it is ahead of the in-memory one, so an
   * auto-reconnect that still holds an advanced in-memory watermark (its
   * in-flight pushes may have promoted memory past the last durable write) is
   * never dragged backward.
   */
  private async seedSentWatermark(): Promise<void> {
    if (!this.serverSiteId) return;
    const persisted = await this.syncManager.getPeerSentState(this.serverSiteId);
    if (persisted && (!this.lastSentHLC || compareHLC(persisted, this.lastSentHLC) > 0)) {
      this.lastSentHLC = persisted;
    }
  }

  /**
   * Send a message to the server.
   *
   * @returns true if the bytes were handed to the socket, false if the send was
   *          dropped (socket not open) or threw. Callers that advance state on a
   *          send (e.g. the delta-sync watermark) must check this — a dropped
   *          send is not success.
   */
  private send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // NOTE: warns on every send attempted while the socket is down; if reconnect
      // windows ever get chatty, downgrade this to debug or rate-limit per type.
      console.warn(`Sync send skipped, socket not open: ${message.type}`);
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Sync send failed for ${message.type}:`, err);
      this.emitSyncEvent('error', `Failed to send ${message.type}: ${msg}`);
      return false;
    }
  }

  /** Detach a socket's event handlers so it can no longer drive this client. */
  private detachSocketHandlers(ws: WebSocket): void {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
  }


  // ==========================================================================
  // Private: Local Change Handling
  // ==========================================================================

  private subscribeToLocalChanges(): void {
    // Unsubscribe from previous if any
    if (this.localChangeUnsubscribe) {
      this.localChangeUnsubscribe();
    }

    // Subscribe to local changes via SyncEventEmitter
    this.localChangeUnsubscribe = this.syncEvents.onLocalChange(() => {
      this.pendingLocalChangeCount++;
      this.debouncePushLocalChanges();
    });
  }

  private debouncePushLocalChanges(): void {
    this.clearDebounceTimer();

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.pushLocalChanges();
    }, this.options.localChangeDebounceMs);
  }

  private async pushLocalChanges(): Promise<void> {
    if (this.options.readOnly) return;
    if (!this.isConnected || !this.serverSiteId) return;

    // Get changes since lastSentHLC (delta sync)
    // Use serverSiteId to filter out changes that originated from the server
    // (which we already have), keeping our local changes to send
    const changes = await this.syncManager.getChangesSince(
      this.serverSiteId,
      this.lastSentHLC ?? undefined
    );

    if (changes.length === 0) return;

    // Serialize and send
    const serialized = changes.map(cs => serializeChangeSet(cs));

    this.emitSyncEvent('local-change', `Sending ${changes.length} change set(s) to server`, {
      changeCount: changes.length,
    });

    // Correlate this push with its ack: the server echoes requestId back on the
    // apply_result, so we promote lastSentHLC only when the matching ack returns.
    const requestId = this.nextApplyRequestId();
    const sent = this.send({
      type: 'apply_changes',
      requestId,
      changes: serialized,
    });

    // Only advance delta-sync state if the bytes actually left. A dropped send
    // must be retried on the next push, so register no pending watermark and
    // leave the pending count untouched.
    if (!sent) return;

    // Record the max HLC this batch carries against its request id; the matching
    // apply_result promotes lastSentHLC to it (see promoteWatermark).
    const batchHLC = maxHLC(changes.map(cs => cs.hlc));
    if (batchHLC) {
      this.pendingSentHLCs.set(requestId, batchHLC);
    }
    this.pendingLocalChangeCount = 0;
  }

  /** Next monotonic apply-request id. Deterministic for test predictability. */
  private nextApplyRequestId(): string {
    return `apply-${++this.applyRequestSeq}`;
  }

  // ==========================================================================
  // Private: Reconnection
  // ==========================================================================

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.stopReconnect || !this.connectionUrl || !this.options.autoReconnect) {
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to max
    const delay = Math.min(
      this.options.reconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.options.maxReconnectDelayMs
    );

    this.reconnectAttempts++;

    this.emitSyncEvent(
      'state-change',
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.connectionUrl!, this.connectionDatabaseId!, this.connectionToken).catch(() => {
        // Error already handled in connect, reconnect will be scheduled by onclose
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ==========================================================================
  // Private: Status & Events
  // ==========================================================================

  private setStatus(status: SyncStatus): void {
    this._status = status;
    this.options.onStatusChange?.(status);
  }

  private emitSyncEvent(
    type: SyncEvent['type'],
    message: string,
    details?: SyncEvent['details']
  ): void {
    const event: SyncEvent = {
      type,
      timestamp: Date.now(),
      message,
      details,
    };
    this.options.onSyncEvent?.(event);
  }
}
