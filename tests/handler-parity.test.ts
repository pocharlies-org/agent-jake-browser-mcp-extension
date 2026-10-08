import { TOOL_CATALOG } from '@agent-jake-browser/protocol';
import { describe, expect, it } from 'vitest';
import { createHandlerMap } from '../packages/core/src/background/tool-handlers';
import type { HandlerContext } from '../packages/core/src/background/tools/handlers';

// The handler factories only close over ctx; nothing runs until a request arrives.
const handlers = () => createHandlerMap({} as HandlerContext);
// Tools the server answers without a browser (serverSide) have no extension handler by design.
// browser_run_code_unsafe also runs in the server process (it sends browser_cdp / browser_evaluate) but the
// catalog does not mark it serverSide; marking it changes CATALOG_VERSION (a contract change, INFRA-719), so it is listed here.
const SERVER_PROCESS_ONLY = ['browser_run_code_unsafe'];
const browserTools = TOOL_CATALOG.filter((t) => !t.serverSide && !SERVER_PROCESS_ONLY.includes(t.name)).map((t) => t.name);

/** What the extension lacks and what it has that the protocol does not know. */
function drift(map: Record<string, unknown>, names: readonly string[]) {
  const have = Object.keys(map);
  return {
    missing: names.filter((n) => !have.includes(n)).sort(),
    extra: have.filter((n) => !names.includes(n)).sort(),
  };
}

describe('extension handlers vs protocol TOOL_CATALOG (C6c)', () => {
  it('has exactly one handler for every tool the browser answers', () => {
    expect(drift(handlers(), browserTools)).toEqual({ missing: [], extra: [] });
  });
  it('the exception stays honest: a catalog tool with no extension handler', () => {
    expect(SERVER_PROCESS_ONLY.filter((n) => !TOOL_CATALOG.some((t) => t.name === n) || n in handlers())).toEqual([]);
  });
  it('fails when a handler is missing', () => {
    const map = handlers();
    delete map.browser_click;
    expect(drift(map, browserTools)).toEqual({ missing: ['browser_click'], extra: [] });
  });
  it('fails when a handler is not in the catalog', () => {
    const map = { ...handlers(), browser_not_in_protocol: async () => ({}) };
    expect(drift(map, browserTools)).toEqual({ missing: [], extra: ['browser_not_in_protocol'] });
  });
});
