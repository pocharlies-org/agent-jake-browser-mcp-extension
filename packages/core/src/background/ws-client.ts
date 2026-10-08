/**
 * WebSocket client for connecting to browser-mcp server.
 * Handles connection lifecycle, reconnection, and message routing.
 */

import { CONFIG } from '@/types/config';
import { log } from '@/utils/logger';
import { buildWsUrl, ensureProfileEpoch, getEffectiveConfig, type RuntimeServerConfig } from '@/config/runtime';
import { logConnection, logError } from './activity-log';
import type { IncomingMessage, OutgoingMessage } from '@/types/messages';
import {
  CLOSE_CODES,
  HEARTBEAT_INTERVAL_MS,
  HELLO_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  parseServerFrame,
  serializeFrame,
  utf8ByteLength,
  type ServerHello,
  type ToolRequest,
} from '@agent-jake-browser/protocol';
import {
  buildHello,
  describeClientVersion,
  describePlatform,
  sanitizeEndpoint,
  validateAck,
  type ConnState,
  type NegotiationStatus,
} from './negotiation';

type MessageHandler = (message: IncomingMessage) => Promise<OutgoingMessage>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WebSocketClient {
  private socket: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private isConnecting = false;
  private shouldReconnect = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private effectiveUrl = '';

  // --- negotiated wire (opt-in via ajb.wireMode). The legacy path above/below never reads these. ---
  private mode: 'legacy' | 'negotiated' = 'legacy';
  private state: ConnState = 'DISCONNECTED';
  /** Bumped on every connect/disconnect: every callback and operation captures it and ignores stale events. */
  private generation = 0;
  private lastError: { code: string; message: string } | null = null;
  private negotiated: ServerHello | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ephemeral per-session contexts (bounded). Cleared on socket loss; never closes the shared socket. */
  private sessions = new Set<string>();
  private cancelled = new Set<string>();
  private sessionCloseHandler: ((sessionId: string) => void) | null = null;

  /** Effective URL last used (or attempted) for connecting. */
  getEffectiveUrl(): string {
    return this.effectiveUrl;
  }

  /**
   * Set the handler for incoming tool requests.
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Reset reconnect counter (call when user initiates new connection).
   */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
    log.info('[WS] Reconnect attempts counter reset');
  }

  /**
   * Connect to the browser-mcp WebSocket server.
   *
   * The endpoint comes from the runtime config (chrome.storage overrides
   * win over build-time defaults) and the handshake query always carries
   * `connectionId`, plus `token` when one is available.
   */
  async connect(): Promise<void> {
    log.info(`[WS] connect() called, current state: ${this.socket?.readyState ?? 'no socket'}, attempts: ${this.reconnectAttempts}`);

    if (this.socket?.readyState === WebSocket.OPEN) {
      log.debug('[WS] Already connected');
      return;
    }

    if (this.isConnecting) {
      log.debug('[WS] Connection in progress');
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    let cfg: RuntimeServerConfig;
    try {
      cfg = await getEffectiveConfig();
    } catch (error) {
      this.isConnecting = false;
      throw error;
    }

    this.mode = cfg.wireMode === 'negotiated' ? 'negotiated' : 'legacy';
    if (this.mode === 'negotiated') return this.connectNegotiated(cfg);

    return new Promise((resolve, reject) => {
      try {
        const url = buildWsUrl(cfg);
        this.effectiveUrl = url;
        log.info(`Connecting to ${url}`);

        this.socket = new WebSocket(url);
        const socket = this.socket;

        this.socket.onopen = () => {
          log.info('WebSocket connected');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          logConnection('ws_connect', `Connected to browser-mcp at ${url}`, true, { url });
          this.startHeartbeat();
          resolve();
        };

        this.socket.onclose = (event) => {
          // Ignore late events from a socket replaced by reload()/disconnect().
          if (this.socket !== socket) {
            log.debug('[WS] Ignoring close from stale socket');
            return;
          }
          log.info(`WebSocket closed: ${event.code} ${event.reason}`);
          this.isConnecting = false;
          this.stopHeartbeat();
          this.socket = null;
          logConnection('ws_close', `WebSocket closed: ${event.code} ${event.reason || 'No reason'}`, true, { code: event.code, reason: event.reason });
          this.handleDisconnect();
        };

        this.socket.onerror = (error) => {
          if (this.socket !== socket) {
            return;
          }
          log.error('WebSocket error:', error);
          this.isConnecting = false;
          logError('ws_error', 'WebSocket connection error', { error: String(error) });
          if (this.reconnectAttempts === 0) {
            reject(new Error('Failed to connect to browser-mcp'));
          }
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    // Invalidate every in-flight callback/operation of the negotiated wire (stale-socket protection).
    this.generation += 1;
    this.clearHelloTimer();
    this.state = 'DISCONNECTED';
    this.negotiated = null;
    this.sessions.clear();
    this.cancelled.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
    }

    // Reject all pending requests
    const pendingCount = this.pendingRequests.size;
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.pendingRequests.clear();

    log.info('Disconnected');
    logConnection('ws_disconnect', 'WebSocket disconnected by client', true, { pendingRequestsCancelled: pendingCount });
  }

  /**
   * Reconnect immediately with the current runtime config.
   * Call after ajb.serverUrl / ajb.token changed (popup save, pairing approved).
   */
  async reload(): Promise<void> {
    log.info('[WS] reload() - reconnecting with current runtime config');
    this.disconnect();
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    // OPEN is not "connected" on the negotiated wire: only a validated hello_ack is.
    if (this.mode === 'negotiated') return this.state === 'READY' && this.socket?.readyState === WebSocket.OPEN;
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if a connection attempt or scheduled reconnect is already pending.
   */
  isReconnecting(): boolean {
    // BLOCKED waits for a configuration change or an explicit retry: background loops must not relaunch it.
    return this.isConnecting || this.reconnectTimer !== null || this.state === 'BLOCKED';
  }

  /** Observable state for the status UI. Never includes the token or the handshake query. */
  getNegotiationStatus(): NegotiationStatus {
    return {
      mode: this.mode,
      state: this.mode === 'negotiated' ? this.state : 'LEGACY',
      error: this.lastError,
      endpoint: sanitizeEndpoint(this.effectiveUrl),
      protocolVersion: this.negotiated?.protocolVersion ?? null,
      catalogVersion: this.negotiated?.catalogVersion ?? '',
    };
  }

  /** Hook for per-session cleanup (INFRA-413 owns the window lifecycle; this only notifies). */
  setSessionCloseHandler(handler: (sessionId: string) => void): void {
    this.sessionCloseHandler = handler;
  }

  /**
   * Send a response back to the server.
   */
  send(message: OutgoingMessage): void {
    if (this.mode === 'negotiated') {
      // Results leave through sendToolResult (bound to their original socket/generation), never through here.
      log.error('Cannot send a legacy frame on the negotiated wire');
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      log.error('Cannot send: not connected');
      return;
    }

    const data = JSON.stringify(message);
    // Only the envelope is logged: a result can carry what the page typed (browser_type with a secret).
    log.debug('Sending:', { id: message.id, success: message.success });
    this.socket.send(data);
  }

  /**
   * Send lightweight traffic so proxies do not close the upgraded connection as idle.
   */
  sendHeartbeat(): void {
    if (this.mode === 'negotiated') {
      if (this.state === 'READY' && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'heartbeat' }));
      }
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), CONFIG.WS_HEARTBEAT_INTERVAL_MS);
    this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Handle incoming WebSocket message.
   */
  private async handleMessage(data: string): Promise<void> {
    let messageId: string | undefined;

    try {
      const message = JSON.parse(data) as IncomingMessage;
      messageId = message.id;
      log.info('[WS] Received message:', message.type, message.id);

      if (!this.messageHandler) {
        log.error('No message handler set');
        this.send({
          id: message.id,
          success: false,
          error: {
            code: 'NO_HANDLER',
            message: 'No message handler configured',
          },
        });
        return;
      }

      log.info('[WS] Calling message handler for:', message.type);
      const response = await this.messageHandler(message);
      log.info('[WS] Message handler returned, sending response');
      this.send(response);
    } catch (error) {
      log.error('[WS] Failed to handle message:', error);
      // Send error response back to server so it doesn't timeout
      if (messageId) {
        this.send({
          id: messageId,
          success: false,
          error: {
            code: 'HANDLER_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  /**
   * Handle disconnection with auto-reconnect.
   * Uses fixed 5-second interval, no exponential backoff.
   * Retries indefinitely when MAX_RECONNECT_ATTEMPTS is 0.
   */
  private handleDisconnect(): void {
    if (this.mode === 'negotiated' && this.state === 'BLOCKED') {
      log.info('[WS] BLOCKED: no automatic retry until configuration changes or an explicit retry');
      return;
    }
    log.info(`[WS] handleDisconnect() - shouldReconnect: ${this.shouldReconnect}, attempts: ${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS || 'unlimited'}`);

    if (!this.shouldReconnect) {
      return;
    }

    // Skip max attempts check if unlimited (0)
    if (CONFIG.MAX_RECONNECT_ATTEMPTS > 0 && this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
      log.error('[WS] Max reconnect attempts reached');
      logError('ws_reconnect_failed', `Max reconnect attempts reached (${CONFIG.MAX_RECONNECT_ATTEMPTS})`, { attempts: this.reconnectAttempts, maxAttempts: CONFIG.MAX_RECONNECT_ATTEMPTS });
      return;
    }

    this.reconnectAttempts++;
    // Fixed interval, no exponential backoff
    const delay = CONFIG.RECONNECT_INTERVAL_MS;

    log.info(`[WS] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    logConnection('ws_reconnecting', `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`, true, { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => {
        log.error('[WS] Reconnect failed:', error);
      });
    }, delay);
  }

  // ------------------------------------------------------------------------------------------------
  // Negotiated wire: DISCONNECTED -> CONNECTING -> NEGOTIATING -> READY. Transient failures -> RETRY_WAIT;
  // explicit auth/protocol/catalog failures -> BLOCKED. No fallback to the legacy wire, ever.
  // ------------------------------------------------------------------------------------------------

  private clearHelloTimer(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private startNegotiatedHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private async connectNegotiated(cfg: RuntimeServerConfig): Promise<void> {
    const generation = ++this.generation;
    this.state = 'CONNECTING';
    this.lastError = null;
    this.negotiated = null;
    const url = buildWsUrl(cfg);
    this.effectiveUrl = url;
    // Never log the handshake query: it carries the token.
    log.info(`Connecting (negotiated) to ${sanitizeEndpoint(url)}`);

    let epoch: string;
    try {
      epoch = await ensureProfileEpoch();
    } catch {
      epoch = 'unknown';
    }
    if (this.generation !== generation) {
      // disconnect()/reload() ran while we were awaiting: this attempt is dead.
      this.isConnecting = false;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        this.isConnecting = false;
        this.state = 'RETRY_WAIT';
        settle(() => reject(error));
        return;
      }
      this.socket = socket;
      const stale = () => this.socket !== socket || this.generation !== generation;

      /** Explicit protocol/auth/catalog failure: visible, closed, and no retry loop. */
      const block = (code: string, message: string) => {
        if (stale()) return;
        this.clearHelloTimer();
        this.stopHeartbeat();
        this.state = 'BLOCKED';
        this.lastError = { code, message };
        this.negotiated = null;
        this.isConnecting = false;
        logError('ws_blocked', message, { code });
        try {
          socket.close(1000, code.slice(0, 120));
        } catch {
          // already closing
        }
        settle(() => reject(new Error(`${code}: ${message}`)));
      };

      socket.onopen = () => {
        if (stale()) return;
        // OPEN is NOT connected: send exactly one hello and wait for the validated ack.
        this.state = 'NEGOTIATING';
        this.helloTimer = setTimeout(() => {
          block('hello_timeout', 'the server did not acknowledge the hello (not a negotiated Browser Harness endpoint?)');
        }, HELLO_TIMEOUT_MS);
        try {
          socket.send(serializeFrame(buildHello({
            clientVersion: describeClientVersion(),
            installationId: cfg.connectionId,
            profileEpoch: epoch,
            platform: describePlatform(),
          })));
        } catch (error) {
          block(error instanceof ProtocolError ? error.code : 'invalid_message', 'could not send hello');
        }
      };

      socket.onmessage = (event) => {
        if (stale()) return;
        const raw = typeof event.data === 'string' ? event.data : '';
        // Application-level bound. The browser may already have allocated the message: no preallocation claim.
        const bytes = utf8ByteLength(raw);
        if (!raw || bytes > MAX_MESSAGE_BYTES) {
          block(raw ? 'payload_too_large' : 'invalid_message', 'inbound frame is empty, binary or over the 32 MiB limit');
          return;
        }
        let frame;
        try {
          frame = parseServerFrame(raw, bytes);
        } catch {
          block('invalid_message', 'server frame does not match the protocol schema');
          return;
        }

        if (this.state === 'NEGOTIATING') {
          if (frame.type === 'hello_reject') {
            block(frame.error.code, frame.error.message);
            return;
          }
          if (frame.type !== 'hello_ack') {
            // A tool before the ack is an early/legacy action: zero execution.
            block('invalid_message', 'unexpected frame before hello_ack');
            return;
          }
          const check = validateAck(frame);
          if (!check.ok) {
            block(check.code, check.message);
            return;
          }
          this.clearHelloTimer();
          this.negotiated = check.ack;
          this.state = 'READY';
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.startNegotiatedHeartbeat();
          logConnection('ws_connect', 'Negotiated with browser-mcp', true, { protocolVersion: check.ack.protocolVersion });
          settle(() => resolve());
          return;
        }

        if (this.state !== 'READY' || !this.negotiated) return;
        switch (frame.type) {
          case 'tool_request':
            void this.runToolRequest(frame, socket, generation);
            return;
          case 'session_close':
            if (frame.connectionId === this.negotiated.connectionId) {
              this.sessions.delete(frame.sessionId);
              this.sessionCloseHandler?.(frame.sessionId);
            }
            return;
          case 'request_cancel':
            if (frame.connectionId === this.negotiated.connectionId) this.rememberCancelled(frame.id);
            return;
          case 'heartbeat_ack':
            return;
          default:
            // duplicate/out-of-state ack, hello_reject after READY
            block('invalid_message', `unexpected ${frame.type} in READY`);
        }
      };

      socket.onerror = () => {
        // 'close' follows; the browser exposes no detail, so no precise auth failure is invented here.
      };

      socket.onclose = (event) => {
        if (stale()) {
          log.debug('[WS] Ignoring close from stale socket');
          return;
        }
        this.clearHelloTimer();
        this.stopHeartbeat();
        this.socket = null;
        this.negotiated = null;
        this.sessions.clear();
        this.cancelled.clear();
        this.isConnecting = false;
        logConnection('ws_close', `WebSocket closed: ${event.code}`, true, { code: event.code });
        if (this.state === 'BLOCKED') {
          settle(() => reject(new Error(this.lastError?.code ?? 'blocked')));
          return;
        }
        // Closed before/after READY without an explicit protocol verdict: transient (auth-unconfirmed or network).
        const closeCode = event.code;
        const beforeAck = this.state !== 'READY';
        this.state = 'RETRY_WAIT';
        this.lastError = {
          code: closeCode === CLOSE_CODES.MESSAGE_TOO_BIG ? 'payload_too_large' : beforeAck ? 'connection_failed' : 'connection_lost',
          message: beforeAck
            ? 'closed before the server acknowledged the hello (network or authentication not confirmed)'
            : 'connection lost',
        };
        settle(() => reject(new Error(this.lastError!.code)));
        this.handleDisconnect();
      };
    });
  }

  private rememberCancelled(id: string): void {
    if (this.cancelled.size >= 256) this.cancelled.delete(this.cancelled.values().next().value as string);
    this.cancelled.add(id);
  }

  private rememberSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    // Local cap bounds stale contexts if a session_close frame can never be delivered.
    if (this.sessions.size >= 256) {
      const oldest = this.sessions.values().next().value as string;
      this.sessions.delete(oldest);
      this.sessionCloseHandler?.(oldest);
    }
    this.sessions.add(sessionId);
  }

  /** Execute one request and answer ONLY on the original, still-READY socket of the original generation. */
  private async runToolRequest(req: ToolRequest, socket: WebSocket, generation: number): Promise<void> {
    const ack = this.negotiated;
    if (!ack) return;
    const reply = (frame: Record<string, unknown>) => {
      if (this.socket !== socket || this.generation !== generation || this.state !== 'READY') {
        log.debug('[WS] Dropping result: its socket is no longer the READY one');
        return;
      }
      try {
        socket.send(serializeFrame(frame as never));
      } catch (error) {
        if (error instanceof ProtocolError && error.code === 'payload_too_large') {
          // Bounded error instead of truncating or replaying; the completed action is NOT undone.
          socket.send(JSON.stringify({
            type: 'tool_result', id: req.id, sessionId: req.sessionId, connectionId: ack.connectionId, house: ack.house,
            ok: false, error: { code: 'payload_too_large', message: 'result exceeds the 32 MiB message limit' },
          }));
        } else {
          log.error('[WS] Could not send result');
        }
      }
    };
    const base = { type: 'tool_result', id: req.id, sessionId: req.sessionId, connectionId: ack.connectionId, house: ack.house };

    if (req.connectionId !== ack.connectionId) {
      reply({ ...base, ok: false, error: { code: 'response_correlation_mismatch', message: 'request addressed to another connection' } });
      return;
    }
    this.rememberSession(req.sessionId);

    let response: OutgoingMessage;
    try {
      if (!this.messageHandler) throw new Error('No message handler configured');
      response = await this.messageHandler({
        id: req.id,
        type: req.tool as IncomingMessage['type'],
        payload: req.args,
        sessionId: req.sessionId,
        ...(req.tabHandle ? { tabHandle: req.tabHandle } : {}),
      });
    } catch (error) {
      response = {
        id: req.id,
        success: false,
        error: { code: 'HANDLER_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }

    if (this.cancelled.delete(req.id)) {
      log.debug('[WS] Result discarded: request was cancelled');
      return;
    }
    if (response.success) {
      reply({ ...base, ok: true, data: response.result });
    } else {
      reply({
        ...base,
        ok: false,
        error: {
          code: String(response.error?.code ?? 'HANDLER_ERROR').slice(0, 64),
          message: String(response.error?.message ?? 'tool failed').slice(0, 512),
        },
      });
    }
  }
}
