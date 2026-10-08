/**
 * Zod validation schemas for browser automation tool parameters.
 * Each schema validates the input payload for its corresponding tool.
 */

import { z } from 'zod';

export const schemas = {
  browser_navigate: z.object({
    url: z.string().url(),
  }),

  browser_click: z.object({
    ref: z.string().describe('Element reference from snapshot (e.g., s1e42)'),
    selector: z.string().optional().describe('CSS selector fallback'),
  }),

  browser_type: z.object({
    ref: z.string(),
    text: z.string(),
    clear: z.boolean().optional().default(false),
    // A password or 2FA code: typed like any text, but never echoed back in the result.
    secret: z.boolean().optional(),
  }),

  browser_hover: z.object({
    ref: z.string(),
    selector: z.string().optional(),
  }),

  browser_drag: z
    .object({
      startRef: z.string().optional(),
      startSelector: z.string().optional(),
      endRef: z.string().optional(),
      endSelector: z.string().optional(),
    })
    .refine((d) => d.startRef || d.startSelector, { message: 'startRef or startSelector is required' })
    .refine((d) => d.endRef || d.endSelector, { message: 'endRef or endSelector is required' }),

  browser_select_option: z.object({
    ref: z.string().optional(),
    selector: z.string().optional(),
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().optional(),
  }),

  browser_press_key: z.object({
    key: z.string().describe('Key name like "Enter", "Tab", "ArrowDown", or "a"'),
  }),

  browser_wait: z.object({
    time: z.number().min(0).max(30).describe('Time to wait in seconds'),
  }),

  browser_new_tab: z.object({
    url: z.string().url(),
    switchTo: z.boolean().optional().default(false),
  }),

  browser_switch_tab: z.object({
    tabId: z.number(),
  }),

  browser_send_to_back: z.object({
    tabId: z.number().optional(),
  }),

  browser_close_tab: z.object({
    tabId: z.number().optional(),
  }),

  browser_get_text: z.object({
    ref: z.string(),
  }),

  browser_get_attribute: z.object({
    ref: z.string(),
    attribute: z.string(),
  }),

  browser_wait_for_element: z.object({
    ref: z.string(),
    timeout: z.number().optional().default(10000),
  }),

  browser_highlight: z.object({
    ref: z.string(),
  }),

  browser_is_visible: z.object({
    ref: z.string(),
  }),

  browser_evaluate: z.object({
    code: z.string().describe('JavaScript code to evaluate via CDP (CSP-safe)'),
  }),

  browser_iframe_eval: z.object({
    iframeSelector: z.string().describe('CSS selector for the target iframe'),
    code: z.string().describe('JavaScript code to evaluate in the iframe contentWindow'),
  }),

  browser_iframe_click: z.object({
    iframeSelector: z.string().describe('CSS selector for the target iframe'),
    targetSelector: z.string().describe('CSS selector inside the iframe to click'),
    waitForNavigation: z.boolean().optional().default(false),
    timeout: z.number().optional().default(10000),
  }),

  browser_resize_viewport: z.object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(200).max(2160),
  }),

  browser_upload_file: z.object({
    ref: z.string().optional(),
    selector: z.string().optional(),
    filePath: z.string().optional(),
    filePaths: z.array(z.string()).optional(),
  }).refine((d) => d.filePath || d.filePaths?.length, { message: 'filePath or filePaths is required' }),

  browser_get_console_logs: z.object({
    types: z.array(z.string()).optional(),
    level: z.enum(['error', 'warning', 'info', 'debug']).optional(),
    all: z.boolean().optional().default(false),
    clear: z.boolean().optional().default(false),
  }),

  browser_network_requests: z.object({
    includeStatic: z.boolean().optional().default(false),
    all: z.boolean().optional().default(false),
    filter: z.string().optional(),
  }),

  browser_network_request: z.object({
    index: z.number().int(),
    part: z.enum(['request-headers', 'request-body', 'response-headers', 'response-body']).optional(),
    maxBodyChars: z.number().int().min(100).optional().default(20000),
  }),

  browser_cdp: z.object({
    method: z.string().regex(/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/, 'CDP method like "Page.reload"'),
    params: z.record(z.string(), z.unknown()).optional(),
  }),

  browser_drop: z.object({
    ref: z.string().optional(),
    selector: z.string().optional(),
    files: z.array(z.object({ name: z.string(), mimeType: z.string(), base64: z.string() })).optional().default([]),
    data: z.record(z.string(), z.string()).optional().default({}),
  }),

  browser_fill_form: z.object({
    fields: z.array(z.object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']).optional(),
    })).min(1),
  }),

  browser_pdf: z.object({
    landscape: z.boolean().optional().default(false),
    printBackground: z.boolean().optional().default(true),
    scale: z.number().min(0.1).max(2).optional().default(1),
    pageRanges: z.string().optional(),
  }),
} as const;

export type ToolName = keyof typeof schemas;
export type ToolPayload<T extends ToolName> = z.infer<typeof schemas[T]>;
