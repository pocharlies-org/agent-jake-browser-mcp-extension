import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockChrome = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: {
    get: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    remove: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onCreated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  debugger: {
    getTargets: vi.fn(),
    attach: vi.fn(),
    sendCommand: vi.fn(),
    detach: vi.fn(),
    onEvent: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onDetach: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([]),
  },
};

(globalThis as { chrome?: unknown }).chrome = mockChrome as unknown;

vi.mock('@/utils/logger', () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/background/activity-log', () => ({
  logTab: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
}));

import { TabManager, WEBAUTHN_PIN_SCRIPT } from '@/background/tab-manager';
import { runInNewContext } from 'node:vm';
import { pageEvents } from '@/background/page-events';

describe('TabManager CDP readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels a file chooser event wait without a late timeout rejection', async () => {
    const manager = new TabManager();
    (manager as unknown as { connectedTabId: number }).connectedTabId = 101;
    const controller = new AbortController();
    const wait = manager.waitForDebuggerEvent('Page.fileChooserOpened', 10000, controller.signal);
    controller.abort();
    await expect(wait).rejects.toThrow('Stopped waiting for Page.fileChooserOpened');
  });

  it('rejects a second file chooser until the first releases its lock', () => {
    const manager = new TabManager();
    manager.beginFileChooser();
    expect(() => manager.beginFileChooser()).toThrow('already in progress');
    manager.endFileChooser();
    expect(() => manager.beginFileChooser()).not.toThrow();
    manager.endFileChooser();
  });

  it('clears captured network and console data on disconnect and debugger detach', async () => {
    const manager = new TabManager();
    pageEvents.handle('Network.requestWillBeSent', { requestId: 'secret', request: { url: 'https://x.test', postData: 'secret' } });
    pageEvents.handle('Runtime.consoleAPICalled', { args: [{ value: 'secret' }] });
    await manager.disconnectTab();
    expect(pageEvents.networkRequests()).toHaveLength(0);
    expect(pageEvents.consoleMessages()).toHaveLength(0);

    pageEvents.handle('Network.requestWillBeSent', { requestId: 'secret2', request: { url: 'https://x.test' } });
    manager.markDebuggerDetached();
    expect(pageEvents.networkRequests()).toHaveLength(0);
  });

  it('ignores a late network event while disconnect is waiting on the close guard', async () => {
    const manager = new TabManager();
    (manager as unknown as { connectedTabId: number }).connectedTabId = 101;
    (manager as unknown as { captureEvents: boolean }).captureEvents = true;
    let releaseGuard!: () => void;
    vi.spyOn(manager as never, 'setLiveConnectionCloseGuard' as never).mockImplementation(
      () => new Promise<void>((resolve) => { releaseGuard = resolve; }) as never,
    );

    const disconnect = manager.disconnectTab();
    await expect(manager.waitForDebuggerEvent('Page.fileChooserOpened')).rejects.toThrow('No connected tab');
    await (manager as unknown as { handleDebuggerEvent: (source: { tabId: number }, method: string, params: object) => Promise<void> })
      .handleDebuggerEvent({ tabId: 101 }, 'Network.requestWillBeSent', {
        requestId: 'late', request: { url: 'https://x.test', headers: { Cookie: 'late-secret' } },
      });
    expect(pageEvents.networkRequests()).toHaveLength(0);
    releaseGuard();
    await disconnect;
    expect(pageEvents.networkRequests()).toHaveLength(0);
  });

  it('rejects old chooser waits and never sends their files to a new tab', async () => {
    const manager = new TabManager();
    (manager as unknown as { connectedTabId: number }).connectedTabId = 101;
    const oldWait = manager.waitForDebuggerEvent('Page.fileChooserOpened');
    const rejected = expect(oldWait).rejects.toThrow('tab changed or detached');

    await manager.disconnectTab();
    await rejected;
    (manager as unknown as { connectedTabId: number }).connectedTabId = 102;
    await (manager as unknown as { handleDebuggerEvent: (source: { tabId: number }, method: string, params: object) => Promise<void> })
      .handleDebuggerEvent({ tabId: 102 }, 'Page.fileChooserOpened', { backendNodeId: 77 });
    await expect(manager.setChooserFiles(101, 77, ['/tmp/old-file'])).rejects.toThrow('Tab changed');
    expect(mockChrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 102 }, 'DOM.setFileInputFiles', expect.anything(),
    );
    await manager.setFileChooserInterception(101, false);
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 101 }, 'Page.setInterceptFileChooserDialog', { enabled: false },
    );
  });

  it('reports not ready when no tab is connected', async () => {
    const manager = new TabManager();
    const status = await manager.getCdpStatus();

    expect(status.connectedTabId).toBeNull();
    expect(status.debuggerAttached).toBe(false);
    expect(status.canExecuteCdp).toBe(false);
    expect(status.lastCdpError).toContain('No tab connected');
  });

  it('throws CDP_DEBUGGER_BUSY when another debugger owns the tab', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets.mockResolvedValue([]);
    mockChrome.debugger.attach.mockRejectedValue(
      new Error('Another debugger is already attached to the tab')
    );
    // The client holding it is not us: Chrome refuses our commands.
    mockChrome.debugger.sendCommand.mockRejectedValue(
      new Error('Debugger is not attached to the tab with id: 101')
    );

    await expect(manager.connectTab(101, 'https://example.com')).rejects.toThrow('CDP_DEBUGGER_BUSY');
  });

  it('attaches even when getTargets says the tab is already attached (another CDP client)', async () => {
    // Regression: with a Playwright client connected over CDP, `getTargets()[].attached` is
    // true while we are not attached at all. Trusting that flag skipped our own attach and
    // every command afterwards died with "Debugger is not attached".
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets.mockResolvedValue([{ tabId: 101, attached: true }]);
    let attached = false;
    mockChrome.debugger.attach.mockImplementation(async () => {
      attached = true;
    });
    mockChrome.debugger.sendCommand.mockImplementation(async () => {
      if (!attached) throw new Error('Debugger is not attached to the tab with id: 101');
      return {};
    });

    await manager.connectTab(101, 'https://example.com');

    expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 101 }, expect.any(String));
  });

  it('installs the WebAuthn guard sequence so the native security-key dialog is not raised', async () => {
    // Regression: GitHub's 2FA page asked for a security key through Chrome's native dialog,
    // which the agent cannot answer and which hid the authenticator-app (1Password TOTP) path.
    // This asserts the CDP command sequence only; browser-level outcomes (NotAllowedError timing,
    // discoverable/conditional get, create with UV) need the Chrome QA harness, not this mock.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : {});

    await manager.connectTab(101, 'https://example.com');

    const webauthn = mockChrome.debugger.sendCommand.mock.calls.filter(([, method]) => String(method).startsWith('WebAuthn.'));
    expect(webauthn.map(([, method]) => method)).toEqual([
      'WebAuthn.disable',
      'WebAuthn.enable',
      'WebAuthn.addVirtualAuthenticator',
      'WebAuthn.setResponseOverrideBits',
    ]);
    expect(webauthn[1][2]).toEqual({ enableUI: false });
    expect(webauthn[2][2]).toEqual({
      options: expect.objectContaining({ hasUserVerification: true, isUserVerified: false, automaticPresenceSimulation: true }),
    });
    expect(webauthn[3][2]).toEqual({ authenticatorId: 'va-1', isBadUP: true });
  });

  it('pins navigator.credentials to Chrome in every document, once per session', async () => {
    // Regression: 1Password replaces navigator.credentials in the page and keeps discoverable
    // passkey requests (no allowCredentials) waiting on its unlock UI forever.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    let n = 0;
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'va-1' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `s${++n}` };
      return {};
    });

    await manager.connectTab(101, 'https://example.com');
    await manager.reattachDebugger();

    const scripts = mockChrome.debugger.sendCommand.mock.calls
      .filter(([, method]) => String(method).includes('ScriptToEvaluateOnNewDocument'))
      .map(([, method, params]) => [method, params]);
    expect(scripts).toEqual([
      ['Page.addScriptToEvaluateOnNewDocument', { source: WEBAUTHN_PIN_SCRIPT, runImmediately: true }],
      ['Page.removeScriptToEvaluateOnNewDocument', { identifier: 's1' }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: WEBAUTHN_PIN_SCRIPT, runImmediately: true }],
    ]);
  });

  it('the pin script hands get/create back to the native implementation and keeps them there', () => {
    class CredentialsContainer {
      get() { return 'native-get'; }
      create() { return 'native-create'; }
    }
    const credentials = new CredentialsContainer() as CredentialsContainer & Record<string, unknown>;
    // What a password manager does in the page before (or after) we run.
    credentials.get = () => 'hijacked';
    const window = { CredentialsContainer, navigator: { credentials } } as Record<string, unknown>;
    window.window = window;

    runInNewContext(WEBAUTHN_PIN_SCRIPT, window);
    credentials.create = () => 'hijacked';
    runInNewContext(WEBAUTHN_PIN_SCRIPT, window); // second run in the same document: no-op

    expect(credentials.get()).toBe('native-get');
    expect(credentials.create()).toBe('native-create');
  });

  it('rolls a partial WebAuthn guard install back to the pre-attach state', async () => {
    // Review blocker: if addVirtualAuthenticator or setResponseOverrideBits fails mid-install,
    // the tab must not stay half-guarded (enabled without authenticator, or authenticator
    // without the UP override). Each failing step must undo exactly what landed.
    for (const failing of ['WebAuthn.addVirtualAuthenticator', 'WebAuthn.setResponseOverrideBits']) {
      mockChrome.debugger.sendCommand.mockReset();
      mockChrome.debugger.sendCommand.mockImplementation(async (_d, method) => {
        if (method === failing) throw new Error(`simulated CDP failure in ${method}`);
        if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'va-1' };
        return {};
      });
      const manager = new TabManager();
      mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
      mockChrome.debugger.attach.mockResolvedValue(undefined);

      await manager.connectTab(101, 'https://example.com');

      const calls = mockChrome.debugger.sendCommand.mock.calls
        .map(([, method]) => String(method));
      expect(calls).toContain('WebAuthn.disable'); // reverted to untouched domain
      if (failing === 'WebAuthn.setResponseOverrideBits') {
        expect(calls).toContain('WebAuthn.removeVirtualAuthenticator');
      } else {
        expect(calls).not.toContain('WebAuthn.removeVirtualAuthenticator');
      }
      expect(manager.getConnectedTabId()).toBe(101); // not fatal: the tab still connects
    }
  });

  it('skips the WebAuthn guard when ajb.webauthnGuard is off, keeping native auth', async () => {
    mockChrome.storage.local.get.mockResolvedValueOnce({ 'ajb.webauthnGuard': 'off' });
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(101, 'https://example.com');

    const webauthn = mockChrome.debugger.sendCommand.mock.calls
      .filter(([, method]) => String(method).startsWith('WebAuthn.'));
    expect(webauthn).toEqual([]);
    expect(manager.getConnectedTabId()).toBe(101);
  });

  it('still connects when the WebAuthn domain is unavailable', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (String(method).startsWith('WebAuthn.')) throw new Error(`'${method}' wasn't found`);
      return {};
    });

    await expect(manager.connectTab(101, 'https://example.com')).resolves.toBeUndefined();
    expect(manager.getConnectedTabId()).toBe(101);
  });

  it('reattaches and retries once when command fails with detached debugger', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });

    // connectTab attach check -> detached
    // sendDebuggerCommand initial check -> attached
    // retry attach check -> detached
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);

    let firstEvaluate = true;
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'DOM.enable') {
        return {};
      }

      if (method === 'Runtime.evaluate') {
        if (firstEvaluate) {
          firstEvaluate = false;
          throw new Error('Debugger is not attached to the tab with id: 101.');
        }

        return { result: { type: 'number', value: 2 } };
      }

      return {};
    });

    await manager.connectTab(101, 'https://example.com');
    const result = await manager.sendDebuggerCommand('Runtime.evaluate', { expression: '1+1' });

    expect(result).toEqual({ result: { type: 'number', value: 2 } });
    expect(mockChrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 101 },
      'Runtime.evaluate',
      { expression: '1+1' }
    );
  });

  it('enables close confirmation on connect and disables it on disconnect', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(101, 'https://example.com');

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );

    await manager.disconnectTab();

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );
  });

  it('reapplies live connection UI for connected tab after reload', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(101, 'https://example.com');
    mockChrome.scripting.executeScript.mockClear();

    await manager.reapplyLiveConnectionUi();

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );
  });
});

describe('TabManager background-tab control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createTab opens in the background by default', async () => {
    const manager = new TabManager();
    mockChrome.tabs.create.mockResolvedValue({ id: 5, url: 'https://example.com', title: '', active: false });

    await manager.createTab('https://example.com', false);

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com',
      active: false,
    });
  });

  it('createTab attaches on a blank page before loading the URL it will drive', async () => {
    // A password manager's page script (1Password) runs at document start; the WebAuthn guard
    // only wins in documents created after we attach, so the URL must load after connectTab.
    const manager = new TabManager();
    const order: string[] = [];
    let onUpdated: ((tabId: number, info: { status?: string }) => void) | undefined;
    mockChrome.tabs.onUpdated.addListener.mockImplementation((fn) => { onUpdated = fn; });
    mockChrome.tabs.create.mockImplementation(async (props) => {
      order.push(`create ${props.url}`);
      return { id: 7, url: props.url, title: '', active: false, status: 'complete' };
    });
    mockChrome.tabs.get.mockResolvedValue({ id: 7, url: 'https://example.com/', title: 'Example', active: false, status: 'complete' });
    mockChrome.tabs.update.mockImplementation(async (_id, props) => {
      order.push(`navigate ${props.url}`);
      queueMicrotask(() => onUpdated?.(7, { status: 'complete' }));
      return {};
    });
    mockChrome.debugger.attach.mockImplementation(async () => { order.push('attach'); });
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') order.push('pin script');
      return method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'va-1' } : { identifier: 's1' };
    });

    const info = await manager.createTab('https://example.com/');

    expect(order).toEqual(['create about:blank', 'attach', 'pin script', 'navigate https://example.com/']);
    expect(info).toMatchObject({ id: 7, url: 'https://example.com/', title: 'Example', connected: true });
  });

  it('createTab activates the tab only when asked', async () => {
    const manager = new TabManager();
    mockChrome.tabs.create.mockResolvedValue({ id: 5, url: 'https://example.com', title: '', active: true });

    await manager.createTab('https://example.com', false, true);

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com',
      active: true,
    });
  });

  it('bringTabToFront activates the tab and returns the previous one', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 3 }]);

    const previous = await manager.bringTabToFront(5);

    expect(previous).toBe(3);
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(5, { active: true });
  });

  it('bringTabToFront is a no-op when the tab is already visible', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }]);

    const previous = await manager.bringTabToFront(5);

    expect(previous).toBeNull();
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });

  it('restoreTabBehind puts the user tab back when ours is still in front', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }]);

    await manager.restoreTabBehind(5, 3);

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('restoreTabBehind leaves the user alone if they switched tabs meanwhile', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1 });
    mockChrome.tabs.query.mockResolvedValue([{ id: 9 }]);

    await manager.restoreTabBehind(5, 3);

    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });

  it('restoreTabBehind survives the previous tab being closed', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockRejectedValue(new Error('No tab with id: 3'));

    await expect(manager.restoreTabBehind(5, 3)).resolves.toBeUndefined();
  });

  it('sendTabToBack activates a sibling tab of the same window', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: true });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }, { id: 6 }]);

    const activated = await manager.sendTabToBack(5);

    expect(activated).toBe(6);
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(6, { active: true });
  });

  it('sendTabToBack is a no-op for an already hidden tab', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: false });

    const activated = await manager.sendTabToBack(5);

    expect(activated).toBeNull();
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });

  it('sendTabToBack is a no-op when the tab is alone in its window', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: true });
    mockChrome.tabs.query.mockResolvedValue([{ id: 5 }]);

    const activated = await manager.sendTabToBack(5);

    expect(activated).toBeNull();
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
  });
});
