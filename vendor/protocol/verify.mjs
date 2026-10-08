#!/usr/bin/env node
/**
 * Offline verification of the vendored @agent-jake-browser/protocol artifact.
 * Independent of the package's own code: it recomputes the catalog digest with node:crypto.
 * Integrity tied to the pinned source/TGZ, not a publisher signature (no signing key exists).
 *
 *   node verify.mjs <package.tgz> <provenance.json>
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const verifierSha256 = () => sha256(readFileSync(new URL(import.meta.url)));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
export function recomputeDigest(descriptors) {
  const sorted = [...descriptors].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `sha256:${sha256(Buffer.from(canonicalJson(sorted), 'utf8'))}`;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

/** Returns { ok, errors[] }; never throws for a bad artifact. */
export async function verifyArtifact({ tgz, provenance }) {
  const errors = [];
  const prov = JSON.parse(readFileSync(provenance, 'utf8'));
  const tgzBytes = readFileSync(tgz);
  if (sha256(tgzBytes) !== prov.tgzSha256) errors.push('tgz sha256 does not match provenance');

  const dir = mkdtempSync(join(tmpdir(), 'ajb-protocol-'));
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
    const root = join(dir, 'package');
    const files = listFiles(root);
    const unexpected = files.filter((f) => f !== 'package.json' && !f.startsWith('dist/') && !/^(LICENSE|README)/i.test(f));
    if (unexpected.length) errors.push(`unexpected files in pack: ${unexpected.join(', ')}`);

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const meta = pkg.browserHarnessProtocol;
    if (!meta) errors.push('package.json lacks browserHarnessProtocol metadata');
    if (pkg.name !== prov.package || pkg.version !== prov.version) errors.push('package name/version differ from provenance');

    const mod = await import(`${pathToFileURL(join(root, 'dist/index.js')).href}?v=${Date.now()}`);
    const recomputed = recomputeDigest(mod.TOOL_CATALOG);
    if (meta && meta.catalogVersion !== recomputed) errors.push('manifest catalogVersion differs from packed descriptors');
    if (mod.CATALOG_VERSION !== recomputed) errors.push('exported CATALOG_VERSION differs from packed descriptors');
    if (prov.catalogVersion !== recomputed) errors.push('provenance catalogVersion differs from packed descriptors');
    const sv = (a) => JSON.stringify(a);
    if (meta && sv(meta.supportedProtocolVersions) !== sv(prov.supportedProtocolVersions)) errors.push('manifest wire versions differ from provenance');
    if (sv([...mod.SUPPORTED_PROTOCOL_VERSIONS]) !== sv(prov.supportedProtocolVersions)) errors.push('exported wire versions differ from provenance');
  } catch (err) {
    errors.push(`verification failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tgz, provenance] = process.argv.slice(2);
  if (!tgz || !provenance) {
    console.error('usage: verify.mjs <package.tgz> <provenance.json>');
    process.exit(2);
  }
  const { ok, errors } = await verifyArtifact({ tgz, provenance });
  if (!ok) {
    for (const e of errors) console.error(`FAIL: ${e}`);
    process.exit(1);
  }
  console.log('protocol artifact verified (hash + offline catalog digest)');
}
