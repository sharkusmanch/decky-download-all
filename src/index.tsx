import { definePlugin, toaster } from "@decky/api";
import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
} from "@decky/ui";
import { useState, useEffect, useRef, FC } from "react";
import { FaDownload, FaCheck } from "react-icons/fa";
import { logger } from "./logger";
import {
  getTotalBytes,
  isUnqueued,
  filterByMode,
  sortBySize,
  type DownloadItem,
  type Mode,
} from "./download-selection";
// Set to true to show debug info in the UI
const DEBUG = false;

enum DownloadAPIFormat {
  Legacy,      // pre-SteamOS 3.8: callback is (unknown, DownloadItem[]), queue methods take only appid
  SteamOS38,  // SteamOS 3.8+: callback is (bIsInitial, { remote_client_id, item_data }[]), queue methods take appid + remote_client_id
}

interface Settings {
  mode: Mode;
  maxSizeMB: number;
}

const STORAGE_KEY = "download-all-settings";
const DEFAULTS: Settings = { mode: "scheduled", maxSizeMB: 5000 };

// Load/save settings from localStorage
const loadSettings = (): Settings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...DEFAULTS, ...JSON.parse(stored) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
};

const saveSettings = (settings: Settings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

// Shared state
let currentSettings = loadSettings();

// Main plugin UI in Quick Access Menu
const PluginContent: FC = () => {
  const [settings, setSettings] = useState(currentSettings);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const apiFormat = useRef(DownloadAPIFormat.Legacy);

  const update = (partial: Partial<Settings>) => {
    const newSettings = { ...settings, ...partial };
    setSettings(newSettings);
    currentSettings = newSettings;
    saveSettings(newSettings);
  };

  useEffect(() => {
    const reg = SteamClient.Downloads.RegisterForDownloadItems((...args: any[]) => {
      // SteamOS 3.8+ format: (bIsInitial: boolean, items: { remote_client_id: string, item_data: DownloadItem[] }[])
      // Old Steam format: (bIsInitial: boolean, items: DownloadItem[])
      // Somewhat brittle split, but differentiate by checking if the array elements have the item_data property.
      const arr: any[] = Array.isArray(args[1]) ? args[1] : Array.isArray(args[0]) ? args[0] : [];
      let items: DownloadItem[];
      if (arr.length > 0 && arr[0].item_data !== undefined) {
        // SteamOS 3.8+ format: only include the local machine (remote_client_id "0")
        apiFormat.current = DownloadAPIFormat.SteamOS38;
        const localEntry = arr.find((entry: any) => entry.remote_client_id === "0");
        items = localEntry ? (localEntry.item_data as DownloadItem[]) : [];
      } else {
        // Legacy format: arr is already DownloadItem[]
        apiFormat.current = DownloadAPIFormat.Legacy;
        items = arr as DownloadItem[];
      }
      const pending = items.filter((d) => !d.completed);
      logger.info(`Downloads updated: ${items.length} total, ${pending.length} pending (${items.length - pending.length} completed)`);
      setDownloads(pending);
    });
    return () => reg.unregister();
  }, []);

  const handleDownloadAll = () => {
    logger.info(`Queue downloads clicked: ${downloads.length} pending downloads, mode: ${settings.mode}`);
    const candidates = filterByMode(downloads.filter(isUnqueued), settings.mode, settings.maxSizeMB);
    if (candidates.length === 0) {
      toaster.toast({ title: "Download All", body: "No downloads to queue" });
      return;
    }
    const sorted = sortBySize(candidates);

    logger.info(`Queueing ${sorted.length} downloads (mode: ${settings.mode})`);
    for (let i = 0; i < sorted.length; i++) {
      const sizeMB = (getTotalBytes(sorted[i]) / (1024 * 1024)).toFixed(1);
      const name = window.appStore?.GetAppOverviewByAppID(sorted[i].appid)?.display_name ?? sorted[i].appid;
      logger.info(`  [${i + 1}] ${name} (${sorted[i].appid}), size=${sizeMB} MB`);
    }

    // Find the end of the current queue
    const maxQueueIndex = Math.max(...downloads.map((d) => d.queue_index), -1);

    // SteamOS 3.8+ queue methods take a remote_client_id as second arg ("0" = local machine).
    // Pre-3.8 methods take only the appid. Cast to any since the lib types are outdated.
    const dl = SteamClient.Downloads as any;
    logger.info(`QueueAppUpdate.length=${dl.QueueAppUpdate?.length}, SetQueueIndex.length=${dl.SetQueueIndex?.length}, ResumeAppUpdate.length=${dl.ResumeAppUpdate?.length}`);

    // Add items to queue, then position them (smallest first at end of existing queue)
    for (let i = 0; i < sorted.length; i++) {
      if (apiFormat.current === DownloadAPIFormat.SteamOS38) {
        dl.QueueAppUpdate(sorted[i].appid, "0");
        dl.SetQueueIndex(sorted[i].appid, maxQueueIndex + 1 + i, "0");
      } else {
        dl.QueueAppUpdate(sorted[i].appid);
        dl.SetQueueIndex(sorted[i].appid, maxQueueIndex + 1 + i);
      }
    }

    // Resume downloading if paused
    const resumeAppId = downloads.find((d) => d.queue_index === 0)?.appid ?? sorted[0].appid;
    if (apiFormat.current === DownloadAPIFormat.SteamOS38) {
      dl.ResumeAppUpdate(resumeAppId, "0");
    } else {
      dl.ResumeAppUpdate(resumeAppId);
    }

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

  // Compute items that will be added to queue based on current mode
  const getItemsToQueue = () =>
    filterByMode(downloads.filter(isUnqueued), settings.mode, settings.maxSizeMB);

  const itemsToQueue = getItemsToQueue();
  const alreadyQueued = downloads.filter((d) => d.queue_index >= 0).length;
  const ignoredCount = downloads.filter(isUnqueued).length - itemsToQueue.length;

  // Debug: show all downloads' actual data
  const debugInfo = downloads.length > 0 ? JSON.stringify(downloads, null, 1) : "none";

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={handleDownloadAll}
            disabled={itemsToQueue.length === 0}
          >
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
            <ButtonItem
              layout="below"
              onClick={() => update({ mode: opt.data })}
            >
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
            <pre style={{ fontSize: "9px", color: "#8b929a", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>
              {debugInfo}
            </pre>
          </PanelSectionRow>
        )}
      </PanelSection>
    </>
  );
};

// Plugin entry
export default definePlugin(() => {
  logger.info("Download All plugin initialized");
  return {
    name: "Download All Button",
    content: <PluginContent />,
    icon: <FaDownload />,
  };
});
