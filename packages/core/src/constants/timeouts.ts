/**
 * Timeout constants used throughout the extension.
 * Centralizes magic numbers for easier maintenance.
 */

export const TIMEOUTS = {
  /** Duration to show element highlight overlay (ms) */
  HIGHLIGHT_DURATION: 2000,

  /** Time to wait for DOM stability check (ms) */
  DOM_STABILITY_MS: 500,

  /** Maximum wait for debugger commands (ms) */
  DEBUGGER_COMMAND: 25000,

  /** Popup polling interval (ms) */
  POLLING_INTERVAL: 2000,

  /** Keep-alive alarm interval (minutes) */
  KEEPALIVE_MINUTES: 0.2,

  /** WebSocket reconnect delay (ms) */
  WS_RECONNECT_DELAY: 1000,

  /** Request timeout for MCP messages (ms) */
  REQUEST_TIMEOUT: 30000,

  /** Maximum wait for a tab to finish loading before the wait is abandoned (ms) */
  TAB_LOAD: 30000,
} as const;

export type TimeoutKey = keyof typeof TIMEOUTS;
