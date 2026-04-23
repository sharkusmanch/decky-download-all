# Auto Download Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `decky-download-all` to automatically queue pending Steam downloads — reactive on Steam events, with a 15-min interval fallback that also nudges stalled downloads back to life — configured independently from the existing manual button.

**Architecture:** Pull the Steam subscription out of the React component and into module scope so it runs whenever the plugin is loaded (not just when the panel is open). Add an `autoRunTick(trigger)` function called from both the subscription (1 s trailing debounce) and a `setInterval` (15 min). Keep the existing manual path intact; add a new "Auto Download" panel section for its independent settings.

**Tech Stack:** TypeScript, React 19, `@decky/api`, `@decky/ui`, Rollup (via `@decky/rollup`), Python 3 backend (unchanged, only the existing `log_from_ui` is used). Tests via Vitest (new).

**Spec:** [docs/superpowers/specs/2026-04-23-auto-download-scheduling-design.md](../specs/2026-04-23-auto-download-scheduling-design.md)

---

## File Structure

**New files:**

- `src/download-selection.ts` — Pure functions: `getTotalBytes`, `isUnqueued`, `isStalledHead`, `filterByMode`, `sortBySize`. No React, no SteamClient. Easy to test.
- `src/settings.ts` — Settings interface, `DEFAULTS`, `loadSettings`, `saveSettings`. Pulled out of `index.tsx` for isolation.
- `src/debounce.ts` — Tiny trailing-debounce helper.
- `src/auto-run.ts` — The `autoRunTick` function, `actedAppids` lifecycle management, `lastAutoRun` state. Imports from `download-selection.ts` and the queue helper.
- `src/plugin-state.ts` — Module-level pub/sub: `currentDownloads`, `apiFormat`, `lastAutoRun`, subscriber list, `useSharedState` React hook.
- `src/queue.ts` — `queueItems(items, apiFormat)` and `resumeHead(appid, apiFormat)` wrappers around `SteamClient.Downloads` that handle the Legacy vs SteamOS-3.8 branch.
- `tests/download-selection.test.ts` — Unit tests for `src/download-selection.ts`.
- `tests/settings.test.ts` — Unit tests for `src/settings.ts`.
- `tests/debounce.test.ts` — Unit tests for `src/debounce.ts`.
- `tests/auto-run.test.ts` — Unit tests for `src/auto-run.ts` (mocked queue helpers).
- `vitest.config.ts` — Vitest configuration.

**Modified files:**

- `src/index.tsx` — Reduced to: plugin entry, the module-level subscription, interval setup, and the React UI (`PluginContent`). Imports everything else.
- `package.json` — Add Vitest devDep; flip the `test` script; add `test:watch`.
- `README.md` — Document auto mode, defaults, retry behavior, log location.
- `plugin.json` — Update `description` to reflect auto behavior.

**Unchanged files:**

- `main.py` — `log_from_ui` already covers all logging needs.
- `rollup.config.js`, `tsconfig.json`, `.github/workflows/*`.

---

## Task 1: Set up Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/smoke.test.ts` (sanity check only; deleted in Task 2 once real tests exist)

- [ ] **Step 1: Install Vitest as a devDep**

Run: `cd /home/deck/decky-download-all && pnpm add -D vitest@^2 happy-dom@^15`

Expected: `pnpm-lock.yaml` updated; `vitest` and `happy-dom` appear under `devDependencies` in `package.json`.

- [ ] **Step 2: Update `package.json` scripts**

Replace the `"test"` line in `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts` at the repo root**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
```

- [ ] **Step 4: Write a smoke test**

Create `tests/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it to verify the harness works**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: `1 passed`. No errors.

- [ ] **Step 6: Commit**

```bash
cd /home/deck/decky-download-all
git add package.json pnpm-lock.yaml vitest.config.ts tests/smoke.test.ts
git commit -m "chore: set up vitest for unit tests"
```

---

## Task 2: Extract pure selection/filter logic with tests

Extract `getTotalBytes`, `isUnqueued`, and introduce `filterByMode`, `sortBySize`, and `isStalledHead`. Replace the inline copies in `index.tsx` with imports. Delete the smoke test.

**Files:**
- Create: `src/download-selection.ts`
- Modify: `src/index.tsx` (remove inline `getTotalBytes` + `isUnqueued`; import from new module)
- Create: `tests/download-selection.test.ts`
- Delete: `tests/smoke.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/download-selection.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  getTotalBytes,
  isUnqueued,
  isStalledHead,
  filterByMode,
  sortBySize,
  type DownloadItem,
} from "../src/download-selection";

const mk = (overrides: Partial<DownloadItem>): DownloadItem => ({
  appid: 1,
  active: false,
  completed: false,
  paused: false,
  queue_index: -1,
  deferred_time: 0,
  update_type_info: [],
  ...overrides,
});

describe("getTotalBytes", () => {
  it("sums bytes_total across pending update_type_info entries", () => {
    const d = mk({
      update_type_info: [
        { has_update: true, completed_update: false, progress: [{ bytes_total: 1000, bytes_in_progress: 0 }] },
        { has_update: true, completed_update: false, progress: [{ bytes_total: 500, bytes_in_progress: 0 }] },
      ],
    });
    expect(getTotalBytes(d)).toBe(1500);
  });

  it("ignores completed updates", () => {
    const d = mk({
      update_type_info: [
        { has_update: true, completed_update: true, progress: [{ bytes_total: 1000, bytes_in_progress: 0 }] },
      ],
    });
    expect(getTotalBytes(d)).toBe(0);
  });

  it("ignores entries with has_update=false", () => {
    const d = mk({
      update_type_info: [
        { has_update: false, completed_update: false, progress: [{ bytes_total: 1000, bytes_in_progress: 0 }] },
      ],
    });
    expect(getTotalBytes(d)).toBe(0);
  });

  it("returns 0 when update_type_info is missing", () => {
    const d = mk({ update_type_info: undefined });
    expect(getTotalBytes(d)).toBe(0);
  });
});

describe("isUnqueued", () => {
  it("is true when queue_index is -1", () => {
    expect(isUnqueued(mk({ queue_index: -1 }))).toBe(true);
  });
  it("is false when queue_index is 0 or higher", () => {
    expect(isUnqueued(mk({ queue_index: 0 }))).toBe(false);
    expect(isUnqueued(mk({ queue_index: 5 }))).toBe(false);
  });
});

describe("isStalledHead", () => {
  const head = (o: Partial<DownloadItem>) => mk({ queue_index: 0, ...o });
  it("is true when head is not active, not paused, not completed", () => {
    expect(isStalledHead(head({ active: false, paused: false, completed: false }))).toBe(true);
  });
  it("is false when head is active", () => {
    expect(isStalledHead(head({ active: true }))).toBe(false);
  });
  it("is false when head is paused (user intent)", () => {
    expect(isStalledHead(head({ paused: true }))).toBe(false);
  });
  it("is false when head is completed", () => {
    expect(isStalledHead(head({ completed: true }))).toBe(false);
  });
  it("is false when item is not queue head (queue_index !== 0)", () => {
    expect(isStalledHead(mk({ queue_index: 1, active: false, paused: false }))).toBe(false);
    expect(isStalledHead(mk({ queue_index: -1, active: false, paused: false }))).toBe(false);
  });
});

describe("filterByMode", () => {
  const unqueuedUnscheduled = mk({ queue_index: -1, deferred_time: 0 });
  const unqueuedScheduled = mk({ appid: 2, queue_index: -1, deferred_time: 1_700_000_000 });
  const unqueuedBigScheduled = mk({
    appid: 3,
    queue_index: -1,
    deferred_time: 1_700_000_000,
    update_type_info: [
      { has_update: true, completed_update: false, progress: [{ bytes_total: 10 * 1024 * 1024 * 1024, bytes_in_progress: 0 }] },
    ],
  });

  it("mode 'all' keeps all unqueued items", () => {
    const out = filterByMode([unqueuedUnscheduled, unqueuedScheduled], "all", 5000);
    expect(out.map((d) => d.appid).sort()).toEqual([1, 2]);
  });

  it("mode 'scheduled' drops unscheduled items", () => {
    const out = filterByMode([unqueuedUnscheduled, unqueuedScheduled], "scheduled", 5000);
    expect(out.map((d) => d.appid)).toEqual([2]);
  });

  it("mode 'size-limit' drops items larger than maxSizeMB", () => {
    const out = filterByMode([unqueuedScheduled, unqueuedBigScheduled], "size-limit", 5000);
    expect(out.map((d) => d.appid)).toEqual([2]);
  });

  it("mode 'size-limit' also requires items to be scheduled", () => {
    const out = filterByMode([unqueuedUnscheduled, unqueuedScheduled], "size-limit", 5000);
    expect(out.map((d) => d.appid)).toEqual([2]);
  });

  it("does not filter out already-queued items (caller is responsible for isUnqueued)", () => {
    const queued = mk({ appid: 99, queue_index: 5, deferred_time: 1_700_000_000 });
    const out = filterByMode([queued], "all", 5000);
    expect(out.map((d) => d.appid)).toEqual([99]);
  });
});

describe("sortBySize", () => {
  it("sorts ascending by getTotalBytes, stable on ties", () => {
    const mkWithSize = (appid: number, bytes: number) =>
      mk({
        appid,
        update_type_info: [
          { has_update: true, completed_update: false, progress: [{ bytes_total: bytes, bytes_in_progress: 0 }] },
        ],
      });
    const a = mkWithSize(1, 3000);
    const b = mkWithSize(2, 1000);
    const c = mkWithSize(3, 2000);
    expect(sortBySize([a, b, c]).map((d) => d.appid)).toEqual([2, 3, 1]);
  });

  it("does not mutate the input array", () => {
    const input = [mk({ appid: 1 }), mk({ appid: 2 })];
    const before = [...input];
    sortBySize(input);
    expect(input).toEqual(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: FAIL with "Cannot find module '../src/download-selection'".

- [ ] **Step 3: Create `src/download-selection.ts` with the extracted logic**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: all tests pass.

- [ ] **Step 5: Update `src/index.tsx` to import from the new module**

In `src/index.tsx`:

1. Remove the inline `ProgressInfo`, `UpdateTypeInfo`, `DownloadItem`, `getTotalBytes`, `isUnqueued` declarations.
2. Remove the inline `Mode` type.
3. Add at the top, near other imports:

```ts
import {
  getTotalBytes,
  isUnqueued,
  filterByMode,
  sortBySize,
  type DownloadItem,
  type Mode,
} from "./download-selection";
```

4. Delete these lines inside `PluginContent`:

```ts
// Items not yet in the queue
const isUnqueued = (d: DownloadItem) => d.queue_index === -1;
```

5. Inside `handleDownloadAll`, replace:

```ts
let items = downloads.filter(isUnqueued);
if (settings.mode === "scheduled") {
  items = items.filter((d) => d.deferred_time > 0);
} else if (settings.mode === "size-limit") {
  const maxBytes = settings.maxSizeMB * 1024 * 1024;
  items = items.filter((d) => d.deferred_time > 0 && getTotalBytes(d) <= maxBytes);
}
```

with:

```ts
const items = filterByMode(downloads.filter(isUnqueued), settings.mode, settings.maxSizeMB);
```

6. Replace:

```ts
items.sort((a, b) => getTotalBytes(a) - getTotalBytes(b));
```

with a reassignment (since `filterByMode` returns a fresh array and `sortBySize` returns a new array, and we want to keep `items` mutable-ish; we'll redeclare it as `const sorted`):

The simplest pattern inside `handleDownloadAll` is:

```ts
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
// ... (rest of handleDownloadAll uses `sorted` instead of `items`)
```

Rename all subsequent `items`-references inside `handleDownloadAll` to `sorted`.

7. Similarly, replace `getItemsToQueue` inside `PluginContent` with:

```ts
const getItemsToQueue = () =>
  filterByMode(downloads.filter(isUnqueued), settings.mode, settings.maxSizeMB);
```

- [ ] **Step 6: Delete the smoke test**

```bash
rm /home/deck/decky-download-all/tests/smoke.test.ts
```

- [ ] **Step 7: Verify the build still works**

Run: `cd /home/deck/decky-download-all && pnpm run build`
Expected: build succeeds without TypeScript errors. Inspect `dist/` if needed.

- [ ] **Step 8: Run tests again**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: all tests pass (smoke.test.ts gone, download-selection tests pass).

- [ ] **Step 9: Commit**

```bash
cd /home/deck/decky-download-all
git add src/download-selection.ts src/index.tsx tests/download-selection.test.ts tests/smoke.test.ts
git commit -m "refactor: extract pure download-selection helpers with unit tests"
```

---

## Task 3: Extract settings module with tests

**Files:**
- Create: `src/settings.ts`
- Create: `tests/settings.test.ts`
- Modify: `src/index.tsx` (remove inline Settings interface, DEFAULTS, loadSettings, saveSettings, STORAGE_KEY)

- [ ] **Step 1: Write failing tests**

Create `tests/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadSettings, saveSettings, DEFAULTS, STORAGE_KEY } from "../src/settings";

beforeEach(() => {
  localStorage.clear();
});

describe("loadSettings", () => {
  it("returns DEFAULTS when localStorage is empty", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("merges stored partial settings with DEFAULTS", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "all", maxSizeMB: 2000 }));
    const s = loadSettings();
    expect(s.mode).toBe("all");
    expect(s.maxSizeMB).toBe(2000);
    expect(s.autoEnabled).toBe(DEFAULTS.autoEnabled);
    expect(s.autoMode).toBe(DEFAULTS.autoMode);
    expect(s.autoMaxSizeMB).toBe(DEFAULTS.autoMaxSizeMB);
  });

  it("fills in new auto-* defaults when upgrading from an older version", () => {
    // Simulate pre-auto-feature stored settings
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "scheduled", maxSizeMB: 5000 }));
    const s = loadSettings();
    expect(s.autoEnabled).toBe(true);
    expect(s.autoMode).toBe("scheduled");
    expect(s.autoMaxSizeMB).toBe(5000);
  });

  it("falls back to DEFAULTS on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not-valid-json");
    expect(loadSettings()).toEqual(DEFAULTS);
  });
});

describe("saveSettings", () => {
  it("persists to localStorage under STORAGE_KEY", () => {
    saveSettings({ ...DEFAULTS, mode: "all", maxSizeMB: 1234 });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.mode).toBe("all");
    expect(parsed.maxSizeMB).toBe(1234);
  });

  it("round-trips with loadSettings", () => {
    const custom = { ...DEFAULTS, autoEnabled: false, autoMode: "size-limit" as const, autoMaxSizeMB: 1500 };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });
});

describe("DEFAULTS", () => {
  it("has autoEnabled=true, autoMode='scheduled', autoMaxSizeMB=5000", () => {
    expect(DEFAULTS.autoEnabled).toBe(true);
    expect(DEFAULTS.autoMode).toBe("scheduled");
    expect(DEFAULTS.autoMaxSizeMB).toBe(5000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: FAIL — module `../src/settings` not found.

- [ ] **Step 3: Create `src/settings.ts`**

```ts
import type { Mode } from "./download-selection";

export interface Settings {
  mode: Mode;
  maxSizeMB: number;
  autoEnabled: boolean;
  autoMode: Mode;
  autoMaxSizeMB: number;
}

export const STORAGE_KEY = "download-all-settings";

export const DEFAULTS: Settings = {
  mode: "scheduled",
  maxSizeMB: 5000,
  autoEnabled: true,
  autoMode: "scheduled",
  autoMaxSizeMB: 5000,
};

export const loadSettings = (): Settings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...DEFAULTS, ...JSON.parse(stored) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
};

export const saveSettings = (settings: Settings): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: all pass.

- [ ] **Step 5: Update `src/index.tsx`**

In `src/index.tsx`:

1. Remove the inline `Settings` interface, `STORAGE_KEY`, `DEFAULTS`, `loadSettings`, `saveSettings`.
2. Remove the `Mode` declaration (now imported from `download-selection`).
3. Add to the top imports:

```ts
import { loadSettings, saveSettings, type Settings } from "./settings";
```

4. The existing `let currentSettings = loadSettings();` line stays.

- [ ] **Step 6: Run build and tests**

Run: `cd /home/deck/decky-download-all && pnpm run build && pnpm test`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
cd /home/deck/decky-download-all
git add src/settings.ts src/index.tsx tests/settings.test.ts
git commit -m "refactor: extract settings module; add auto-* defaults"
```

---

## Task 4: Extract queue + resume helpers

Wraps the Legacy vs SteamOS-3.8 branching that currently lives inline in `handleDownloadAll`. No new behavior; just makes the logic reusable by `auto-run.ts`. Not unit-testable (calls `SteamClient`); verified manually via the build and by later on-device runs.

**Files:**
- Create: `src/queue.ts`
- Modify: `src/index.tsx` (use the helper in `handleDownloadAll`)

- [ ] **Step 1: Create `src/queue.ts`**

```ts
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

// Append `items` to the end of the existing queue (after maxQueueIndex), then resume the queue head.
// `items` should already be in the desired order (caller sorts).
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
```

- [ ] **Step 2: Update `src/index.tsx` to use the helpers**

1. Remove the inline `enum DownloadAPIFormat { ... }` declaration.
2. Add to imports:

```ts
import {
  DownloadAPIFormat,
  detectAPIFormat,
  extractItems,
  queueItems,
  resumeAppUpdate,
} from "./queue";
```

3. In the `useEffect` subscription body, replace the API-format-detection and item-extraction block:

Old:
```ts
const arr: any[] = Array.isArray(args[1]) ? args[1] : Array.isArray(args[0]) ? args[0] : [];
let items: DownloadItem[];
if (arr.length > 0 && arr[0].item_data !== undefined) {
  apiFormat.current = DownloadAPIFormat.SteamOS38;
  const localEntry = arr.find((entry: any) => entry.remote_client_id === "0");
  items = localEntry ? (localEntry.item_data as DownloadItem[]) : [];
} else {
  apiFormat.current = DownloadAPIFormat.Legacy;
  items = arr as DownloadItem[];
}
```

New:
```ts
const arr: any[] = Array.isArray(args[1]) ? args[1] : Array.isArray(args[0]) ? args[0] : [];
apiFormat.current = detectAPIFormat(arr);
const items = extractItems(arr, apiFormat.current);
```

4. In `handleDownloadAll`, replace the for-loop queueing block:

Old:
```ts
for (let i = 0; i < items.length; i++) {
  if (apiFormat.current === DownloadAPIFormat.SteamOS38) {
    dl.QueueAppUpdate(items[i].appid, "0");
    dl.SetQueueIndex(items[i].appid, maxQueueIndex + 1 + i, "0");
  } else {
    dl.QueueAppUpdate(items[i].appid);
    dl.SetQueueIndex(items[i].appid, maxQueueIndex + 1 + i);
  }
}
const resumeAppId = downloads.find((d) => d.queue_index === 0)?.appid ?? items[0].appid;
if (apiFormat.current === DownloadAPIFormat.SteamOS38) {
  dl.ResumeAppUpdate(resumeAppId, "0");
} else {
  dl.ResumeAppUpdate(resumeAppId);
}
```

New (note: the variable was renamed to `sorted` in Task 2; adjust accordingly):
```ts
queueItems(sorted, maxQueueIndex, apiFormat.current);
const resumeAppId = downloads.find((d) => d.queue_index === 0)?.appid ?? sorted[0].appid;
resumeAppUpdate(resumeAppId, apiFormat.current);
```

5. Remove the now-unused `const dl = SteamClient.Downloads as any;` line and the `QueueAppUpdate.length=...` debug log line (or keep the debug log but move it to use `dl` computed locally; simpler to just remove).

- [ ] **Step 3: Verify build**

Run: `cd /home/deck/decky-download-all && pnpm run build`
Expected: success, no TS errors.

- [ ] **Step 4: Run tests**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: still all passing.

- [ ] **Step 5: Commit**

```bash
cd /home/deck/decky-download-all
git add src/queue.ts src/index.tsx
git commit -m "refactor: extract queue+resume helpers to src/queue.ts"
```

---

## Task 5: Add the debounce helper with tests

**Files:**
- Create: `src/debounce.ts`
- Create: `tests/debounce.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/debounce.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trailingDebounce } from "../src/debounce";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("trailingDebounce", () => {
  it("fires once after the delay when called once", () => {
    const fn = vi.fn();
    const d = trailingDebounce(fn, 1000);
    d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple calls within the window into a single trailing call", () => {
    const fn = vi.fn();
    const d = trailingDebounce(fn, 1000);
    d();
    vi.advanceTimersByTime(500);
    d();
    vi.advanceTimersByTime(500);
    d();
    // Only 500ms have elapsed since the most recent call.
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents the pending call", () => {
    const fn = vi.fn();
    const d = trailingDebounce(fn, 1000);
    d();
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fires again for a new call after the previous one has resolved", () => {
    const fn = vi.fn();
    const d = trailingDebounce(fn, 1000);
    d();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    d();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: FAIL — `../src/debounce` not found.

- [ ] **Step 3: Create `src/debounce.ts`**

```ts
export interface DebouncedFn {
  (): void;
  cancel: () => void;
}

export const trailingDebounce = (fn: () => void, waitMs: number): DebouncedFn => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, waitMs);
  };
  (debounced as DebouncedFn).cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced as DebouncedFn;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/deck/decky-download-all
git add src/debounce.ts tests/debounce.test.ts
git commit -m "feat: add trailing-debounce helper"
```

---

## Task 6: Create module-level plugin state (pub/sub + hook)

Host the shared state that both the auto-runner and `PluginContent` need to read.

**Files:**
- Create: `src/plugin-state.ts`
- Modify: (none yet — wired up in Task 8)

No unit tests here: the module exports mutable refs and a subscriber list; exercising it usefully requires a real React renderer. Behavior gets covered by the integration-style on-device verification in Task 11.

- [ ] **Step 1: Create `src/plugin-state.ts`**

```ts
import { useEffect, useState } from "react";
import type { DownloadItem } from "./download-selection";
import { DownloadAPIFormat } from "./queue";

export interface LastAutoRun {
  time: number;                                    // Date.now()
  trigger: "reactive" | "interval";
  action: "queued" | "resumed";
  count: number;                                   // items queued (0 for "resumed")
}

// Mutable module-level state. Readers call the accessors; writers call the setters,
// which notify subscribers so React components can re-render.

let currentDownloads: DownloadItem[] = [];
let apiFormat: DownloadAPIFormat = DownloadAPIFormat.Legacy;
let lastAutoRun: LastAutoRun | null = null;

const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((fn) => fn());

export const getCurrentDownloads = (): DownloadItem[] => currentDownloads;
export const getAPIFormat = (): DownloadAPIFormat => apiFormat;
export const getLastAutoRun = (): LastAutoRun | null => lastAutoRun;

export const setCurrentDownloads = (items: DownloadItem[]): void => {
  currentDownloads = items;
  notify();
};

export const setAPIFormat = (format: DownloadAPIFormat): void => {
  apiFormat = format;
};

export const setLastAutoRun = (run: LastAutoRun): void => {
  lastAutoRun = run;
  notify();
};

// React hook: re-renders the caller whenever module state changes.
export const useSharedState = (): { downloads: DownloadItem[]; lastAutoRun: LastAutoRun | null } => {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const cb = () => forceRender((n) => n + 1);
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }, []);
  return { downloads: currentDownloads, lastAutoRun };
};
```

- [ ] **Step 2: Verify build**

Run: `cd /home/deck/decky-download-all && pnpm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
cd /home/deck/decky-download-all
git add src/plugin-state.ts
git commit -m "feat: add module-level plugin state with pub/sub"
```

---

## Task 7: Implement `autoRunTick` with tests

Heart of the feature. Track A (queue new eligible items) + Track B (resume stalled head). Tested with mocked queue helpers.

**Files:**
- Create: `src/auto-run.ts`
- Create: `tests/auto-run.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/auto-run.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DownloadItem } from "../src/download-selection";
import { DownloadAPIFormat } from "../src/queue";

// Mock the modules that autoRunTick depends on.
const mockQueueItems = vi.fn();
const mockResumeAppUpdate = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock("../src/queue", async () => {
  const actual = await vi.importActual<typeof import("../src/queue")>("../src/queue");
  return {
    ...actual,
    queueItems: (...args: any[]) => mockQueueItems(...args),
    resumeAppUpdate: (...args: any[]) => mockResumeAppUpdate(...args),
  };
});

vi.mock("../src/logger", () => ({
  logger: {
    info: (msg: string) => mockLoggerInfo(msg),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import the subjects under test *after* the mocks.
import { autoRunTick, resetActedAppidsForTest } from "../src/auto-run";
import { setCurrentDownloads, setAPIFormat } from "../src/plugin-state";
import { saveSettings, DEFAULTS } from "../src/settings";

const mk = (overrides: Partial<DownloadItem>): DownloadItem => ({
  appid: 0,
  active: false,
  completed: false,
  paused: false,
  queue_index: -1,
  deferred_time: 0,
  update_type_info: [
    { has_update: true, completed_update: false, progress: [{ bytes_total: 1024 * 1024, bytes_in_progress: 0 }] },
  ],
  ...overrides,
});

beforeEach(() => {
  mockQueueItems.mockReset();
  mockResumeAppUpdate.mockReset();
  mockLoggerInfo.mockReset();
  localStorage.clear();
  saveSettings({ ...DEFAULTS, autoEnabled: true, autoMode: "all", autoMaxSizeMB: 99999 });
  setAPIFormat(DownloadAPIFormat.Legacy);
  setCurrentDownloads([]);
  resetActedAppidsForTest();
});

describe("autoRunTick — Track A (queue new items)", () => {
  it("is a no-op when autoEnabled is false", () => {
    saveSettings({ ...DEFAULTS, autoEnabled: false });
    setCurrentDownloads([mk({ appid: 1 })]);
    autoRunTick("reactive");
    expect(mockQueueItems).not.toHaveBeenCalled();
  });

  it("queues unqueued eligible items sorted ascending by size", () => {
    setCurrentDownloads([
      mk({ appid: 1, update_type_info: [{ has_update: true, completed_update: false, progress: [{ bytes_total: 3000, bytes_in_progress: 0 }] }] }),
      mk({ appid: 2, update_type_info: [{ has_update: true, completed_update: false, progress: [{ bytes_total: 1000, bytes_in_progress: 0 }] }] }),
      mk({ appid: 3, update_type_info: [{ has_update: true, completed_update: false, progress: [{ bytes_total: 2000, bytes_in_progress: 0 }] }] }),
    ]);
    autoRunTick("reactive");
    expect(mockQueueItems).toHaveBeenCalledTimes(1);
    const [items, maxIdx, format] = mockQueueItems.mock.calls[0];
    expect(items.map((d: DownloadItem) => d.appid)).toEqual([2, 3, 1]);
    expect(maxIdx).toBe(-1);
    expect(format).toBe(DownloadAPIFormat.Legacy);
  });

  it("respects autoMode 'scheduled' (drops unscheduled)", () => {
    saveSettings({ ...DEFAULTS, autoEnabled: true, autoMode: "scheduled", autoMaxSizeMB: 99999 });
    setCurrentDownloads([
      mk({ appid: 1, deferred_time: 0 }),
      mk({ appid: 2, deferred_time: 1_700_000_000 }),
    ]);
    autoRunTick("interval");
    const [items] = mockQueueItems.mock.calls[0];
    expect(items.map((d: DownloadItem) => d.appid)).toEqual([2]);
  });

  it("respects autoMode 'size-limit' (drops items larger than autoMaxSizeMB)", () => {
    saveSettings({ ...DEFAULTS, autoEnabled: true, autoMode: "size-limit", autoMaxSizeMB: 1 });
    setCurrentDownloads([
      mk({ appid: 1, deferred_time: 1_700_000_000, update_type_info: [{ has_update: true, completed_update: false, progress: [{ bytes_total: 500 * 1024, bytes_in_progress: 0 }] }] }),
      mk({ appid: 2, deferred_time: 1_700_000_000, update_type_info: [{ has_update: true, completed_update: false, progress: [{ bytes_total: 10 * 1024 * 1024, bytes_in_progress: 0 }] }] }),
    ]);
    autoRunTick("interval");
    const [items] = mockQueueItems.mock.calls[0];
    expect(items.map((d: DownloadItem) => d.appid)).toEqual([1]);
  });

  it("skips already-acted appids on a second call", () => {
    setCurrentDownloads([mk({ appid: 1 }), mk({ appid: 2 })]);
    autoRunTick("reactive");
    expect(mockQueueItems).toHaveBeenCalledTimes(1);
    autoRunTick("reactive");
    expect(mockQueueItems).toHaveBeenCalledTimes(1); // second call has nothing new
  });

  it("clears acted-appid when the item disappears from currentDownloads", () => {
    setCurrentDownloads([mk({ appid: 1 })]);
    autoRunTick("reactive");
    expect(mockQueueItems).toHaveBeenCalledTimes(1);
    // Simulate the download completing and being removed from Steam's list.
    setCurrentDownloads([]);
    autoRunTick("reactive");
    // Now it reappears (re-install); autoRun should pick it up again.
    setCurrentDownloads([mk({ appid: 1 })]);
    autoRunTick("reactive");
    expect(mockQueueItems).toHaveBeenCalledTimes(2);
  });

  it("appends after the existing queue (uses maxExistingQueueIndex)", () => {
    setCurrentDownloads([
      mk({ appid: 99, queue_index: 2 }),
      mk({ appid: 1, queue_index: -1 }),
    ]);
    autoRunTick("reactive");
    const [, maxIdx] = mockQueueItems.mock.calls[0];
    expect(maxIdx).toBe(2);
  });
});

describe("autoRunTick — Track B (resume stalled head)", () => {
  it("resumes when the queue head is not active and not paused", () => {
    setCurrentDownloads([mk({ appid: 42, queue_index: 0, active: false, paused: false, completed: false })]);
    autoRunTick("interval");
    expect(mockResumeAppUpdate).toHaveBeenCalledWith(42, DownloadAPIFormat.Legacy);
  });

  it("does NOT resume a user-paused head", () => {
    setCurrentDownloads([mk({ appid: 42, queue_index: 0, paused: true })]);
    autoRunTick("interval");
    expect(mockResumeAppUpdate).not.toHaveBeenCalled();
  });

  it("does NOT resume an active head", () => {
    setCurrentDownloads([mk({ appid: 42, queue_index: 0, active: true })]);
    autoRunTick("interval");
    expect(mockResumeAppUpdate).not.toHaveBeenCalled();
  });

  it("runs both tracks in the same tick when applicable", () => {
    setCurrentDownloads([
      mk({ appid: 42, queue_index: 0, active: false, paused: false }),   // stalled head
      mk({ appid: 1, queue_index: -1 }),                                   // new eligible
    ]);
    autoRunTick("reactive");
    expect(mockQueueItems).toHaveBeenCalledTimes(1);
    expect(mockResumeAppUpdate).toHaveBeenCalledWith(42, DownloadAPIFormat.Legacy);
  });

  it("is gated on autoEnabled just like Track A", () => {
    saveSettings({ ...DEFAULTS, autoEnabled: false });
    setCurrentDownloads([mk({ appid: 42, queue_index: 0, active: false, paused: false })]);
    autoRunTick("interval");
    expect(mockResumeAppUpdate).not.toHaveBeenCalled();
  });
});

describe("autoRunTick — lastAutoRun bookkeeping", () => {
  it("records 'queued' when Track A runs", async () => {
    const { getLastAutoRun } = await import("../src/plugin-state");
    setCurrentDownloads([mk({ appid: 1 })]);
    autoRunTick("reactive");
    const last = getLastAutoRun();
    expect(last?.action).toBe("queued");
    expect(last?.count).toBe(1);
    expect(last?.trigger).toBe("reactive");
  });

  it("records 'resumed' when only Track B runs", async () => {
    const { getLastAutoRun } = await import("../src/plugin-state");
    setCurrentDownloads([mk({ appid: 42, queue_index: 0, active: false, paused: false })]);
    autoRunTick("interval");
    const last = getLastAutoRun();
    expect(last?.action).toBe("resumed");
    expect(last?.count).toBe(0);
    expect(last?.trigger).toBe("interval");
  });

  it("prefers 'queued' when both tracks run in the same tick", async () => {
    const { getLastAutoRun } = await import("../src/plugin-state");
    setCurrentDownloads([
      mk({ appid: 42, queue_index: 0, active: false, paused: false }),
      mk({ appid: 1, queue_index: -1 }),
    ]);
    autoRunTick("reactive");
    const last = getLastAutoRun();
    expect(last?.action).toBe("queued");
    expect(last?.count).toBe(1);
  });

  it("does not update lastAutoRun for a no-op tick", async () => {
    const { getLastAutoRun } = await import("../src/plugin-state");
    setCurrentDownloads([]);
    autoRunTick("interval");
    expect(getLastAutoRun()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: FAIL — `../src/auto-run` not found.

- [ ] **Step 3: Create `src/auto-run.ts`**

```ts
import {
  filterByMode,
  getTotalBytes,
  isStalledHead,
  isUnqueued,
  sortBySize,
} from "./download-selection";
import { queueItems, resumeAppUpdate } from "./queue";
import {
  getCurrentDownloads,
  getAPIFormat,
  setLastAutoRun,
} from "./plugin-state";
import { loadSettings } from "./settings";
import { logger } from "./logger";

export type AutoRunTrigger = "reactive" | "interval";

// Appids we've already moved from unqueued -> queued in this plugin session.
// Prevents re-queuing on repeated ticks while items are still visible.
const actedAppids = new Set<number>();

// Reset when an appid disappears from Steam's list (completed, cancelled, uninstalled).
const pruneActedAppids = (visibleAppids: Set<number>): void => {
  for (const id of actedAppids) {
    if (!visibleAppids.has(id)) actedAppids.delete(id);
  }
};

export const autoRunTick = (trigger: AutoRunTrigger): void => {
  const settings = loadSettings();
  if (!settings.autoEnabled) return;

  const downloads = getCurrentDownloads();
  const format = getAPIFormat();
  const now = Date.now();

  // Keep actedAppids aligned with what Steam currently shows.
  pruneActedAppids(new Set(downloads.map((d) => d.appid)));

  // Track A: queue new eligible items.
  const unqueued = downloads.filter(isUnqueued);
  const eligible = filterByMode(unqueued, settings.autoMode, settings.autoMaxSizeMB)
    .filter((d) => !actedAppids.has(d.appid));

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
      const name = (window as any).appStore?.GetAppOverviewByAppID(sorted[i].appid)?.display_name ?? sorted[i].appid;
      logger.info(`  [${i + 1}] ${name} (${sorted[i].appid}), size=${sizeMB} MB`);
    }

    setLastAutoRun({ time: now, trigger, action: "queued", count: sorted.length });
    trackAFired = true;
  }

  // Track B: kick stalled queue head.
  const head = downloads.find(isStalledHead);
  if (head) {
    resumeAppUpdate(head.appid, format);
    const name = (window as any).appStore?.GetAppOverviewByAppID(head.appid)?.display_name ?? head.appid;
    logger.info(`Auto-run (${trigger}): resumed stalled head ${name} (${head.appid})`);
    if (!trackAFired) {
      setLastAutoRun({ time: now, trigger, action: "resumed", count: 0 });
    }
  }
};

// For tests only.
export const resetActedAppidsForTest = (): void => {
  actedAppids.clear();
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: all `auto-run.test.ts` tests pass. Other suites still pass.

- [ ] **Step 5: Commit**

```bash
cd /home/deck/decky-download-all
git add src/auto-run.ts tests/auto-run.test.ts
git commit -m "feat: implement autoRunTick with two-track logic and tests"
```

---

## Task 8: Move Steam subscription to module scope; wire interval + debounce

Now the big rewiring: pull the `RegisterForDownloadItems` subscription out of `PluginContent`'s `useEffect` and into module scope, start the 15-min interval at plugin load, and reactively call `autoRunTick` via the debounce. `PluginContent` becomes a subscriber.

**Files:**
- Modify: `src/index.tsx`

No unit tests added here (interaction with `SteamClient` and React lifecycle); verified manually + via the full test suite still passing.

- [ ] **Step 1: Update `src/index.tsx`**

Full rewrite of the file. Replace the contents of `src/index.tsx` with:

```tsx
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
  type DownloadItem,
  type Mode,
} from "./download-selection";
import {
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings";
import {
  detectAPIFormat,
  extractItems,
  queueItems,
  resumeAppUpdate,
} from "./queue";
import {
  setAPIFormat,
  setCurrentDownloads,
  getAPIFormat,
  useSharedState,
} from "./plugin-state";
import { autoRunTick } from "./auto-run";
import { trailingDebounce } from "./debounce";

declare const SteamClient: any;

const DEBUG = false;
const FALLBACK_INTERVAL_MS = 15 * 60 * 1000;
const REACTIVE_DEBOUNCE_MS = 1000;

const reactiveTick = trailingDebounce(() => autoRunTick("reactive"), REACTIVE_DEBOUNCE_MS);

let subscription: { unregister: () => void } | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

const initPluginRuntime = (): void => {
  const s = loadSettings();
  logger.info(
    `Auto mode initialized: enabled=${s.autoEnabled}, mode=${s.autoMode}, ` +
    `maxSizeMB=${s.autoMaxSizeMB}, interval=${FALLBACK_INTERVAL_MS / 60000}min`,
  );

  subscription = SteamClient.Downloads.RegisterForDownloadItems((...args: any[]) => {
    const arr: any[] = Array.isArray(args[1]) ? args[1] : Array.isArray(args[0]) ? args[0] : [];
    const format = detectAPIFormat(arr);
    setAPIFormat(format);
    const items = extractItems(arr, format);
    const pending = items.filter((d) => !d.completed);
    logger.info(`Downloads updated: ${items.length} total, ${pending.length} pending (${items.length - pending.length} completed)`);
    setCurrentDownloads(pending);
    reactiveTick();
  });

  intervalHandle = setInterval(() => autoRunTick("interval"), FALLBACK_INTERVAL_MS);
};

const teardownPluginRuntime = (): void => {
  subscription?.unregister();
  subscription = null;
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  reactiveTick.cancel();
};

// The React panel view — reads shared module state, issues manual actions + settings edits.
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
  };

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
      const name = (window as any).appStore?.GetAppOverviewByAppID(sorted[i].appid)?.display_name ?? sorted[i].appid;
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

  const itemsToQueue = filterByMode(downloads.filter(isUnqueued), settings.mode, settings.maxSizeMB);
  const alreadyQueued = downloads.filter((d) => d.queue_index >= 0).length;
  const ignoredCount = downloads.filter(isUnqueued).length - itemsToQueue.length;
  const debugInfo = downloads.length > 0 ? JSON.stringify(downloads, null, 1) : "none";

  const renderLastAutoRun = () => {
    if (!lastAutoRun) return null;
    const when = new Date(lastAutoRun.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const what = lastAutoRun.action === "queued"
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
            <pre style={{ fontSize: "9px", color: "#8b929a", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>
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
  return {
    name: "Download All Button",
    content: <PluginContent />,
    icon: <FaDownload />,
    onDismount: () => {
      logger.info("Download All plugin unloading");
      teardownPluginRuntime();
    },
  };
});
```

> **Note on `onDismount`:** the Decky API may or may not expose this as a typed field on the plugin return. If TS complains, cast the plugin's return object to `any` at the `return` site so the teardown still runs. Do not delete the teardown — the subscription and interval leak otherwise.

- [ ] **Step 2: Verify build**

Run: `cd /home/deck/decky-download-all && pnpm run build`
Expected: success. `ToggleField` is exported from `@decky/ui` v4.11.0 (verified); if the build ever complains about `onDismount`, cast the plugin return to `any` as noted above.

- [ ] **Step 3: Run tests**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
cd /home/deck/decky-download-all
git add src/index.tsx
git commit -m "feat: move subscription to module scope; add auto mode UI + interval/debounce"
```

---

## Task 9: Update README and plugin.json description

**Files:**
- Modify: `README.md`
- Modify: `plugin.json`

- [ ] **Step 1: Rewrite `README.md`**

```markdown
# Decky Plugin - Download All

A Decky plugin that queues pending Steam downloads and keeps the queue moving — manually on demand, and automatically in the background.

## Features

### Manual trigger

Open the Decky menu and press **Queue N Downloads** to add all eligible pending downloads to the queue (smallest first). Three modes:

1. **All** — includes unscheduled downloads.
2. **Scheduled** — only downloads Steam has scheduled for later.
3. **Scheduled with Size Limit** — same as Scheduled, but caps by a configurable max-size slider.

### Auto Download (new)

When enabled, the plugin automatically queues eligible downloads as soon as Steam reports them, plus a 15-minute fallback tick that:

- Catches anything missed (events lost, plugin just loaded, Deck just resumed from sleep).
- Nudges a stalled queue head back to life (e.g., after a network drop) via Steam's own `ResumeAppUpdate`. User-paused downloads are never overridden.

Auto mode has **its own** mode + size-limit, independent from the manual button. The defaults are `enabled`, mode `Scheduled`, size-limit `5000 MB`.

Auto mode runs silently — no toasts — and logs each action to `~/homebrew/logs/`.

## Queue ordering

Both manual and auto paths append to the end of the existing queue, ordered smallest first.

## Screenshots

<img width="1280" height="800" alt="image" src="https://raw.githubusercontent.com/bentemple/decky-download-all/main/assets/preview.png" />

## Development

```bash
pnpm install
pnpm run build     # Rollup build into dist/
pnpm test          # Vitest unit tests
pnpm run watch     # rebuild on change
```
```

- [ ] **Step 2: Update `plugin.json` description**

In `plugin.json`, change:

```json
"description": "Download All - A plugin that let's the user immediately queue all scheduled downloads to immediately download.",
```

to:

```json
"description": "Queues pending Steam downloads on demand and automatically in the background. Catches stalled downloads and retries after network drops.",
```

- [ ] **Step 3: Commit**

```bash
cd /home/deck/decky-download-all
git add README.md plugin.json
git commit -m "docs: document auto download mode and retry behavior"
```

---

## Task 10: Full test run + build

Final sanity check before device verification.

- [ ] **Step 1: Run all tests**

Run: `cd /home/deck/decky-download-all && pnpm test`
Expected: every suite passes.

- [ ] **Step 2: Run the build**

Run: `cd /home/deck/decky-download-all && pnpm run build`
Expected: success, `dist/` populated.

- [ ] **Step 3: Inspect `dist/` for obvious size regressions**

Run: `ls -la /home/deck/decky-download-all/dist/`
Expected: output is present, not drastically larger than previous builds (the new logic is <1KB worth of compiled JS).

No commit for this task — it is a verification-only step.

---

## Task 11: On-device verification

The Deck user already has failed/stalled downloads queued, which makes this a real integration test. This is manual and must be performed by the developer on the Steam Deck.

For each check, note the result. If anything fails, stop and investigate before declaring the feature complete.

- [ ] **Step 1: Install the built plugin to Decky Loader**

Either:
- Use Decky's dev mode and point it at the local `dist/`, OR
- Install via the usual plugin install path.

Expected: Plugin shows "Download All" in the Decky menu; panel opens without errors.

- [ ] **Step 2: Verify init log**

Run: `tail -n 50 ~/homebrew/logs/Download\ All.log` (or whatever the configured log file name is).
Expected: Log line `Auto mode initialized: enabled=true, mode=scheduled, maxSizeMB=5000, interval=15min` appears shortly after plugin load.

- [ ] **Step 3: Reactive path — trigger a new download**

Open Steam, start queuing a new update from Steam's own UI so it becomes "pending/scheduled" but not started. Within ~1–3 seconds of the event, auto mode should queue it.

Expected:
- Log line `Auto-run (reactive): queued 1 items, total <X>MB` appears in `~/homebrew/logs/`.
- The download moves into the active queue in Steam's UI.
- Panel status line (once reopened) shows `Last auto-run: HH:MM — queued 1 download`.
- No toast is shown (silent mode).

- [ ] **Step 4: Idempotency — trigger the same download again**

Cause the subscription to fire again (Steam progress updates will naturally do this). Auto mode should **not** try to re-queue the already-queued item.

Expected:
- No new `queued N items` log lines for the same appid within the session.
- `actedAppids` is implicitly doing its job.

- [ ] **Step 5: Interval fallback — wait 15 min**

Leave the Deck running with at least one pending unqueued download (or introduce one, then wait). Every 15 minutes the interval tick fires.

Expected:
- Log shows `Auto-run (interval): ...` entries periodically.
- If nothing eligible exists at tick time, the log is silent (no "did nothing" spam).

- [ ] **Step 6: Stalled-head retry — use the existing failed downloads**

The user reported failed downloads in queue. With auto mode enabled, either:
- Wait for the next interval tick, or
- Toggle the plugin off/on to force re-init, or
- Toggle auto off and back on to trigger a fresh reactive call.

Expected:
- Log line `Auto-run (<trigger>): resumed stalled head <name> (<appid>)`.
- Queue head changes from stalled to active in Steam's UI.
- Panel status line shows `Last auto-run: HH:MM — resumed stalled download`.

- [ ] **Step 7: User-paused items are respected**

Pause a download in Steam's UI (user intent). Wait for the next reactive or interval tick.

Expected:
- No `resumed stalled head` log line for the paused item.
- Paused status is untouched.

- [ ] **Step 8: Auto mode off**

Open the panel, toggle "Automatically queue downloads" off.

Expected:
- Log line `Auto mode setting changed: autoEnabled=false`.
- No further auto-run log lines fire.
- Manual "Queue N Downloads" button continues to work.

- [ ] **Step 9: Auto mode size-limit**

Toggle auto on, set mode to "Scheduled With Size Limit", slide to a very small value (e.g., 100 MB). Introduce a new large pending download.

Expected:
- Auto mode does **not** queue the large download.
- Switching mode to "All" or raising the slider picks it up on the next tick.

- [ ] **Step 10: Survives plugin reload**

From the Decky menu, reload the plugin (or restart Steam). Verify init log reappears, `actedAppids` is empty (so auto mode will re-examine all downloads), and auto mode resumes normally.

- [ ] **Step 11: Final commit (if any fixes were required)**

If Tasks 3–11 uncovered bugs requiring code fixes, commit them separately from the verification. If no fixes, skip.

---

## Self-Review Notes (for reference)

- **Spec coverage:**
  - Reactive + interval — Tasks 7, 8.
  - Independent auto settings — Tasks 3 (schema), 8 (UI).
  - Silent, log-only — Task 7 (logging), Task 8 (no toast in auto path).
  - Idempotent retry — Task 7 (`isStalledHead` + `resumeAppUpdate`).
  - Default ON + conservative "scheduled" — Task 3 (`DEFAULTS`).
  - Debounce + `actedAppids` — Tasks 5, 7.
  - Module-scope subscription — Task 8.
  - UI "Auto Download" section + status line — Task 8.
  - README/plugin.json updates — Task 9.

- **Placeholder scan:** No TBD/TODO. Every code step shows the actual code.

- **Type consistency:** `DownloadItem` and `Mode` live in `src/download-selection.ts` and are imported by every consumer. `Settings` lives in `src/settings.ts`. `DownloadAPIFormat` lives in `src/queue.ts`. `LastAutoRun` lives in `src/plugin-state.ts`. No conflicting definitions.
