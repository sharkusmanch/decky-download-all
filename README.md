# Decky Plugin - Download All

A Decky plugin that queues pending Steam downloads and keeps the queue moving — manually on demand, and automatically in the background.

## Features

### Manual trigger

Open the Decky menu and press **Queue N Downloads** to add all eligible pending downloads to the queue (smallest first). Three modes:

1. **All** — includes unscheduled downloads.
2. **Scheduled** — only downloads Steam has scheduled for later.
3. **Scheduled with Size Limit** — same as Scheduled, but caps by a configurable max-size slider.

### Auto Download

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
pnpm run watch     # rebuild on change
```
