/**
 * Message types for communication between extension components
 * and the browser-mcp WebSocket server.
 */

// Tool names exposed via MCP
export type ToolName =
  | 'browser_navigate'
  | 'browser_go_back'
  | 'browser_go_forward'
  | 'browser_state'
  | 'browser_find'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_type'
  | 'browser_hover'
  | 'browser_drag'
  | 'browser_select_option'
  | 'browser_press_key'
  | 'browser_wait'
  | 'browser_screenshot'
  | 'browser_get_console_logs'
  // New tools (improvements)
  | 'browser_new_tab'
  | 'browser_list_tabs'
  | 'browser_switch_tab'
  | 'browser_send_to_back'
  | 'browser_close_tab'
  | 'browser_get_text'
  | 'browser_get_attribute'
  | 'browser_is_visible'
  | 'browser_wait_for_element'
  | 'browser_highlight'
  | 'browser_evaluate'
  | 'browser_get_html'
  | 'browser_iframe_eval'
  | 'browser_iframe_click'
  | 'browser_pdf'
  | 'browser_upload_file'
  | 'browser_network_requests'
  | 'browser_network_request'
  | 'browser_cdp'
  | 'browser_drop'
  | 'browser_fill_form';

// Messages from browser-mcp server
export interface IncomingMessage {
  id: string;
  type: ToolName;
  payload: Record<string, unknown>;
  /** Negotiated wire only: the MCP session that owns this request. Consumers (INFRA-413) read it; they do not invent their own. */
  sessionId?: string;
  /** Negotiated wire only: opaque tab target for the session; never a Chrome numeric tab id. */
  tabHandle?: string;
}

// Response back to browser-mcp server
export interface OutgoingMessage {
  id: string;
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Internal messages between background and content scripts
export interface ContentScriptRequest {
  action: string;
  payload: Record<string, unknown>;
}

export interface ContentScriptResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ARIA tree node representation
export interface AriaNode {
  role: string;
  name: string;
  ref: string;
  children: (AriaNode | string)[];
  props: Record<string, unknown>;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
}

// Snapshot metadata
export interface Snapshot {
  generation: number;
  elements: Map<number, Element>;
  root: AriaNode;
  timestamp: number;
}

// Tab info for tab management
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  connected: boolean;
}

// Viewport coordinates
export interface Coordinates {
  x: number;
  y: number;
  /**
   * false when the element lives in a cross-origin iframe and its position could not be
   * translated into top-frame coordinates: CDP events would land somewhere else.
   */
  exact?: boolean;
}

// Element bounding box
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
