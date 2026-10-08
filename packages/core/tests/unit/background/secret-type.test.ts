/**
 * browser_type with `secret: true` (browser_fill_secret on the server): the text is typed, but the secret never comes back
 * in the answer and never reaches the console (C7c: «secretos nunca en logs, query ni transcript»).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionHandlers } from '@/background/tools/handlers/interaction';
import type { HandlerContext } from '@/background/tools/handlers/types';

const SECRET = 'Zq9-SECRET-4d2b';

/** The interaction handlers with just enough of the browser around them to type into one field. */
function typingContext() {
  return {
    tabManager: { getConnectedTabId: () => 5, sendDebuggerCommand: vi.fn(async () => ({})) },
    resolveRef: vi.fn(async () => ({ frameId: 0, selector: '#pw' })),
    sendToContent: vi.fn(async (action: string) => (action === 'getElementCoordinates' ? { x: 10, y: 10, exact: true } : {})),
    sendToAllFrames: vi.fn(async () => []),
    waitForStableOrNavigation: vi.fn(async () => ({ navigated: false })),
    dispatchKeyEventTyped: vi.fn(async () => undefined),
    dispatchMouseEventTyped: vi.fn(async () => undefined),
  };
}

/** Every character sent as a `char` event, in order: what actually reached the field. */
const typedChars = (ctx: ReturnType<typeof typingContext>) =>
  ctx.dispatchKeyEventTyped.mock.calls.filter(([type]) => type === 'char').map(([, key]) => key).join('');

describe('browser_type with a secret', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { tabs: { get: vi.fn(async () => ({ url: 'https://example.test/login' })) } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('types the secret, and the answer carries no trace of it', async () => {
    const ctx = typingContext();
    const handlers = createInteractionHandlers(ctx as unknown as HandlerContext);

    const answer = await handlers.browser_type({ ref: 's1e5', text: SECRET, clear: true, secret: true });

    expect(typedChars(ctx)).toBe(SECRET);
    expect(answer).toEqual({ cleared: true });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it('keeps the same secret out of the answer when the page navigates after typing', async () => {
    const ctx = typingContext();
    ctx.waitForStableOrNavigation.mockResolvedValueOnce({ navigated: true, newUrl: 'https://example.test/home' } as never);
    const handlers = createInteractionHandlers(ctx as unknown as HandlerContext);

    const answer = await handlers.browser_type({ ref: 's1e5', text: SECRET, secret: true });

    expect(answer).toEqual({ cleared: false, navigated: true, newUrl: 'https://example.test/home' });
  });

  it('a plain type still says what it typed', async () => {
    const handlers = createInteractionHandlers(typingContext() as unknown as HandlerContext);

    expect(await handlers.browser_type({ ref: 's1e5', text: 'hello' })).toEqual({ typed: 'hello', cleared: false });
  });
});

describe('the outgoing log of the legacy wire', () => {
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    static latest: FakeSocket;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: () => void;
    readonly send = vi.fn();
    constructor(public url: string) {
      FakeSocket.latest = this;
    }
    open() {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }
    close() {
      this.readyState = FakeSocket.CLOSED;
    }
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/config/runtime', () => ({
      getEffectiveConfig: vi.fn(async () => ({})),
      buildWsUrl: vi.fn(() => 'ws://127.0.0.1:8765/?connectionId=log-test'),
    }));
    vi.doMock('../../../src/background/activity-log', () => ({ logConnection: vi.fn(), logError: vi.fn() }));
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a result with a typed secret is sent, and nothing about it reaches the console', async () => {
    const consoleSpies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { WebSocketClient } = await import('../../../src/background/ws-client');
    const client = new WebSocketClient();
    const connecting = client.connect();
    await vi.waitFor(() => expect(FakeSocket.latest).toBeDefined());
    FakeSocket.latest.open();
    await connecting;

    const sentBefore = FakeSocket.latest.send.mock.calls.length;
    client.send({ id: 'req-1', success: true, result: { typed: SECRET, cleared: true } } as never);

    expect(FakeSocket.latest.send.mock.calls.length).toBe(sentBefore + 1);
    const logged = consoleSpies.flatMap((spy) => spy.mock.calls).flat().map(String).join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain('req-1'); // the envelope is still logged
  });
});
