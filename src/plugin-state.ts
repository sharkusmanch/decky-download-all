import { useEffect, useState } from "react";
import type { DownloadItem } from "./download-selection";
import { DownloadAPIFormat } from "./queue";

export interface LastAutoRun {
  time: number; // Date.now() timestamp of the run
  trigger: "reactive" | "interval" | "settings";
  action: "queued" | "resumed";
  count: number; // number of items queued (0 for "resumed")
}

// Mutable module-level state. Readers use the accessors; writers use the setters,
// which notify subscribers so React components re-render.

let currentDownloads: DownloadItem[] = [];
let apiFormat: DownloadAPIFormat = DownloadAPIFormat.Legacy;
let lastAutoRun: LastAutoRun | null = null;
let downloadsPaused = false;

const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((fn) => fn());

export const getCurrentDownloads = (): DownloadItem[] => currentDownloads;
export const getAPIFormat = (): DownloadAPIFormat => apiFormat;
export const getLastAutoRun = (): LastAutoRun | null => lastAutoRun;
export const getDownloadsPaused = (): boolean => downloadsPaused;

export const setCurrentDownloads = (items: DownloadItem[]): void => {
  currentDownloads = items;
  notify();
};

export const setAPIFormat = (format: DownloadAPIFormat): void => {
  apiFormat = format;
};

export const setLastAutoRun = (run: LastAutoRun): void => {
  lastAutoRun = run;
  notify();
};

export const setDownloadsPaused = (paused: boolean): void => {
  if (downloadsPaused === paused) return;
  downloadsPaused = paused;
  notify();
};

// React hook: re-renders the caller whenever module state changes.
export const useSharedState = (): {
  downloads: DownloadItem[];
  lastAutoRun: LastAutoRun | null;
  downloadsPaused: boolean;
} => {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const cb = () => forceRender((n) => n + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  return { downloads: currentDownloads, lastAutoRun, downloadsPaused };
};
