import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

describe('core without houses (D2)', () => {
  const FORBIDDEN = /house-pocharlies|house-staticduo|op-safe/;
  it('packages/core references no house adapter or op-safe', () => {
    const offenders = walk(join(root, 'packages/core')).filter((f) => !f.endsWith('vendor-protocol.test.ts') && FORBIDDEN.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// C6d (INFRA-390): the vendored protocol is the only home of schemas. Until M1B.3 extracts the tool-argument schemas,
// the extension's own copies are listed; a new schema anywhere else (or one more in a listed file) fails here.
// M1B.3 lowers these numbers as schemas move to the protocol. Never raise one: use the vendored protocol instead.
const SCHEMA_MARKERS = /\bz\.(?:strict|loose)?[oO]bject\(|type: 'object'|^\s*tool\(/gm;
const BASELINE: Record<string, number> = {
  'packages/core/src/background/agent/tools-catalog.ts': 25,
  'packages/core/src/background/tools/schemas.ts': 30,
};

/** Schema markers per source file under packages/<pkg>/src. */
function schemaCopies(base: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const pkg of readdirSync(join(base, 'packages'))) {
    const src = join(base, 'packages', pkg, 'src');
    for (const f of statSync(src, { throwIfNoEntry: false })?.isDirectory() ? walk(src) : []) {
      const n = readFileSync(f, 'utf8').match(SCHEMA_MARKERS)?.length ?? 0;
      if (n) found[relative(base, f)] = n;
    }
  }
  return found;
}
const offenders = (found: Record<string, number>) =>
  [...new Set([...Object.keys(found), ...Object.keys(BASELINE)])].filter((f) => found[f] !== BASELINE[f]).sort();

describe('the vendored protocol is the only schema source (C6d)', () => {
  it('the extension holds no schema beyond the listed ones', () => {
    expect(offenders(schemaCopies(root))).toEqual([]);
  });
  describe('fails on a new copy', () => {
    const dirs: string[] = [];
    /** A fresh tree with the listed layout (n markers per listed file) plus `extra` files. */
    const tree = (extra: Record<string, string> = {}) => {
      const tmp = mkdtempSync(join(tmpdir(), 'ajb-schemas-'));
      dirs.push(tmp);
      const files = { ...Object.fromEntries(Object.entries(BASELINE).map(([rel, n]) => [rel, 'z.object({})\n'.repeat(n)])), ...extra };
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(tmp, rel)), { recursive: true });
        writeFileSync(join(tmp, rel), text);
      }
      return tmp;
    };
    afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

    it('the listed layout is clean', () => expect(offenders(schemaCopies(tree()))).toEqual([]));
    it('a schema in a new file (a house, say)', () => {
      const tmp = tree({ 'packages/house-pocharlies/src/copy.ts': 'export const S = z.object({ url: z.string() });\n' });
      expect(offenders(schemaCopies(tmp))).toEqual(['packages/house-pocharlies/src/copy.ts']);
    });
    it('one more schema in a listed file', () => {
      const tmp = tree({ 'packages/core/src/background/tools/schemas.ts': 'z.object({})\n'.repeat(31) });
      expect(offenders(schemaCopies(tmp))).toEqual(['packages/core/src/background/tools/schemas.ts']);
    });
  });
});
