/**
 * Real sockets: the extension's WebSocketClient against a loopback server that applies the SAME negotiation
 * decisions as the product server (protocol package: negotiateVersion + exact catalog digest).
 * The matrix is a fixed fixture committed with the tests (vendor/protocol/version-matrix.json, identical to the
 * server repo's copy).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { CATALOG_VERSION, negotiateVersion, parseClientFrame } from '@agent-jake-browser/protocol';
import { WebSocketClient } from '../../../src/background/ws-client';

const matrix = JSON.parse(readFileSync(resolve(__dirname, '../../../../../vendor/protocol/version-matrix.json'), 'utf8'));
let port = 0;

vi.mock('@/config/runtime', () => ({
  getEffectiveConfig: vi.fn(async () => ({ wireMode: 'negotiated', connectionId: 'inst-1' })),
  buildWsUrl: vi.fn(() => `ws://127.0.0.1:${port}/ws/harness`),
  ensureProfileEpoch: vi.fn(async () => 'epoch-1'),
}));
vi.mock('@/utils/logger', () => ({ log: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/background/activity-log', () => ({ logConnection: vi.fn(), logError: vi.fn() }));

type ServerKind = { kind: 'negotiated'; versions: number[]; catalog: 'current' | 'stale' } | { kind: 'legacy' };

function startServer(cfg: ServerKind): Promise<{ wss: WebSocketServer; toolsSeen: unknown[] }> {
  const toolsSeen: unknown[] = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws: ServerSocket) => {
    if (cfg.kind === 'legacy') {
      // A legacy server never waits for a hello: it just starts driving the browser with unversioned frames.
      ws.send(JSON.stringify({ id: 'legacy-1', type: 'browser_state', payload: {} }));
      return;
    }
    ws.on('message', (data) => {
      const hello = parseClientFrame(data.toString());
      if (hello.type !== 'hello') return;
      const version = negotiateVersion(cfg.versions, hello.supportedProtocolVersions);
      const catalog = cfg.catalog === 'stale' ? `sha256:${'0'.repeat(64)}` : CATALOG_VERSION;
      if (version === null) {
        ws.send(JSON.stringify({ type: 'hello_reject', error: { code: 'protocol_version_mismatch', message: 'no common version' }, supportedProtocolVersions: cfg.versions }));
      } else if (hello.catalogVersion !== catalog) {
        ws.send(JSON.stringify({ type: 'hello_reject', error: { code: 'catalog_version_mismatch', message: 'catalog differs' } }));
      } else {
        ws.send(JSON.stringify({ type: 'hello_ack', protocolVersion: version, protocolPackageVersion: '0.1.0', catalogVersion: catalog, serverVersion: '1.0.0', browserId: 'b1', connectionId: 'c1', house: 'h', capabilities: [] }));
      }
    });
  });
  return new Promise((resolveStart) => wss.on('listening', () => {
    port = (wss.address() as { port: number }).port;
    resolveStart({ wss, toolsSeen });
  }));
}

describe('extension x server version matrix (fixed fixture, real WebSocket)', () => {
  let wss: WebSocketServer | undefined;
  let client: WebSocketClient;
  const handler = vi.fn();

  beforeEach(() => {
    handler.mockReset();
    client = new WebSocketClient();
    client.setMessageHandler(handler);
  });
  afterEach(async () => {
    client.disconnect();
    await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
    wss = undefined;
  });

  for (const row of matrix.extensionView) {
    it(row.name, async () => {
      ({ wss } = await startServer(row.server));
      const result = await client.connect().then(() => 'connected', (e: Error) => e.message);
      const status = client.getNegotiationStatus();
      if (row.expect.state === 'READY') {
        expect(result).toBe('connected');
        expect(status).toMatchObject({ state: 'READY', protocolVersion: row.expect.protocolVersion });
        expect(client.isConnected()).toBe(true);
      } else {
        expect(result).toContain(row.expect.code);
        expect(status).toMatchObject({ state: 'BLOCKED', error: { code: row.expect.code } });
        expect(client.isConnected()).toBe(false);
        expect(handler).not.toHaveBeenCalled(); // the incompatible pair executed nothing
      }
    });
  }
});
