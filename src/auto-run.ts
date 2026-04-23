import {
  filterByMode,
  getTotalBytes,
  isStalledHead,
  isUnqueued,
  sortBySize,
  type DownloadItem,
} from "./download-selection";
import { queueItems, resumeAppUpdate } from "./queue";
import {
  getCurrentDownloads,
  getAPIFormat,
  getDownloadsPaused,
  setLastAutoRun,
} from "./plugin-state";
import { loadSettings } from "./settings";
import { logger } from "./logger";

export type AutoRunTrigger = "reactive" | "interval" | "settings";

// Appids that autoRunTick has moved from unqueued -> queued in this plugin session.
// Prevents re-queuing while items remain visible to Steam. Pruned when items
// disappear from Steam's list (completed, cancelled, uninstalled).
const actedAppids = new Set<number>();

// Appids the user explicitly unqueued (queue_index went from >=0 to -1 without
// us initiating it). Track A skips these so we don't undo the user's action.
// Pruned on disappearance — a fresh re-install of the same game can be auto-queued.
const userDequeuedAppids = new Set<number>();

const pruneActedAppids = (visibleAppids: Set<number>): void => {
  for (const id of actedAppids) {
    if (!visibleAppids.has(id)) actedAppids.delete(id);
  }
  for (const id of userDequeuedAppids) {
    if (!visibleAppids.has(id)) userDequeuedAppids.delete(id);
  }
};

// Called by the download-items subscription with the previous and current
// snapshots. Any appid that went from queued (queue_index >= 0) to unqueued
// (queue_index === -1) without our doing is attributed to the user and added
// to `userDequeuedAppids`.
export const recordUserDequeues = (
  previous: DownloadItem[] | null,
  current: DownloadItem[],
): void => {
  if (!previous) return;
  const prevByAppid = new Map(previous.map((d) => [d.appid, d]));
  for (const cur of current) {
    const prev = prevByAppid.get(cur.appid);
    if (prev && prev.queue_index >= 0 && cur.queue_index === -1) {
      userDequeuedAppids.add(cur.appid);
    }
  }
};

export const autoRunTick = (trigger: AutoRunTrigger): void => {
  const settings = loadSettings();
  if (!settings.autoEnabled) return;
  if (getDownloadsPaused()) return;

  const downloads = getCurrentDownloads();
  const format = getAPIFormat();
  const now = Date.now();

  pruneActedAppids(new Set(downloads.map((d) => d.appid)));

  // Track A: queue new eligible items.
  const unqueued = downloads.filter(isUnqueued);
  const eligible = filterByMode(unqueued, settings.autoMode, settings.autoMaxSizeMB).filter(
    (d) => !actedAppids.has(d.appid) && !userDequeuedAppids.has(d.appid),
  );

  let trackAFired = false;
  if (eligible.length > 0) {
    const sorted = sortBySize(eligible);
    const maxQueueIndex = Math.max(-1, ...downloads.map((d) => d.queue_index));
    queueItems(sorted, maxQueueIndex, format);
    for (const d of sorted) actedAppids.add(d.appid);

    const totalMB = sorted.reduce((acc, d) => acc + getTotalBytes(d), 0) / (1024 * 1024);
    logger.info(`Auto-run (${trigger}): queued ${sorted.length} items, total ${totalMB.toFixed(1)}MB`);
    for (let i = 0; i < sorted.length; i++) {
      const sizeMB = (getTotalBytes(sorted[i]) / (1024 * 1024)).toFixed(1);
      const name =
        (window as any).appStore?.GetAppOverviewByAppID(sorted[i].appid)?.display_name ??
        sorted[i].appid;
      logger.info(`  [${i + 1}] ${name} (${sorted[i].appid}), size=${sizeMB} MB`);
    }

    setLastAutoRun({ time: now, trigger, action: "queued", count: sorted.length });
    trackAFired = true;
  }

  // Track B: kick stalled queue head (network return, prior session leftover, etc.).
  const head = downloads.find(isStalledHead);
  if (head) {
    resumeAppUpdate(head.appid, format);
    const name =
      (window as any).appStore?.GetAppOverviewByAppID(head.appid)?.display_name ?? head.appid;
    logger.info(`Auto-run (${trigger}): resumed stalled head ${name} (${head.appid})`);
    if (!trackAFired) {
      setLastAutoRun({ time: now, trigger, action: "resumed", count: 0 });
    }
  }
};
