/**
 * Content script entry point.
 * Runs in the context of web pages and handles DOM interactions.
 */

import {
  generateSnapshot,
  getCurrentSnapshot,
  getElementByRef,
  formatSnapshotAsText,
} from './aria-tree';
import {
  buildSelector,
  findElement,
  getElementCenter,
  scrollIntoView,
  isElementVisible,
  isElementClickable,
} from './selector';
import type { ContentScriptRequest, ContentScriptResponse, Coordinates } from '@/types/messages';
import { TIMEOUTS, getHighlightCSS } from '@/constants';
import { CONFIG } from '@/types/config';
import { generateCompactState, formatCompactState, findCompact } from './compact-state';
import {
  handleDispatchDrop,
  handleFillField,
  handleFieldLength,
  handleGetFieldLength,
  handleSetFieldText,
  handleClearField,
} from './form-actions';

// Visual highlight overlay
let highlightOverlay: HTMLDivElement | null = null;

/**
 * Handle messages from background script.
 */
chrome.runtime.onMessage.addListener(
  (
    request: ContentScriptRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ContentScriptResponse) => void
  ) => {
    handleRequest(request)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));

    // Return true to indicate async response
    return true;
  }
);

/**
 * Route request to appropriate handler.
 */
async function handleRequest(request: ContentScriptRequest): Promise<unknown> {
  const { action, payload } = request;

  switch (action) {
    case 'generateState':
      return handleGenerateState(payload as { max?: number } | undefined);

    case 'findElements':
      return findCompact((payload as { text: string }).text);

    case 'generateSnapshot':
      return handleGenerateSnapshot(payload as { frame?: string } | undefined);

    case 'getSelector':
      return handleGetSelector(payload as { ref: string });

    case 'getElementCoordinates':
      return handleGetElementCoordinates(payload as { selector: string; clickable?: boolean });

    case 'scrollIntoView':
      return handleScrollIntoView(payload as { selector: string });

    case 'selectOption':
      return handleSelectOption(payload as {
        selector: string;
        values?: string[];
        value?: string;
        label?: string;
        index?: number;
      });

    case 'getText':
      return handleGetText(payload as { selector: string });

    case 'getAttribute':
      return handleGetAttribute(payload as { selector: string; attribute: string });

    case 'isVisible':
      return handleIsVisible(payload as { selector: string });

    case 'waitForElement':
      return handleWaitForElement(payload as { selector: string; timeout?: number });

    case 'highlight':
      return handleHighlight(payload as { selector: string });

    case 'waitForDomStable':
      return handleWaitForDomStable(payload as { timeout?: number });

    case 'getPageInfo':
      return handleGetPageInfo();

    case 'evaluate':
      return handleEvaluate(payload as { code: string });

    case 'dispatchClick':
      return handleDispatchClick(payload as { selector: string });

    case 'focusElement':
      return handleFocusElement(payload as { selector: string });

    case 'dispatchDrop':
      return handleDispatchDrop(payload as Parameters<typeof handleDispatchDrop>[0]);

    case 'fillField':
      return handleFillField(payload as Parameters<typeof handleFillField>[0]);

    case 'getFieldLength':
      return handleGetFieldLength(payload as { selector: string });

    case 'fieldLength':
      return handleFieldLength(payload as { selector: string });

    case 'setFieldText':
      return handleSetFieldText(payload as { selector: string; text: string; kept: number });

    case 'clearField':
      return handleClearField(payload as { selector: string });

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Evaluate JavaScript code in the page context.
 */
function handleEvaluate(payload: { code: string }): unknown {
  try {
    // Use indirect eval to run in global scope
    // eslint-disable-next-line no-eval
    const result = (0, eval)(payload.code);
    return result;
  } catch (error) {
    throw new Error(`Evaluation error: ${(error as Error).message}`);
  }
}

/**
 * Compact DOM-first state (the default view). See compact-state.ts.
 */
function handleGenerateState(payload?: { max?: number }): string {
  return formatCompactState(generateCompactState(payload?.max ?? 150));
}

/**
 * PROGRAMMATIC click, for cross-origin iframes where the element's position cannot be
 * translated into top-frame coordinates and CDP events would land somewhere else. It is
 * not a trusted event (isTrusted=false): only used when the proper path does not exist.
 */
async function handleDispatchClick(payload: { selector: string }): Promise<{ clicked: boolean; trusted: boolean }> {
  const element = await findElement(payload.selector, { visible: true });
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };

  if (element instanceof HTMLElement) {
    element.focus({ preventScroll: true });
  }
  element.dispatchEvent(new MouseEvent('mouseover', init));
  element.dispatchEvent(new MouseEvent('mousemove', init));
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));

  // element.click() fires the `click` event itself: dispatching one by hand as well
  // would duplicate it, and a duplicated submit on a bank form is not a cosmetic detail.
  if (element instanceof HTMLElement) {
    element.click();
  } else {
    element.dispatchEvent(new MouseEvent('click', init));
  }

  return { clicked: true, trusted: false };
}

/**
 * Focus an element without going through coordinates. The focus itself IS real, so the
 * key events CDP sends next reach this element even inside a cross-origin iframe.
 */
async function handleFocusElement(payload: { selector: string }): Promise<{ focused: boolean }> {
  const element = await findElement(payload.selector, { visible: true });
  if (element instanceof HTMLElement) {
    element.focus({ preventScroll: true });
    return { focused: document.activeElement === element };
  }
  return { focused: false };
}

/**
 * Generate accessibility snapshot.
 * Inside an iframe the refs are tagged ([f3:s1e42]) so the action comes back to THIS
 * frame: the snapshot is generated per document, and "s1e42" exists in every one of them.
 */
function handleGenerateSnapshot(payload?: { frame?: string }): string {
  const snapshot = generateSnapshot();
  const text = formatSnapshotAsText(snapshot);
  if (!payload?.frame) return text;
  return text.replace(/\[(s\d+e\d+)(\||\])/g, `[${payload.frame}:$1$2`);
}

/**
 * Get CSS selector for an element ref.
 */
function handleGetSelector(payload: { ref: string }): string {
  const element = getElementByRef(payload.ref);
  if (!element) {
    const snapshot = getCurrentSnapshot();
    if (!snapshot) {
      throw new Error('No snapshot available. Generate a snapshot first.');
    }

    const refMatch = payload.ref.match(/^s(\d+)e/);
    if (refMatch && parseInt(refMatch[1], 10) !== snapshot.generation) {
      throw new Error(
        `Stale element reference. Snapshot generation is ${snapshot.generation}, ` +
        `but ref is from generation ${refMatch[1]}. Regenerate snapshot.`
      );
    }

    throw new Error(`Element not found for ref: ${payload.ref}`);
  }

  return buildSelector(element);
}

/**
 * Get center coordinates of an element.
 */
async function handleGetElementCoordinates(
  payload: { selector: string; clickable?: boolean }
): Promise<Coordinates> {
  const element = await findElement(payload.selector, {
    visible: true,
    clickable: payload.clickable,
  });

  return getElementCenter(element);
}

/**
 * Scroll element into view.
 */
async function handleScrollIntoView(payload: { selector: string }): Promise<void> {
  const element = await findElement(payload.selector, { visible: false });
  await scrollIntoView(element);
}

/**
 * Select option(s) in a dropdown.
 * Accepts the four shapes the tool exposes: `values` (a list, for <select multiple>),
 * `value` (the value attribute), `label` (visible text) and `index` (0-based position).
 */
async function handleSelectOption(
  payload: { selector: string; values?: string[]; value?: string; label?: string; index?: number }
): Promise<{ selected: string[] }> {
  const element = await findElement(payload.selector);

  if (!(element instanceof HTMLSelectElement)) {
    throw new Error('Element is not a <select>');
  }

  const select = element;
  const options = Array.from(select.options);

  const chosen: HTMLOptionElement[] = [];
  if (payload.index !== undefined) {
    const option = options[payload.index];
    if (!option) throw new Error(`Option index out of range: ${payload.index}`);
    chosen.push(option);
  }
  if (payload.label !== undefined) {
    const option = options.find(opt => (opt.textContent ?? '').trim() === payload.label);
    if (!option) throw new Error(`Option not found by label: ${payload.label}`);
    chosen.push(option);
  }
  if (payload.value !== undefined) {
    const option = options.find(opt => opt.value === payload.value);
    if (!option) throw new Error(`Option not found by value: ${payload.value}`);
    chosen.push(option);
  }
  for (const value of payload.values ?? []) {
    const option = options.find(
      opt => opt.value === value || opt.textContent?.trim() === value
    );
    if (!option) throw new Error(`Option not found: ${value}`);
    chosen.push(option);
  }

  if (!chosen.length) {
    throw new Error('One of value, label, index or values is required');
  }

  const toSelect = select.multiple ? chosen : chosen.slice(0, 1);

  // Clear previous selection if single-select
  if (!select.multiple) {
    select.value = '';
  }

  for (const option of toSelect) {
    option.selected = true;
  }

  // Dispatch events
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));

  return { selected: toSelect.map(o => o.value) };
}

/**
 * Get text content of an element.
 */
async function handleGetText(payload: { selector: string }): Promise<string> {
  const element = await findElement(payload.selector);
  return element.textContent?.trim() || '';
}

/**
 * Get attribute value of an element.
 */
async function handleGetAttribute(
  payload: { selector: string; attribute: string }
): Promise<string | null> {
  const element = await findElement(payload.selector);
  return element.getAttribute(payload.attribute);
}

/**
 * Check if element is visible.
 */
async function handleIsVisible(payload: { selector: string }): Promise<boolean> {
  try {
    const element = document.querySelector(payload.selector);
    if (!element) {
      return false;
    }
    return isElementVisible(element);
  } catch {
    return false;
  }
}

/**
 * Wait for element to appear.
 */
async function handleWaitForElement(
  payload: { selector: string; timeout?: number }
): Promise<boolean> {
  try {
    await findElement(payload.selector, {
      timeout: payload.timeout || CONFIG.ELEMENT_WAIT_TIMEOUT_MS,
      visible: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Highlight an element visually (for debugging).
 */
async function handleHighlight(payload: { selector: string }): Promise<void> {
  // Remove previous highlight
  if (highlightOverlay) {
    highlightOverlay.remove();
    highlightOverlay = null;
  }

  const element = await findElement(payload.selector);
  const rect = element.getBoundingClientRect();

  highlightOverlay = document.createElement('div');
  highlightOverlay.style.cssText = getHighlightCSS(rect);

  document.body.appendChild(highlightOverlay);

  // Remove after highlight duration
  setTimeout(() => {
    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }
  }, TIMEOUTS.HIGHLIGHT_DURATION);
}

/**
 * Wait for DOM to stabilize (no mutations for a period).
 */
function handleWaitForDomStable(payload: { timeout?: number }): Promise<void> {
  const timeout = payload.timeout || CONFIG.DOM_STABILITY_MS;

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, timeout);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    // Start the timer immediately
    timer = setTimeout(() => {
      observer.disconnect();
      resolve();
    }, timeout);
  });
}

/**
 * Get page information.
 */
function handleGetPageInfo(): { url: string; title: string } {
  return {
    url: window.location.href,
    title: document.title,
  };
}

// Log that content script is loaded
console.log('[AgentJake] Content script loaded');
