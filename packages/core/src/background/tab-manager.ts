/**
 * Manages connected tab state and tab operations.
 * Tracks which tab is currently being automated.
 */

import { log } from '@/utils/logger';
import { logTab, logError } from './activity-log';
import type { TabInfo } from '@/types/messages';
import { DEBUGGER, TIMEOUTS } from '@/constants';
import { pageEvents } from './page-events';

export interface CdpStatus {
  connectedTabId: number | null;
  debuggerAttached: boolean;
  canExecuteCdp: boolean;
  lastCdpError: string | null;
}

export class TabManager {
  private connectedTabId: number | null = null;
  private debuggerAttached = false;
  private captureEvents = false;
  private connectionGeneration = 0;
  private disconnecting = false;
  private lastCdpError: string | null = null;
  private pendingNewTab: TabInfo | null = null;
  private newTabListener: ((tab: chrome.tabs.Tab) => void) | null = null;
  private fileChooserInProgress = false;

  /**
   * Initialize tab manager, restoring state from storage.
   */
  async initialize(): Promise<void> {
    const stored = await chrome.storage.local.get(DEBUGGER.STORAGE_KEY);
    if (stored[DEBUGGER.STORAGE_KEY]) {
      const tabId = stored[DEBUGGER.STORAGE_KEY] as number;
      // Verify tab still exists
      if (await this.tabExists(tabId)) {
        this.connectedTabId = tabId;
        await this.setLiveConnectionCloseGuard(tabId, true);
        log.info(`Restored connected tab: ${tabId}`);
      } else {
        await chrome.storage.local.remove(DEBUGGER.STORAGE_KEY);
      }
    }
  }

  /**
   * Get the currently connected tab ID.
   */
  getConnectedTabId(): number | null {
    return this.connectedTabId;
  }

  /**
   * Return live CDP readiness for diagnostics and preflight checks.
   * Attempts a self-heal attach when possible.
   */
  async getCdpStatus(): Promise<CdpStatus> {
    const tabId = this.connectedTabId;
    if (!tabId) {
      return {
        connectedTabId: null,
        debuggerAttached: false,
        canExecuteCdp: false,
        lastCdpError: this.lastCdpError ?? 'CDP_NOT_READY: No tab connected',
      };
    }

    let attached = await this.isDebuggerAttached(tabId);
    if (!attached) {
      try {
        await this.attachDebugger(tabId);
        attached = await this.isDebuggerAttached(tabId);
      } catch (error) {
        this.recordCdpError(error);
      }
    }

    if (!attached) {
      return {
        connectedTabId: tabId,
        debuggerAttached: false,
        canExecuteCdp: false,
        lastCdpError: this.lastCdpError ?? `CDP_NOT_READY: Debugger is not attached to tab ${tabId}`,
      };
    }

    const probe = await this.probeCdp(tabId);

    return {
      connectedTabId: tabId,
      debuggerAttached: true,
      canExecuteCdp: probe.ok,
      lastCdpError: probe.error,
    };
  }

  /**
   * Connect to a specific tab for automation.
   * If tabUrl is chrome://newtab/, navigates to about:blank first.
   */
  async connectTab(tabId: number, tabUrl?: string): Promise<void> {
    // If tab is chrome://newtab/, navigate to about:blank first
    // (Chrome blocks extensions from accessing chrome:// URLs)
    if (tabUrl === 'chrome://newtab/') {
      await this.waitForNextTabLoad(tabId, () => chrome.tabs.update(tabId, { url: 'about:blank' }));
    }

    // Disconnect previous tab if any
    if (this.connectedTabId && this.connectedTabId !== tabId) {
      await this.disconnectTab();
    }

    // Verify tab exists
    if (!await this.tabExists(tabId)) {
      await logError('tab_connect', `Tab ${tabId} does not exist`, { tabId });
      throw new Error(`Tab ${tabId} does not exist`);
    }

    try {
      // Attach debugger
      if (this.connectedTabId !== tabId) pageEvents.reset(); // another tab: its history is not ours
      await this.attachDebugger(tabId);

      this.connectedTabId = tabId;
      this.captureEvents = true;
      await chrome.storage.local.set({ [DEBUGGER.STORAGE_KEY]: tabId });

      // Get tab info for logging
      const tab = await chrome.tabs.get(tabId);
      const title = tab.title || tab.url || `Tab ${tabId}`;
      await this.setLiveConnectionCloseGuard(tabId, true);

      log.info(`Connected to tab: ${tabId}`);
      await logTab('tab_connect', `Connected to: ${title}`, true, { tabId, url: tab.url });
    } catch (error) {
      await logError('tab_connect', `Failed to connect: ${(error as Error).message}`, { tabId });
      throw error;
    }
  }

  /**
   * Disconnect from the current tab.
   */
  async disconnectTab(): Promise<void> {
    this.captureEvents = false;
    this.cancelEventWaiters();
    pageEvents.reset();
    if (!this.connectedTabId) {
      return;
    }

    this.disconnecting = true;
    const tabId = this.connectedTabId;
    try {
      await this.setLiveConnectionCloseGuard(tabId, false);
    } finally {
      await this.detachDebugger();
      this.connectedTabId = null;
      this.cancelEventWaiters();
      pageEvents.reset();
      this.disconnecting = false;
      await chrome.storage.local.remove(DEBUGGER.STORAGE_KEY);
    }

    log.info(`Disconnected from tab: ${tabId}`);
    await logTab('tab_disconnect', `Disconnected from tab ${tabId}`, true, { tabId });
  }

  /**
   * Check if a tab exists.
   */
  private async tabExists(tabId: number): Promise<boolean> {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if debugger is actually attached to a tab.
   * Uses chrome.debugger.getTargets() for accurate state.
   */
  /**
   * Are *we* attached to that tab? `getTargets()[].attached` cannot answer: it is true for
   * any attached client — DevTools, another extension, a Playwright `connectOverCDP` — and
   * not only for us. The one thing that tells our client apart is Chrome accepting a
   * command from it; `Runtime.enable` is idempotent and is what we send next anyway.
   */
  private async isDebuggerAttached(tabId: number): Promise<boolean> {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attach debugger to tab for input simulation.
   *
   * We always try the attach, because Chrome allows several debugger clients on the same
   * tab and grants us one even when DevTools or a CDP client already holds it. Only when
   * Chrome answers "Another debugger" is there a question of whose it is, and a command —
   * not the target list — is what answers it.
   */
  private async attachDebugger(tabId: number): Promise<void> {
    this.captureEvents = false;
    this.cancelEventWaiters();
    pageEvents.reset();
    this.debuggerAttached = false;

    try {
      log.info(`Attaching debugger to tab ${tabId}...`);
      await chrome.debugger.attach({ tabId }, DEBUGGER.PROTOCOL_VERSION);
      this.debuggerAttached = true;
      this.lastCdpError = null;
      log.info(`Debugger attached to tab ${tabId}`);
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (message.includes('Another debugger') || message.includes('Already attached')) {
        // Either the client holding it is us (then commands work), or it is DevTools.
        if (await this.isDebuggerAttached(tabId)) {
          this.debuggerAttached = true;
          this.lastCdpError = null;
          log.debug(`Debugger was already ours on tab ${tabId}`);
        } else {
          const typedError = new Error(`CDP_DEBUGGER_BUSY: ${message}`);
          this.recordCdpError(typedError);
          log.warn('Debugger already attached by another client');
          throw typedError;
        }
      } else {
        log.error('Failed to attach debugger:', error);
        this.recordCdpError(error);
        throw error;
      }
    }

    // Always enable domains after attaching or detecting existing attachment
    // These calls are idempotent (safe to call multiple times)
    await this.enableDebuggerDomains(tabId);
    if (this.connectedTabId === tabId) this.captureEvents = true;
  }

  /**
   * Enable required debugger protocol domains.
   */
  private async enableDebuggerDomains(tabId: number): Promise<void> {
    for (const domain of ['Runtime', 'Page', 'DOM'] as const) {
      try {
        await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
        log.info(`${domain} domain enabled`);
      } catch (enableError) {
        this.recordCdpError(enableError);
        throw new Error(`CDP_NOT_READY: Failed to enable ${domain} domain: ${(enableError as Error).message}`);
      }
    }

    // Console and network capture (see page-events.ts). Not fatal: input keeps working
    // without them, only browser_network_requests / console come back empty.
    for (const domain of ['Network', 'Log'] as const) {
      try {
        await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
      } catch (enableError) {
        log.warn(`${domain} domain not enabled:`, enableError);
      }
    }

    await this.installDialogAutoAccept(tabId);
  }

  /** Only one upload may consume the next file chooser event. */
  beginFileChooser(): void {
    if (this.disconnecting) throw new Error('Tab is disconnecting');
    if (this.fileChooserInProgress) throw new Error('A file chooser upload is already in progress');
    this.fileChooserInProgress = true;
  }

  endFileChooser(): void {
    this.fileChooserInProgress = false;
  }

  private cancelEventWaiters(): void {
    this.connectionGeneration++;
    for (const waiter of [...this.eventWaiters]) {
      waiter.reject(new Error('Debugger event wait canceled because the tab changed or detached'));
    }
  }

  async setChooserFiles(tabId: number, backendNodeId: number, files: string[]): Promise<void> {
    if (this.disconnecting || this.connectedTabId !== tabId) throw new Error('Tab changed during file upload');
    // Pin the command to the original tab; reattachment would invalidate the chooser node.
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { backendNodeId, files });
  }

  async setFileChooserInterception(tabId: number, enabled: boolean): Promise<void> {
    if (enabled && (this.disconnecting || this.connectedTabId !== tabId)) throw new Error('Tab changed during file upload');
    await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled });
  }

  /** Resolve with the next matching event from the connected tab. */
  waitForDebuggerEvent<T = Record<string, unknown>>(method: string, timeout = 10000, signal?: AbortSignal): Promise<T> {
    const tabId = this.connectedTabId;
    if (tabId === null || this.disconnecting) return Promise.reject(new Error('No connected tab for debugger event wait'));
    const generation = this.connectionGeneration;
    return new Promise<T>((resolve, reject) => {
      const waiter = { method, tabId, generation, resolve: (params: unknown) => {
        cleanup();
        resolve(params as T);
      }, reject: (error: Error) => {
        cleanup();
        reject(error);
      } };
      const cleanup = () => {
        clearTimeout(timer);
        this.eventWaiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`Stopped waiting for ${method}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out after ${timeout}ms waiting for ${method}`));
      }, timeout);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.eventWaiters.add(waiter);
    });
  }

  private eventWaiters = new Set<{
    method: string; tabId: number; generation: number;
    resolve: (params: unknown) => void; reject: (error: Error) => void;
  }>();

  private async installDialogAutoAccept(tabId: number): Promise<void> {
    const debuggerTarget = { tabId };

    chrome.debugger.onEvent.removeListener(this.handleDebuggerEvent);
    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent);

    try {
      await chrome.debugger.sendCommand(debuggerTarget, 'Page.setInterceptFileChooserDialog', { enabled: false });
    } catch {
      // Not all Chrome versions expose this command; dialog auto-accept below is enough.
    }
  }

  private handleDebuggerEvent = async (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): Promise<void> => {
    if (!this.connectedTabId || source.tabId !== this.connectedTabId) {
      return;
    }

    if (this.captureEvents) pageEvents.handle(method, params as Record<string, unknown> | undefined);

    for (const waiter of this.eventWaiters) {
      if (waiter.method === method && waiter.tabId === source.tabId && waiter.generation === this.connectionGeneration) {
        waiter.resolve(params ?? {});
      }
    }

    if (method !== 'Page.javascriptDialogOpening') {
      return;
    }

    const eventParams = params as { type?: string } | undefined;
    const dialogType = String(eventParams?.type || '');
    const accept = dialogType === 'beforeunload' || dialogType === 'confirm' || dialogType === 'alert';

    try {
      await chrome.debugger.sendCommand(
        { tabId: this.connectedTabId },
        'Page.handleJavaScriptDialog',
        { accept }
      );
      log.info(`[Dialog] Auto-handled ${dialogType || 'javascript'} dialog`);
    } catch (error) {
      log.warn('[Dialog] Failed to auto-handle JavaScript dialog:', error);
    }
  };

  /**
   * Detach debugger from tab.
   */
  private async detachDebugger(): Promise<void> {
    if (!this.connectedTabId) {
      return;
    }

    // Always reset flag
    this.debuggerAttached = false;

    try {
      chrome.debugger.onEvent.removeListener(this.handleDebuggerEvent);
      await chrome.debugger.detach({ tabId: this.connectedTabId });
      log.debug('Debugger detached');
    } catch (error) {
      // May already be detached
      log.warn('Failed to detach debugger:', error);
    }
  }

  /**
   * Reattach debugger to the connected tab.
   * Called when debugger is unexpectedly detached.
   */
  async reattachDebugger(): Promise<void> {
    if (!this.connectedTabId) {
      throw new Error('No tab connected');
    }

    // Mark as detached so attachDebugger will do full attach
    this.debuggerAttached = false;

    await this.attachDebugger(this.connectedTabId);
    log.info(`[TabManager] Debugger reattached to tab ${this.connectedTabId}`);
  }

  /**
   * Mark debugger as detached (called from onDetach listener).
   */
  markDebuggerDetached(): void {
    this.captureEvents = false;
    this.cancelEventWaiters();
    pageEvents.reset();
    this.debuggerAttached = false;
    this.lastCdpError = 'CDP_DEBUGGER_DETACHED: Debugger detached unexpectedly';
  }

  /**
   * Send a debugger command to the connected tab.
   * Auto-reattaches debugger if it has been detached.
   */
  async sendDebuggerCommand<T>(
    method: string,
    params?: Record<string, unknown>,
    timeout: number = 25000 // 25 seconds default timeout (less than WS timeout of 30s)
  ): Promise<T> {
    if (!this.connectedTabId) {
      throw new Error('No tab connected');
    }

    let retriedAfterDetach = false;

    while (true) {
      // Check actual debugger state (not just our flag) and reattach if needed
      const attached = await this.isDebuggerAttached(this.connectedTabId);
      if (!attached) {
        log.warn(`[sendDebuggerCommand] Debugger detached, reattaching to tab ${this.connectedTabId}...`);
        await this.attachDebugger(this.connectedTabId);
      }

      log.debug(`[sendDebuggerCommand] Executing ${method}`, {
        tabId: this.connectedTabId,
        hasParams: params !== undefined,
      });

      // Wrap Chrome's debugger command in a timeout
      const commandPromise = chrome.debugger.sendCommand(
        { tabId: this.connectedTabId },
        method,
        params
      ) as Promise<T>;

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Debugger command timed out after ${timeout}ms: ${method}`));
        }, timeout);
      });

      try {
        const result = await Promise.race([commandPromise, timeoutPromise]);
        this.lastCdpError = null;
        log.debug(`[sendDebuggerCommand] ${method} completed successfully`);
        return result;
      } catch (error) {
        const message = (error as Error)?.message || String(error);
        this.recordCdpError(error);
        log.error(`[sendDebuggerCommand] ${method} failed:`, error);

        if (message.includes('Debugger is not attached')) {
          if (retriedAfterDetach) {
            throw new Error(`CDP_NOT_READY: ${message}`);
          }

          retriedAfterDetach = true;
          await this.attachDebugger(this.connectedTabId);
          continue;
        }

        throw error;
      }
    }
  }

  private recordCdpError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastCdpError = message;
  }

  private async probeCdp(tabId: number): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
    try {
      await chrome.debugger.sendCommand(
        { tabId },
        'Runtime.evaluate',
        { expression: '1+1', returnByValue: true }
      );
      this.lastCdpError = null;
      return { ok: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordCdpError(error);
      return { ok: false, error: message };
    }
  }

  /**
   * List all open tabs.
   * Only marks a tab as "active" if it's the active tab in the last focused normal window.
   */
  async listTabs(): Promise<TabInfo[]> {
    // Get the active tab in the last focused window (most reliable method)
    const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const currentTabId = currentTab?.id;

    const tabs = await chrome.tabs.query({});

    return tabs.map(tab => ({
      id: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
      // Only mark the specific current tab as active
      active: tab.id === currentTabId,
      connected: tab.id === this.connectedTabId,
    }));
  }

  /**
   * Create a new tab and optionally connect to it.
   *
   * The tab opens in the BACKGROUND by default: `chrome.tabs.create` without
   * `active: false` would jump the window to the new tab and steal the user's
   * view. Pass `active: true` only when the user is meant to see it.
   */
  async createTab(url: string, connect = true, active = false): Promise<TabInfo> {
    const tab = await chrome.tabs.create({ url, active });

    if (connect && tab.id) {
      try {
        // Wait for tab to finish loading (bounded; see waitForTabLoad)
        await this.waitForTabLoad(tab.id);
        await this.connectTab(tab.id);
      } catch (error) {
        // Cleanup on every exit: a tab we created but failed to drive must not linger
        // half-connected — drop any partial session and remove our own tab, then report
        // the original failure. Tabs we did not create are never touched by this path.
        if (this.connectedTabId === tab.id) {
          await this.disconnectTab().catch(() => undefined);
        }
        await chrome.tabs.remove(tab.id).catch(() => undefined);
        throw error;
      }
    }

    return {
      id: tab.id!,
      url: tab.url || url,
      title: tab.title || '',
      active: tab.active,
      connected: connect && tab.id === this.connectedTabId,
    };
  }

  /**
   * Activate a tab inside its own window (no window focus change).
   * Returns the tab that was active there before, or null when the tab was
   * already in front — callers use it as the token for restoreTabBehind.
   */
  async bringTabToFront(tabId: number): Promise<number | null> {
    const tab = await chrome.tabs.get(tabId);
    const [previous] = await chrome.tabs.query({
      windowId: tab.windowId,
      active: true,
    });
    if (previous?.id === tabId) {
      return null;
    }
    await chrome.tabs.update(tabId, { active: true });
    return previous?.id ?? null;
  }

  /**
   * Undo a bringTabToFront: put the previously visible tab back, but only if
   * our tab is still the one in front. If the user switched tabs meanwhile,
   * their choice wins and we leave it alone.
   */
  async restoreTabBehind(tabId: number, previousTabId: number | null): Promise<void> {
    if (previousTabId === null) {
      return;
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      const [current] = await chrome.tabs.query({
        windowId: tab.windowId,
        active: true,
      });
      if (current?.id !== tabId) {
        return;
      }
      await chrome.tabs.update(previousTabId, { active: true });
    } catch {
      // The tab to restore was closed mid-capture; nothing to undo.
    }
  }

  /**
   * Push a tab to the background by activating another tab of its window.
   * No-op when the tab is already hidden or it is the only tab there.
   */
  async sendTabToBack(tabId?: number): Promise<number | null> {
    const targetId = tabId ?? this.connectedTabId;
    if (!targetId) {
      throw new Error('No tab specified and no connected tab');
    }

    const tab = await chrome.tabs.get(targetId);
    if (!tab.active) {
      return null;
    }

    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    const other = siblings.find((t) => t.id !== undefined && t.id !== targetId);
    if (!other?.id) {
      return null;
    }

    await chrome.tabs.update(other.id, { active: true });
    return other.id;
  }

  /**
   * Switch to a different tab.
   */
  async switchTab(tabId: number): Promise<void> {
    if (!await this.tabExists(tabId)) {
      throw new Error(`Tab ${tabId} does not exist`);
    }

    await this.connectTab(tabId);
    await chrome.tabs.update(tabId, { active: true });
  }

  /**
   * Close a tab.
   */
  async closeTab(tabId?: number): Promise<void> {
    const targetTabId = tabId || this.connectedTabId;

    if (!targetTabId) {
      throw new Error('No tab specified and no connected tab');
    }

    if (targetTabId === this.connectedTabId) {
      await this.disconnectTab();
    }

    await chrome.tabs.remove(targetTabId);
    log.info(`Closed tab: ${targetTabId}`);
  }

  /**
   * Re-apply live connection UI on the connected tab after page navigations/reloads.
   */
  async reapplyLiveConnectionUi(): Promise<void> {
    if (!this.connectedTabId) {
      return;
    }

    await this.setLiveConnectionCloseGuard(this.connectedTabId, true);
  }

  /**
   * Start listening for new tabs opened during an operation.
   * Call this before actions that might open new tabs (like clicks).
   */
  startNewTabDetection(): void {
    // Clear any previous state
    this.pendingNewTab = null;

    // Remove existing listener if any
    if (this.newTabListener) {
      chrome.tabs.onCreated.removeListener(this.newTabListener);
    }

    this.newTabListener = (tab: chrome.tabs.Tab) => {
      // Only track if we have a connected tab (automation in progress)
      // and it's not the connected tab itself
      if (this.connectedTabId && tab.id && tab.id !== this.connectedTabId) {
        log.info(`[NewTabDetection] New tab opened: ${tab.id}, url: ${tab.url || tab.pendingUrl || 'unknown'}`);
        this.pendingNewTab = {
          id: tab.id,
          url: tab.url || tab.pendingUrl || '',
          title: tab.title || '',
          active: tab.active,
          connected: false,
        };
      }
    };

    chrome.tabs.onCreated.addListener(this.newTabListener);
    log.debug('[NewTabDetection] Started listening for new tabs');
  }

  /**
   * Stop listening for new tabs and return any detected tab.
   * Returns the new tab info if one was detected, null otherwise.
   */
  stopNewTabDetection(): TabInfo | null {
    if (this.newTabListener) {
      chrome.tabs.onCreated.removeListener(this.newTabListener);
      this.newTabListener = null;
      log.debug('[NewTabDetection] Stopped listening for new tabs');
    }

    const newTab = this.pendingNewTab;
    this.pendingNewTab = null;

    if (newTab) {
      log.info(`[NewTabDetection] Returning detected new tab: ${newTab.id}`);
    }

    return newTab;
  }

  /**
   * Wait for a tab to finish loading.
   */
  /**
   * Wait for a tab to be loaded NOW: resolves immediately when the tab already reports
   * status 'complete' (a fresh tab whose load finished before we subscribed, a cached page,
   * about:blank), otherwise waits for the next completion event. Bounded and leak-free:
   * rejects on timeout, on the tab being closed, or on the tab not existing, and every exit
   * path removes both listeners. For create/adopt flows — never for a navigation you are
   * about to trigger (a previous load's 'complete' would resolve it early); use
   * waitForNextTabLoad for those.
   */
  public waitForTabLoad(tabId: number, timeout = TIMEOUTS.TAB_LOAD): Promise<void> {
    return this.tabLoadWait(tabId, timeout, true).promise;
  }

  /**
   * Arm the wait BEFORE triggering a navigation (update/reload) and resolve only on the
   * completion that follows the trigger. A 'complete' from a PREVIOUS load never resolves
   * it: the state is deliberately not consulted. If the trigger itself fails, the wait is
   * cancelled, listeners are removed and the trigger error propagates. Bounded and
   * leak-free like waitForTabLoad.
   */
  public waitForNextTabLoad(
    tabId: number,
    trigger: () => Promise<unknown>,
    timeout = TIMEOUTS.TAB_LOAD,
  ): Promise<void> {
    const wait = this.tabLoadWait(tabId, timeout, false);
    // Both lifecycles are observed from the start, and only the WAIT decides when the caller
    // resumes: a timeout, a closed tab or a missing tab end the operation even if the trigger
    // never settles, while a failed trigger cancels the wait with its ORIGINAL error object
    // (identity preserved, no wrapper, no late success). The trigger's own rejection is
    // handled here, so it can never surface as an unhandled rejection.
    void (async () => {
      try {
        await trigger();
      } catch (error) {
        wait.cancel(error);
      }
    })();
    return wait.promise;
  }

  private tabLoadWait(
    tabId: number,
    timeout: number,
    resolveIfAlreadyComplete: boolean,
  ): { promise: Promise<void>; cancel: (reason: unknown) => void } {
    let cancel: (reason: unknown) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      let done = false;
      const settle = (fn: () => void) => {
        if (done) return;
        done = true;
        cleanup();
        fn();
      };
      const onUpdated = (updatedTabId: number, changeInfo: { status?: string }) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          settle(() => resolve());
        }
      };
      const onRemoved = (removedTabId: number) => {
        if (removedTabId === tabId) {
          settle(() => reject(new Error(`Tab ${tabId} was closed while waiting for it to load`)));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`Timed out after ${timeout}ms waiting for tab ${tabId} to load`)));
      }, timeout);
      cancel = (reason) => settle(() => reject(reason));
      // Listeners go in first, so no completion event is lost between subscribe and check.
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      chrome.tabs.get(tabId).then(
        (tab) => {
          if (resolveIfAlreadyComplete && tab.status === 'complete') settle(() => resolve());
        },
        () => settle(() => reject(new Error(`Tab ${tabId} does not exist`))),
      );
    });
    return { promise, cancel };
  }  /**
   * Clear any live-connection UI/guards from old extension builds.
   * Automation tabs must stay unobstructed for agent-driven clicks.
   */
  private async setLiveConnectionCloseGuard(tabId: number, _enabled: boolean): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const host = window as unknown as Record<string, unknown>;
          const keys = {
            state: '__agentJakeLiveCloseGuardMessage',
            handler: '__agentJakeLiveCloseGuardHandler',
            banner: '__agentJakeLiveCloseGuardBanner',
            moveHandler: '__agentJakeLiveBannerMoveHandler',
            overlay: '__agentJakeLiveCloseGuardOverlay',
            dismissed: '__agentJakeLiveCloseGuardOverlayDismissed',
            style: '__agentJakeLiveCloseGuardStyle',
          };

          const existingBeforeUnload = host[keys.handler];
          if (typeof existingBeforeUnload === 'function') {
            window.removeEventListener('beforeunload', existingBeforeUnload as EventListener);
          }

          const moveHandler = host[keys.moveHandler];
          if (typeof moveHandler === 'function') {
            window.removeEventListener('mousemove', moveHandler as EventListener);
          }

          for (const key of [keys.banner, keys.overlay, keys.style]) {
            const element = host[key] as Element | undefined;
            element?.remove?.();
            host[key] = null;
          }

          host[keys.state] = '';
          host[keys.handler] = null;
          host[keys.moveHandler] = null;
          host[keys.dismissed] = null;
          window.onbeforeunload = null;

          document.querySelectorAll(
            '.agent-jake-live-banner, .agent-jake-live-overlay, #agent-jake-live-close-guard-style'
          ).forEach((element) => element.remove());
        },
      });
    } catch {
      // Best effort: restricted pages cannot be scripted.
    }
  }

}
