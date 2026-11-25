/**
 * Content-script side of browser_drop and browser_fill_form.
 * Runs in the frame the ref belongs to, so both work inside iframes as well.
 */
import { findElement } from './selector';

export interface DropFile {
  name: string;
  mimeType: string;
  base64: string;
}

/**
 * Drop files and/or MIME data on an element as if dragged in from outside the page:
 * dragenter → dragover → drop, all carrying the same DataTransfer.
 */
export async function handleDispatchDrop(payload: {
  selector: string;
  files?: DropFile[];
  data?: Record<string, string>;
}): Promise<{ dropped: string[]; accepted: boolean }> {
  const element = await findElement(payload.selector, { visible: true });
  const dt = new DataTransfer();
  for (const f of payload.files ?? []) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
  }
  for (const [type, value] of Object.entries(payload.data ?? {})) dt.setData(type, value);

  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: dt,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  element.dispatchEvent(new DragEvent('dragenter', init));
  // A drop target says "yes" by cancelling dragover; report it so a silent no-op shows.
  const accepted = !element.dispatchEvent(new DragEvent('dragover', init));
  element.dispatchEvent(new DragEvent('drop', init));

  return { dropped: [...(payload.files ?? []).map((f) => f.name), ...Object.keys(payload.data ?? {})], accepted };
}

type FieldKind = 'textbox' | 'checkbox' | 'radio' | 'combobox' | 'slider';

function kindOf(el: Element): FieldKind {
  const type = (el.getAttribute('type') || '').toLowerCase();
  const role = el.getAttribute('role');
  if (el instanceof HTMLSelectElement) return 'combobox';
  if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox';
  if (type === 'radio' || role === 'radio') return 'radio';
  if (type === 'range' || role === 'slider') return 'slider';
  return 'textbox';
}

/**
 * Set a value through the prototype's setter, then fire input/change: frameworks that
 * track the value themselves (React) ignore a plain `el.value = ...`.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function handleFillField(payload: {
  selector: string;
  value: string | number | boolean;
  type?: FieldKind;
}): Promise<{ kind: FieldKind }> {
  const el = await findElement(payload.selector);
  const kind = payload.type ?? kindOf(el);
  const value = payload.value;

  if (el instanceof HTMLElement) el.focus({ preventScroll: true });

  switch (kind) {
    case 'checkbox':
    case 'radio': {
      const want = value === true || String(value).toLowerCase() === 'true';
      const isChecked = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (kind === 'radio' && isChecked && !want) {
        throw new Error('A selected radio cannot be unchecked; select another option in its group');
      }
      if (isChecked !== want) (el as HTMLElement).click();
      break;
    }
    case 'combobox': {
      if (!(el instanceof HTMLSelectElement)) throw new Error('combobox field is not a <select>');
      const v = String(value);
      const opt = [...el.options].find((o) => o.label === v || o.text.trim() === v) ?? [...el.options].find((o) => o.value === v);
      if (!opt) throw new Error(`No option "${v}"`);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    default: {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) setNativeValue(el, String(value));
      else if (el instanceof HTMLElement && el.isContentEditable) {
        el.textContent = String(value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      } else throw new Error(`Not a fillable field: <${el.tagName.toLowerCase()}>`);
    }
  }
  return { kind };
}

/** Length of an editable field's value — never the value: it may be a secret. */
export async function handleFieldLength(payload: { selector: string }): Promise<{ length: number }> {
  const el = await findElement(payload.selector);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return { length: [...el.value].length };
  if (el instanceof HTMLElement && el.isContentEditable) return { length: [...(el.textContent ?? '')].length };
  return { length: 0 };
}

/** Length-only existence probe for a field (browser_fill_secret verification): never the value. */
export async function handleGetFieldLength(payload: { selector: string }): Promise<{ exists: boolean; length?: number }> {
  const el = document.querySelector(payload.selector);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { exists: false };
  return { exists: true, length: el.value.length };
}

/**
 * Empty an editable field from inside the page: setNativeValue (the native setter, so a
 * framework's own setter does not swallow it, plus the input/change events it listens to).
 */
export async function handleClearField(payload: { selector: string }): Promise<{ length: number }> {
  const el = await findElement(payload.selector);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, '');
    return { length: el.value.length };
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { length: 0 };
  }
  return { length: 0 };
}

/**
 * Last resort of browser_type when the keys CDP sent did not land (the field holds another number
 * of characters than it should): set `kept` leading characters of the current value + `text`
 * through the native setter, with the input/change events a framework listens to. Answers with
 * lengths only: `text` may be a secret. Refuses (applied:false) when the field has a maxlength the
 * result would exceed, or when it is not an editable field: it never guesses around a mask.
 */
export async function handleSetFieldText(payload: {
  selector: string;
  text: string;
  kept: number;
}): Promise<{ applied: boolean; length: number }> {
  const el = await findElement(payload.selector);
  const keep = (value: string) => [...value].slice(0, payload.kept).join('');
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const next = keep(el.value) + payload.text;
    if (el.maxLength >= 0 && [...next].length > el.maxLength) return { applied: false, length: [...el.value].length };
    setNativeValue(el, next);
    return { applied: true, length: [...el.value].length };
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.textContent = keep(el.textContent ?? '') + payload.text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    return { applied: true, length: [...(el.textContent ?? '')].length };
  }
  return { applied: false, length: 0 };
}
