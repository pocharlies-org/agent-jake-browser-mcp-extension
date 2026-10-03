/**
 * Runtime server configuration.
 *
 * Build-time CONFIG (VITE_WS_*) remains the fallback, but the server URL and
 * the auth token can be overridden at runtime from the popup and are
 * persisted in chrome.storage.local under the F-Multi / F-Descarga contract
 * keys:
 *   ajb.serverUrl     full ws(s)://host[:port][/path] entered by the user (S2)
 *   ajb.token         token obtained via pairing or typed by the user
 *   ajb.connectionId  persistent UUID that identifies this browser install
 *   ajb.pairCode      OTP of an in-flight pairing flow (survives SW restarts)
 *
 * A packaged `config.json` at the extension root (injected by the server when
 * it builds the download zip) sits between those two levels. Full precedence:
 *   1. ajb.serverUrl in chrome.storage.local  (manual override / pairing)
 *   2. config.json in the package            ({"version":1,"wsUrl":"wss://..."})
 *   3. build-time VITE_WS_* defaults
 * Any missing/invalid config.json falls back silently to level 3.
 */

import { CONFIG } from '@/types/config';

export const STORAGE_KEYS = {
  serverUrl: 'ajb.serverUrl',
  token: 'ajb.token',
  connectionId: 'ajb.connectionId',
  pairCode: 'ajb.pairCode',
  /** 'legacy' (default, unchanged wire) | 'negotiated' (hello + version/catalog check, no fallback). */
  wireMode: 'ajb.wireMode',
} as const;

export type WireMode = 'legacy' | 'negotiated';

export interface ParsedServerUrl {
  secure: boolean;
  hostname: string;
  port: number;
  /** Normalised path: '' or '/something' (never a bare '/'). */
  path: string;
}

export interface RuntimeServerConfig extends ParsedServerUrl {
  scheme: 'ws' | 'wss';
  /** Effective auth token (storage value wins, build default is fallback). */
  token: string;
  /** Persistent per-install UUID (always present). */
  connectionId: string;
  /** Which wire this install speaks. Existing installs stay `legacy` until explicitly switched. */
  wireMode: WireMode;
  /** Where host/port/path came from. */
  source: ServerConfigSource;
  /** True when host/port/path come from ajb.serverUrl (source === 'manual'). */
  fromStorage: boolean;
}

export type ServerConfigSource = 'manual' | 'config.json' | 'build';

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return chrome.storage.local.get(keys) as Promise<Record<string, unknown>>;
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return chrome.storage.local.set(items);
}

function storageRemove(keys: string[]): Promise<void> {
  return chrome.storage.local.remove(keys);
}

/**
 * Parse a user-typed server URL. Accepts ws(s):// and http(s):// schemes;
 * a bare host (no scheme) is treated as secure (wss) so remote installs do
 * not silently downgrade. Returns null when the value is unusable.
 */
export function parseWsUrl(raw: string): ParsedServerUrl | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `wss://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  let secure: boolean;
  switch (url.protocol) {
    case 'ws:': secure = false; break;
    case 'wss:': secure = true; break;
    case 'http:': secure = false; break;
    case 'https:': secure = true; break;
    default: return null;
  }

  if (!url.hostname) return null;

  const port = url.port
    ? Number(url.port)
    : secure ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');

  return { secure, hostname: url.hostname, port, path };
}

/**
 * Parsed `config.json` shipped inside the extension package (the server
 * injects it when serving /download). Loaded once per service-worker
 * lifetime; any problem (missing file, bad JSON, wrong version, invalid
 * wsUrl) resolves to null and the caller silently falls through.
 */
export const BUNDLE_CONFIG_FILE = 'config.json';

let bundleConfigCache: Promise<ParsedServerUrl | null> | null = null;

async function fetchBundleConfig(): Promise<ParsedServerUrl | null> {
  try {
    const response = await fetch(chrome.runtime.getURL(BUNDLE_CONFIG_FILE));
    // Missing extension resources may surface as an error status or as an
    // opaque synthesized page; json() then throws and we catch below.
    if (response.status && response.status >= 400) return null;
    const raw = await response.json() as { version?: unknown; wsUrl?: unknown };
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version !== 1) return null;
    if (typeof raw.wsUrl !== 'string') return null;
    const trimmed = raw.wsUrl.trim();
    // The embedded config must be an explicit ws/wss URL — no bare hosts.
    if (!/^wss?:\/\//i.test(trimmed)) return null;
    return parseWsUrl(trimmed);
  } catch {
    return null;
  }
}

/**
 * Cached load of the packaged config.json (promise memoised for the SW
 * lifetime, including negative results). Exported for diagnostics/tests.
 */
export function loadBundleConfig(): Promise<ParsedServerUrl | null> {
  if (!bundleConfigCache) {
    bundleConfigCache = fetchBundleConfig();
  }
  return bundleConfigCache;
}

/**
 * Ensure the persistent per-install connection UUID exists and return it.
 */
export async function ensureConnectionId(): Promise<string> {
  const stored = await storageGet([STORAGE_KEYS.connectionId]);
  const existing = stored[STORAGE_KEYS.connectionId];
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  const id = crypto.randomUUID();
  await storageSet({ [STORAGE_KEYS.connectionId]: id });
  return id;
}

/**
 * Effective server config following the precedence
 * storage (ajb.serverUrl) > packaged config.json > build defaults.
 * Token follows `ajb.token ?? CONFIG.WS_TOKEN`
 * (an explicitly stored empty string clears the token for open-LAN setups).
 */
export async function getEffectiveConfig(): Promise<RuntimeServerConfig> {
  const stored = await storageGet([STORAGE_KEYS.serverUrl, STORAGE_KEYS.token, STORAGE_KEYS.wireMode]);
  const rawUrl = typeof stored[STORAGE_KEYS.serverUrl] === 'string'
    ? (stored[STORAGE_KEYS.serverUrl] as string)
    : '';
  const parsed = parseWsUrl(rawUrl);

  let base: ParsedServerUrl;
  let source: ServerConfigSource;
  if (parsed) {
    base = parsed;
    source = 'manual';
  } else {
    const bundle = await loadBundleConfig();
    if (bundle) {
      base = bundle;
      source = 'config.json';
    } else {
      base = {
        secure: CONFIG.WS_SECURE,
        hostname: CONFIG.WS_HOST,
        port: CONFIG.WS_PORT,
        path: CONFIG.WS_PATH ? `/${CONFIG.WS_PATH.replace(/^\/+/, '').replace(/\/+$/, '')}` : '',
      };
      source = 'build';
    }
  }

  const token = typeof stored[STORAGE_KEYS.token] === 'string'
    ? (stored[STORAGE_KEYS.token] as string)
    : CONFIG.WS_TOKEN;

  const connectionId = await ensureConnectionId();

  return {
    ...base,
    scheme: base.secure ? 'wss' : 'ws',
    token,
    connectionId,
    wireMode: stored[STORAGE_KEYS.wireMode] === 'negotiated' ? 'negotiated' : 'legacy',
    source,
    fromStorage: source === 'manual',
  };
}

/**
 * Save (or clear, with '' / null) the runtime server URL override.
 */
export async function setServerUrl(url: string | null): Promise<void> {
  const trimmed = (url ?? '').trim();
  if (!trimmed) {
    await storageRemove([STORAGE_KEYS.serverUrl]);
    return;
  }
  await storageSet({ [STORAGE_KEYS.serverUrl]: trimmed });
}

/**
 * Save an explicit token. '' is a real value: it clears the token (open LAN)
 * rather than falling back to the build default. Pass null to remove the
 * override entirely and fall back to CONFIG.WS_TOKEN.
 */
export async function setToken(token: string | null): Promise<void> {
  if (token === null) {
    await storageRemove([STORAGE_KEYS.token]);
    return;
  }
  await storageSet({ [STORAGE_KEYS.token]: token });
}

/** Persist the wire mode. 'legacy' removes the key so old installs keep behaving exactly as before. */
export async function setWireMode(mode: WireMode): Promise<void> {
  if (mode === 'negotiated') await storageSet({ [STORAGE_KEYS.wireMode]: 'negotiated' });
  else await storageRemove([STORAGE_KEYS.wireMode]);
}

let fallbackEpoch: string | null = null;

/**
 * Profile epoch: changes when the browser session restarts (chrome.storage.session is cleared then), so any
 * server-side state tied to the old epoch is invalid. Falls back to a per-worker UUID when session storage is absent.
 */
export async function ensureProfileEpoch(): Promise<string> {
  try {
    const area = (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session;
    if (area) {
      const stored = await area.get(['ajb.profileEpoch']);
      const existing = stored['ajb.profileEpoch'];
      if (typeof existing === 'string' && existing) return existing;
      const fresh = crypto.randomUUID();
      await area.set({ 'ajb.profileEpoch': fresh });
      return fresh;
    }
  } catch {
    // fall through to the per-worker value
  }
  fallbackEpoch ??= crypto.randomUUID();
  return fallbackEpoch;
}

/**
 * WebSocket endpoint for a config: scheme://host[:port]/path with the
 * handshake query `token` (when set) and `connectionId`, URL-encoded.
 */
export function buildWsUrl(cfg: RuntimeServerConfig): string {
  const defaultPort = cfg.secure ? 443 : 80;
  const portSuffix = cfg.port === defaultPort ? '' : `:${cfg.port}`;
  const params = new URLSearchParams();
  if (cfg.token) params.set('token', cfg.token);
  params.set('connectionId', cfg.connectionId);
  return `${cfg.scheme}://${cfg.hostname}${portSuffix}${cfg.path}?${params.toString()}`;
}

/** Endpoint without the handshake query, for display in the popup. */
export function buildDisplayUrl(cfg: RuntimeServerConfig): string {
  const defaultPort = cfg.secure ? 443 : 80;
  const portSuffix = cfg.port === defaultPort ? '' : `:${cfg.port}`;
  return `${cfg.scheme}://${cfg.hostname}${portSuffix}${cfg.path}`;
}

/**
 * HTTP(S) origin paired with a WS config (wss→https, ws→http), used for the
 * /pair/* endpoints and the download page.
 */
export function httpOrigin(cfg: RuntimeServerConfig): string {
  const scheme = cfg.secure ? 'https' : 'http';
  const defaultPort = cfg.secure ? 443 : 80;
  const portSuffix = cfg.port === defaultPort ? '' : `:${cfg.port}`;
  return `${scheme}://${cfg.hostname}${portSuffix}`;
}

/** Whether the server URL currently comes from the user-editable override. */
export async function hasStoredServerUrl(): Promise<boolean> {
  const stored = await storageGet([STORAGE_KEYS.serverUrl]);
  return typeof stored[STORAGE_KEYS.serverUrl] === 'string'
    && (stored[STORAGE_KEYS.serverUrl] as string).trim() !== '';
}
