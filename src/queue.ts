import type { DownloadItem } from "./download-selection";

export enum DownloadAPIFormat {
  Legacy,
  SteamOS38,
}

export const detectAPIFormat = (arr: any[]): DownloadAPIFormat => {
  if (arr.length > 0 && arr[0].item_data !== undefined) return DownloadAPIFormat.SteamOS38;
  return DownloadAPIFormat.Legacy;
};

export const extractItems = (arr: any[], format: DownloadAPIFormat): DownloadItem[] => {
  if (format === DownloadAPIFormat.SteamOS38) {
    const localEntry = arr.find((entry: any) => entry.remote_client_id === "0");
    return localEntry ? (localEntry.item_data as DownloadItem[]) : [];
  }
  return arr as DownloadItem[];
};

// Append `items` to the end of the existing queue (after maxExistingQueueIndex),
// in the order provided. Caller sorts.
export const queueItems = (
  items: DownloadItem[],
  maxExistingQueueIndex: number,
  format: DownloadAPIFormat,
): void => {
  const dl = (window as any).SteamClient.Downloads;
  for (let i = 0; i < items.length; i++) {
    if (format === DownloadAPIFormat.SteamOS38) {
      dl.QueueAppUpdate(items[i].appid, "0");
      dl.SetQueueIndex(items[i].appid, maxExistingQueueIndex + 1 + i, "0");
    } else {
      dl.QueueAppUpdate(items[i].appid);
      dl.SetQueueIndex(items[i].appid, maxExistingQueueIndex + 1 + i);
    }
  }
};

export const resumeAppUpdate = (appid: number, format: DownloadAPIFormat): void => {
  const dl = (window as any).SteamClient.Downloads;
  if (format === DownloadAPIFormat.SteamOS38) {
    dl.ResumeAppUpdate(appid, "0");
  } else {
    dl.ResumeAppUpdate(appid);
  }
};
