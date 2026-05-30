/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_PREFIX?: string;
  readonly VITE_DEV_GATEWAY?: string;
  readonly VITE_TG_API_ID?: string;
  readonly VITE_TG_API_HASH?: string;
  readonly VITE_DEFAULT_SESSION_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
