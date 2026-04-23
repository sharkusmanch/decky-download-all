export interface ProgressInfo {
  bytes_total: number;
  bytes_in_progress: number;
}

export interface UpdateTypeInfo {
  has_update: boolean;
  completed_update: boolean;
  progress?: ProgressInfo[];
}

export interface DownloadItem {
  appid: number;
  active: boolean;
  completed: boolean;
  paused: boolean;
  queue_index: number;
  deferred_time: number;
  update_type_info?: UpdateTypeInfo[];
}

export type Mode = "all" | "scheduled" | "size-limit";

export const getTotalBytes = (d: DownloadItem): number => {
  let total = 0;
  for (const info of d.update_type_info || []) {
    if (info.has_update && !info.completed_update) {
      for (const prog of info.progress || []) {
        total += prog.bytes_total || 0;
      }
    }
  }
  return total;
};

export const isUnqueued = (d: DownloadItem): boolean => d.queue_index === -1;

export const isStalledHead = (d: DownloadItem): boolean =>
  d.queue_index === 0 && !d.active && !d.paused && !d.completed;

export const filterByMode = (items: DownloadItem[], mode: Mode, maxSizeMB: number): DownloadItem[] => {
  if (mode === "all") return items;
  if (mode === "scheduled") return items.filter((d) => d.deferred_time > 0);
  const maxBytes = maxSizeMB * 1024 * 1024;
  return items.filter((d) => d.deferred_time > 0 && getTotalBytes(d) <= maxBytes);
};

export const sortBySize = (items: DownloadItem[]): DownloadItem[] =>
  [...items].sort((a, b) => getTotalBytes(a) - getTotalBytes(b));
