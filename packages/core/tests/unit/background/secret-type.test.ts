/**
 * browser_type with `secret: true` (browser_fill_secret on the server): the text is typed, but the secret never comes back
 * in the answer and never reaches the console (C7c: «secretos nunca en logs, query ni transcript»).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionHandlers } from '@/background/tools/handlers/interaction';
import type { HandlerContext } from '@/background/tools/handlers/types';

const SECRET = 'Zq9-SECRET-4d2b';

/**
 * The interaction handlers with just enough of a browser around them to type into one field:
 * a simulated field value answers the length probes, and the `char` key events land in it
 * (or, with `land: false`, they do not — the hidden-tab case browser_type must catch).
 */
function typingContext(opts: { initial?: string; land?: boolean } = {}) {
  const sim = { value: opts.initial ?? '' };
  const land = opts.land !== false;
  return {
    sim,
    tabManager: { getConnectedTabId: () => 5, sendDebuggerCommand: vi.fn(async () => ({})) },
    resolveRef: vi.fn(async () => ({ frameId: 0, selector: '#pw' })),
    sendToContent: vi.fn(async (action: string, payload?: { text?: string; kept?: number }) => {
      if (action === 'getElementCoordinates') return { x: 10, y: 10, exact: true };
      if (action === 'fieldLength') return { length: [...sim.value].length };
      if (action === 'getFieldLength') return { exists: true, length: sim.value.length };
      if (action === 'clearField') { sim.value = ''; return { length: 0 }; }
      if (action === 'setFieldText') {
        sim.value = [...sim.value].slice(0, payload?.kept ?? 0).join('') + (payload?.text ?? '');
        return { applied: true, length: sim.value.length };
      }
      return {};
    }),
    sendToAllFrames: vi.fn(async () => []),
    waitForStableOrNavigation: vi.fn(async () => ({ navigated: false })),
    dispatchKeyEventTyped: vi.fn(async (type: string, _key: string, text?: string) => {
      if (land && type === 'char' && text) sim.value += text;
    }),
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

  it('types the secret and answers typed+verified, with no trace of it in the answer', async () => {
    const ctx = typingContext();
    const handlers = createInteractionHandlers(ctx as unknown as HandlerContext);

    const answer = await handlers.browser_type({ ref: 's1e5', text: SECRET, clear: true, secret: true });

    expect(typedChars(ctx)).toBe(SECRET);
    expect(answer).toEqual({ typed: true, cleared: true, navigated: false, verified: true, length: SECRET.length });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it('keeps the same secret out of the answer when the page navigates after typing', async () => {
    const ctx = typingContext();
    ctx.waitForStableOrNavigation.mockResolvedValueOnce({ navigated: true, newUrl: 'https://example.test/home' } as never);
    const handlers = createInteractionHandlers(ctx as unknown as HandlerContext);

    const answer = await handlers.browser_type({ ref: 's1e5', text: SECRET, secret: true });

    expect(answer).toEqual({ typed: true, cleared: false, navigated: true, verified: false });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it('repairs from inside the page when the keys did not land, and says so', async () => {
    const ctx = typingContext({ land: false });
    const handlers = createInteractionHandlers(ctx as unknown as HandlerContext);

    const answer = await handlers.browser_type({ ref: 's1e5', text: SECRET, secret: true });

    expect(answer).toEqual({
      typed: true, cleared: false, navigated: false, verified: true, length: SECRET.length, fallback: 'native-setter',
    });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it('fills by CSS selector (no ref): the field is the one asked for', async () => {
    const ctx = typingContext();
    const handlers = createInteractionHandlers(ctx as unknown as HandlerContext);

    const answer = await handlers.browser_type({ selector: '#password', text: SECRET, clear: true, secret: true });

    expect(ctx.resolveRef).not.toHaveBeenCalled();
    expect(ctx.sim.value).toBe(SECRET);
    expect(answer).toMatchObject({ typed: true, verified: true });
  });

  it('a plain type still says what it typed', async () => {
    const handlers = createInteractionHandlers(typingContext() as unknown as HandlerContext);

    expect(await handlers.browser_type({ ref: 's1e5', text: 'hello' })).toEqual({ typed: 'hello', cleared: false });
  });

  it('a mismatched plain type surfaces the length warning', async () => {
    const ctx = typingContext({ land: false });
    ctx.sendToContent = vi.fn(async (action: string) => {
      if (action === 'getElementCoordinates') return { x: 10, y: 10, exact: true };
      if (action === 'fieldLength') return { length: 0 };
      if (action === 'setFieldText') return { applied: false, length: 0 };
      return {};
    }) as never;
    const handlers = createInteractionHandlers(ctx as unknown as HandlerContext);

    const answer = await handlers.browser_type({ ref: 's1e5', text: 'hello' }) as { warning?: string };

    expect(answer.warning).toContain('the field holds 0 characters after typing 5');
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
