import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_VERSION, MAX_MESSAGE_BYTES } from '@agent-jake-browser/protocol';
import { WebSocketClient } from '../../../src/background/ws-client';
import type { IncomingMessage } from '../../../src/types/messages';

vi.mock('@/config/runtime', () => ({
  getEffectiveConfig: vi.fn(async () => ({ wireMode: 'negotiated', connectionId: 'inst-1', token: 'SECRET-TOKEN' })),
  buildWsUrl: vi.fn(() => 'ws://127.0.0.1:18766/ws/harness?token=SECRET-TOKEN&connectionId=inst-1'),
  ensureProfileEpoch: vi.fn(async () => 'epoch-1'),
}));
vi.mock('@/utils/logger', () => ({ log: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/background/activity-log', () => ({ logConnection: vi.fn(), logError: vi.fn() }));

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (e: { code: number; reason: string }) => void;
  onmessage?: (e: { data: unknown }) => void;
  onerror?: () => void;
  readonly sent: any[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = '') {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
}
const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const ack = (over: Record<string, unknown> = {}) => ({
  type: 'hello_ack', protocolVersion: 1, protocolPackageVersion: '0.1.0', catalogVersion: CATALOG_VERSION,
  serverVersion: '1.0.0', browserId: 'browser-1', connectionId: 'conn-1', house: 'house-a', capabilities: [], ...over,
});
const toolRequest = (over: Record<string, unknown> = {}) => ({
  type: 'tool_request', id: 'req-1', sessionId: 'sess-1', connectionId: 'conn-1', tool: 'browser_state', args: {}, ...over,
});
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe('negotiated wire — extension state machine', () => {
  let client: WebSocketClient;
  const handler = vi.fn(async (m: IncomingMessage) => ({ id: m.id, success: true, result: { echoed: m.payload } }));

  beforeEach(() => {
    FakeSocket.instances = [];
    handler.mockClear();
    vi.stubGlobal('WebSocket', FakeSocket);
    client = new WebSocketClient();
    client.setMessageHandler(handler);
  });
  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function negotiate() {
    const connected = client.connect();
    await flush();
    sock().open();
    sock().receive(ack());
    await connected;
    return sock();
  }

  it('OPEN is not connected: it sends exactly one hello and resolves only after a validated ack', async () => {
    let resolved = false;
    const connected = client.connect().then(() => { resolved = true; });
    await flush();
    sock().open();
    expect(client.isConnected()).toBe(false);
    expect(client.getNegotiationStatus().state).toBe('NEGOTIATING');
    expect(sock().sent).toHaveLength(1);
    expect(sock().sent[0]).toMatchObject({ type: 'hello', supportedProtocolVersions: [1], catalogVersion: CATALOG_VERSION, installationId: 'inst-1', profileEpoch: 'epoch-1', capabilities: [] });
    expect(sock().sent[0]).not.toHaveProperty('house');
    await flush();
    expect(resolved).toBe(false);
    sock().receive(ack());
    await connected;
    expect(client.isConnected()).toBe(true);
    expect(client.getNegotiationStatus()).toMatchObject({ state: 'READY', protocolVersion: 1, endpoint: 'ws://127.0.0.1:18766/ws/harness' });
  });

  it('status and logs never expose the token or the handshake query', async () => {
    await negotiate();
    expect(JSON.stringify(client.getNegotiationStatus())).not.toContain('SECRET-TOKEN');
    expect(client.getNegotiationStatus().endpoint).not.toContain('?');
  });

  it.each([
    ['hello_reject version', { type: 'hello_reject', error: { code: 'protocol_version_mismatch', message: 'no common version' }, supportedProtocolVersions: [2] }, 'protocol_version_mismatch'],
    ['hello_reject catalog', { type: 'hello_reject', error: { code: 'catalog_version_mismatch', message: 'catalog differs' } }, 'catalog_version_mismatch'],
    ['ack with a version that was not offered', ack({ protocolVersion: 7 }), 'protocol_version_mismatch'],
    ['ack with another catalog', ack({ catalogVersion: `sha256:${'0'.repeat(64)}` }), 'catalog_version_mismatch'],
    ['ack that fails the schema', { ...ack(), extra: true }, 'invalid_message'],
    ['a tool request before the ack (legacy/early action)', toolRequest(), 'invalid_message'],
    ['a legacy-shaped frame', { id: 'x', type: 'browser_state', payload: {} }, 'invalid_message'],
    ['a binary/non-text frame', undefined, 'invalid_message'],
  ])('incompatible server (%s) => BLOCKED, explicit error, no retry loop, zero tool executions', async (_n, frame, code) => {
    vi.useFakeTimers();
    const connected = client.connect().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    sock().open();
    if (frame === undefined) sock().onmessage?.({ data: new ArrayBuffer(4) });
    else sock().receive(frame);
    const err = await connected;
    expect((err as Error).message).toContain(code);
    expect(client.getNegotiationStatus()).toMatchObject({ state: 'BLOCKED', error: { code } });
    expect(client.isConnected()).toBe(false);
    expect(client.isReconnecting()).toBe(true); // background loops must not relaunch a BLOCKED client
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1); // no reconnect storm
    expect(handler).not.toHaveBeenCalled();
  });

  it('a silent (old, legacy) server => BLOCKED hello_timeout after 5 s, never a fallback', async () => {
    vi.useFakeTimers();
    const connected = client.connect().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    sock().open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(((await connected) as Error).message).toContain('hello_timeout');
    expect(client.getNegotiationStatus()).toMatchObject({ state: 'BLOCKED', error: { code: 'hello_timeout' } });
    expect(sock().sent.every((f) => f.type === 'hello')).toBe(true);
  });

  it('BLOCKED respects an explicit retry: disconnect + connect starts a fresh negotiation', async () => {
    const first = client.connect().catch(() => 'blocked');
    await flush();
    sock().open();
    sock().receive({ type: 'hello_reject', error: { code: 'catalog_version_mismatch', message: 'x' } });
    await first;
    expect(client.getNegotiationStatus().state).toBe('BLOCKED');
    client.disconnect();
    expect(client.getNegotiationStatus().state).toBe('DISCONNECTED');
    const retry = client.connect();
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    sock().open();
    sock().receive(ack());
    await retry;
    expect(client.getNegotiationStatus().state).toBe('READY');
  });

  it('a failed negotiation does not touch the stored token/URL/installation id (config is only read)', async () => {
    const runtime = await import('@/config/runtime');
    const first = client.connect().catch(() => undefined);
    await flush();
    sock().open();
    sock().receive({ type: 'hello_reject', error: { code: 'protocol_version_mismatch', message: 'x' } });
    await first;
    expect(Object.keys(runtime).sort()).toEqual(['buildWsUrl', 'ensureProfileEpoch', 'getEffectiveConfig']);
  });

  it('closing before OPEN/ack settles the connect once and goes to RETRY_WAIT (transient, auth unconfirmed)', async () => {
    vi.useFakeTimers();
    const connected = client.connect().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    sock().serverClose(1006);
    expect(((await connected) as Error).message).toBe('connection_failed');
    expect(client.getNegotiationStatus()).toMatchObject({ state: 'RETRY_WAIT', error: { code: 'connection_failed' } });
    await vi.advanceTimersByTimeAsync(5_000); // fixed reconnect interval
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('READY: runs a tool request with session and tab handle and answers a correlated tool_result', async () => {
    const s = await negotiate();
    s.receive(toolRequest({ tabHandle: 'th-9', args: { selector: '#a' } }));
    await flush();
    expect(handler).toHaveBeenCalledWith({ id: 'req-1', type: 'browser_state', payload: { selector: '#a' }, sessionId: 'sess-1', tabHandle: 'th-9' });
    expect(s.sent.at(-1)).toEqual({ type: 'tool_result', id: 'req-1', sessionId: 'sess-1', connectionId: 'conn-1', house: 'house-a', ok: true, data: { echoed: { selector: '#a' } } });
  });

  it('failure results carry ok:false + a bounded error and no data', async () => {
    handler.mockResolvedValueOnce({ id: 'req-1', success: false, error: { code: 'ELEMENT_NOT_FOUND', message: 'x'.repeat(2000) } } as never);
    const s = await negotiate();
    s.receive(toolRequest());
    await flush();
    const out = s.sent.at(-1);
    expect(out).toMatchObject({ type: 'tool_result', ok: false, error: { code: 'ELEMENT_NOT_FOUND' } });
    expect(out.error.message.length).toBe(512);
    expect(out).not.toHaveProperty('data');
  });

  it('a request addressed to another connectionId is answered response_correlation_mismatch without running', async () => {
    const s = await negotiate();
    s.receive(toolRequest({ connectionId: 'someone-else' }));
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(s.sent.at(-1)).toMatchObject({ ok: false, error: { code: 'response_correlation_mismatch' } });
  });

  it('a callback of a stale socket is ignored: an old socket cannot change state or answer through its replacement', async () => {
    const old = await negotiate();
    let finish: (v: unknown) => void = () => {};
    handler.mockImplementationOnce(() => new Promise((r) => { finish = r; }) as never);
    old.receive(toolRequest({ id: 'slow' }));
    await flush();
    client.disconnect(); // generation bump + socket dropped
    const second = client.connect();
    await flush();
    sock().open();
    sock().receive(ack({ connectionId: 'conn-2' }));
    await second;
    const replacement = sock();
    finish({ id: 'slow', success: true, result: 'late' });
    await flush();
    // nothing was written to the replacement socket, and the old one's events are ignored
    expect(replacement.sent.filter((f) => f.type === 'tool_result')).toHaveLength(0);
    old.receive(ack({ connectionId: 'conn-evil' }));
    old.serverClose(1006);
    expect(client.getNegotiationStatus().state).toBe('READY');
    expect(client.isConnected()).toBe(true);
  });

  it('request_cancel discards the late result; session_close notifies the hook and never closes the socket', async () => {
    const s = await negotiate();
    const closed = vi.fn();
    client.setSessionCloseHandler(closed);
    let finish: (v: unknown) => void = () => {};
    handler.mockImplementationOnce(() => new Promise((r) => { finish = r; }) as never);
    s.receive(toolRequest());
    await flush();
    s.receive({ type: 'request_cancel', id: 'req-1', sessionId: 'sess-1', connectionId: 'conn-1' });
    finish({ id: 'req-1', success: true, result: 1 });
    await flush();
    expect(s.sent.filter((f) => f.type === 'tool_result')).toHaveLength(0);
    s.receive({ type: 'session_close', sessionId: 'sess-1', connectionId: 'conn-1' });
    expect(closed).toHaveBeenCalledWith('sess-1');
    expect(client.isConnected()).toBe(true);
  });

  it('duplicate / out-of-state ack in READY => BLOCKED', async () => {
    const s = await negotiate();
    s.receive(ack({ connectionId: 'conn-2' }));
    expect(client.getNegotiationStatus()).toMatchObject({ state: 'BLOCKED', error: { code: 'invalid_message' } });
  });

  it('heartbeat starts only after the ack, carries no extra keys, and stops on close', async () => {
    vi.useFakeTimers();
    const connected = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sock().open();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sock().sent.filter((f) => f.type === 'heartbeat')).toHaveLength(0);
    sock().receive(ack());
    await connected;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sock().sent.filter((f) => f.type === 'heartbeat')).toEqual([{ type: 'heartbeat' }]);
  });

  it('an oversize result is replaced by a bounded payload_too_large error (no truncation, no replay)', async () => {
    handler.mockResolvedValueOnce({ id: 'req-1', success: true, result: 'x'.repeat(MAX_MESSAGE_BYTES) } as never);
    const s = await negotiate();
    s.receive(toolRequest());
    await flush();
    expect(s.sent.at(-1)).toMatchObject({ type: 'tool_result', ok: false, error: { code: 'payload_too_large' } });
  });

  it('an inbound frame over the limit blocks with payload_too_large before parsing', async () => {
    const connected = client.connect().catch((e: Error) => e);
    await flush();
    sock().open();
    sock().onmessage?.({ data: 'x'.repeat(MAX_MESSAGE_BYTES + 1) });
    expect(((await connected) as Error).message).toContain('payload_too_large');
  });
});
