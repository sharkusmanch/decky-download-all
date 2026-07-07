import { definePlugin } from "@decky/api";
import { ButtonItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { useState, useEffect, FC } from "react";
import { FaDownload, FaCheck } from "react-icons/fa";
import { logger } from "./logger";
import { selectItemsToQueue } from "./lib/downloads";
import * as controller from "./controller";

const modeOptions = [
  { label: "All", data: "all" as const },
  { label: "Scheduled", data: "scheduled" as const },
  { label: "Scheduled With Size Limit", data: "size-limit" as const },
];

const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

const PluginContent: FC = () => {
  // Re-render whenever the controller notifies (downloads/settings/lastRun changed).
  const [, force] = useState(0);
  useEffect(() => controller.subscribe(() => force((n) => n + 1)), []);
  const { settings, downloads, lastRun } = controller.getState();

  const itemsToQueue = selectItemsToQueue(downloads, settings);
  const alreadyQueued = downloads.filter((d) => d.queue_index >= 0).length;
  const ignoredCount = downloads.filter((d) => d.queue_index === -1).length - itemsToQueue.length;

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => controller.runQueue({ silent: false })}
            disabled={itemsToQueue.length === 0}>
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
            <ButtonItem layout="below" onClick={() => controller.updateSettings({ mode: opt.data })}>
              {settings.mode === opt.data && <FaCheck style={{ marginRight: "8px" }} />}
              {opt.label}
            </ButtonItem>
          </PanelSectionRow>
        ))}
        {settings.mode === "size-limit" && (
          <PanelSectionRow>
            <SliderField label={`Max Size: ${settings.maxSizeMB} MB`} value={settings.maxSizeMB}
              min={100} max={10000} step={100}
              onChange={(v) => controller.updateSettings({ maxSizeMB: v })} />
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Auto Queue">
        <PanelSectionRow>
          <ToggleField label="Auto-queue on a timer" checked={settings.autoQueue}
            onChange={(v) => controller.updateSettings({ autoQueue: v })} />
        </PanelSectionRow>
        {settings.autoQueue && (
          <PanelSectionRow>
            <SliderField label={`Every ${settings.autoQueueIntervalMin} min`}
              value={settings.autoQueueIntervalMin} min={5} max={120} step={5}
              onChange={(v) => controller.updateSettings({ autoQueueIntervalMin: v })} />
          </PanelSectionRow>
        )}
        {settings.autoQueue && (
          <PanelSectionRow>
            <span style={{ fontSize: "12px", color: "#8b929a" }}>
              Auto-queue on · every {settings.autoQueueIntervalMin} min
              {lastRun && ` · last queued ${lastRun.count} game${lastRun.count !== 1 ? "s" : ""} ${ago(lastRun.at)}`}
            </span>
          </PanelSectionRow>
        )}
      </PanelSection>
    </>
  );
};

export default definePlugin(() => {
  logger.info("Download All+ plugin initialized");
  controller.init();
  return {
    name: "Download All+",
    content: <PluginContent />,
    icon: <FaDownload />,
    onDismount() { controller.dispose(); },
  };
});
