import type { Mode } from "./download-selection";

export interface Settings {
  mode: Mode;
  maxSizeMB: number;
  autoEnabled: boolean;
  autoMode: Mode;
  autoMaxSizeMB: number;
}

export const STORAGE_KEY = "download-all-settings";

export const DEFAULTS: Settings = {
  mode: "scheduled",
  maxSizeMB: 5000,
  autoEnabled: true,
  autoMode: "scheduled",
  autoMaxSizeMB: 5000,
};

export const loadSettings = (): Settings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...DEFAULTS, ...JSON.parse(stored) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
};

export const saveSettings = (settings: Settings): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};
