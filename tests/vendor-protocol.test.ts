import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM verifier vendored next to the artifact
import { verifyArtifact } from '../vendor/protocol/verify.mjs';

const root = resolve(__dirname, '..');
const dir = join(root, 'vendor/protocol');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const prov = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));

describe('vendored @agent-jake-browser/protocol (provenance, hash, offline catalog digest)', () => {
  it('tgz bytes, descriptors, manifest and exports are consistent with provenance', async () => {
    const r = await verifyArtifact({ tgz: join(dir, 'agent-jake-browser-protocol.tgz'), provenance: join(dir, 'provenance.json') });
    expect(r).toEqual({ ok: true, errors: [] });
  });
  it('the vendored verifier is the one the provenance recorded', () => {
    expect(sha(readFileSync(join(dir, 'verify.mjs')))).toBe(prov.verifierSha256);
  });
  it('the lockfile pins the same tarball with npm integrity', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const entry = lock.packages['node_modules/@agent-jake-browser/protocol'];
    expect(entry.resolved).toBe('file:vendor/protocol/agent-jake-browser-protocol.tgz');
    const sri = `sha512-${createHash('sha512').update(readFileSync(join(dir, 'agent-jake-browser-protocol.tgz'))).digest('base64')}`;
    expect(entry.integrity).toBe(sri);
  });
  it('provenance names the canonical source and records the pinned wire/catalog', () => {
    expect(prov.sourceRepo).toBe('pocharlies-org/agent-jake-browser-mcp-server');
    expect(prov.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(prov.supportedProtocolVersions).toEqual([1]);
    expect(prov.catalogVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('core without houses (D2)', () => {
  const FORBIDDEN = /house-pocharlies|house-staticduo|op-safe/;
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  it('packages/core references no house adapter or op-safe', () => {
    const offenders = walk(join(root, 'packages/core')).filter((f) => !f.endsWith('vendor-protocol.test.ts') && FORBIDDEN.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
