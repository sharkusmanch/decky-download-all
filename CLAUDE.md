# Download All+ (decky-download-all)

A Decky Loader plugin that queues Steam downloads on demand or on a background timer, from the Quick Access Menu on SteamOS / Steam Deck. Fork of bentemple/decky-download-all, renamed to `Download All+` / `download-all-plus` so store updates to the upstream plugin can't clobber it.

For general Decky Loader knowledge (frontend/backend split, `@decky/api`/`@decky/ui`, `SteamClient` APIs, deploy/debug), see the `developing-decky-plugins` skill. This file covers what's specific to this plugin.

## What it does

Steam schedules updates for a later window; this plugin starts them immediately. A **manual** button queues pending downloads (smallest first, appended below the active queue), filtered by one of three modes. **Auto Queue** re-runs that same action on a timer in the background.

## Architecture

Almost entirely **frontend** — the queue actions are `SteamClient` calls, which only exist in the browser context. The Python backend (`main.py`) is a trivial log bridge (`log_from_ui` callable) so the frontend can write to Decky's log.

The frontend is split three ways so the logic is testable and the timer can run in the background:

| File | Role | Tested |
|---|---|---|
| `src/lib/downloads.ts` | **Pure logic**: types, `getTotalBytes`, `parseDownloadItems` (legacy vs SteamOS-3.8 shape), `selectItemsToQueue` (mode filter + smallest-first sort), `planQueueOps` (queue indices + resume appid), `Settings`/`DEFAULTS`. No `SteamClient`/React imports. | vitest (`src/lib/__tests__/downloads.test.ts`) |
| `src/controller.ts` | **Module-scope, effectful**: registers `SteamClient.Downloads.RegisterForDownloadItems`, holds latest downloads + detected API format + settings, `runQueue({silent})` does the `SteamClient.Downloads.QueueAppUpdate`/`SetQueueIndex`/`ResumeAppUpdate` calls, owns the timer, and exposes `getState`/`subscribe`/`updateSettings`/`init`/`dispose`. | on-device only |
| `src/index.tsx` | **Thin view**: `definePlugin` calls `controller.init()` / `dispose()`; `PluginContent` subscribes and renders the panel + Auto Queue UI. | on-device only |
| `src/logger.ts` | Frontend→backend log bridge (`callable("log_from_ui")`). | — |

**Why the module-scope controller matters:** the original kept the download listener and queue logic *inside* the panel component, which only mounts while the QAM is open. Auto Queue needs a timer that runs when the menu is closed, so all shared state + the timer live at module scope (started in `definePlugin`, torn down in `onDismount`) — they persist for the plugin's lifetime regardless of panel visibility.

## Key details

**Settings** (localStorage key `download-all-settings`): `mode` (`all|scheduled|size-limit`), `maxSizeMB`, `autoQueue` (default `false`), `autoQueueIntervalMin` (default `15`). Loaded/saved in `controller.ts`; shape + defaults in `downloads.ts`.

**SteamOS 3.8 format split:** `RegisterForDownloadItems` changed shape in SteamOS 3.8 (per-client wrappers `{remote_client_id, item_data}[]`) vs the older flat `DownloadItem[]`. `parseDownloadItems` detects by whether array elements carry `item_data`, and selects the local machine (`remote_client_id === "0"`). The queue methods also gained a trailing `"0"` arg in 3.8. `SteamClient.Downloads` is cast to `any` — the lib types are stale.

**Auto Queue behavior:** each tick calls `runQueue({silent:true})` using the *current* mode; silent = Decky log only, no toasts; no-ops cleanly when nothing matches. Toggling `autoQueue` or changing the interval reschedules the timer.

**Queue semantics** (preserved from upstream): only unqueued items (`queue_index === -1`), smallest-first, appended below `max(queue_index)`, then resume the queue head (or first new item).

## Commands

```bash
pnpm install
pnpm run test    # vitest (13 tests over downloads.ts)
pnpm run build   # → dist/index.js

# Deploy (plugins dir is root-owned → stage then sudo)
scp -r . deck@<ip>:/tmp/decky-download-all-plus
ssh deck@<ip> "sudo rm -rf ~/homebrew/plugins/decky-download-all-plus && \
  sudo cp -r /tmp/decky-download-all-plus ~/homebrew/plugins/ && \
  sudo systemctl restart plugin_loader"
```

## Conventions

- **Pure logic goes in `downloads.ts` and is test-first.** `controller.ts` and `index.tsx` stay thin (they touch `SteamClient`/React/timers and can't be unit-tested); if logic accretes there, push it into `downloads.ts` with tests.
- **Keep the fork identity distinct** from upstream. Decky matches installed plugins to the store by `plugin.json` `name`; `package.json` `version` gates updates. Both must stay non-upstream (`Download All+` / `download-all-plus`) or a store update could overwrite this fork.
- Register listeners/timers at module scope in `definePlugin`, cleaned up in `onDismount` — never inside the panel component (it unmounts when the QAM closes).

## Gotchas

- `SteamClient.Downloads` method signatures differ by SteamOS version (the trailing `"0"` client-id arg) and are untyped — always branch on the detected `format` and cast to `any`.
- A stale timer after a dev reload usually means `dispose()` didn't run — it's the first thing to check.
- The frontend logs through the backend bridge, so frontend messages appear in the Decky log prefixed `[UI]`.
