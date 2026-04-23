import { definePlugin, toaster } from "@decky/api";
import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
} from "@decky/ui";
import { FC, useState } from "react";
import { FaDownload, FaCheck } from "react-icons/fa";

import { logger } from "./logger";
import {
  filterByMode,
  getTotalBytes,
  isUnqueued,
  sortBySize,
  type Mode,
} from "./download-selection";
import { loadSettings, saveSettings, type Settings } from "./settings";
import {
  detectAPIFormat,
  extractItems,
  queueItems,
  resumeAppUpdate,
} from "./queue";
import {
  setAPIFormat,
  setCurrentDownloads,
  setDownloadsPaused,
  getAPIFormat,
  useSharedState,
} from "./plugin-state";
import { autoRunTick, recordUserDequeues } from "./auto-run";
import { trailingDebounce } from "./debounce";

declare const SteamClient: any;

const DEBUG = false;
const FALLBACK_INTERVAL_MS = 15 * 60 * 1000;
const REACTIVE_DEBOUNCE_MS = 1000;

// ----- Module-scope runtime: subscription + interval, started once at plugin load.

const reactiveTick = trailingDebounce(() => autoRunTick("reactive"), REACTIVE_DEBOUNCE_MS);
const settingsTick = trailingDebounce(() => autoRunTick("settings"), REACTIVE_DEBOUNCE_MS);

let itemsSubscription: { unregister: () => void } | null = null;
let overviewSubscription: { unregister: () => void } | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// Previous pending-items snapshot, used to detect user-initiated dequeues
// (queue_index >= 0 -> -1 transitions we didn't cause).
let previousPending: import("./download-selection").DownloadItem[] | null = null;

const initPluginRuntime = (): void => {
  const s = loadSettings();
  logger.info(
    `Auto mode initialized: enabled=${s.autoEnabled}, mode=${s.autoMode}, ` +
      `maxSizeMB=${s.autoMaxSizeMB}, interval=${FALLBACK_INTERVAL_MS / 60000}min`,
  );

  itemsSubscription = SteamClient.Downloads.RegisterForDownloadItems((...args: any[]) => {
    const arr: any[] = Array.isArray(args[1]) ? args[1] : Array.isArray(args[0]) ? args[0] : [];
    const format = detectAPIFormat(arr);
    setAPIFormat(format);
    const items = extractItems(arr, format);
    const pending = items.filter((d) => !d.completed);
    const unqueued = pending.filter((d) => d.queue_index === -1).length;
    const queued = pending.filter((d) => d.queue_index >= 0).length;
    const active = pending.filter((d) => d.active).length;
    const paused = pending.filter((d) => d.paused).length;
    const head = pending.find((d) => d.queue_index === 0);
    const headDesc = head
      ? `head[appid=${head.appid} active=${head.active} paused=${head.paused}]`
      : "head=none";
    logger.info(
      `Downloads updated: ${items.length} total, ${pending.length} pending ` +
        `(${items.length - pending.length} completed, ${unqueued} unqueued, ${queued} queued, ` +
        `${active} active, ${paused} paused) ${headDesc}`,
    );
    recordUserDequeues(previousPending, pending);
    previousPending = pending;
    setCurrentDownloads(pending);
    reactiveTick();
  });

  let lastPausedLogged: boolean | null = null;
  overviewSubscription = SteamClient.Downloads.RegisterForDownloadOverview((overview: any) => {
    const paused = !!overview?.paused;
    if (paused !== lastPausedLogged) {
      logger.info(`Download overview: paused=${paused}`);
      lastPausedLogged = paused;
    }
    setDownloadsPaused(paused);
  });

  intervalHandle = setInterval(() => autoRunTick("interval"), FALLBACK_INTERVAL_MS);
};

const teardownPluginRuntime = (): void => {
  itemsSubscription?.unregister();
  itemsSubscription = null;
  overviewSubscription?.unregister();
  overviewSubscription = null;
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  reactiveTick.cancel();
  settingsTick.cancel();
  previousPending = null;
};

const AUTO_SETTING_KEYS = new Set(["autoEnabled", "autoMode", "autoMaxSizeMB"]);
const affectsAutoRun = (partial: Partial<Settings>): boolean =>
  Object.keys(partial).some((k) => AUTO_SETTING_KEYS.has(k));

// ----- React panel view.

const PluginContent: FC = () => {
  const { downloads, lastAutoRun } = useSharedState();
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  const update = (partial: Partial<Settings>) => {
    const next = { ...settings, ...partial };
    setSettings(next);
    saveSettings(next);
    for (const [k, v] of Object.entries(partial)) {
      logger.info(`Auto mode setting changed: ${k}=${v}`);
    }
    if (affectsAutoRun(partial)) settingsTick();
  };

  const handleDownloadAll = () => {
    logger.info(
      `Queue downloads clicked: ${downloads.length} pending downloads, mode: ${settings.mode}`,
    );
    const candidates = filterByMode(
      downloads.filter(isUnqueued),
      settings.mode,
      settings.maxSizeMB,
    );
    if (candidates.length === 0) {
      toaster.toast({ title: "Download All", body: "No downloads to queue" });
      return;
    }
    const sorted = sortBySize(candidates);
    logger.info(`Queueing ${sorted.length} downloads (mode: ${settings.mode})`);
    for (let i = 0; i < sorted.length; i++) {
      const sizeMB = (getTotalBytes(sorted[i]) / (1024 * 1024)).toFixed(1);
      const name =
        (window as any).appStore?.GetAppOverviewByAppID(sorted[i].appid)?.display_name ??
        sorted[i].appid;
      logger.info(`  [${i + 1}] ${name} (${sorted[i].appid}), size=${sizeMB} MB`);
    }
    const maxQueueIndex = Math.max(-1, ...downloads.map((d) => d.queue_index));
    queueItems(sorted, maxQueueIndex, getAPIFormat());
    const resumeAppId = downloads.find((d) => d.queue_index === 0)?.appid ?? sorted[0].appid;
    resumeAppUpdate(resumeAppId, getAPIFormat());
    toaster.toast({
      title: "Download All",
      body: `Added ${sorted.length} downloads to queue (smallest first)`,
    });
  };

  const modeOptions: { label: string; data: Mode }[] = [
    { label: "All", data: "all" },
    { label: "Scheduled", data: "scheduled" },
    { label: "Scheduled With Size Limit", data: "size-limit" },
  ];

  const itemsToQueue = filterByMode(
    downloads.filter(isUnqueued),
    settings.mode,
    settings.maxSizeMB,
  );
  const alreadyQueued = downloads.filter((d) => d.queue_index >= 0).length;
  const ignoredCount = downloads.filter(isUnqueued).length - itemsToQueue.length;
  const debugInfo = downloads.length > 0 ? JSON.stringify(downloads, null, 1) : "none";

  const renderLastAutoRun = () => {
    if (!lastAutoRun) return null;
    const when = new Date(lastAutoRun.time).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const what =
      lastAutoRun.action === "queued"
        ? `queued ${lastAutoRun.count} download${lastAutoRun.count !== 1 ? "s" : ""}`
        : `resumed stalled download`;
    return (
      <PanelSectionRow>
        <span style={{ fontSize: "12px", color: "#8b929a" }}>
          Last auto-run: {when} — {what}
        </span>
      </PanelSectionRow>
    );
  };

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleDownloadAll} disabled={itemsToQueue.length === 0}>
            <FaDownload style={{ marginRight: "8px" }} />
            Queue {itemsToQueue.length} Download{itemsToQueue.length !== 1 ? "s" : ""}
          </ButtonItem>
        </PanelSectionRow>
        {(alreadyQueued > 0 || ignoredCount > 0) && (
          <PanelSectionRow>
            <span style={{ fontSize: "12px", color: "#8b929a" }}>
              {alreadyQueued > 0 && `${alreadyQueued} Already Queued`}
              {alreadyQueued > 0 && ignoredCount > 0 && ", "}
              {ignoredCount > 0 && `${ignoredCount} Filtered Out by Download Behavior Configuration`}
            </span>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Download Behavior">
        {modeOptions.map((opt) => (
          <PanelSectionRow key={opt.data}>
            <ButtonItem layout="below" onClick={() => update({ mode: opt.data })}>
              {settings.mode === opt.data && <FaCheck style={{ marginRight: "8px" }} />}
              {opt.label}
            </ButtonItem>
          </PanelSectionRow>
        ))}
        {settings.mode === "size-limit" && (
          <PanelSectionRow>
            <SliderField
              label={`Max Size: ${settings.maxSizeMB} MB`}
              value={settings.maxSizeMB}
              min={100}
              max={10000}
              step={100}
              onChange={(v) => update({ maxSizeMB: v })}
            />
          </PanelSectionRow>
        )}
        {DEBUG && (
          <PanelSectionRow>
            <pre
              style={{
                fontSize: "9px",
                color: "#8b929a",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                margin: 0,
              }}
            >
              {debugInfo}
            </pre>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Auto Download">
        <PanelSectionRow>
          <ToggleField
            label="Automatically queue downloads"
            checked={settings.autoEnabled}
            onChange={(v) => update({ autoEnabled: v })}
          />
        </PanelSectionRow>
        {settings.autoEnabled && (
          <>
            {modeOptions.map((opt) => (
              <PanelSectionRow key={`auto-${opt.data}`}>
                <ButtonItem layout="below" onClick={() => update({ autoMode: opt.data })}>
                  {settings.autoMode === opt.data && <FaCheck style={{ marginRight: "8px" }} />}
                  {opt.label}
                </ButtonItem>
              </PanelSectionRow>
            ))}
            {settings.autoMode === "size-limit" && (
              <PanelSectionRow>
                <SliderField
                  label={`Max Size: ${settings.autoMaxSizeMB} MB`}
                  value={settings.autoMaxSizeMB}
                  min={100}
                  max={10000}
                  step={100}
                  onChange={(v) => update({ autoMaxSizeMB: v })}
                />
              </PanelSectionRow>
            )}
            {renderLastAutoRun()}
          </>
        )}
      </PanelSection>
    </>
  );
};

// Plugin entry — runs once per plugin load.
export default definePlugin(() => {
  logger.info("Download All plugin initialized");
  initPluginRuntime();
  const def: any = {
    name: "Download All Button",
    content: <PluginContent />,
    icon: <FaDownload />,
    onDismount: () => {
      logger.info("Download All plugin unloading");
      teardownPluginRuntime();
    },
  };
  return def;
});
