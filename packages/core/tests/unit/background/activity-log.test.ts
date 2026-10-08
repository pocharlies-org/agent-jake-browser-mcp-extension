import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activityLog, logTool } from '@/background/activity-log';

const key = 'agent_jake_activity_log';
const stored: Record<string, unknown> = {};

beforeEach(async () => {
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: vi.fn(async () => ({ [key]: stored[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(stored, items)),
      remove: vi.fn(async () => { delete stored[key]; }),
    } },
  });
  await activityLog.clear();
});

describe('durable activity history', () => {
  it('stores tool metadata without network, console or form secrets', async () => {
    const secret = 'secret-marker-729';
    await logTool('browser_network_request', `Response: ${secret}`, true, 7, {
      payload: { authorization: secret, fields: [{ value: secret }] },
      result: { responseBody: secret, logs: [{ text: secret }] },
    });

    const saved = JSON.stringify(stored[key]);
    expect(saved).not.toContain(secret);
    expect(saved).toContain('browser_network_request');
    expect(saved).not.toContain('payload');
    expect(saved).not.toContain('result');
  });

  it('never keeps the text a browser_fill_secret typed (payload flagged secret, echoed in the result)', async () => {
    const secret = 'hunter2-Sup3r$ecret';
    await logTool('browser_type', `Type "${secret.slice(0, 20)}"`, true, 9, {
      payload: { selector: '#pw', text: secret, clear: true, secret: true },
      result: { typed: secret, cleared: true },
    });
    const saved = JSON.stringify(stored[key]);
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain(secret.slice(0, 6));
    expect(saved).toContain('browser_type');
  });

  it('keeps numeric diagnostics while removing URLs and remote text', async () => {
    const { logConnection } = await import('@/background/activity-log');
    await logConnection('ws_close', 'https://example.test/?token=secret-marker-729', true,
      { code: 1006, reason: 'secret-marker-729' });
    const [entry] = (await activityLog.getAll()).activities;
    expect(entry.details).toEqual({ code: 1006 });
    expect(JSON.stringify(stored[key])).not.toContain('secret-marker-729');
  });

  it('removes sensitive details from entries persisted by older versions', async () => {
    await activityLog.clear();
    const secret = 'old-secret-marker-307';
    stored[key] = [{ id: 'old', timestamp: 1, type: 'tool', action: 'browser_get_console_logs',
      description: secret, details: { logs: [{ text: secret }] }, success: true }];

    vi.resetModules();
    const { activityLog: freshLog } = await import('@/background/activity-log');
    const history = await freshLog.getAll();
    expect(history.activities[0].description).toBe('browser get console logs');
    expect(JSON.stringify(stored[key])).not.toContain(secret);
  });

  it('deletes old secret-bearing history if its sanitized rewrite fails', async () => {
    await activityLog.clear();
    stored[key] = [{ id: 'old', timestamp: 1, type: 'tool', action: 'browser_network_request',
      description: 'old-secret', details: { responseBody: 'old-secret' }, success: true }];
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('quota exceeded'));
    vi.resetModules();
    const { activityLog: freshLog } = await import('@/background/activity-log');

    expect((await freshLog.getAll()).activities).toEqual([]);
    expect(stored[key]).toBeUndefined();
  });

  it('fails closed if neither rewriting nor deleting old secret-bearing history works', async () => {
    await activityLog.clear();
    stored[key] = [{ id: 'old', timestamp: 1, type: 'tool', action: 'browser_network_request',
      description: 'old-secret', success: true }];
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('quota exceeded'));
    vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(new Error('storage unavailable'));
    vi.resetModules();
    const { activityLog: freshLog } = await import('@/background/activity-log');

    await expect(freshLog.getAll()).rejects.toThrow('storage unavailable');
  });
});
