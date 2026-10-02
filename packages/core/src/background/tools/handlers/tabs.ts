/**
 * Tab management tool handlers: new_tab, list_tabs, switch_tab, send_to_back, close_tab.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createTabHandlers(ctx: HandlerContext): HandlerMap {
  return {
    browser_new_tab: async (payload) => {
      const { url, switchTo } = schemas.browser_new_tab.parse(payload);
      const tabInfo = await ctx.tabManager.createTab(url, true, switchTo);
      return { tab: tabInfo };
    },

    // closeById tells the server this build closes the tab it is asked for (see browser_close_tab):
    // its tab reaper closes nothing on a browser that does not say so.
    browser_list_tabs: async () => {
      return { tabs: await ctx.tabManager.listTabs(), closeById: true };
    },

    browser_switch_tab: async (payload) => {
      const { tabId } = schemas.browser_switch_tab.parse(payload);
      await ctx.tabManager.switchTab(tabId);
      return { switched: tabId };
    },

    browser_send_to_back: async (payload) => {
      const { tabId } = schemas.browser_send_to_back.parse(payload);
      const activatedTabId = await ctx.tabManager.sendTabToBack(tabId);
      return { sentToBack: tabId ?? ctx.tabManager.getConnectedTabId(), activatedTabId };
    },

    // The server closes an idle agent tab by id (its tab reaper), so the id must be honoured:
    // ignoring it closed the connected tab instead. The answer echoes the id actually closed.
    browser_close_tab: async (payload) => {
      const { tabId } = schemas.browser_close_tab.parse(payload ?? {});
      const closed = await ctx.tabManager.closeTab(tabId);
      return { closed: true, tabId: closed };
    },
  };
}
