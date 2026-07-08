import { toaster } from "@decky/api";
import { logger } from "./logger";
import {
  DEFAULTS, getTotalBytes, parseDownloadItems, planQueueOps, selectItemsToQueue, verifyQueued,
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
let loggedArity = false;
let disposed = false;      // set in dispose(); stops in-flight runQueue continuations
let snapshotGen = 0;       // bumped on every RegisterForDownloadItems callback

// Verification pending for queued appids. Overlapping runs within the verify window
// MERGE into one pending verification (appids unioned, silence only if every run
// was silent, gen from the latest run) — clobbering would drop the earlier run's
// failure toast and under-count lastRun.
let verifyTimer: number | null = null;
let pendingVerify: { appids: Set<number>; silent: boolean; gen: number } | null = null;
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
// The SteamClient methods are fire-and-forget with no documented return value,
// so success is verified against the next downloads snapshot rather than assumed:
// lastRun only reflects appids whose queue_index actually moved off -1.
export async function runQueue({ silent }: { silent: boolean }) {
  const items = selectItemsToQueue(downloads, settings);
  if (items.length === 0) {
    logger.info(`runQueue: nothing to queue (mode=${settings.mode}, silent=${silent})`);
    if (!silent) toaster.toast({ title: "Download All", body: "No downloads to queue" });
    return;
  }
  const { ops, resumeAppId } = planQueueOps(items, downloads);
  const dl = SteamClient.Downloads as any;
  if (!loggedArity) {
    loggedArity = true;
    logger.info(`API arity: QueueAppUpdate.length=${dl.QueueAppUpdate?.length}, SetQueueIndex.length=${dl.SetQueueIndex?.length}, ResumeAppUpdate.length=${dl.ResumeAppUpdate?.length}`);
  }
  logger.info(`runQueue: queueing ${ops.length} (mode=${settings.mode}, format=${format}, silent=${silent})`);
  for (const op of ops) {
    const name = window.appStore?.GetAppOverviewByAppID(op.appid)?.display_name ?? op.appid;
    const mb = (getTotalBytes(items.find((i) => i.appid === op.appid)!) / 1048576).toFixed(1);
    logger.info(`  queue ${name} (${op.appid}) @${op.index}, ${mb} MB`);
    try {
      // Await in case these return promises — a rejection would otherwise vanish.
      if (format === "steamos38") {
        await dl.QueueAppUpdate(op.appid, "0");
        await dl.SetQueueIndex(op.appid, op.index, "0");
      } else {
        await dl.QueueAppUpdate(op.appid);
        await dl.SetQueueIndex(op.appid, op.index);
      }
    } catch (e) {
      logger.error(`  queue ${op.appid} rejected: ${e}`);
    }
  }
  try {
    if (resumeAppId !== null) {
      if (format === "steamos38") await dl.ResumeAppUpdate(resumeAppId, "0");
      else await dl.ResumeAppUpdate(resumeAppId);
    }
  } catch (e) {
    logger.error(`  resume ${resumeAppId} rejected: ${e}`);
  }
  if (disposed) return; // plugin torn down while we were awaiting — don't re-arm anything
  // Steam's item events can lag far behind the calls (a large download spends
  // minutes preallocating before anything changes state), so verification is
  // two-stage: the listener early-confirms as soon as a fresh snapshot shows
  // every appid queued, and a 30s timer delivers the final verdict otherwise.
  pendingVerify = {
    appids: new Set([...(pendingVerify?.appids ?? []), ...ops.map((o) => o.appid)]),
    silent: silent && (pendingVerify?.silent ?? true),
    gen: snapshotGen,
  };
  if (verifyTimer !== null) window.clearTimeout(verifyTimer);
  verifyTimer = window.setTimeout(() => finishVerify(false), 30_000);
  if (!silent) toaster.toast({ title: "Download All", body: `Queueing ${ops.length} download${ops.length !== 1 ? "s" : ""} (smallest first)` });
  notify();
}

// Resolve the pending verification. earlyConfirm = called from the listener on a
// fresh snapshot: only settle if everything confirmed; otherwise keep waiting for
// the 30s deadline (Steam may just not have applied the queue ops yet).
function finishVerify(earlyConfirm: boolean) {
  const v = pendingVerify;
  if (!v || disposed) return;
  const ids = [...v.appids];
  const inconclusive = snapshotGen === v.gen
    ? "no downloads update within 30s"
    : downloads.length === 0 ? "empty downloads snapshot" : null;
  const result = inconclusive ? null : verifyQueued(ids, downloads);
  if (earlyConfirm && (result === null || result.missing.length > 0)) return; // not settled yet
  pendingVerify = null;
  if (verifyTimer !== null) { window.clearTimeout(verifyTimer); verifyTimer = null; }
  if (result === null) {
    logger.info(`runQueue verify: inconclusive — ${inconclusive} (queued: ${ids.join(", ")})`);
    // A button press should always resolve to visible feedback.
    if (!v.silent) toaster.toast({ title: "Download All", body: "Couldn't confirm downloads were queued — check Decky log" });
    return;
  }
  const { confirmed, missing } = result;
  logger.info(`runQueue verify: ${confirmed.length}/${ids.length} confirmed queued${missing.length ? `, still unqueued: ${missing.join(", ")}` : ""}`);
  if (confirmed.length > 0) lastRun = { at: Date.now(), count: confirmed.length };
  if (!v.silent && missing.length > 0) {
    toaster.toast({ title: "Download All", body: `${missing.length} download${missing.length !== 1 ? "s" : ""} failed to queue — check Decky log` });
  }
  notify();
}

function stopTimer() { if (timer !== null) { window.clearInterval(timer); timer = null; } }
function reschedule() {
  stopTimer();
  if (settings.autoQueue) {
    const ms = Math.max(1, settings.autoQueueIntervalMin) * 60_000;
    timer = window.setInterval(() => { runQueue({ silent: true }).catch((e) => logger.error(`auto-queue tick failed: ${e}`)); }, ms);
    logger.info(`auto-queue timer started: every ${settings.autoQueueIntervalMin} min`);
  }
}

export function init() {
  disposed = false;
  reg = SteamClient.Downloads.RegisterForDownloadItems((...args: any[]) => {
    const parsed = parseDownloadItems(args);
    format = parsed.format;
    downloads = parsed.items.filter((d) => !d.completed);
    snapshotGen++;
    finishVerify(true); // early-confirm a pending verification if all appids now queued
    notify();
  });
  reschedule();
  logger.info("controller initialized");
}

export function dispose() {
  disposed = true;
  stopTimer();
  if (verifyTimer !== null) { window.clearTimeout(verifyTimer); verifyTimer = null; }
  pendingVerify = null;
  reg?.unregister();
  reg = null;
  listeners.clear();
}
