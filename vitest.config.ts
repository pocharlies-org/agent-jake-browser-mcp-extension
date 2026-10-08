import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['tests/composition.test.ts', 'tests/vendor-protocol.test.ts', 'tests/handler-parity.test.ts'] },
  resolve: { alias: { '@': resolve(__dirname, 'packages/core/src') } },
});
