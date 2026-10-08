/**
 * Tool handlers orchestrator for browser automation commands.
 * Delegates to categorized handler modules.
 */

import type { TabManager } from './tab-manager';
import type { IncomingMessage, OutgoingMessage, ToolName as MessageToolName } from '@/types/messages';
import { log } from '@/utils/logger';
import { logTool, logError } from './activity-log';
import { getKeyDefinition } from '@/constants/keys';
import { createToolContext } from './tools/utils';
import type { HandlerContext, HandlerMap } from './tools/handlers';
import {
  createNavigationHandlers,
  createInteractionHandlers,
  createQueryHandlers,
  createStateHandlers,
  createTabHandlers,
  createUtilityHandlers,
  createDevtoolsHandlers,
} from './tools/handlers';

/**
 * Build a HandlerContext from a TabManager.
 * Extends ToolContext with typed mouse/key event wrappers.
 */
function buildHandlerContext(tabManager: TabManager): HandlerContext {
  const ctx = createToolContext(tabManager);

  return {
    ...ctx,

    async dispatchMouseEventTyped(type, x, y, button = 'left', clickCount = 1) {
      await ctx.dispatchMouseEvent(type, x, y, button, clickCount);
    },

    async dispatchKeyEventTyped(type, key, text?) {
      const keyDef = getKeyDefinition(key);
      await tabManager.sendDebuggerCommand('Input.dispatchKeyEvent', {
        type,
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.keyCode,
        text: type === 'char' ? text : undefined,
      });
    },
  };
}

/**
 * Every handler keyed by tool name. The only place the handler groups are composed:
 * tests/handler-parity.test.ts checks these keys against the protocol catalog.
 */
export function createHandlerMap(ctx: HandlerContext): HandlerMap {
  return {
    ...createNavigationHandlers(ctx),
    ...createInteractionHandlers(ctx),
    ...createQueryHandlers(ctx),
    ...createStateHandlers(ctx),
    ...createTabHandlers(ctx),
    ...createUtilityHandlers(ctx),
    ...createDevtoolsHandlers(ctx),
  };
}

/**
 * Create tool handlers bound to a tab manager.
 */
export function createToolHandlers(tabManager: TabManager) {
  const ctx = buildHandlerContext(tabManager);

  const handlers = createHandlerMap(ctx);

  /**
   * Handle incoming message from WebSocket.
   */
  return async function handleMessage(message: IncomingMessage): Promise<OutgoingMessage> {
    const { id, type, payload } = message;
    const startTime = performance.now();

    log.debug(`[Tool] Received: ${type} (id: ${id})`);

    try {
      const handler = handlers[type];
      if (!handler) {
        logError('unknown_tool', `Unknown tool: ${type}`);
        return {
          id,
          success: false,
          error: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${type}`,
          },
        };
      }

      const result = await handler(payload);
      const durationMs = Math.round(performance.now() - startTime);

      const description = getToolDescription(type, payload, result);
      logTool(type, description, true, durationMs, { payload, result });

      log.info(`[Tool] Completed: ${type} (id: ${id}) - success in ${durationMs}ms`);

      return {
        id,
        success: true,
        result,
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime);
      log.error(`[Tool] Failed: ${type} (id: ${id}) - ${(error as Error).message} in ${durationMs}ms`);

      logTool(type, (error as Error).message, false, durationMs, { payload, error: (error as Error).message });

      return {
        id,
        success: false,
        error: {
          code: (error as Error).name || 'EXECUTION_ERROR',
          message: (error as Error).message,
        },
      };
    }
  };
}

/**
 * Get a concise description for the tool action.
 */
function getToolDescription(type: string, payload: unknown, result: unknown): string {
  const p = payload as Record<string, unknown>;
  const r = result as Record<string, unknown>;

  switch (type) {
    case 'browser_navigate':
      return `Navigate to ${p?.url || 'unknown'}`;
    case 'browser_click':
      return `Click on "${p?.ref || p?.selector}"`;
    case 'browser_type':
      return `Type "${String(p?.text || '').slice(0, 20)}${(String(p?.text || '').length > 20) ? '...' : ''}"`;
    case 'browser_hover':
      return `Hover on "${p?.ref || p?.selector}"`;
    case 'browser_press_key':
      return `Press key "${p?.key}"`;
    case 'browser_wait':
      return `Wait ${p?.time}s`;
    case 'browser_screenshot':
      return 'Take screenshot';
    case 'browser_snapshot':
      return `Snapshot: ${r?.title || 'page'}`;
    case 'browser_new_tab':
      return `New tab: ${p?.url || 'unknown'}`;
    case 'browser_switch_tab':
      return `Switch to tab ${p?.tabId}`;
    case 'browser_close_tab':
      return 'Close tab';
    case 'browser_evaluate':
      return `Evaluate JS via CDP (${String(p?.code || '').length} chars)`;
    case 'browser_get_html':
      return `Get page HTML (${(r?.html as string)?.length || 0} chars)`;
    case 'browser_iframe_eval':
      return `Evaluate JS in iframe ${p?.iframeSelector || 'unknown'} (${String(p?.code || '').length} chars)`;
    case 'browser_iframe_click':
      return `Click ${p?.targetSelector || 'unknown'} inside iframe ${p?.iframeSelector || 'unknown'}`;
    case 'browser_resize_viewport':
      return `Resize to ${p?.width}x${p?.height}`;
    case 'browser_upload_file':
      return `Upload file: ${p?.filePath ?? (p?.filePaths as string[] | undefined)?.join(', ')}`;
    case 'browser_network_requests':
      return `Network requests (${((r?.requests as unknown[]) ?? []).length})`;
    case 'browser_network_request':
      return `Network request [${p?.index}]${p?.part ? ` ${p.part}` : ''}`;
    case 'browser_get_console_logs':
      return `Console logs (${((r?.logs as unknown[]) ?? []).length})`;
    case 'browser_cdp':
      return `CDP ${p?.method}`;
    case 'browser_drop':
      return `Drop on "${p?.ref || p?.selector}"`;
    case 'browser_fill_form':
      return `Fill form (${((p?.fields as unknown[]) ?? []).length} fields)`;
    case 'browser_select_option':
      return `Select option in "${p?.ref || p?.selector}"`;
    case 'browser_pdf':
      return `Print page to PDF (${Math.round(String((r as Record<string, unknown>)?.pdf ?? '').length * 0.75)} bytes)`;
    default:
      return type.replace('browser_', '').replace(/_/g, ' ');
  }
}
