# Notabeam — sync for Obsidian

Real-time, cross-platform sync for your notes and attachments through a sync
server **you control**. Notabeam keeps Markdown notes, canvases, Excalidraw
drawings and binary attachments in sync across all your devices (desktop and
mobile), and tolerates going offline — changes (including deletions and
renames) catch up automatically when you reconnect.

> Notabeam is independent and not affiliated with Obsidian. "Obsidian" is used
> only to describe compatibility.

## Features

- Real-time sync of notes (`.md`), `.canvas`, `.excalidraw` and binary attachments
- Desktop and mobile
- Offline-tolerant: deletions, renames and edits made offline reconcile on reconnect
- Non-destructive deletions (incoming deletes go to the trash) and conflict copies on divergent edits
- You choose the server — self-host it for free

## How it works

The plugin connects over **WebSocket** to a sync server **you configure** in the
settings (default `ws://localhost:3000`). Your notes and their metadata are sent
over this connection, authenticated by a vault **token** and a **device id**.
Binary **attachments** are uploaded and downloaded over **HTTP** at
`/blob/<hash>` on the same server.

**Your data is sent only to the server URL you set** — there is no default or
hidden cloud endpoint.

## Deployment options

- **Self-host (available now, free, no account):** run your own Notabeam server
  (Docker Compose or a single binary) and point the plugin at it. See
  [notabeam.app](https://notabeam.app) for the self-hosting guide.
- **Notabeam Cloud (coming soon):** a managed, hosted server — no setup,
  requires an account and a paid subscription. A privacy policy will be
  published at [notabeam.app](https://notabeam.app) before launch. Cloud is
  **not required** to use this plugin.

## Setup

1. Run a Notabeam server (self-host) — see [notabeam.app](https://notabeam.app).
2. Create a vault token on the server.
3. In Obsidian: **Settings → Notabeam** — enter the server URL and token.
4. Edit your notes — they sync across every device connected to the same vault.

## Privacy & security

- **No telemetry.** The plugin does not collect or send any usage or analytics data.
- **No self-update.** The plugin updates only through Obsidian's Community Plugins catalog.
- Data is transmitted only to the server URL you configure.
- For any server reachable over the internet, use `wss://` and `https://` (TLS).
  Plain `ws://` is acceptable only on a trusted local network, at your own risk.
  The token travels in the WebSocket query and as an HTTP `Bearer` header —
  always protect it with TLS.

## Roadmap

- Notabeam Cloud — managed hosting (no server to run)
- MCP server — let AI assistants (e.g. Claude) read and write your notes

## License

MIT — see [LICENSE](LICENSE).

## Links

- Website: [notabeam.app](https://notabeam.app)
