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
