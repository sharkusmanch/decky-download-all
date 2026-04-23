# Auto Download Scheduling — Design

Date: 2026-04-23
Plugin: `decky-download-all`

## Summary

Extend the plugin from a manual-trigger-only tool into one that automatically queues pending Steam downloads whenever they become available, with a 15-minute fallback tick that also nudges stalled downloads (e.g., after network loss) back to life. Inspired by the Windows Millennium plugin [`sharkusmanch/steam-download-now`](https://github.com/sharkusmanch/steam-download-now).

The manual "Queue N Downloads" button stays exactly as it is today.

## Goals / Non-goals

**Goals**
- Auto-queue eligible pending downloads as soon as Steam announces them (reactive).
- 15-minute fallback tick to catch missed events and nudge stalled downloads.
- Auto-mode behavior is independently configurable from the manual-button behavior.
- Works without the user ever opening the Quick Access panel.

**Non-goals**
- Time-of-day windows (e.g., "only run overnight").
- User-configurable interval duration.
- Explicit failure classification / retry-with-backoff logic.
- Any backend (Python) orchestration — existing `main.py` only hosts the logger.
- Notifications / toasts for auto-initiated actions (log-only).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Trigger | Reactive primary + 15-min interval fallback | Reactive is snappy; interval catches missed events, post-sleep wake, and network-return retries. |
| Behavior settings | Auto mode has its own independent mode + size-limit, separate from manual | "Queue now" and "run unattended" have different risk tolerances — conflating them causes surprises. |
| Time-of-day window | None | Simpler; user dismissed. |
| Default state | Auto mode default ON | User-directed; existing users opt out if they prefer manual-only. Default auto-mode behavior is `"scheduled"` (conservative). |
| Fallback interval | 15 minutes, fixed | Snappy recovery without UI config bloat. |
| Notifications | Silent; log-only | Avoids mid-gameplay toasts; Steam shows its own download notifications. |
| Retry failed/stalled | Idempotent "kick the queue head" pass on every tick | No reliable failure flag in `DownloadItem`; resuming a stalled head via `ResumeAppUpdate` handles network drops, mid-download errors, and half-finished prior sessions uniformly. |

## Architecture

All changes are in the frontend (`src/index.tsx`). `main.py` is unchanged.

### Module-level state and lifecycle

Currently the `SteamClient.Downloads.RegisterForDownloadItems` subscription lives inside `PluginContent`'s `useEffect`, so it only runs while the Quick Access panel is open. Auto mode needs to run whenever Steam is running, so:

1. The download-items subscription moves to **module scope** (executed once at plugin load, inside the body of `definePlugin`'s factory). It maintains:
   - `currentDownloads: DownloadItem[]` — latest pending-item snapshot.
   - `apiFormat: DownloadAPIFormat` — Legacy vs. SteamOS 3.8+.
   - `lastAutoRun: { time, trigger, action: "queued" | "resumed", count } | null` — for UI status line (`count` is items queued for `queued`, always 0 for `resumed`).
2. A small pub/sub notifies subscribers (the React panel) when state changes, so UI updates remain reactive without re-registering Steam callbacks.
3. An `autoRunTick(trigger)` function is invoked from both:
   - the subscription callback (reactive path — debounced 1 s trailing),
   - a `setInterval` (fallback path — 15 min).
4. The interval and subscription are started once at plugin init. They live for the lifetime of the Steam renderer process. On plugin unload (if Decky provides a hook), both are torn down; otherwise the leak is harmless (plugin unloads are rare, and the handlers no-op once the module state is gone).

### React component

`PluginContent` subscribes to the module-level state via a small hook. It keeps:
- The existing manual "Queue N Downloads" button and behavior section (unchanged).
- A new "Auto Download" section (described below).

## Settings

Schema extends the existing `Settings` interface in-place; localStorage key stays `download-all-settings`. New fields are merged with `DEFAULTS` on load, so existing users upgrade without losing their mode/size-limit preferences.

```ts
interface Settings {
  // Existing — drives the manual button
  mode: "all" | "scheduled" | "size-limit";
  maxSizeMB: number;

  // New — drives auto mode (independent)
  autoEnabled: boolean;                             // default: true
  autoMode: "all" | "scheduled" | "size-limit";    // default: "scheduled"
  autoMaxSizeMB: number;                            // default: 5000
}
```

Default `autoMode: "scheduled"` is deliberately more conservative than `autoMode: "all"` — auto-starting a 70GB unscheduled update the moment someone installs the plugin would be rude.

## UI

Three panel sections in the Quick Access menu:

1. **Manual queue** (unchanged) — "Queue N Downloads" button, pending/filtered counts.
2. **Download Behavior** (unchanged) — modes + size-limit slider; drives the manual button.
3. **Auto Download** (new):
   - Toggle: "Automatically queue downloads" (on/off).
   - When enabled:
     - Same three mode buttons (All / Scheduled / Scheduled with Size Limit), scoped to `autoMode`.
     - Size-limit slider for `autoMaxSizeMB` when `autoMode === "size-limit"`.
   - Status line (below the toggle):
     - Before first run this session: blank.
     - After a run that did work: `Last auto-run: HH:MM — queued N downloads` or `Last auto-run: HH:MM — resumed stalled download`.
     - Runs that did nothing are not surfaced in the status line.

## Auto-run logic

```
autoRunTick(trigger: "reactive" | "interval"):
  if not settings.autoEnabled: return

  # Track A — queue new eligible items
  items = currentDownloads
    .filter(isUnqueued)                                      # queue_index === -1
    .filter(filterByAutoMode(settings))                      # same rules as manual
    .filter(d => !actedAppids.has(d.appid))                  # debounce against re-queuing
  if items.nonempty:
    items.sort((a, b) => getTotalBytes(a) - getTotalBytes(b))
    queueItems(items, apiFormat)                             # shared helper w/ manual
    for d in items: actedAppids.add(d.appid)
    lastAutoRun = { time: now, trigger, action: "queued", count: items.length }
    log: "Auto-run (<trigger>): queued N items, total <sizeMB>MB"

  # Track B — kick stalled queue head (network return, prior session leftover, etc.)
  head = currentDownloads.find(d => d.queue_index === 0)
  if head and !head.active and !head.paused and !head.completed:
    ResumeAppUpdate(head.appid, apiFormat)
    # Only overwrite lastAutoRun if Track A didn't already set it this tick.
    if lastAutoRun.time !== now: lastAutoRun = { time: now, trigger, action: "resumed", count: 0 }
    log: "Auto-run (<trigger>): resumed stalled head <name> (<appid>)"
```

### Reactive debouncing

`RegisterForDownloadItems` fires on every download progress tick. Without debouncing, `autoRunTick` would run on every event. Mitigation:

- A module-level `setTimeout` ref coalesces reactive calls into a **1-second trailing debounce**. Progress bursts collapse into a single run.
- The `actedAppids` set is a belt-and-braces guard against re-queuing an item we've already moved into the queue within this session.

### Interval

`setInterval(() => autoRunTick("interval"), 15 * 60 * 1000)` started once at plugin init. Not synchronized with reactive path — if both fire close together, the `actedAppids` + idempotency of `ResumeAppUpdate` keep the outcome safe.

### `actedAppids` lifecycle

- In-memory `Set<number>`, created at plugin load.
- Added to when an appid is queued by track A.
- Removed when an appid disappears from `currentDownloads` (completed, uninstalled, manually cancelled) — lets re-installs of the same game be acted on again within the same session.
- Not persisted. Plugin reload resets it. This is intentional: on reload we re-snapshot Steam's state and don't want stale blocklists.

### Retry semantics (Track B)

Steam's `DownloadItem` shape does not expose a distinct `failed` flag. The signal we use is the combination of `queue_index === 0 && !active && !paused && !completed` — the head of the queue is not making progress and is not user-paused. Treatment:

- `paused === true` → user intent. Never overridden.
- Otherwise → call `ResumeAppUpdate(head.appid)`. Idempotent; safe if the download is already active.

This catches: network drops that Steam didn't auto-resume from, transient Steam daemon errors, and queue heads left stalled from a previous session.

## Logging

All logs flow through the existing `log_from_ui` backend callable into `~/homebrew/logs/`.

Logged:
- At plugin load: `Auto mode initialized: enabled=<bool>, mode=<str>, maxSizeMB=<n>, interval=15min`
- On every auto-run that queues anything: `Auto-run (<trigger>): queued <N> items, total <sizeMB>MB` + one line per queued item (same format as the existing manual path).
- On every auto-run that resumes a stalled head: `Auto-run (<trigger>): resumed stalled head <name> (<appid>)`
- Settings changes affecting auto mode: `Auto mode setting changed: <key>=<value>`

Not logged:
- Auto-runs that did nothing (would spam the log every 15 min plus every reactive debounce).
- Individual reactive callbacks inside the debounce window (logging is post-debounce).
- `actedAppids` bookkeeping.

## Edge cases

- **Settings toggled while auto-run in flight:** settings are read at the top of `autoRunTick`, so toggling `autoEnabled` off takes effect on the next tick; any in-flight queueing completes normally.
- **Auto re-enabled after being off:** `actedAppids` persists across the toggle — we don't want to re-queue items Steam already has queued. Items that have since completed drop out of `currentDownloads` and are cleared from `actedAppids` by the normal lifecycle.
- **Manual button pressed:** does not populate `actedAppids`. The manual path filters on `isUnqueued`, so items already queued by auto mode are correctly skipped.
- **Plugin loads with an already-stalled download in the queue:** interval tick (and first reactive event) run Track B and resume it.

## File changes

- `src/index.tsx` — main work: extract subscription + state to module scope, add settings fields, extract `queueItems` helper, add `autoRunTick`, add "Auto Download" UI section.
- `main.py` — unchanged.
- `plugin.json` — update `description` to reflect auto behavior.
- `README.md` — document auto mode, defaults, retry behavior, where logs go.

## Out-of-scope follow-ups

- Exposing retry status in the UI (e.g., "Auto-resumed after network error"). Deferred; log is sufficient for now.
- Configurable interval. Fixed at 15 min until a real need shows up.
- Optional time-of-day window. User declined; easy to add later if it becomes painful.
