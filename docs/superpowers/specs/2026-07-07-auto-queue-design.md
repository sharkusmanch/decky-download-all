# Auto-Queue on a Timer — Design

**Date:** 2026-07-07
**Status:** Approved

## Goal

Add an opt-in background timer that periodically re-runs the existing "queue downloads" action, so Steam updates parked in the scheduled window get started without opening the Quick Access Menu.

## Problem: everything lives in the panel component

Today the download listener (`RegisterForDownloadItems`), the `downloads` state, and `handleDownloadAll` all live inside `PluginContent` — the React component that only mounts while the QAM panel is open. A background timer cannot live there: it would only tick while the panel is visible. The shared state and queue action must move to **module scope**, registered at plugin load in `definePlugin`, where they persist for the plugin's lifetime regardless of panel visibility (the same reason Decky plugins register event listeners at module scope, not in components).

A Python-backend timer was considered and rejected: the backend cannot call `SteamClient` (frontend-only), so the frontend must own the timer regardless.

## Architecture

Split pure logic from effectful, stateful code — which also supplies the tests the plugin currently lacks.

- **`src/lib/downloads.ts`** — pure, unit-tested. No `SteamClient`/React.
  - `DownloadItem` / `ProgressInfo` / `UpdateTypeInfo` types, `Mode`, `Settings`.
  - `getTotalBytes(item)` — sum pending-update bytes.
  - `parseDownloadItems(args)` → `{ items: DownloadItem[], format: 'legacy' | 'steamos38' }` — the legacy-vs-SteamOS-3.8 shape detection (currently an inline heuristic), including selecting the local machine (`remote_client_id === "0"`) in the 3.8 shape.
  - `selectItemsToQueue(downloads, settings)` — unqueued filter, mode filter (all / scheduled / size-limit), smallest-first sort.
  - `planQueueOps(items, downloads)` → `{ appid, index }[]` and the resume appid — pure computation of what to enqueue and at which queue indices.
- **`src/controller.ts`** — module-scope, effectful (verified on-device, not unit-tested).
  - Registers `SteamClient.Downloads.RegisterForDownloadItems` once; holds `latestDownloads` + detected `format`.
  - `runQueue({ silent })` — apply current settings via `selectItemsToQueue`/`planQueueOps`, perform the `SteamClient.Downloads.QueueAppUpdate` / `SetQueueIndex` / `ResumeAppUpdate` calls (format-aware), log via the UI logger, toast only when `!silent` and items were queued. Records `lastRun = { at, count }`.
  - Timer: `startTimer()/stopTimer()/reschedule()` using `window.setInterval`; a tick calls `runQueue({ silent: true })` when `autoQueue` is enabled. Toggling enable or changing the interval reschedules.
  - `subscribe(fn)` + `getState()` — a tiny store so the panel re-renders on download updates and `lastRun` changes.
  - `dispose()` — unregister listener + clear timer.
- **`src/index.tsx`** — `definePlugin` calls `controller.init()` on load and `controller.dispose()` in `onDismount`. `PluginContent` subscribes to the controller for `downloads`/`lastRun`, calls `controller.runQueue({ silent: false })` for the manual button, and renders the settings UI.

## Settings

Extend the existing `localStorage` blob (`download-all-settings`):
- `autoQueue: boolean` — default `false` (opt-in).
- `autoQueueIntervalMin: number` — default `15`.

Existing `mode` and `maxSizeMB` are unchanged. Settings continue to load/save through the same helpers, now living in `downloads.ts`.

## UI

New `PanelSection title="Auto Queue"`:
- `ToggleField` "Auto-queue on a timer" bound to `autoQueue`.
- When enabled, `SliderField` "Every {n} min" — min 5, max 120, step 5, bound to `autoQueueIntervalMin`.
- One status line (only visible when the panel is open — not a toast): `Auto-queue on · every 15 min` plus, if a run has happened, `· last queued N game(s) Xm ago`. When off: nothing beyond the toggle.

The existing manual button and Download Behavior section are unchanged, except they now read/write shared state through the controller.

## Timer behavior

- Each tick reuses the **current mode** (All / Scheduled / size-limit) and size limit.
- **Silent**: Decky log only, no toasts on auto ticks.
- No-ops cleanly when `selectItemsToQueue` returns nothing (logged at debug level, no side effects).
- Interval changes / enable toggles clear and restart the timer immediately.
- Timer runs whenever the plugin is loaded (module scope), independent of the panel being open; cleared on `onDismount`.

## Testing

Add vitest (the current `test` script is a stub). Cover `src/lib/downloads.ts`:
- `getTotalBytes`: sums only pending (`has_update && !completed_update`) progress; ignores completed.
- `parseDownloadItems`: legacy shape (array of items), SteamOS-3.8 shape (`{ remote_client_id, item_data }[]`) selecting `"0"`, and the empty/degenerate cases; returns the right `format`.
- `selectItemsToQueue`: each mode; size-limit boundary; excludes already-queued (`queue_index >= 0`); scheduled filter (`deferred_time > 0`); smallest-first order.
- `planQueueOps`: indices append below the current max queue index; resume appid selection.

`controller.ts` (timer + `SteamClient` calls) is verified on-device only. Frontend build (`pnpm build`) must stay green.

## Out of scope

Per-game selection, pause/clear-queue controls, progress/ETA display, largest-first or alternate sorts, GB-based size units — noted as possible future work, not part of this change.
