export interface SavedProfile {
  phone: string;
  cloudSync: boolean;
}

const STORAGE_KEY = "tg-alive.profile";

export function loadSavedProfile(): SavedProfile | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as SavedProfile;
    if (!parsed.phone) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveProfile(value: SavedProfile): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function clearSavedProfile(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
