import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/background/activity-log', () => ({ logTool: vi.fn(), logError: vi.fn() }));

import { routeToTargetTab } from '@/background/tool-handlers';

function fakeTabs(driven: number[], existing: number[]) {
  const state = { driven: new Set(driven) };
  return {
    state,
    hasTab: vi.fn(async (tabId: number) => existing.includes(tabId)),
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

  it('answers TAB_GONE without touching another session tab when the session tab was closed', async () => {
    // connectTab lets go of the current tab first, so calling it for a gone tab would drop the
    // tab (and debugger) another session was using.
    const tabs = fakeTabs([10], [10]);
    await expect(routeToTargetTab(tabs, { targetTabId: 99 })).rejects.toMatchObject({ name: 'TAB_GONE' });
    expect(tabs.connectTab).not.toHaveBeenCalled();
    expect([...tabs.state.driven]).toEqual([10]);
  });

  it('passes other connection errors through unchanged', async () => {
    const tabs = fakeTabs([10], [10, 20]);
    tabs.connectTab.mockRejectedValueOnce(new Error('CDP_DEBUGGER_BUSY: Another debugger'));
    await expect(routeToTargetTab(tabs, { targetTabId: 20 })).rejects.toThrow('CDP_DEBUGGER_BUSY');
  });
});
