import { toaster } from "@decky/api";
import { logger } from "./logger";
import {
  DEFAULTS, getTotalBytes, parseDownloadItems, planQueueOps, selectItemsToQueue,
  type ApiFormat, type DownloadItem, type Settings,
} from "./lib/downloads";

const STORAGE_KEY = "download-all-settings";

const loadSettings = (): Settings => {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? { ...DEFAULTS, ...JSON.parse(s) } : DEFAULTS;
  } catch { return DEFAULTS; }
};

// Module-scope state — persists for the plugin's lifetime, independent of the QAM panel.
let settings: Settings = loadSettings();
let downloads: DownloadItem[] = [];
let format: ApiFormat = "legacy";
let lastRun: { at: number; count: number } | null = null;
let reg: { unregister(): void } | null = null;
let timer: number | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((fn) => fn());

export const getState = () => ({ settings, downloads, lastRun });
export const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function updateSettings(partial: Partial<Settings>) {
  settings = { ...settings, ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  reschedule();
  notify();
}

// Apply the current mode to the tracked downloads and enqueue via SteamClient.
export function runQueue({ silent }: { silent: boolean }) {
  const items = selectItemsToQueue(downloads, settings);
  if (items.length === 0) {
    logger.info(`runQueue: nothing to queue (mode=${settings.mode}, silent=${silent})`);
    if (!silent) toaster.toast({ title: "Download All", body: "No downloads to queue" });
    return;
  }
  const { ops, resumeAppId } = planQueueOps(items, downloads);
  const dl = SteamClient.Downloads as any;
  logger.info(`runQueue: queueing ${ops.length} (mode=${settings.mode}, format=${format}, silent=${silent})`);
  for (const op of ops) {
    const name = window.appStore?.GetAppOverviewByAppID(op.appid)?.display_name ?? op.appid;
    const mb = (getTotalBytes(items.find((i) => i.appid === op.appid)!) / 1048576).toFixed(1);
    logger.info(`  queue ${name} (${op.appid}) @${op.index}, ${mb} MB`);
    if (format === "steamos38") {
      dl.QueueAppUpdate(op.appid, "0");
      dl.SetQueueIndex(op.appid, op.index, "0");
    } else {
      dl.QueueAppUpdate(op.appid);
      dl.SetQueueIndex(op.appid, op.index);
    }
  }
  if (resumeAppId !== null) {
    if (format === "steamos38") dl.ResumeAppUpdate(resumeAppId, "0");
    else dl.ResumeAppUpdate(resumeAppId);
  }
  lastRun = { at: Date.now(), count: ops.length };
  if (!silent) toaster.toast({ title: "Download All", body: `Added ${ops.length} downloads to queue (smallest first)` });
  notify();
}

function stopTimer() { if (timer !== null) { window.clearInterval(timer); timer = null; } }
function reschedule() {
  stopTimer();
  if (settings.autoQueue) {
    const ms = Math.max(1, settings.autoQueueIntervalMin) * 60_000;
    timer = window.setInterval(() => runQueue({ silent: true }), ms);
    logger.info(`auto-queue timer started: every ${settings.autoQueueIntervalMin} min`);
  }
}

export function init() {
  reg = SteamClient.Downloads.RegisterForDownloadItems((...args: any[]) => {
    const parsed = parseDownloadItems(args);
    format = parsed.format;
    downloads = parsed.items.filter((d) => !d.completed);
    notify();
  });
  reschedule();
  logger.info("controller initialized");
}

export function dispose() {
  stopTimer();
  reg?.unregister();
  reg = null;
  listeners.clear();
}
