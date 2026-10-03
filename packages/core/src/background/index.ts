/**
 * Background service worker entry point.
 * Manages WebSocket connection to browser-mcp and routes tool calls.
 *
 * Uses chrome.alarms API to keep the service worker alive when a tab is connected.
 * Manifest V3 service workers can go to sleep after ~30 seconds of inactivity,
 * which would kill the WebSocket connection to browser-mcp.
 */

// MUST be first import - polyfills window/document for service worker context
import './sw-polyfill';

import { WebSocketClient } from './ws-client';
import { TabManager } from './tab-manager';
import { createToolHandlers } from './tool-handlers';
import { activityLog } from './activity-log';
import { preparePrivateStorage } from './storage-privacy';
import {
  cancelPairing,
  getPairingInfo,
  maybeAutoStartPairing,
  setOnTokenApproved,
  startPairing,
} from './pairing';
import { log } from '@/utils/logger';
import { createCopilotTrafficGate, registerCopilotBridge } from './agent/bridge';
import {
  buildDisplayUrl,
  getEffectiveConfig,
  parseWsUrl,
  setServerUrl,
  setToken,
  setWireMode,
  STORAGE_KEYS,
} from '@/config/runtime';

// Keep-alive alarm name - fires every 12 seconds to prevent service worker sleep
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_INTERVAL_MINUTES = 0.2; // 12 seconds

// Singleton instances
let wsClient: WebSocketClient | null = null;
let tabManager: TabManager | null = null;
let handleToolMessage: ReturnType<typeof createToolHandlers> | null = null;
let copilotGate: ReturnType<typeof createCopilotTrafficGate> | null = null;
let initialized: Promise<void> | null = null;

// Copilot side panel: its Port and the Alt+J shortcut must be registered at the top
// level, so a wake-up by either event finds the listener in place.
registerCopilotBridge(async () => {
  await initialized?.catch(() => undefined);
  return { tabManager, handleMessage: handleToolMessage, acquireLease: () => copilotGate?.acquire() ?? null };
});

chrome.commands.onCommand.addListener((command, tab) => {
  // No await before open(): the shortcut's user gesture must still be live.
  if (command === 'open-copilot' && tab?.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
      log.warn('[Copilot] Could not open side panel:', error);
    });
  }
});

/**
 * Initialize the extension.
 */
async function initialize(): Promise<void> {
  log.info('Initializing Agent Jake Browser MCP Extension');

  await preparePrivateStorage();

  // Create tab manager
  tabManager = new TabManager();
  await tabManager.initialize();

  // Create WebSocket client (for local MCP server)
  wsClient = new WebSocketClient();

  // When pairing stores a fresh token, reconnect so the handshake uses it.
  setOnTokenApproved(() => {
    wsClient?.reload().catch((error) => {
      log.warn('[Pairing] Reload after approval failed:', error);
    });
  });

  // Create tool handlers
  const handleMessage = createToolHandlers(tabManager);
  handleToolMessage = handleMessage;
  copilotGate = createCopilotTrafficGate(tabManager, handleMessage);
  wsClient.setMessageHandler((message) => copilotGate!.handleMcp(message));

  // Start connection loop for local MCP
  startConnectionLoop();

  // Resume or auto-start a pairing flow when the runtime config calls for it.
  maybeAutoStartPairing().catch((error) => {
    log.warn('[Pairing] Auto-start check failed:', error);
  });

  log.info('Extension initialized');
}

/**
 * Start or stop the keep-alive alarm based on whether a tab is connected.
 * The alarm prevents the service worker from going to sleep.
 */
async function updateKeepAliveAlarm(): Promise<void> {
  const tabId = tabManager?.getConnectedTabId();

  // The alarm runs ALWAYS. Without it the MV3 service worker sleeps after ~30s,
  // takes the WebSocket down with it, and the agent sees "Extension not
  // connected" with no way to wake it — there is no UI to poke when the MCP
  // client is a headless session.
  void tabId;
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing) {
    await chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
    });
    log.info('[KeepAlive] Alarm started - service worker stays awake');
  }
}

/**
 * Handle keep-alive alarm - triggers connection check.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    log.debug('[KeepAlive] Alarm fired - checking connection');
    wsClient?.sendHeartbeat();
    tryConnect();
  }
});

/**
 * Try to connect to browser-mcp if we have a connected tab.
 */
async function tryConnect(): Promise<void> {
  if (!wsClient) return;

  const tabId = tabManager?.getConnectedTabId();
  const wsConnected = wsClient?.isConnected();
  log.debug(`[Loop] tryConnect - tabId: ${tabId}, wsConnected: ${wsConnected}`);

  // Keep the WebSocket up connected tab or not: tools that do not touch the DOM
  // (list_tabs, navigate, new_tab) must work, and the tab gets attached on the
  // first command that needs it (see ensureTabId in tools/utils.ts).
  void tabId;

  // Skip if ws-client already has a reconnect scheduled
  if (wsClient.isReconnecting()) {
    log.debug('[Loop] Reconnect already scheduled, skipping');
    return;
  }

  if (!wsConnected) {
    log.info('[Loop] Not connected, attempting WebSocket connect...');
    try {
      await wsClient.connect();
      log.info('[Loop] Connected to browser-mcp');
    } catch (error) {
      log.warn(`[Loop] Connect failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Connection loop - keeps trying to connect to browser-mcp.
 */
async function startConnectionLoop(): Promise<void> {
  if (!wsClient) return;

  // Try immediately
  await tryConnect();

  // Update keep-alive alarm based on current state
  await updateKeepAliveAlarm();

  // The ws-client handles its own reconnection via handleDisconnect().
  // The keep-alive alarm (every 12s) serves as a backup.
}

/**
 * Handle messages from popup.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Log all incoming messages for debugging
  log.debug('Message received, url:', sender.url, 'action:', message?.action);

  // Check if message is from our extension pages (popup, etc.)
  // When popup is opened as a page (Playwright), sender.tab is set but URL is still chrome-extension://
  const isFromExtension = sender.url?.startsWith('chrome-extension://');
  const isFromContentScript = sender.tab && !isFromExtension;

  if (isFromContentScript) {
    // Message from content script in a regular web page - handle separately
    // Don't return false - just don't respond to popup-style messages
    return;
  }

  // This is from popup or other extension page
  (async () => {
    try {
      const response = await handlePopupMessage(message);
      log.debug('Sending popup response');
      sendResponse(response);
    } catch (error) {
      log.error('Message handler error:', error);
      sendResponse({ success: false, error: (error as Error).message });
    }
  })();

  return true; // Keep sendResponse channel open for async response
});

/**
 * Handle popup messages.
 */
async function handlePopupMessage(message: {
  action: string;
  payload?: unknown;
}): Promise<unknown> {
  const { action, payload } = message;

  switch (action) {
    case 'getStatus': {
      // Ensure tabManager is initialized before accessing
      const tabs = tabManager ? await tabManager.listTabs() : [];
      return {
        connected: wsClient?.isConnected() || false,
        tabId: tabManager?.getConnectedTabId() || null,
        tabs,
        // negotiating / incompatible / auth-unconfirmed / transient, sanitized endpoint, wire version
        negotiation: wsClient?.getNegotiationStatus() ?? null,
      };
    }

    case 'getCdpStatus': {
      if (!tabManager) {
        return {
          connectedTabId: null,
          debuggerAttached: false,
          canExecuteCdp: false,
          lastCdpError: 'CDP_NOT_READY: Tab manager not initialized',
        };
      }

      return await tabManager.getCdpStatus();
    }

    case 'getServerConfig': {
      const cfg = await getEffectiveConfig();
      const stored = await chrome.storage.local.get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.token]);
      return {
        effectiveUrl: buildDisplayUrl(cfg),
        fromStorage: cfg.fromStorage,
        source: cfg.source,
        storedServerUrl: typeof stored[STORAGE_KEYS.serverUrl] === 'string'
          ? (stored[STORAGE_KEYS.serverUrl] as string)
          : '',
        storedToken: typeof stored[STORAGE_KEYS.token] === 'string'
          ? (stored[STORAGE_KEYS.token] as string)
          : '',
        hasToken: cfg.token !== '',
        connectionId: cfg.connectionId,
        connected: wsClient?.isConnected() || false,
        pairing: getPairingInfo(),
      };
    }

    case 'saveServerConfig': {
      const { serverUrl, token, wireMode } = (payload || {}) as { serverUrl?: string; token?: string; wireMode?: string };
      if (typeof serverUrl === 'string') {
        const trimmed = serverUrl.trim();
        if (trimmed && parseWsUrl(trimmed) === null) {
          return { success: false, error: `Invalid server URL: ${trimmed}` };
        }
        await setServerUrl(trimmed || null);
      }
      if (typeof token === 'string') {
        await setToken(token.trim());
      }
      if (wireMode === 'legacy' || wireMode === 'negotiated') {
        // Changing the wire is an explicit operator action; it also clears a BLOCKED state via reload().
        await setWireMode(wireMode);
      }
      // Reconnect immediately so the new URL/token take effect.
      cancelPairing();
      wsClient?.disconnect();
      await wsClient?.reload();
      const cfg = await getEffectiveConfig();
      return {
        success: true,
        connected: wsClient?.isConnected() || false,
        effectiveUrl: buildDisplayUrl(cfg),
      };
    }

    case 'startPairing': {
      const result = await startPairing();
      return { success: true, ...result };
    }

    case 'pairingStatus': {
      return getPairingInfo();
    }

    case 'connectTab': {
      const { tabId, tabUrl } = payload as { tabId: number; tabUrl?: string };
      await tabManager?.connectTab(tabId, tabUrl);
      // Reset reconnect counter and try to connect immediately
      wsClient?.resetReconnectAttempts();
      wsClient?.connect().catch(() => {}); // Fire and forget
      // Start keep-alive alarm to prevent service worker sleep
      await updateKeepAliveAlarm();
      return { success: true };
    }

    case 'connectMcp': {
      if (!tabManager?.getConnectedTabId()) {
        return { success: false, error: 'Pick a tab before connecting MCP' };
      }

      wsClient?.resetReconnectAttempts();
      await wsClient?.connect();
      await updateKeepAliveAlarm();
      return { success: true };
    }

    case 'disconnectMcp': {
      wsClient?.disconnect();
      return { success: true };
    }

    case 'toggleMcp': {
      if (wsClient?.isConnected()) {
        wsClient.disconnect();
        return { success: true, connected: false };
      }

      if (!tabManager?.getConnectedTabId()) {
        return { success: false, connected: false, error: 'Pick a tab before connecting MCP' };
      }

      wsClient?.resetReconnectAttempts();
      await wsClient?.connect();
      await updateKeepAliveAlarm();
      return { success: true, connected: true };
    }

    case 'disconnectTab': {
      await tabManager?.disconnectTab();
      wsClient?.disconnect();
      // Stop keep-alive alarm
      await updateKeepAliveAlarm();
      return { success: true };
    }

    case 'getActivity': {
      try {
        const { limit } = (payload as { limit?: number }) || {};
        if (limit) {
          return await activityLog.getLatest(limit);
        }
        return await activityLog.getAll();
      } catch (error) {
        log.error('Failed to get activity:', error);
        // Return empty response on error
        return { activities: [], total: 0 };
      }
    }

    case 'clearActivity': {
      await activityLog.clear();
      return { success: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Handle extension install/update.
 */
chrome.runtime.onInstalled.addListener((details) => {
  log.info(`Extension installed: ${details.reason}`);
});

/**
 * Handle debugger detach.
 * Attempts to reattach if it wasn't user-initiated.
 */
chrome.debugger.onDetach.addListener(async (source, reason) => {
  log.warn(`Debugger detached from tab ${source.tabId}: ${reason}`);

  // Mark debugger as detached in TabManager
  tabManager?.markDebuggerDetached();

  // If it's our connected tab and reason isn't user-initiated, try to reattach
  const connectedTabId = tabManager?.getConnectedTabId();
  if (source.tabId === connectedTabId && reason !== 'canceled_by_user') {
    // Small delay to let Chrome settle
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      await tabManager?.reattachDebugger();
      log.info('[onDetach] Debugger reattached successfully');
    } catch (error) {
      log.error('[onDetach] Failed to reattach debugger:', error);
      // Don't throw - the next tool call will try again via sendDebuggerCommand
    }
  }
});

/**
 * Re-apply live connection guard UI after the connected tab reloads/navigates.
 */
chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
  if (changeInfo.status !== 'complete') {
    return;
  }

  const connectedTabId = tabManager?.getConnectedTabId();
  if (!connectedTabId || connectedTabId !== updatedTabId) {
    return;
  }

  tabManager?.reapplyLiveConnectionUi().catch((error) => {
    log.warn('[onUpdated] Failed to re-apply live connection UI:', error);
  });
});

// Initialize on load
const extensionVersion = chrome.runtime.getManifest().version;
console.log('========================================');
console.log(`Agent Jake Browser MCP Extension v${extensionVersion}`);
console.log('========================================');
initialized = initialize();
initialized.catch(error => {
  log.error('Failed to initialize:', error);
});

// Expose debug helpers for service worker console
(globalThis as Record<string, unknown>).__debug = {
  getStatus: () => ({
    wsConnected: wsClient?.isConnected(),
    tabId: tabManager?.getConnectedTabId(),
    reconnectAttempts: (wsClient as unknown as { reconnectAttempts?: number })?.reconnectAttempts,
  }),
  forceConnect: () => wsClient?.connect(),
  forceDisconnect: () => wsClient?.disconnect(),
  resetReconnect: () => wsClient?.resetReconnectAttempts(),
};
