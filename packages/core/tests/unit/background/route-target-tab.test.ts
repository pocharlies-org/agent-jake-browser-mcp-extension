import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/background/activity-log', () => ({ logTool: vi.fn(), logTab: vi.fn(), logError: vi.fn() }));

import { routeToTargetTab } from '@/background/tool-handlers';
import { TabManager } from '@/background/tab-manager';

// Minimal chrome for the real TabManager used by the cross-session integration case below.
// The unit cases pass their own fake manager, so nothing here runs unless TabManager is driven.
const chromeMock = {
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
    remove: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  debugger: {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    getTargets: vi.fn().mockResolvedValue([]),
    onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  windows: { getAll: vi.fn().mockResolvedValue([{ id: 1, focused: true }]), create: vi.fn() },
};
(globalThis as { chrome?: unknown }).chrome = chromeMock;

function fakeTabs(driven: number[], existing: number[], connected: number | null = null) {
  const state = { driven: new Set(driven) };
  return {
    state,
    hasTab: vi.fn(async (tabId: number) => existing.includes(tabId)),
    getConnectedTabId: vi.fn(() => connected),
    // The real connectTab takes the debugger for the tab it is given and leaves the others alone.
    connectTab: vi.fn(async (tabId: number) => {
      if (!existing.includes(tabId)) throw new Error(`Tab ${tabId} does not exist`);
      state.driven.add(tabId);
    }),
  };
}

describe('routeToTargetTab', () => {
  // Regression: two MCP sessions on one browser shared the single connected tab, so the
  // second session's commands landed in the first session's tab.
  it('connects to the session tab before the command, names it and keeps it out of the payload', async () => {
    const tabs = fakeTabs([10], [10, 20]);
    const routed = await routeToTargetTab(tabs, { targetTabId: 20, selector: '#x' });
    expect(tabs.connectTab).toHaveBeenCalledWith(20);
    expect(routed.tabId).toBe(20);
    expect(routed.payload).toEqual({ selector: '#x' });
    // The other session is untouched: its tab stays driven alongside this one.
    expect([...tabs.state.driven].sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('leaves commands without a target alone', async () => {
    const tabs = fakeTabs([10], [10]);
    expect(await routeToTargetTab(tabs, { url: 'https://a.test' })).toEqual({ tabId: null, payload: { url: 'https://a.test' } });
    expect(await routeToTargetTab(tabs, undefined)).toEqual({ tabId: null, payload: undefined });
    expect(tabs.connectTab).not.toHaveBeenCalled();
  });

  it('rejects a targetTabId that is not a positive integer with INVALID_TARGET_TAB_ID', async () => {
    // A 0 or negative id used to fall through to TAB_GONE — safe, but it told the session its tab
    // was closed when the command itself was malformed. A malformed id must never reach the tab
    // lookup nor the debugger of any session.
    for (const bad of [0, -7, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '20', null, {}]) {
      const tabs = fakeTabs([10], [10, 20]);
      await expect(routeToTargetTab(tabs, { targetTabId: bad, url: 'https://x.test' })).rejects.toMatchObject({
        name: 'INVALID_TARGET_TAB_ID',
      });
      expect(tabs.hasTab).not.toHaveBeenCalled();
      expect(tabs.connectTab).not.toHaveBeenCalled();
      expect([...tabs.state.driven]).toEqual([10]);
    }
  });

  it('answers TAB_GONE without touching another session tab when the session tab was closed', async () => {
    // connectTab lets go of the current tab first, so calling it for a gone tab would drop the
    // tab (and debugger) another session was using.
    const tabs = fakeTabs([10], [10]);
    await expect(routeToTargetTab(tabs, { targetTabId: 99 })).rejects.toMatchObject({ name: 'TAB_GONE' });
    expect(tabs.connectTab).not.toHaveBeenCalled();
    expect([...tabs.state.driven]).toEqual([10]);
  });

  it('skips connectTab when the session tab is already the connected one, dropping nobody', async () => {
    // Reconnecting a tab the manager is already on would re-attach its debugger and reset the
    // page-event history of a session that is not moving (fork 837dd77).
    const tabs = fakeTabs([10, 20], [10, 20], 20);
    const routed = await routeToTargetTab(tabs, { targetTabId: 20, selector: '#x' });
    expect(tabs.connectTab).not.toHaveBeenCalled();
    expect(routed.tabId).toBe(20);
    expect(routed.payload).toEqual({ selector: '#x' });
    expect([...tabs.state.driven].sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('passes other connection errors through unchanged', async () => {
    const tabs = fakeTabs([10], [10, 20]);
    tabs.connectTab.mockRejectedValueOnce(new Error('CDP_DEBUGGER_BUSY: Another debugger'));
    await expect(routeToTargetTab(tabs, { targetTabId: 20 })).rejects.toThrow('CDP_DEBUGGER_BUSY');
  });
});

describe('routeToTargetTab — cross-session routing (fork tests/session-windows.spec.ts)', () => {
  it('survives the cleanup of another session, and a TAB_GONE does not move the other session tab', async () => {
    const live = new Map<number, string>([
      [20, 'https://b.test/survivor-b'], // session B: its tab, driven
      [30, 'https://a.test/cleanup-a'], // session A: about to be cleaned up
    ]);
    chromeMock.tabs.get.mockImplementation(async (tabId: number) => {
      const url = live.get(tabId);
      if (url === undefined) throw new Error(`No tab: ${tabId}`);
      return { id: tabId, url };
    });
    chromeMock.tabs.update.mockImplementation(async (tabId: number, changes: { url?: string }) => {
      if (changes.url !== undefined) live.set(tabId, changes.url);
    });

    const manager = new TabManager();
    await manager.connectTab(20);
    expect(manager.getConnectedTabId()).toBe(20);

    // Session A's cleanup closes its tab and leaves the singleton manager disconnected while B
    // still owns its tab (the state the fork's Playwright scenario ends up in).
    live.delete(30);
    await manager.disconnectTab();
    expect(manager.getConnectedTabId()).toBeNull();

    // Routing to B survives the cleanup: it reconnects and names the tab.
    const routed = await routeToTargetTab(manager, { targetTabId: 20, url: 'https://b.test/survivor-b-routed' });
    expect(routed).toEqual({ tabId: 20, payload: { url: 'https://b.test/survivor-b-routed' } });
    expect(manager.getConnectedTabId()).toBe(20);

    // TAB_GONE for A's dead tab must not move B's tab: no connect (which would let go of B), no
    // detach, no navigation.
    const detachCalls = chromeMock.debugger.detach.mock.calls.length;
    await expect(
      routeToTargetTab(manager, { targetTabId: 30, url: 'https://a.test/must-not-navigate' }),
    ).rejects.toMatchObject({ name: 'TAB_GONE' });
    expect(chromeMock.debugger.detach).toHaveBeenCalledTimes(detachCalls);
    expect(manager.getConnectedTabId()).toBe(20);
    expect(live.get(20)).toBe('https://b.test/survivor-b');
  });
});
