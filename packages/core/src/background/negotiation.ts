/**
 * Pure pieces of the negotiated Browser Harness handshake (client side).
 * Schemas, limits and version negotiation come ONLY from @agent-jake-browser/protocol (vendored tgz).
 */
import {
  CATALOG_VERSION,
  MAX_IDENTIFIER_BYTES,
  PROTOCOL_PACKAGE_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ServerHelloSchema,
  utf8ByteLength,
  type ClientHello,
  type ServerHello,
} from '@agent-jake-browser/protocol';

/** Explicit, observable connection states. READY is never persisted as truth across worker restarts. */
export type ConnState = 'DISCONNECTED' | 'CONNECTING' | 'NEGOTIATING' | 'READY' | 'RETRY_WAIT' | 'BLOCKED';

export interface NegotiationStatus {
  mode: 'legacy' | 'negotiated';
  state: ConnState | 'LEGACY';
  /** Stable code of the last failure (protocol/auth/catalog/transient), if any. */
  error: { code: string; message: string } | null;
  /** Endpoint without handshake query (no token). */
  endpoint: string;
  protocolVersion: number | null;
  catalogVersion: string;
}

function clampIdentifier(value: string, fallback: string): string {
  let out = value || fallback;
  while (utf8ByteLength(out) > MAX_IDENTIFIER_BYTES) out = out.slice(0, -1);
  return out || fallback;
}

export function buildHello(input: {
  clientVersion: string;
  installationId: string;
  profileEpoch: string;
  platform: string;
}): ClientHello {
  return {
    type: 'hello',
    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    protocolPackageVersion: PROTOCOL_PACKAGE_VERSION,
    catalogVersion: CATALOG_VERSION,
    clientVersion: clampIdentifier(input.clientVersion, '0.0.0'),
    installationId: clampIdentifier(input.installationId, 'unknown'),
    profileEpoch: clampIdentifier(input.profileEpoch, 'unknown'),
    platform: clampIdentifier(input.platform, 'unknown'),
    capabilities: [],
  };
}

export type AckCheck = { ok: true; ack: ServerHello } | { ok: false; code: string; message: string };

/** Validate the server ack against what THIS client offered. Anything else is an explicit failure. */
export function validateAck(frame: unknown, offered: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS): AckCheck {
  const parsed = ServerHelloSchema.safeParse(frame);
  if (!parsed.success) return { ok: false, code: 'invalid_message', message: 'hello_ack does not match the protocol schema' };
  const ack = parsed.data;
  if (!offered.includes(ack.protocolVersion)) {
    return { ok: false, code: 'protocol_version_mismatch', message: `server chose version ${ack.protocolVersion}, which was not offered` };
  }
  if (ack.catalogVersion !== CATALOG_VERSION) {
    return { ok: false, code: 'catalog_version_mismatch', message: 'server tool catalog differs from this extension' };
  }
  return { ok: true, ack };
}

export function describePlatform(): string {
  const nav = (globalThis as { navigator?: { userAgentData?: { platform?: string }; platform?: string } }).navigator;
  return nav?.userAgentData?.platform || nav?.platform || 'unknown';
}

export function describeClientVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

/** Display form of a ws(s) URL: no query string, so the token never reaches status UI or logs. */
export function sanitizeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}
