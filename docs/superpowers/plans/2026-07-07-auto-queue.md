# Auto-Queue on a Timer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in background timer that periodically re-runs the download-queue action, and in doing so lift the queue logic out of the panel component into testable pure functions plus a module-scope controller.

**Architecture:** Split the current single `src/index.tsx` into pure logic (`src/lib/downloads.ts`, unit-tested), an effectful module-scope controller (`src/controller.ts`, owns the `SteamClient` listener + timer, verified on-device), and a thin view (`src/index.tsx`). The timer lives at module scope so it runs whenever the plugin is loaded, not only while the QAM panel is open.

**Tech Stack:** TypeScript, React, `@decky/ui` + `@decky/api`, rollup, pnpm, vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-auto-queue-design.md`. Branch: `feat/auto-queue`.

---

### Task 0: vitest toolchain

**Files:** Modify `package.json`

- [ ] **Step 1: Add vitest and a real test script**

```bash
cd /config/decky-download-all
pnpm add -D vitest
```
Then edit `package.json` `scripts.test` from the stub to:
```json
"test": "vitest run"
```

- [ ] **Step 2: Verify vitest runs (no tests yet)**

Run: `pnpm run test`
Expected: vitest starts and reports "No test files found" (exit non-zero is fine at this point).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add vitest test toolchain"
```

---

### Task 1: `downloads.ts` — types, settings, getTotalBytes

**Files:**
- Create: `src/lib/downloads.ts`
- Test: `src/lib/__tests__/downloads.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/downloads.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getTotalBytes, DEFAULTS, type DownloadItem } from "../downloads";

const item = (over: Partial<DownloadItem>): DownloadItem => ({
  appid: 1, active: false, completed: false, paused: false,
  queue_index: -1, deferred_time: 0, update_type_info: [], ...over,
});

describe("getTotalBytes", () => {
  it("sums bytes_total across pending updates", () => {
    const d = item({ update_type_info: [
      { has_update: true, completed_update: false, progress: [{ bytes_total: 100, bytes_in_progress: 0 }, { bytes_total: 50, bytes_in_progress: 0 }] },
    ] });
    expect(getTotalBytes(d)).toBe(150);
  });
  it("ignores completed updates and missing info", () => {
    const d = item({ update_type_info: [
      { has_update: true, completed_update: true, progress: [{ bytes_total: 999, bytes_in_progress: 0 }] },
      { has_update: false, completed_update: false, progress: [{ bytes_total: 5, bytes_in_progress: 0 }] },
    ] });
    expect(getTotalBytes(d)).toBe(0);
    expect(getTotalBytes(item({ update_type_info: undefined }))).toBe(0);
  });
});

describe("DEFAULTS", () => {
  it("auto-queue is off by default at 15 min", () => {
    expect(DEFAULTS.autoQueue).toBe(false);
    expect(DEFAULTS.autoQueueIntervalMin).toBe(15);
    expect(DEFAULTS.mode).toBe("scheduled");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm run test`
Expected: FAIL — cannot find `../downloads`.

- [ ] **Step 3: Implement**

`src/lib/downloads.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm run test`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/downloads.ts src/lib/__tests__/downloads.test.ts
git commit -m "feat: pure download types, settings defaults, getTotalBytes"
```

---

### Task 2: `parseDownloadItems` — legacy vs SteamOS 3.8 shape

**Files:**
- Modify: `src/lib/downloads.ts`
- Test: `src/lib/__tests__/downloads.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { parseDownloadItems } from "../downloads";

describe("parseDownloadItems", () => {
  const a = item({ appid: 1 }), b = item({ appid: 2 });

  it("legacy: items array in args[1]", () => {
    const r = parseDownloadItems([true, [a, b]]);
    expect(r.format).toBe("legacy");
    expect(r.items.map(i => i.appid)).toEqual([1, 2]);
  });

  it("steamos38: picks the local machine (remote_client_id '0')", () => {
    const r = parseDownloadItems([true, [
      { remote_client_id: "0", item_data: [a] },
      { remote_client_id: "99", item_data: [b] },
    ]]);
    expect(r.format).toBe("steamos38");
    expect(r.items.map(i => i.appid)).toEqual([1]);
  });

  it("steamos38 with no local entry → empty", () => {
    const r = parseDownloadItems([true, [{ remote_client_id: "7", item_data: [a] }]]);
    expect(r.format).toBe("steamos38");
    expect(r.items).toEqual([]);
  });

  it("degenerate args → legacy empty", () => {
    expect(parseDownloadItems([]).items).toEqual([]);
    expect(parseDownloadItems([true, null]).items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm run test` → FAIL (`parseDownloadItems` undefined).

- [ ] **Step 3: Implement** (append to `src/lib/downloads.ts`)

```ts
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
```

- [ ] **Step 4: Run to verify pass** — `pnpm run test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/downloads.ts src/lib/__tests__/downloads.test.ts
git commit -m "feat: parseDownloadItems handles legacy and SteamOS 3.8 shapes"
```

---

### Task 3: `selectItemsToQueue` + `planQueueOps`

**Files:**
- Modify: `src/lib/downloads.ts`
- Test: `src/lib/__tests__/downloads.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { selectItemsToQueue, planQueueOps } from "../downloads";

const sized = (appid: number, over: Partial<DownloadItem>, bytes: number): DownloadItem =>
  item({ appid, deferred_time: 1, ...over,
    update_type_info: [{ has_update: true, completed_update: false, progress: [{ bytes_total: bytes, bytes_in_progress: 0 }] }] });

const settings = (over: Partial<import("../downloads").Settings> = {}) => ({ ...DEFAULTS, ...over });

describe("selectItemsToQueue", () => {
  it("all mode: every unqueued item, smallest first", () => {
    const dl = [sized(1, {}, 300), sized(2, {}, 100), item({ appid: 3, queue_index: 0 })];
    expect(selectItemsToQueue(dl, settings({ mode: "all" })).map(d => d.appid)).toEqual([2, 1]);
  });
  it("scheduled mode: only deferred_time > 0", () => {
    const dl = [sized(1, { deferred_time: 0 }, 100), sized(2, { deferred_time: 5 }, 100)];
    expect(selectItemsToQueue(dl, settings({ mode: "scheduled" })).map(d => d.appid)).toEqual([2]);
  });
  it("size-limit mode: scheduled and within maxSizeMB", () => {
    const dl = [sized(1, {}, 100 * 1024 * 1024), sized(2, {}, 9000 * 1024 * 1024)];
    const r = selectItemsToQueue(dl, settings({ mode: "size-limit", maxSizeMB: 5000 }));
    expect(r.map(d => d.appid)).toEqual([1]);
  });
  it("excludes already-queued items", () => {
    const dl = [item({ appid: 1, queue_index: 2, deferred_time: 1 })];
    expect(selectItemsToQueue(dl, settings({ mode: "all" }))).toEqual([]);
  });
});

describe("planQueueOps", () => {
  it("appends below the current max queue index; resumes head or first item", () => {
    const items = [sized(2, {}, 100), sized(3, {}, 200)];
    const downloads = [item({ appid: 1, queue_index: 0 }), ...items];
    const plan = planQueueOps(items, downloads);
    expect(plan.ops).toEqual([{ appid: 2, index: 1 }, { appid: 3, index: 2 }]);
    expect(plan.resumeAppId).toBe(1); // head of queue (queue_index 0)
  });
  it("with no active head, resumes the first queued item", () => {
    const items = [sized(2, {}, 100)];
    expect(planQueueOps(items, items).resumeAppId).toBe(2);
    expect(planQueueOps([], []).resumeAppId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm run test` → FAIL.

- [ ] **Step 3: Implement** (append to `src/lib/downloads.ts`)

```ts
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
```

- [ ] **Step 4: Run to verify pass** — `pnpm run test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/downloads.ts src/lib/__tests__/downloads.test.ts
git commit -m "feat: selectItemsToQueue and planQueueOps (mode filter, sort, positions)"
```

---

### Task 4: `controller.ts` — module-scope listener, runQueue, timer

**Files:**
- Create: `src/controller.ts`

Not unit-tested (uses `SteamClient`/`window`/timers). Verified by build + on-device.

- [ ] **Step 1: Implement**

`src/controller.ts`:
```ts
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
```

- [ ] **Step 2: Verify it type-checks in the build** (done in Task 5's build). Sanity-parse now:

Run: `pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -i controller || echo "no controller type errors"`
Expected: `no controller type errors` (SteamClient/appStore/window globals are typed by `@decky/ui`; if `window.appStore` is untyped, it's already used the same way in the current `index.tsx`).

- [ ] **Step 3: Commit**

```bash
git add src/controller.ts
git commit -m "feat: module-scope controller — download listener, runQueue, auto-queue timer"
```

---

### Task 5: Rewrite `src/index.tsx` — wire controller + Auto Queue UI

**Files:**
- Modify: `src/index.tsx` (full rewrite)

- [ ] **Step 1: Replace the file**

`src/index.tsx`:
```tsx
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
  logger.info("Download All plugin initialized");
  controller.init();
  return {
    name: "Download All Button",
    content: <PluginContent />,
    icon: <FaDownload />,
    onDismount() { controller.dispose(); },
  };
});
```

Note: the panel subscribes to the controller on mount and force-re-renders on every `notify()`, reading fresh module state via `controller.getState()` each render. (Avoid `useSyncExternalStore` here — `getState()` returns a new object each call, which trips React's "getSnapshot should be cached" loop.)

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: `created dist/index.js` with no TypeScript errors. (`ToggleField`/`useSyncExternalStore` are exported by `@decky/ui`/React respectively.)

- [ ] **Step 3: Full check**

Run: `pnpm run test && pnpm run build && echo OK`
Expected: tests green, build clean, `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/index.tsx
git commit -m "feat: auto-queue UI + wire panel to module-scope controller"
```

---

### Task 6: On-device smoke test (manual — needs a Steam Deck)

Cannot run from this environment. Deploy (plugins dir is root-owned → stage then sudo):
```bash
pnpm run build
scp -r . deck@<ip>:/tmp/download-all
ssh deck@<ip> "sudo rm -rf ~/homebrew/plugins/download-all && \
  sudo cp -r /tmp/download-all ~/homebrew/plugins/ && \
  sudo systemctl restart plugin_loader"
```

- [ ] Panel opens; manual "Queue N Downloads" button still works exactly as before (all/scheduled/size-limit).
- [ ] Enable "Auto-queue on a timer", set 5 min; schedule a download in Steam; confirm it gets queued within the interval **with the QAM closed** (check Decky log for `runQueue: queueing`).
- [ ] Auto ticks produce **no toasts**; manual button still toasts.
- [ ] Status line shows "last queued N games Xm ago" after an auto run.
- [ ] Toggle off → timer stops (no further `auto-queue timer` runs in log); change interval → log shows a new "timer started" line.

Then use superpowers:finishing-a-development-branch (push `feat/auto-queue`, open a PR).
