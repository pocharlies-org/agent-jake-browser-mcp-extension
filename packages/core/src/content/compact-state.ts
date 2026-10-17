/**
 * COMPACT page state (DOM-first) — the default way to "see" a page.
 * Returns only VISIBLE interactive elements with a stable [n] ref (data-hx
 * attribute), not the whole accessibility tree: ~2 KB against the tens of KB
 * an ARIA snapshot costs. The ARIA snapshot stays as the fallback when this
 * is not enough.
 */

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
  '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]',
  '[role=combobox]', '[role=menuitem]', '[role=tab]', '[role=switch]',
  '[contenteditable="true"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** True for fields whose value is a secret: never emit it into the transcript (SC-2601). */
export function isSecretInput(type: string, autocomplete: string): boolean {
  if (type.toLowerCase() === 'password') return true;
  const ac = autocomplete.toLowerCase();
  return ac === 'current-password' || ac === 'new-password';
}

export interface CompactElement {
  i: number;
  tag: string;
  type: string;
  name: string;
  href: string;
  disabled: boolean;
}

export interface CompactState {
  url: string;
  title: string;
  n: number;
  total: number;
  els: CompactElement[];
  digest: string;
}

/** Tag every visible interactive element with data-hx="n" and describe it. */
export function generateCompactState(max = 150): CompactState {
  document.querySelectorAll('[data-hx]').forEach((e) => e.removeAttribute('data-hx'));

  const all = document.querySelectorAll(INTERACTIVE_SELECTOR);
  const els: CompactElement[] = [];
  let i = 0;

  for (const el of Array.from(all)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if ((rect.width < 2 && rect.height < 2) || style.visibility === 'hidden' || style.display === 'none') {
      continue;
    }

    const anyEl = el as HTMLElement & { value?: string; htmlFor?: string; disabled?: boolean; type?: string };
    const inputType = anyEl.type || el.getAttribute('type') || '';
    const secret = isSecretInput(inputType, el.getAttribute('autocomplete') || '');
    let name = (
      el.getAttribute('aria-label') ||
      anyEl.innerText ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      (secret ? '' : anyEl.value) ||
      ''
    ).toString();
    if (secret && !name.trim()) name = '••••';

    if (!name.trim() && anyEl.htmlFor) {
      const label = document.querySelector(`label[for="${CSS.escape(anyEl.htmlFor)}"]`);
      name = (label as HTMLElement | null)?.innerText || '';
    }

    el.setAttribute('data-hx', String(i));
    els.push({
      i,
      tag: el.tagName.toLowerCase(),
      type: inputType.slice(0, 12),
      name: name.trim().replace(/\s+/g, ' ').slice(0, 60),
      href: (el.getAttribute('href') || '').slice(0, 70),
      disabled: !!(anyEl.disabled || el.getAttribute('aria-disabled') === 'true'),
    });

    if (++i >= max) break;
  }

  const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
  return {
    url: location.href,
    title: document.title,
    n: els.length,
    total: all.length,
    els,
    digest: body.slice(0, 220),
  };
}

/** Format the state for the agent: one line per element. */
export function formatCompactState(s: CompactState): string {
  const lines = [`# ${s.title}`, `  ${s.url}`];
  for (const e of s.els) {
    const bits = [`[${e.i}] ${e.tag}${e.type ? ':' + e.type : ''}`];
    if (e.name) bits.push(`"${e.name}"`);
    if (e.href) bits.push(e.href);
    if (e.disabled) bits.push('(disabled)');
    lines.push('  ' + bits.join(' '));
  }
  if (s.n < s.total) lines.push(`  ... ${s.total - s.n} more elements (raise max or use browser_find)`);
  lines.push(`  ~ ${s.digest}`);
  return lines.join('\n');
}

/** Search elements by text/href without returning the whole state. */
export function findCompact(query: string, max = 400): string {
  const s = generateCompactState(max);
  const q = query.toLowerCase();
  const hits = s.els.filter((e) => e.name.toLowerCase().includes(q) || e.href.toLowerCase().includes(q));
  if (!hits.length) return '  (sin coincidencias)';
  return hits
    .map((e) => `  [${e.i}] ${e.tag}${e.type ? ':' + e.type : ''} "${e.name}" ${e.href}`.trimEnd())
    .join('\n');
}

/** Resuelve un ref compacto [n] a selector CSS para las herramientas de interaccion. */
export function refToSelector(ref: number | string): string {
  return `[data-hx="${String(ref).replace(/[^0-9]/g, '')}"]`;
}
