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
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
  serializeSnapshotCheckpoint,
  PROTOCOL_VERSION,
  type SyncManager,
  type SyncEventEmitter,
  type HLC,
  type SiteId,
  type AdoptedRows,
  type ChangeSet,
  type ClientMessage,
  type GetSnapshotMessage,
  type ResumeSnapshotMessage,
  type SerializedChangeSet,
  type SerializedSnapshotChunk,
  type SnapshotProgress,
} from '@quereus/sync';

import {
  UnrecordedRowsError,
  type SyncClientOptions,
  type SyncStatus,
  type SyncEvent,
} from './types.js';
import { SnapshotStreamReader } from './snapshot-reader.js';

// Default configuration values
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS = 50;
const DEFAULT_SNAPSHOT_CHUNK_TIMEOUT_MS = 60_000;

/**
 * What one push attempt did. `drained` and `held` both mean nothing left the
 * socket, but only `drained` means nothing remains to send: a snapshot taken
 * after `held` would destroy the work still waiting.
 */
type PushOutcome =
  | { status: 'sent'; requestId: string }
  | { status: 'drained' }
  | { status: 'held' };

/**
 * Where rows sync has never recorded leave an automatic snapshot. `clear` means it may
 * go ahead. `adopted` means rows were just recorded, so a snapshot may follow only once
 * they are pushed. `stopped` means no snapshot: the socket is closed or already replaced.
 */
type UnrecordedRowsVerdict = 'clear' | 'adopted' | 'stopped';

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
    | 'bootstrapOnEmpty' | 'unrecordedRows' | 'snapshotChunkTimeoutMs'
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
  // Callers waiting for a specific push's ack (the snapshot_required recovery
  // must not take a snapshot until its push has landed). Keyed by request id;
  // settled from handleApplyResult once the id leaves pendingSentHLCs, rejected
  // when the socket closes or the server reports the push failed.
  private readonly ackWaiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
  // Monotonic per-client counter backing apply-request ids. Deterministic (no
  // Date.now / Math.random) so tests can predict the ids. Intentionally NOT
  // reset on disconnect: pendingSentHLCs is cleared there instead, so a stale
  // ack redelivered after a reconnect carries an id we no longer hold (dropped)
  // rather than colliding with a freshly-reused id and crediting the wrong batch.
  private applyRequestSeq = 0;
  // True while snapshot_required recovery is draining local changes. That loop
  // sends the next batch itself after each ack, so handleApplyResult must not
  // start one too; both would read the same range and every batch would go twice.
  private recoveryOwnsPush = false;

  // True once the server has answered a get_changes with nothing, meaning this
  // pull has reached the end of what the server holds. A `changes` reply carries
  // one bounded batch, so only this flag may report `synced`. Cleared wherever a
  // new pull begins (connect(), the start of a snapshot transfer) or the connection
  // goes away (disconnect(), onclose), so an apply finishing late reports nothing.
  private caughtUp = false;

  // Local change debouncing
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLocalChangeCount = 0;

  // Local change listener cleanup
  private localChangeUnsubscribe: (() => void) | null = null;

  // Snapshot bootstrap state. `activeSnapshotReader` routes incoming
  // snapshot_chunk messages; `snapshotTransferPromise` is the whole in-flight
  // transfer (request → stream → apply → watermark), resolving to the failure
  // Error or null on success — it never rejects, so an unobserved automatic
  // bootstrap can't surface an unhandled rejection. Both are null when no
  // transfer is active.
  private activeSnapshotReader: SnapshotStreamReader | null = null;
  private snapshotTransferPromise: Promise<Error | null> | null = null;
  private snapshotStallTimer: ReturnType<typeof setTimeout> | null = null;
  // Last tablesProcessed a sync event was emitted for — progress fires once per
  // column-versions chunk and would flood an event log; events are throttled to
  // table boundaries. -1 = none yet this transfer.
  private snapshotEventTablesProcessed = -1;
  // One dropped-chunk warning per transfer gap, not one per chunk — an aborted
  // stream can trail thousands of late chunks.
  private droppedChunkWarned = false;

  // Pending connect() promise settlement — allows handshake_ack / server error
  // to resolve or reject the promise returned by connect().
  private _connectResolve: (() => void) | null = null;
  private _connectReject: ((error: Error) => void) | null = null;

  constructor(options: SyncClientOptions) {
    // A read-only client can never push, so adopted rows would never leave the device
    // and the next snapshot would delete them.
    if (options.readOnly && options.unrecordedRows === 'adopt') {
      throw new Error(`The unrecordedRows option 'adopt' cannot be combined with readOnly: adopted rows have to be pushed`);
    }
    this.syncManager = options.syncManager;
    this.syncEvents = options.syncEvents;
    this.options = {
      ...options,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      localChangeDebounceMs: options.localChangeDebounceMs ?? DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS,
      bootstrapOnEmpty: options.bootstrapOnEmpty ?? true,
      unrecordedRows: options.unrecordedRows ?? 'refuse',
      snapshotChunkTimeoutMs: options.snapshotChunkTimeoutMs ?? DEFAULT_SNAPSHOT_CHUNK_TIMEOUT_MS,
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

  /** Whether the client has fetched everything the server holds and is receiving live changes */
  get isSynced(): boolean {
    return this._status.status === 'synced';
  }

  /**
   * Whether a snapshot transfer (bootstrap or resume) is in flight. While true
   * the local database is partial: incoming deltas are dropped (re-fetched by
   * the post-bootstrap catch-up), local pushes are held, and the application
   * should not write to the database.
   */
  get isBootstrapping(): boolean {
    return this.snapshotTransferPromise !== null;
  }

  /**
   * Whether the local store holds a pending snapshot checkpoint — i.e. a
   * previous snapshot apply was interrupted and the database is PARTIAL.
   * Usable before connecting (e.g. at app startup, to gate reads); the next
   * connect resumes the transfer automatically.
   */
  async hasPendingSnapshot(): Promise<boolean> {
    const checkpoints = await this.syncManager.listSnapshotCheckpoints();
    return checkpoints.length > 0;
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
    this.caughtUp = false;

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
      // onclose is detached, so it cannot release these, and their acks will
      // never come. A recovery parked here would otherwise hold recoveryOwnsPush
      // and resume on the new socket.
      this.rejectAckWaiters(new Error('Connection replaced before the push was acknowledged'));
    }

    this.setStatus({ status: 'connecting' });

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      try {
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.sendHandshake(databaseId, token);
          this.setStatus({ status: 'syncing', progress: 0 });
          this.emitSyncEvent('state-change', 'Connected to sync server, handshake sent');
          // Don't resolve yet — wait for handshake_ack (or server error).
        };

        this.ws.onclose = () => {
          this.caughtUp = false;
          // A transfer interrupted by a socket drop aborts here; the saved
          // checkpoint makes the reconnect below resume it via resume_snapshot.
          this.abortSnapshotTransfer(new Error('Connection closed during snapshot transfer'));
          this.rejectAckWaiters(new Error('Connection closed before the push was acknowledged'));
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
    this.caughtUp = false;

    // Abort any in-flight snapshot transfer. Its promise settles (resolved with
    // the abort error — it never rejects), and the checkpoint saved by the
    // interrupted apply lets a later connect resume.
    this.abortSnapshotTransfer(new Error('Disconnected'));

    // Reject any pending connect() promise
    this.settleConnect(new Error('Disconnected'));

    this.clearReconnectTimer();
    this.stopWatchingLocalChanges();

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
    this.rejectAckWaiters(new Error('Disconnected'));
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
        // Safe to advance the received watermark, and the pull continues from it.
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

      case 'snapshot_chunk':
        // MUST stay synchronous: handleMessage is invoked from ws.onmessage
        // without serialization, so two messages can be in-flight through it at
        // once and anything after an `await` may interleave. Reaching push()
        // with no intervening await is what preserves chunk order — the whole
        // transfer's correctness rests on it.
        this.handleSnapshotChunk(message);
        break;

      case 'snapshot_complete':
        this.handleSnapshotComplete();
        break;

      case 'snapshot_required':
        await this.handleSnapshotRequired(message);
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

    // A snapshot-stream failure (or any fatal error) kills the transfer. For
    // SNAPSHOT_ERROR the failure path closes the socket and the reconnect
    // resumes from the checkpoint; for a fatal error the stopReconnect set
    // below wins — no reconnect, no resume.
    if (fatal || message.code === 'SNAPSHOT_ERROR') {
      this.abortSnapshotTransfer(new Error(`Server error during snapshot: ${message.message}`));
    }

    // A push the server could not apply gets an `error`, never an apply_result,
    // so anyone awaiting that ack would wait until the socket closed. The error
    // carries no requestId, so every waiter is released.
    if (fatal || message.code === 'APPLY_CHANGES_ERROR') {
      this.rejectAckWaiters(new Error(`Push not acknowledged: ${message.message}`));
    }

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

  private async handleHandshakeAck(
    message: { serverSiteId?: string; connectionId?: string; protocolVersion?: number }
  ): Promise<void> {
    // Wire-version gate. A coordinator on a different protocol version — or one
    // predating versioning, so the ack carries none — would silently
    // misinterpret us. Treat any mismatch (strict equality; absent counts as
    // mismatch) as fatal: stop reconnecting, surface a lasting error, and reject
    // the pending connect().
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      const serverPart = message.protocolVersion === undefined
        ? 'server sent none (pre-versioning coordinator)'
        : `server speaks v${message.protocolVersion}`;
      this.stopWithError(new Error(`Sync protocol version mismatch: client speaks v${PROTOCOL_VERSION}, ${serverPart}`));
      return;
    }

    if (message.serverSiteId) {
      this.serverSiteId = siteIdFromBase64(message.serverSiteId);
    }

    this.emitSyncEvent(
      'state-change',
      `Authenticated with server (connection: ${message.connectionId?.slice(0, 8) ?? 'unknown'})`
    );

    // Handshake accepted — resolve the connect() promise.
    this.settleConnect();

    // Bootstrap is decided and FINISHED before the incremental path starts, so
    // the post-snapshot get_changes below carries the snapshot's HLC and the
    // local-change subscription never sees a partial database. A failed
    // transfer has already closed the socket — stop here and let the reconnect
    // (which finds the saved checkpoint) resume it.
    const bootstrapOk = await this.maybeBootstrap();
    if (!bootstrapOk) return;

    // Seed the sent watermark from durable per-peer state so a fresh process
    // (or a reconnect) resumes delta-push where it left off instead of
    // replaying the entire local history to the server. Seeded BEFORE the
    // get_changes goes out: its reply may be snapshot_required, whose recovery
    // pushes from this watermark and must not see it still unseeded.
    await this.seedSentWatermark();

    // Request changes from server since our last sync with this peer
    await this.requestChangesFromServer();

    // In read-only (pull-only) mode, skip push entirely
    if (!this.options.readOnly) {
      // Subscribe to local changes for pushing to server
      this.subscribeToLocalChanges();

      // Push any existing local changes to server (changes made while offline).
      // This sends the first batch; each ack sends the next (handleApplyResult).
      await this.pushLocalChanges();
    }
  }

  /**
   * Stop for good, until the next explicit connect(): a lasting `error` status, no
   * reconnect, and the pending connect() (if any) rejected. For a condition a bare
   * reconnect cannot fix. A pending reconnect timer is cancelled too, since the
   * connect() it fires would clear stopReconnect. The local-change listener goes as
   * well: nothing can be pushed from here, an app may replace this client without
   * disconnecting it, and the next handshake subscribes again.
   */
  private stopWithError(error: Error): void {
    this.stopReconnect = true;
    this.clearReconnectTimer();
    this.stopWatchingLocalChanges();
    this.setStatus({ status: 'error', message: error.message });
    this.emitSyncEvent('error', error.message);
    this.options.onError?.(error);
    this.settleConnect(error);
    // Detach first so the socket's deferred onclose can't fire back into the client
    // (scheduleReconnect is already guarded by stopReconnect, but we don't want the
    // disconnected-status churn either). onclose would have released these two, so
    // they are released here.
    if (this.ws) {
      this.detachSocketHandlers(this.ws);
      this.ws.close();
      this.ws = null;
    }
    this.abortSnapshotTransfer(error);
    this.rejectAckWaiters(error);
  }

  /**
   * Apply received changesets to the local store. An ordered reply also drives
   * the pull: a non-empty one advances the received watermark (`lastSyncHLC`) and
   * asks for the next batch, and an empty one ends the pull.
   *
   * @param ordered Only the ordered `changes` reply is contiguous and gap-free,
   *   so only it may advance the watermark. A `push_changes` broadcast is applied
   *   (idempotently) but must leave the watermark unmoved, so a broadcast the
   *   client never received is still redelivered by the next
   *   `get_changes sinceHLC=<watermark>`.
   */
  private async handleChanges(
    serializedChangeSets: SerializedChangeSet[],
    ordered: boolean
  ): Promise<void> {
    // While a snapshot is streaming, incoming deltas are DROPPED, not applied:
    // applyChanges would interleave with the snapshot's clear-and-rewrite of
    // the same cv:/tb:/cl: records. Nothing is lost — the watermark is not
    // advanced here, so the get_changes catch-up that runs right after
    // bootstrap re-fetches everything past the snapshot HLC.
    if (this.isBootstrapping) {
      this.emitSyncEvent(
        'info',
        `Dropped ${serializedChangeSets.length} incoming change set(s) during snapshot bootstrap (re-fetched afterwards)`
      );
      return;
    }

    const changeSets = serializedChangeSets.map(cs => deserializeChangeSet(cs));
    const arrivedOn = this.ws;

    // Set before the first await, so it applies to the pull this reply arrived in. A
    // connect() or snapshot transfer that starts during the apply clears the flag for
    // its new pull, and this reply must not overwrite that.
    if (ordered && changeSets.length === 0) {
      this.caughtUp = true;
    }

    const result = await this.syncManager.applyChanges(changeSets);

    // Only on the ordered path, where contiguity guarantees nothing below the
    // reply's max HLC was missed.
    const advanced = ordered && await this.advanceReceivedWatermark(changeSets);

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

    // A reply carries one bounded batch and its size says nothing about what remains,
    // so ask again until a reply is empty. Only a real advance continues, so a server
    // repeating itself cannot loop this, and a reply that did not move the watermark
    // ends a duplicate chain. A replacement socket runs its own pull from the handshake,
    // and a request sent on it now could beat that handshake and be refused.
    // NOTE: a get_changes the server answers with GET_CHANGES_ERROR, a failed apply or a
    // throwing onRemoteChanges ends the pull with the socket open, so the status stays
    // syncing and the remainder waits for the next reconnect. If that shows up, retry on
    // a backoff timer.
    if (advanced && this.ws === arrivedOn) {
      await this.requestChangesFromServer();
    }

    // A stop that landed while this apply finished outranks it: the socket is gone.
    if (this.caughtUp && !this.stopReconnect) {
      this.setStatus({ status: 'synced', lastSyncTime: Date.now() });
    }
  }

  /**
   * Move the received watermark up to the max HLC of an ordered reply. Forward only:
   * the store does not guard this, and a stale reply must not drag the watermark back.
   *
   * @returns true only when the watermark moved.
   */
  private async advanceReceivedWatermark(changeSets: ChangeSet[]): Promise<boolean> {
    // NOTE: the compare and write are not atomic and messages are not serialized, so two
    // chains on one socket (connect() then requestSnapshot()) can step the watermark
    // back, which only re-fetches, or skip the range of a reply whose apply then fails.
    // If chains ever overlap in normal use, serialize ordered replies.
    const serverSiteId = this.serverSiteId;
    const replyHLC = maxHLC(changeSets.map(cs => cs.hlc));
    if (!serverSiteId || !replyHLC) return false;

    const current = await this.syncManager.getPeerSyncState(serverSiteId);
    if (current && compareHLC(replyHLC, current) <= 0) return false;

    await this.syncManager.updatePeerSyncState(serverSiteId, replyHLC);
    return true;
  }

  private async handleApplyResult(message: {
    requestId?: string;
    applied?: number;
    rejected?: Array<{ reason: string; code?: string }>;
  }): Promise<void> {
    const advanced = await this.promoteWatermark(message.requestId);
    this.settleAckWaiters();

    this.emitSyncEvent('info', `Server applied ${message.applied ?? 0} change(s)`);

    if (message.rejected?.length) {
      for (const r of message.rejected) {
        this.emitSyncEvent('rejected', r.reason, { rejections: [r] });
      }
    }

    // A push carries one bounded batch, so an ack does not mean we are caught up.
    // Only a real advance continues the chain: the watermark can only climb so
    // far, whereas re-reading after a stale ack would send the same batch again.
    // NOTE: a push that fails or is dropped ends the chain, so the remainder waits
    // (durably) for the next local write or reconnect. If that stall ever shows
    // up on a device that goes quiet, retry on a backoff timer.
    if (advanced && !this.recoveryOwnsPush) {
      await this.pushLocalChanges();
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
   *
   * @returns true only when `lastSentHLC` moved forward.
   */
  private async promoteWatermark(requestId: string | undefined): Promise<boolean> {
    if (requestId === undefined) return false;

    const promoted = this.pendingSentHLCs.get(requestId);
    if (!promoted) {
      this.emitSyncEvent('info', `Ignoring apply_result for unknown push (requestId: ${requestId})`);
      return false;
    }

    this.pendingSentHLCs.delete(requestId);
    let advanced = false;

    // Never move the watermark backward: an out-of-order ack for an older batch
    // must not undo a newer batch a prior ack already promoted.
    if (!this.lastSentHLC || compareHLC(promoted, this.lastSentHLC) > 0) {
      this.lastSentHLC = promoted;
      advanced = true;
      // Persist the confirmed watermark per peer so a restart resumes delta-push
      // from here instead of replaying local history. Only written on a real
      // forward advance, and only for a correlated ack (so we persist a
      // watermark we actually confirmed sent).
      if (this.serverSiteId) {
        await this.syncManager.updatePeerSentState(this.serverSiteId, this.lastSentHLC);
      }
    }

    // Drop any still-pending batches the new watermark now subsumes (every push
    // starts from an acknowledged watermark, so all at or below the new one has
    // landed), so their late/duplicate acks can't re-promote an already-covered HLC.
    for (const [id, hlc] of this.pendingSentHLCs) {
      if (compareHLC(hlc, this.lastSentHLC) <= 0) {
        this.pendingSentHLCs.delete(id);
      }
    }

    return advanced;
  }

  /**
   * Resolve once the push identified by `requestId` has been acknowledged.
   * Resolved immediately when the id is not pending (already acked, or
   * subsumed by a later ack — see {@link promoteWatermark}); rejected when the
   * socket closes or the server reports the push failed.
   */
  private waitForAck(requestId: string): Promise<void> {
    if (!this.pendingSentHLCs.has(requestId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.ackWaiters.get(requestId) ?? [];
      waiters.push({ resolve, reject });
      this.ackWaiters.set(requestId, waiters);
    });
  }

  /** Release every waiter whose push is no longer pending (acked or subsumed). */
  private settleAckWaiters(): void {
    for (const [requestId, waiters] of this.ackWaiters) {
      if (this.pendingSentHLCs.has(requestId)) continue;
      this.ackWaiters.delete(requestId);
      for (const waiter of waiters) waiter.resolve();
    }
  }

  private rejectAckWaiters(error: Error): void {
    const all = [...this.ackWaiters.values()];
    this.ackWaiters.clear();
    for (const waiters of all) {
      for (const waiter of waiters) waiter.reject(error);
    }
  }

  private async handleRequestChanges(message: { siteId?: string; sinceHLC?: string }): Promise<void> {
    // Server is relaying a request for changes from another peer
    if (!message.siteId) return;
    // No pushes while a snapshot is landing — local data is partial.
    if (this.isBootstrapping) return;

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
  // Snapshot bootstrap
  // ==========================================================================
  //
  // NOTE: this file is ~1450 lines; this section is ~300 of them and is the
  // natural extraction seam — it touches the rest of the client only through
  // `send`, `setStatus`, `emitSyncEvent`, `syncManager` and `ws`. If the file
  // grows much further, lift it into a `SnapshotBootstrap` collaborator that
  // takes those five as its interface rather than splitting elsewhere.

  /**
   * Explicitly request a full snapshot of the database from the server.
   *
   * CONTRACT: do not write to the database while the snapshot is landing. The
   * apply clears sync metadata and rewrites cell records unconditionally — a
   * concurrent local write is silently overwritten and never pushed. Hold
   * application writes until this resolves (watch {@link isBootstrapping} /
   * the `bootstrapping` status). The same fate meets local work that is still
   * UNPUSHED when this is called: its metadata is wiped, so it is never sent,
   * and an unpushed row is DELETED if the server's copy covers its table and
   * lacks the row. The `snapshot_required` recovery pushes first for that reason
   * — this explicit path does not, so call it only on a replica with nothing
   * pending. It also skips the `unrecordedRows` check: the caller asked for a full
   * replace, so rows sync has never recorded are deleted the same way.
   *
   * Resolves once the snapshot has landed and the catch-up `get_changes` for what
   * came after it has gone out. The status reaches `synced` when that catch-up ends.
   *
   * Idempotent while a transfer is in flight: a second call joins the same
   * transfer instead of starting another stream, and whoever started it does the
   * catch-up. Rejects when not connected / handshaken, or when the transfer fails
   * (the socket is then closed and the normal reconnect path resumes from the
   * saved checkpoint).
   */
  async requestSnapshot(): Promise<void> {
    if (this.snapshotTransferPromise) {
      const error = await this.snapshotTransferPromise;
      if (error) throw error;
      return;
    }
    if (!this.isConnected || !this.serverSiteId) {
      throw new Error('Cannot request a snapshot: not connected to a sync server');
    }
    const error = await this.runSnapshotTransfer({ type: 'get_snapshot' });
    if (error) throw error;
    await this.requestChangesFromServer();
  }

  /**
   * The server refused our `get_changes`: its delta floor is above our
   * received watermark, so deletes we need have been pruned and no incremental
   * reply can be complete. Recover by taking a full copy — but only AFTER our
   * own unsent work has landed on the server. The snapshot apply makes each
   * table the server's copy covers hold exactly that copy's rows: an unpushed
   * local delete would be undone and an unpushed local insert would be deleted.
   *
   * Order: (1) send all unsent work, every batch ({@link pushUntilDrained});
   * (2) stream the snapshot; (3) catch up from the snapshot's HLC, which the
   * transfer recorded as the received watermark and which is at or above the
   * floor by construction. A push that fails or a socket that drops stops the
   * sequence: the reconnect re-sends `get_changes`, is refused again, and lands
   * back here — pushes are idempotent, so the loop converges.
   *
   * Local writes made DURING the transfer remain the gap tracked by
   * backlog/feat-sync-bootstrap-write-gate; this path does not widen it.
   */
  private async handleSnapshotRequired(message: { sinceHLC?: string; deltaFloor?: string }): Promise<void> {
    if (this.snapshotTransferPromise) {
      // A transfer is already landing; it records its snapshot HLC as the
      // received watermark, so this refusal of the OLD one is moot (the next
      // get_changes — a bootstrap's own catch-up, or the next handshake's —
      // carries the new one).
      return;
    }

    // Ahead of the push, so a device that is about to stop does not first drain its
    // work to the server, and rows being adopted go out with that work and so come
    // back in the snapshot. (The handshake's own first push has already gone by now.)
    if (await this.settleUnrecordedRows() === 'stopped') return;

    this.emitSyncEvent(
      'state-change',
      'Server no longer holds history back to our watermark (its delta floor is '
        + `${message.deltaFloor ?? 'unknown'}): pushing local changes, then taking a full copy`,
    );

    if (!this.options.readOnly) {
      try {
        await this.pushUntilDrained();
      } catch (err) {
        // Not an error to surface: the reconnect path retries the whole
        // sequence, and the refusal that brought us here will repeat.
        // NOTE: only a reconnect retries. A push the server answers with
        // APPLY_CHANGES_ERROR, or one that could not be sent, leaves the socket
        // open, so the recovery stays parked (broadcasts still land; the gap
        // does not) until the socket next drops. If that shows up, re-send
        // get_changes after the reconnect backoff instead of returning here.
        this.emitSyncEvent(
          'info',
          `Snapshot recovery deferred: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    const error = await this.runSnapshotTransfer({ type: 'get_snapshot' });
    if (error) return;

    await this.requestChangesFromServer();
  }

  /**
   * Send local changes one batch at a time, waiting for each ack, until a read
   * past the acknowledged watermark finds nothing. That read is the whole safety
   * condition, so a push already in flight (the handshake-time one) needs no
   * wait of its own: its range is at worst re-sent once, and whichever ack lands
   * first subsumes the other.
   *
   * @throws when a batch could not be sent or its ack will not come — unsent work
   *         remains, so the caller must not go on to take a snapshot.
   */
  private async pushUntilDrained(): Promise<void> {
    this.recoveryOwnsPush = true;
    try {
      // NOTE: progress relies on every read's max hlc exceeding the watermark, which
      // getChangesToPush guarantees today. Unlike the ack chain this loop has no
      // "did it advance" check; if a read could ever return facts at or below the
      // watermark, stop here on a non-advancing ack or it re-sends them forever.
      let push = await this.pushLocalChanges();
      while (push.status === 'sent') {
        await this.waitForAck(push.requestId);
        push = await this.pushLocalChanges();
      }
      if (push.status === 'held') {
        throw new Error('Unsent local changes could not be pushed');
      }
    } finally {
      this.recoveryOwnsPush = false;
    }
  }

  /**
   * Decide, on handshake, whether to run a snapshot transfer before the
   * incremental path: resume a pending checkpoint, adopt unrecorded rows on first
   * contact, bootstrap an empty replica, or none of these.
   *
   * Rows just adopted rule out a bootstrap: they have not been pushed, so a snapshot
   * would delete them. The incremental path that follows pushes them.
   *
   * @returns false when a transfer failed or unrecorded rows stopped it — the
   *          socket has been closed and the caller must stop the handshake flow.
   */
  private async maybeBootstrap(): Promise<boolean> {
    // A transfer from the PREVIOUS socket can still be unwinding (its abort has
    // to propagate through the apply). This handshake belongs to a new socket,
    // so joining that dead transfer would report its failure as this
    // connection's and stop the handshake with nothing scheduled to retry it.
    // Wait for it to settle, then decide fresh off the checkpoint it left.
    if (this.snapshotTransferPromise) await this.snapshotTransferPromise;

    // NOTE: checkpoints carry no server identity (the apply stamps the
    // RECEIVER's site id into them), so a replica that syncs one database to
    // two different coordinators would resume server A's checkpoint against
    // server B — B skips the tables A already completed, silently. One
    // coordinator per database today; key checkpoints by peer before that
    // changes.
    const pending = await this.syncManager.listSnapshotCheckpoints();

    if (pending.length > 0) {
      // A checkpoint means the database is PARTIAL: a prior apply cleared sync
      // metadata and never reached its footer. Resume the newest; clear the
      // rest — the client tracks one transfer, so they are unreachable and
      // would otherwise accumulate forever.
      const newest = pending.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      for (const checkpoint of pending) {
        if (checkpoint.snapshotId !== newest.snapshotId) {
          await this.syncManager.clearSnapshotCheckpoint(checkpoint.snapshotId);
        }
      }
      this.emitSyncEvent('state-change', 'Resuming interrupted snapshot transfer');
      const error = await this.runSnapshotTransfer({
        type: 'resume_snapshot',
        checkpoint: serializeSnapshotCheckpoint(newest),
      });
      return error === null;
    }

    // Independent of bootstrapOnEmpty: this is about these rows, not about bootstrapping.
    if (this.options.unrecordedRows === 'adopt' && await this.isFirstContact()) {
      const verdict = await this.settleUnrecordedRows();
      if (verdict !== 'clear') return verdict === 'adopted';
    }

    if (this.options.bootstrapOnEmpty && await this.isReplicaEmpty()) {
      const verdict = await this.settleUnrecordedRows();
      if (verdict !== 'clear') return verdict === 'adopted';
      this.emitSyncEvent('state-change', 'Empty replica: requesting full snapshot from server');
      const error = await this.runSnapshotTransfer({ type: 'get_snapshot' });
      return error === null;
    }

    return true;
  }

  /**
   * A replica is "empty" — safe to bootstrap wholesale — only when BOTH hold
   * against the server learned at handshake:
   *
   * - no peer sync state (never synced with this server), and
   * - no change facts, whichever device wrote them. That is why this reads with
   *   getChangesSince rather than getChangesToPush: a device holding changes learned
   *   over another route must not be bootstrapped over them.
   *
   * The first alone would also match a device holding real local data that is
   * merely meeting this server for the first time — bootstrapping it would
   * delete every row the server's copy lacks, from each table that copy covers.
   * The second alone would match a device already following this server that
   * simply holds nothing yet, which needs no snapshot. Requiring both admits only
   * the genuinely new device. A device that pre-created its schema locally still
   * counts as empty: schema migration records are not consulted, and replicated DDL
   * applies idempotently.
   *
   * A device whose rows were written BEFORE sync attached also passes: those
   * rows have no change facts. {@link settleUnrecordedRows} stands between that
   * device and a bootstrap that would delete them.
   */
  private async isReplicaEmpty(): Promise<boolean> {
    if (!this.serverSiteId) return false;

    const peerState = await this.syncManager.getPeerSyncState(this.serverSiteId);
    if (peerState !== undefined) return false;

    // NOTE: this arm materializes every local change set when it runs. It runs only
    // when no peer sync state exists. That is usually once, on a device with nothing to
    // materialize, but a device that adopted rows and reconnects before its first
    // `changes` reply holds them all. If that shows up, replace this with a cheap
    // existence scan over the `cv:` prefix.
    const localChanges = await this.syncManager.getChangesSince(this.serverSiteId);
    return localChanges.length === 0;
  }

  /**
   * Whether this device has exchanged nothing with this server yet. Peer sent state is
   * written on the first ack, so this is what makes handshake adoption run once: until
   * that ack a reconnect rescans, skipping the rows already adopted.
   */
  private async isFirstContact(): Promise<boolean> {
    if (!this.serverSiteId) return false;
    return await this.syncManager.getPeerSyncState(this.serverSiteId) === undefined
      && await this.syncManager.getPeerSentState(this.serverSiteId) === undefined;
  }

  /**
   * Deal with rows sync has never recorded, as the `unrecordedRows` option says, ahead
   * of an automatic snapshot that would delete them.
   *
   * A transfer already running settles it, whether it was there first or started
   * meanwhile: in practice an explicit {@link requestSnapshot} starts one
   * (`await connect(); await requestSnapshot()` does), the caller asked for that full
   * replace, its header clears the metadata both options below read, and the caller
   * here simply joins it. So does a pending checkpoint: that transfer's header already
   * cleared the metadata, every row would look unrecorded, and the decision was made
   * when it started.
   *
   * A scan or adoption that fails is not a verdict, so it retries through the reconnect
   * rather than stopping for good. Either way no snapshot follows.
   */
  private settleUnrecordedRows(): Promise<UnrecordedRowsVerdict> {
    const policy = this.options.unrecordedRows;
    if (policy === 'replace' || this.snapshotTransferPromise) return Promise.resolve('clear');
    return policy === 'adopt' ? this.adoptUnrecordedRows() : this.refuseOverUnrecordedRows();
  }

  /** The `refuse` arm of {@link settleUnrecordedRows}. */
  private async refuseOverUnrecordedRows(): Promise<UnrecordedRowsVerdict> {
    // A reconnect or disconnect can replace `this.ws` during the scan. The verdict
    // then belongs to nobody: the new socket's handshake decides for itself.
    const socket = this.ws;
    let tables: ReadonlyArray<{ schema: string; table: string }> = [];
    try {
      const resuming = (await this.syncManager.listSnapshotCheckpoints()).length > 0;
      if (!resuming) tables = await this.syncManager.findTablesWithUnrecordedRows();
    } catch (err) {
      this.failAndRetry(socket, 'Could not check for rows sync has never recorded', err);
      return 'stopped';
    }
    if (this.ws !== socket) return 'stopped';
    if (tables.length === 0 || this.snapshotTransferPromise) return 'clear';

    this.stopWithError(new UnrecordedRowsError(tables));
    return 'stopped';
  }

  /**
   * The `adopt` arm of {@link settleUnrecordedRows}. The transfer check sits right against
   * the call with no `await` between: a transfer started after that call waits inside the
   * manager for the adoption to finish, and one started before it must not be adopted
   * under, since its header clears the metadata and every row would be stamped as new.
   */
  private async adoptUnrecordedRows(): Promise<UnrecordedRowsVerdict> {
    const socket = this.ws;
    let adopted: AdoptedRows;
    try {
      const resuming = (await this.syncManager.listSnapshotCheckpoints()).length > 0;
      if (resuming || this.snapshotTransferPromise) return this.ws === socket ? 'clear' : 'stopped';
      adopted = await this.syncManager.adoptUnrecordedRows();
    } catch (err) {
      this.failAndRetry(socket, 'Could not record rows sync has never recorded', err);
      return 'stopped';
    }
    if (adopted.rows > 0) {
      this.emitSyncEvent(
        'state-change',
        `Recorded ${adopted.rows} existing row(s) in ${adopted.tables.length} table(s) as local changes`,
        { changeCount: adopted.rows },
      );
    }
    if (this.ws !== socket) return 'stopped';
    if (adopted.rows === 0 || this.snapshotTransferPromise) return 'clear';
    return 'adopted';
  }

  /**
   * Run one snapshot transfer: send the request, stream chunks through the
   * reader into `applySnapshotStream`, then write the peer watermark.
   *
   * Resolves to null on success or the failure Error — never rejects, so the
   * automatic bootstrap path (which nobody awaits externally) cannot surface
   * an unhandled rejection. On failure the socket is closed WITHOUT detaching
   * handlers: onclose firing is the retry mechanism (status → disconnected,
   * scheduleReconnect, and the next handshake finds the pending checkpoint and
   * sends resume_snapshot). No lingering `error` status and no stopReconnect —
   * a snapshot failure is transient by construction.
   */
  private runSnapshotTransfer(msg: GetSnapshotMessage | ResumeSnapshotMessage): Promise<Error | null> {
    if (this.snapshotTransferPromise) {
      return this.snapshotTransferPromise;
    }

    this.caughtUp = false;

    // Cleanup rides on the returned promise rather than a `finally` INSIDE the
    // transfer body: the body can settle synchronously (a send that fails
    // before its first await), and an inner finally would then null the field
    // before the assignment below ever set it — pinning isBootstrapping true
    // for the life of the client. A .finally() callback always runs a microtask
    // later, i.e. after the assignment.
    const promise = this.executeSnapshotTransfer(msg).finally(() => {
      this.clearSnapshotStallTimer();
      this.activeSnapshotReader = null;
      this.snapshotTransferPromise = null;
    });
    this.snapshotTransferPromise = promise;
    return promise;
  }

  /** The transfer body itself; state setup/teardown belongs to {@link runSnapshotTransfer}. */
  private async executeSnapshotTransfer(
    msg: GetSnapshotMessage | ResumeSnapshotMessage
  ): Promise<Error | null> {
    // The socket this transfer belongs to. A reconnect can replace `this.ws`
    // while the apply unwinds, and the failure path below must not close the
    // fresh socket in the dead one's name.
    const socket = this.ws;
    const reader = new SnapshotStreamReader();
    this.activeSnapshotReader = reader;
    this.snapshotEventTablesProcessed = -1;
    this.droppedChunkWarned = false;

    try {
      this.setStatus({
        status: 'bootstrapping',
        tablesProcessed: 0, totalTables: 0,
        entriesProcessed: 0, totalEntries: 0,
      });

      if (!this.send(msg)) {
        // Socket died before the request left — abandon without starting the
        // apply; the reconnect path retries.
        throw new Error('Snapshot request could not be sent (socket not open)');
      }

      this.resetSnapshotStallTimer();
      // NOTE: the apply returns only when the stream ENDS, and only
      // snapshot_complete ends it — a socket drop between the footer and that
      // message fails a transfer whose data already landed and whose
      // checkpoint the footer already cleared, so the next connect
      // re-bootstraps from scratch. Correct (idempotent), just wasteful; if it
      // ever shows up in practice, end the stream on the footer instead.
      await this.syncManager.applySnapshotStream(
        reader.chunks(),
        progress => this.reportSnapshotProgress(progress)
      );

      // The snapshot delivered everything up to its header HLC; record that
      // as the received watermark so the follow-up get_changes asks for
      // changes AFTER the snapshot point instead of replaying from nothing.
      // (applySnapshotStream merges the HLC into the local clock but writes
      // no peer state — the client owns that.) On a RESUMED transfer this is
      // conservative: the header carries the original snapshot's HLC while
      // the data served was read live, so the watermark is older than some
      // applied data and the catch-up re-fetches a little. That is correct —
      // re-application is idempotent — and cheaper than the alternative; do
      // not "fix" it by advancing past the header HLC.
      if (reader.headerHLC && this.serverSiteId) {
        await this.syncManager.updatePeerSyncState(this.serverSiteId, reader.headerHLC);
      }

      this.emitSyncEvent('state-change', 'Snapshot bootstrap complete');
      this.setStatus({ status: 'syncing', progress: 0 });
      return null;
    } catch (err) {
      return this.failAndRetry(socket, 'Snapshot transfer failed', err);
    }
  }

  /**
   * Report a transient failure and close `socket` with its handlers attached, so
   * onclose firing is what retries (status → disconnected, scheduleReconnect, and
   * the next handshake decides afresh).
   *
   * @returns the failure as an Error.
   */
  private failAndRetry(socket: WebSocket | null, description: string, err: unknown): Error {
    const error = err instanceof Error ? err : new Error(String(err));
    // Work torn down by our own disconnect() is not a failure to report — the
    // caller asked for it, and onError means "needs attention".
    if (!this.intentionalDisconnect) {
      this.emitSyncEvent('error', `${description}: ${error.message}`);
      this.options.onError?.(error);
    }
    // Close unless the socket is already closed, in which case onclose has fired
    // or is in flight. `socket.OPEN`, not the global `WebSocket.OPEN`: this can run
    // long after the work started, and a teardown that has since removed the global
    // (an environment shim, a test harness) would turn this cleanup into a
    // ReferenceError.
    if (socket && socket.readyState === socket.OPEN) {
      socket.close();
    }
    return error;
  }

  /** Route one snapshot_chunk to the active transfer. Synchronous — see the dispatch comment. */
  private handleSnapshotChunk(message: { chunk?: SerializedSnapshotChunk }): void {
    if (!this.activeSnapshotReader) {
      // A late chunk from an aborted stream must never leak into the next
      // transfer. Warn once per gap, not per chunk — a dead stream can trail
      // thousands.
      if (!this.droppedChunkWarned) {
        this.droppedChunkWarned = true;
        console.warn('Dropping snapshot_chunk with no active snapshot transfer');
        this.emitSyncEvent('info', 'Dropped snapshot chunk(s) received with no active transfer');
      }
      return;
    }
    if (!message.chunk) return;
    this.activeSnapshotReader.push(message.chunk);
    this.resetSnapshotStallTimer();
  }

  /** End the active transfer's stream (no-op when none). */
  private handleSnapshotComplete(): void {
    if (!this.activeSnapshotReader) return;
    this.clearSnapshotStallTimer();
    this.activeSnapshotReader.complete();
  }

  /**
   * Abort the in-flight transfer, if any. The reader throws into
   * `applySnapshotStream`, which lands in the transfer's failure path.
   */
  private abortSnapshotTransfer(error: Error): void {
    this.activeSnapshotReader?.abort(error);
  }

  /**
   * Stall watchdog: a server that stops sending mid-stream without closing the
   * socket would otherwise hang the bootstrap forever with no reconnect. Reset
   * on every chunk; cleared on complete and when the transfer settles.
   */
  private resetSnapshotStallTimer(): void {
    this.clearSnapshotStallTimer();
    const timeoutMs = this.options.snapshotChunkTimeoutMs;
    this.snapshotStallTimer = setTimeout(() => {
      this.snapshotStallTimer = null;
      this.abortSnapshotTransfer(new Error(`Snapshot transfer stalled: no chunk within ${timeoutMs}ms`));
    }, timeoutMs);
  }

  private clearSnapshotStallTimer(): void {
    if (this.snapshotStallTimer) {
      clearTimeout(this.snapshotStallTimer);
      this.snapshotStallTimer = null;
    }
  }

  /**
   * Forward apply progress: every tick to `onSnapshotProgress` and the status,
   * but a human-readable sync event only when `tablesProcessed` changes —
   * progress fires once per column-versions chunk and would flood an event log.
   */
  private reportSnapshotProgress(progress: SnapshotProgress): void {
    this.options.onSnapshotProgress?.(progress);
    this.setStatus({
      status: 'bootstrapping',
      tablesProcessed: progress.tablesProcessed,
      totalTables: progress.totalTables,
      entriesProcessed: progress.entriesProcessed,
      totalEntries: progress.totalEntries,
      currentTable: progress.currentTable,
    });
    if (progress.tablesProcessed !== this.snapshotEventTablesProcessed) {
      this.snapshotEventTablesProcessed = progress.tablesProcessed;
      this.emitSyncEvent(
        'info',
        `Snapshot: ${progress.tablesProcessed} of ${progress.totalTables} tables`,
        { changeCount: progress.entriesProcessed }
      );
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
      // Stamp the wire version so the coordinator can reject a drifted client
      // before authenticating. See handleHandshakeAck for the reverse check.
      protocolVersion: PROTOCOL_VERSION,
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

  private stopWatchingLocalChanges(): void {
    this.clearDebounceTimer();
    this.localChangeUnsubscribe?.();
    this.localChangeUnsubscribe = null;
  }

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

  /**
   * Push the next batch of local changes past `lastSentHLC`. `getChangesToPush`
   * bounds what one read returns, so this is not everything: the ack continues
   * from here (handleApplyResult, or {@link pushUntilDrained} during recovery).
   *
   * @returns `sent` when a tracked batch left the socket, `drained` when nothing
   *          is left past the watermark, and `held` when nothing was attempted
   *          or the send was dropped (read-only, not connected, bootstrapping).
   */
  private async pushLocalChanges(): Promise<PushOutcome> {
    if (this.options.readOnly) return { status: 'held' };
    if (!this.isConnected || !this.serverSiteId) return { status: 'held' };
    // No pushes while a snapshot is landing — local data is partial.
    if (this.isBootstrapping) return { status: 'held' };

    // What this device wrote past lastSentHLC. Changes it received from other devices
    // are left out: they came through this server, so it already has them.
    const changes = await this.syncManager.getChangesToPush(
      this.serverSiteId,
      this.lastSentHLC ?? undefined
    );

    if (changes.length === 0) return { status: 'drained' };

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
    if (!sent) return { status: 'held' };

    // Record the max HLC this batch carries against its request id; the matching
    // apply_result promotes lastSentHLC to it (see promoteWatermark).
    const batchHLC = maxHLC(changes.map(cs => cs.hlc));
    if (batchHLC) {
      this.pendingSentHLCs.set(requestId, batchHLC);
    }
    this.pendingLocalChangeCount = 0;
    return { status: 'sent', requestId };
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
