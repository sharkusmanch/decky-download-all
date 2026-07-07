# Download All+

A Decky Loader plugin that queues Steam downloads on demand — or automatically on a timer — from the Quick Access Menu on SteamOS / Steam Deck.

Steam parks updates in a "scheduled" window; Download All+ starts them immediately, manually or in the background, without opening each game.

> Fork of [bentemple/decky-download-all](https://github.com/bentemple/decky-download-all) (BSD-3-Clause), adding auto-queue on a timer and a test suite. Renamed to avoid colliding with the upstream store plugin's identity.

## Features

- **Queue button** — immediately queue pending downloads, smallest first, appended below whatever's already downloading.
- **Three modes** (Download Behavior):
  1. **All** — every pending download, including unscheduled ones.
  2. **Scheduled** — only downloads Steam has scheduled for later.
  3. **Scheduled with Size Limit** — scheduled downloads up to a configurable max size.
- **Auto Queue (new)** — an opt-in background timer that re-runs the queue every N minutes (5–120, default 15) using your selected mode. Runs even with the Quick Access Menu closed, silently (no toasts); a status line shows when it last queued something.

## Install

Off-store (Decky Settings → Developer → Install Plugin from URL), using a release zip from this fork's GitHub releases. Or sideload a local build:

```bash
pnpm install && pnpm run build
scp -r . deck@<ip>:/tmp/decky-download-all-plus
ssh deck@<ip> "sudo rm -rf ~/homebrew/plugins/decky-download-all-plus && \
  sudo cp -r /tmp/decky-download-all-plus ~/homebrew/plugins/ && \
  sudo systemctl restart plugin_loader"
```

## Development

```bash
pnpm install
pnpm run test    # vitest — pure queue/format logic
pnpm run build   # → dist/index.js
```

See `CLAUDE.md` for architecture and `docs/superpowers/specs/` for design notes.

## Screenshots

<img width="1280" height="800" alt="image" src="https://raw.githubusercontent.com/bentemple/decky-download-all/main/assets/preview.png" />
