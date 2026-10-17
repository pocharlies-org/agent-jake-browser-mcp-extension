/**
 * Vue component type declarations for TypeScript.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_WS_HOST?: string;
  readonly VITE_WS_PATH?: string;
  readonly VITE_WS_PORT?: string;
  readonly VITE_WS_TOKEN?: string;
  readonly VITE_WS_SECURE?: string;
  readonly VITE_WEBAUTHN_GUARD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
