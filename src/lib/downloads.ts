// Pure logic for the Download All plugin — no SteamClient/React imports, unit-tested.

export interface ProgressInfo { bytes_total: number; bytes_in_progress: number }
export interface UpdateTypeInfo { has_update: boolean; completed_update: boolean; progress?: ProgressInfo[] }
export interface DownloadItem {
  appid: number;
  active: boolean;
  completed: boolean;
  paused: boolean;
  queue_index: number;   // -1 = unqueued, >= 0 = in queue
  deferred_time: number; // > 0 = scheduled for later
  update_type_info?: UpdateTypeInfo[];
}

export type ApiFormat = "legacy" | "steamos38";
export type Mode = "all" | "scheduled" | "size-limit";

export interface Settings {
  mode: Mode;
  maxSizeMB: number;
  autoQueue: boolean;
  autoQueueIntervalMin: number;
}

export const DEFAULTS: Settings = {
  mode: "scheduled",
  maxSizeMB: 5000,
  autoQueue: false,
  autoQueueIntervalMin: 15,
};

// Sum bytes across updates that are pending (has_update and not completed).
export const getTotalBytes = (d: DownloadItem): number => {
  let total = 0;
  for (const info of d.update_type_info || []) {
    if (info.has_update && !info.completed_update) {
      for (const prog of info.progress || []) total += prog.bytes_total || 0;
    }
  }
  return total;
};

// The RegisterForDownloadItems callback shape changed in SteamOS 3.8. Detect by
// checking whether array elements carry `item_data` (the 3.8 per-client wrapper).
export function parseDownloadItems(args: any[]): { items: DownloadItem[]; format: ApiFormat } {
  const arr: any[] = Array.isArray(args[1]) ? args[1] : Array.isArray(args[0]) ? args[0] : [];
  if (arr.length > 0 && arr[0].item_data !== undefined) {
    const local = arr.find((e) => e.remote_client_id === "0"); // "0" = this machine
    return { items: (local?.item_data ?? []) as DownloadItem[], format: "steamos38" };
  }
  return { items: arr as DownloadItem[], format: "legacy" };
}

export interface QueuePlan {
  ops: { appid: number; index: number }[];
  resumeAppId: number | null;
}

const isUnqueued = (d: DownloadItem) => d.queue_index === -1;

// Which unqueued downloads to enqueue, given the mode, smallest first.
export function selectItemsToQueue(downloads: DownloadItem[], settings: Settings): DownloadItem[] {
  let items = downloads.filter(isUnqueued);
  if (settings.mode === "scheduled") {
    items = items.filter((d) => d.deferred_time > 0);
  } else if (settings.mode === "size-limit") {
    const maxBytes = settings.maxSizeMB * 1024 * 1024;
    items = items.filter((d) => d.deferred_time > 0 && getTotalBytes(d) <= maxBytes);
  }
  return [...items].sort((a, b) => getTotalBytes(a) - getTotalBytes(b));
}

// Queue positions (append below the existing queue) and which appid to resume.
export function planQueueOps(items: DownloadItem[], downloads: DownloadItem[]): QueuePlan {
  const maxQueueIndex = downloads.reduce((m, d) => Math.max(m, d.queue_index), -1);
  const ops = items.map((it, i) => ({ appid: it.appid, index: maxQueueIndex + 1 + i }));
  const resumeAppId = downloads.find((d) => d.queue_index === 0)?.appid ?? items[0]?.appid ?? null;
  return { ops, resumeAppId };
}
