import { describe, expect, it, vi } from 'vitest';
import { createTabHandlers } from '@/background/tools/handlers/tabs';
import type { HandlerContext } from '@/background/tools/handlers/types';

/** A tab manager whose closeTab behaves like the real one: the given id, else the connected tab. */
function contextWith(connectedTabId: number) {
  const closeTab = vi.fn(async (tabId?: number) => tabId ?? connectedTabId);
  const listTabs = vi.fn(async () => [{ id: connectedTabId, url: 'https://a.example/', title: 'a', active: true, connected: true }]);
  const ctx = { tabManager: { closeTab, listTabs } } as unknown as HandlerContext;
  return { handlers: createTabHandlers(ctx), closeTab };
}

describe('browser_close_tab', () => {
  it('closes the tab it is given, not the connected one', async () => {
    const { handlers, closeTab } = contextWith(7);

    const answer = await handlers.browser_close_tab({ tabId: 42 });

    expect(closeTab).toHaveBeenCalledWith(42);
    expect(answer).toEqual({ closed: true, tabId: 42 });
  });

  it('closes the connected tab when no id is given, and says which', async () => {
    const { handlers, closeTab } = contextWith(7);

    const answer = await handlers.browser_close_tab({});

    expect(closeTab).toHaveBeenCalledWith(undefined);
    expect(answer).toEqual({ closed: true, tabId: 7 });
  });

  it('rejects an id that is not a number', async () => {
    const { handlers, closeTab } = contextWith(7);

    await expect(handlers.browser_close_tab({ tabId: 'all' })).rejects.toThrow();
    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe('browser_list_tabs', () => {
  it('announces that this build closes tabs by id', async () => {
    const { handlers } = contextWith(7);

    const answer = (await handlers.browser_list_tabs({})) as { tabs: Array<{ id: number }>; closeById: boolean };

    expect(answer.closeById).toBe(true);
    expect(answer.tabs.map((t) => t.id)).toEqual([7]);
  });
});
