import { describe, expect, it } from 'vitest';
import { isSecretInput } from '@/content/compact-state';

// SC-2601: browser_state volcaba el value de un input password en el transcript.
describe('isSecretInput', () => {
  it('flags password inputs', () => {
    expect(isSecretInput('password', '')).toBe(true);
    expect(isSecretInput('PASSWORD', '')).toBe(true);
  });

  it('flags password autocomplete tokens even with type=text', () => {
    expect(isSecretInput('text', 'current-password')).toBe(true);
    expect(isSecretInput('text', 'New-Password')).toBe(true);
  });

  it('leaves ordinary inputs alone', () => {
    expect(isSecretInput('text', '')).toBe(false);
    expect(isSecretInput('search', 'search')).toBe(false);
    expect(isSecretInput('email', 'email')).toBe(false);
  });
});
