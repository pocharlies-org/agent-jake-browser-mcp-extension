/**
 * Interaction tool handlers: click, type, hover, press_key, snapshot.
 *
 * Everything that acts on a ref first resolves WHICH FRAME that ref lives in and sends
 * its orders to that frame. The click stays a trusted CDP event as long as the element's
 * position can be translated into top-frame coordinates (same-origin iframes); inside a
 * cross-origin iframe that translation does not exist, and rather than firing at the
 * wrong point of the page it falls back to a programmatic click inside the frame.
 */
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap, Coordinates } from './types';

export function createInteractionHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, sendToAllFrames, resolveRef, waitForStableOrNavigation } = ctx;

  return {
    browser_snapshot: async () => {
      const frames = await sendToAllFrames<string>('generateSnapshot');
      const { url, title } = await sendToContent<{ url: string; title: string }>('getPageInfo');

      const snapshot = frames
        .map((f) => (f.frameId === 0 ? f.data : `# frame f${f.frameId} — ${f.url}\n${f.data}`))
        .join('\n');

      return { url, title, snapshot, frames: frames.length };
    },

    browser_click: async (payload) => {
      const { ref } = schemas.browser_click.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();
      if (!tabId) throw new Error('No tab connected');

      const initialTab = await chrome.tabs.get(tabId);
      const initialUrl = initialTab.url || '';

      ctx.tabManager.startNewTabDetection();

      try {
        const { frameId, selector } = await resolveRef(ref);
        await sendToContent('scrollIntoView', { selector }, frameId);

        const coords = await sendToContent<Coordinates>('getElementCoordinates', {
          selector,
          clickable: true,
        }, frameId);

        let trusted = true;
        if (coords.exact === false) {
          // Cross-origin iframe: there is no way to know where it lands on the page.
          await sendToContent('dispatchClick', { selector }, frameId);
          trusted = false;
        } else {
          await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
          await ctx.dispatchMouseEventTyped('mousePressed', coords.x, coords.y, 'left', 1);
          await ctx.dispatchMouseEventTyped('mouseReleased', coords.x, coords.y, 'left', 1);
        }

        const result = await waitForStableOrNavigation(initialUrl, frameId);

        await new Promise(resolve => setTimeout(resolve, 100));

        const newTab = ctx.tabManager.stopNewTabDetection();

        if (result.navigated) {
          return {
            clicked: ref,
            navigated: true,
            newUrl: result.newUrl,
            ...(trusted ? {} : { trusted: false }),
            ...(newTab && { newTabOpened: newTab }),
          };
        }
        return {
          clicked: ref,
          ...(trusted ? {} : { trusted: false }),
          ...(newTab && { newTabOpened: newTab }),
        };
      } catch (error) {
        ctx.tabManager.stopNewTabDetection();
        throw error;
      }
    },

    browser_type: async (payload) => {
      const { ref, text, clear, secret } = schemas.browser_type.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();
      if (!tabId) throw new Error('No tab connected');

      const initialTab = await chrome.tabs.get(tabId);
      const initialUrl = initialTab.url || '';

      const { frameId, selector } = await resolveRef(ref);
      await sendToContent('scrollIntoView', { selector }, frameId);

      const coords = await sendToContent<Coordinates>('getElementCoordinates', { selector }, frameId);

      if (coords.exact === false) {
        // With no reliable coordinates, focus is set from inside the frame. The focus
        // itself IS real, so the keys CDP sends next still reach this input.
        await sendToContent('focusElement', { selector }, frameId);
      } else {
        // Click to focus
        await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
        await ctx.dispatchMouseEventTyped('mousePressed', coords.x, coords.y, 'left', 1);
        await ctx.dispatchMouseEventTyped('mouseReleased', coords.x, coords.y, 'left', 1);
      }

      if (clear) {
        // A bare Control keyDown does not modify the next key over CDP: without
        // `modifiers` the "a" just types, and Backspace then eats one char
        // ("Dani" + clear + "Luis" = "DanLuis"). The editing command selects all
        // on every platform.
        await ctx.tabManager.sendDebuggerCommand('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'],
        });
        await ctx.tabManager.sendDebuggerCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
        });
        await ctx.dispatchKeyEventTyped('keyDown', 'Backspace');
        await ctx.dispatchKeyEventTyped('keyUp', 'Backspace');
      }

      for (const char of text) {
        await ctx.dispatchKeyEventTyped('keyDown', char);
        await ctx.dispatchKeyEventTyped('char', char, char);
        await ctx.dispatchKeyEventTyped('keyUp', char);
      }

      const result = await waitForStableOrNavigation(initialUrl, frameId);
      // A secret leaves no trace in the answer: not in the result the server gets, not in any log of it.
      const echo = secret ? {} : { typed: text };
      if (result.navigated) {
        return { ...echo, cleared: clear, navigated: true, newUrl: result.newUrl };
      }
      return { ...echo, cleared: clear };
    },

    browser_hover: async (payload) => {
      const { ref } = schemas.browser_hover.parse(payload);
      const { frameId, selector } = await resolveRef(ref);
      await sendToContent('scrollIntoView', { selector }, frameId);
      const coords = await sendToContent<Coordinates>('getElementCoordinates', { selector }, frameId);
      await ctx.dispatchMouseEventTyped('mouseMoved', coords.x, coords.y);
      return { hovered: ref };
    },

    browser_drag: async (payload) => {
      const parsed = schemas.browser_drag.parse(payload);
      const start = parsed.startRef ? await resolveRef(parsed.startRef) : { frameId: 0, selector: parsed.startSelector! };
      const end = parsed.endRef ? await resolveRef(parsed.endRef) : { frameId: 0, selector: parsed.endSelector! };

      await sendToContent('scrollIntoView', { selector: start.selector }, start.frameId);
      await sendToContent('scrollIntoView', { selector: end.selector }, end.frameId);
      const from = await sendToContent<Coordinates>('getElementCoordinates', { selector: start.selector }, start.frameId);
      const to = await sendToContent<Coordinates>('getElementCoordinates', { selector: end.selector }, end.frameId);

      // Trusted events over CDP, same as click. The intermediate moves are the
      // point: HTML5 drag-and-drop fires dragstart/dragover/drop only when the
      // pointer actually travels between press and release.
      await ctx.dispatchMouseEventTyped('mouseMoved', from.x, from.y);
      await ctx.dispatchMouseEventTyped('mousePressed', from.x, from.y, 'left', 1);
      const STEPS = 12;
      for (let i = 1; i <= STEPS; i++) {
        await ctx.dispatchMouseEventTyped(
          'mouseMoved',
          from.x + ((to.x - from.x) * i) / STEPS,
          from.y + ((to.y - from.y) * i) / STEPS,
          'left',
          1,
        );
      }
      await ctx.dispatchMouseEventTyped('mouseReleased', to.x, to.y, 'left', 1);

      return { dragged: `${parsed.startRef ?? parsed.startSelector} -> ${parsed.endRef ?? parsed.endSelector}` };
    },

    /**
     * The server has advertised browser_select_option all along, but the extension had
     * no handler for it: the tool always answered "Unknown tool". Any form with a
     * <select> — a bank transfer, to pick one — forced a drop down to raw JS.
     */
    browser_select_option: async (payload) => {
      const { ref, selector, value, label, index } = schemas.browser_select_option.parse(payload);
      const target = selector ? { frameId: 0, selector } : await resolveRef(ref!);
      await sendToContent('scrollIntoView', { selector: target.selector }, target.frameId);
      const { selected } = await sendToContent<{ selected: string[] }>('selectOption', {
        selector: target.selector,
        value,
        label,
        index,
      }, target.frameId);
      return { selected };
    },

    browser_press_key: async (payload) => {
      const { key } = schemas.browser_press_key.parse(payload);
      const tabId = ctx.tabManager.getConnectedTabId();
      if (!tabId) throw new Error('No tab connected');

      const initialTab = await chrome.tabs.get(tabId);
      const initialUrl = initialTab.url || '';

      await ctx.dispatchKeyEventTyped('keyDown', key);
      await ctx.dispatchKeyEventTyped('keyUp', key);

      const result = await waitForStableOrNavigation(initialUrl);
      if (result.navigated) {
        return { pressed: key, navigated: true, newUrl: result.newUrl };
      }
      return { pressed: key };
    },
  };
}
