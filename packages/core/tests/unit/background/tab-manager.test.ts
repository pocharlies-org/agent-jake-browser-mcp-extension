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
    onRemoved: {
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

import { TabManager } from '@/background/tab-manager';
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

  it('waitForTabLoad resolves, times out with cleanup, and rejects when the tab closes', async () => {
    // Review 5394880058 P1: the old wait never resolved if the load event was missed,
    // and left its onUpdated listener retained forever on every non-complete exit.
    vi.useFakeTimers();
    try {
      const manager = new TabManager();
      mockChrome.tabs.onUpdated.addListener.mockClear();
      mockChrome.tabs.onUpdated.removeListener.mockClear();
      mockChrome.tabs.onRemoved.addListener.mockClear();
      mockChrome.tabs.onRemoved.removeListener.mockClear();

      // 1) timeout path: no completion, no close -> bounded rejection, all listeners gone.
      mockChrome.tabs.get.mockResolvedValue({ id: 55, status: 'loading' });
      const hanging = manager.waitForTabLoad(55, 1000);
      const assertion = expect(hanging).rejects.toThrow('Timed out after 1000ms waiting for tab 55 to load');
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(mockChrome.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
      expect(mockChrome.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);

      // 2) close path: tab removed while waiting -> rejection with both listeners cleaned.
      mockChrome.tabs.onUpdated.addListener.mockClear();
      mockChrome.tabs.onUpdated.removeListener.mockClear();
      mockChrome.tabs.onRemoved.addListener.mockClear();
      mockChrome.tabs.onRemoved.removeListener.mockClear();
      mockChrome.tabs.get.mockResolvedValue({ id: 55, status: 'loading' });
      const closing = manager.waitForTabLoad(55, 1000);
      const closeAssertion = expect(closing).rejects.toThrow('Tab 55 was closed while waiting for it to load');
      const removedListener = mockChrome.tabs.onRemoved.addListener.mock.calls[0][0];
      removedListener(55);
      await closeAssertion;
      expect(mockChrome.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
      expect(mockChrome.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);

      // 3) success path: completion event resolves and cleans up.
      mockChrome.tabs.get.mockResolvedValue({ id: 55, status: 'loading' });
      mockChrome.tabs.onUpdated.addListener.mockClear();
      mockChrome.tabs.onUpdated.removeListener.mockClear();
      mockChrome.tabs.onRemoved.addListener.mockClear();
      mockChrome.tabs.onRemoved.removeListener.mockClear();
      const ok = manager.waitForTabLoad(55, 1000);
      const updatedListener = mockChrome.tabs.onUpdated.addListener.mock.calls[0][0];
      updatedListener(55, { status: 'complete' });
      await expect(ok).resolves.toBeUndefined();
      expect(mockChrome.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
      expect(mockChrome.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForTabLoad resolves a tab that already completed, without waiting for a new event', async () => {
    // Review 5395548320 P1: create/adopt must NOT kill a healthy tab whose load finished
    // before we subscribed. The state-aware wait resolves from the current 'complete' status.
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 55, status: 'complete' });

    await expect(manager.waitForTabLoad(55, 1000)).resolves.toBeUndefined();
    expect(mockChrome.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
    expect(mockChrome.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
  });

  it('waitForNextTabLoad ignores a previous complete, resolves on the next one, and cancels on trigger failure', async () => {
    // Review 5395548320 P1: navigation waits must not resolve from a PREVIOUS load's state,
    // and a failed trigger must not leave the armed wait hanging.
    vi.useFakeTimers();
    try {
      const manager = new TabManager();
      mockChrome.tabs.get.mockResolvedValue({ id: 55, status: 'complete' }); // already loaded

      // 1) armed wait does not resolve from the previous complete...
      const trigger = vi.fn(async () => { mockChrome.tabs.get.mockResolvedValue({ id: 55, status: 'loading' }); });
      const next = manager.waitForNextTabLoad(55, trigger, 1000);
      await Promise.resolve(); // let the trigger settle
      let settled = false;
      void next.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      // ...but the completion that follows the trigger does.
      const updatedListener = mockChrome.tabs.onUpdated.addListener.mock.calls.at(-1)![0];
      updatedListener(55, { status: 'complete' });
      await expect(next).resolves.toBeUndefined();

      // 2) trigger rejects -> the armed wait is cancelled with the trigger error, listeners gone.
      mockChrome.tabs.onUpdated.removeListener.mockClear();
      mockChrome.tabs.onRemoved.removeListener.mockClear();
      const failing = manager.waitForNextTabLoad(55, () => Promise.reject(new Error('nav blocked')), 1000);
      await expect(failing).rejects.toThrow('nav blocked');
      expect(mockChrome.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
      expect(mockChrome.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('createTab removes its own tab and reports the original error when the load wait fails', async () => {
    vi.useFakeTimers();
    try {
      const manager = new TabManager();
      mockChrome.tabs.create.mockResolvedValue({ id: 60, url: 'https://slow.example', active: false });
      mockChrome.tabs.get.mockImplementation(() => new Promise(() => {})); // never completes
      mockChrome.tabs.remove.mockClear().mockResolvedValue(undefined);

      const created = manager.createTab('https://slow.example', true, false);
      const assertion = expect(created).rejects.toThrow('Timed out');
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;

      // Cleanup: our own tab is removed and no session is left pointing at it.
      expect(mockChrome.tabs.remove).toHaveBeenCalledWith(60);
      expect(manager.getConnectedTabId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
