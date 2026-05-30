export const API_PREFIX = normalizePrefix(import.meta.env.VITE_API_PREFIX || "/api");

export const APP_CONFIG = {
  apiId: parseApiId(import.meta.env.VITE_TG_API_ID),
  apiHash: import.meta.env.VITE_TG_API_HASH?.trim() || "",
  defaultSessionPassword: import.meta.env.VITE_DEFAULT_SESSION_PASSWORD || ""
};

export const HAS_TELEGRAM_CONFIG = Boolean(APP_CONFIG.apiId && APP_CONFIG.apiHash);

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_PREFIX}${cleanPath}`;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/\/+$/, "");
}

function parseApiId(value?: string): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
