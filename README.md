<!-- TODO(visual): брендовый баннер (theme-aware). Захостить ассет на CDN (drag-and-drop в черновой GitHub issue → URL) и заменить блок ниже на:
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="<URL>/banner-dark.png">
    <img alt="Notabeam" src="<URL>/banner-light.png" width="440">
  </picture>
</p>
-->

<h1 align="center">Notabeam — sync for Obsidian</h1>

<p align="center">
  <b>Edit on your laptop, see it on your phone — before you put it down.</b><br>
  Real-time, cross-platform sync for your notes, canvases, drawings and attachments,
  on a server <b>you own</b>.<br>
  Self-host it free in minutes — no CouchDB, no S3 buckets, no cloud account.
</p>

<p align="center">
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/RooTooZ/notabeam-obsidian?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Latest release" src="https://img.shields.io/github/v/release/RooTooZ/notabeam-obsidian?style=flat-square">
  <img alt="Last commit" src="https://img.shields.io/github/last-commit/RooTooZ/notabeam-obsidian?style=flat-square">
  <!-- TODO: после попадания в каталог добавить downloads:
  <img alt="Downloads" src="https://img.shields.io/badge/dynamic/json?style=flat-square&label=downloads&query=$.notabeam.downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json">
  -->
</p>

<p align="center">
  <a href="#-quickstart"><b>Self-host in 3 minutes →</b></a> ·
  <a href="https://notabeam.app"><b>Docs & Cloud waitlist →</b></a> ·
  <a href="#-faq">FAQ</a>
</p>

> Notabeam is independent and **not affiliated with Obsidian**. “Obsidian” is used here only to describe compatibility.

<!-- TODO(visual): демо-GIF real-time синка — телефон + десктоп в одном кадре, правка мгновенно появляется на втором, мелькают пер-файловые значки. ≤20 сек, 15fps, цель <5 МБ. Захостить на CDN (issue drag-and-drop), НЕ коммитить в дерево репо. Заменить строку ниже на:
<p align="center"><img src="<CDN URL>/demo.gif" width="640" alt="Notabeam real-time sync demo"></p>
-->
<p align="center"><em>▶︎ Demo coming soon — real-time sync between desktop and mobile.</em></p>

---

Notabeam keeps your Obsidian vault in sync across desktop and mobile, **in real time**, through a sync server **you control**. Edit on one device — it's on the others before you put it down. It syncs Markdown, canvases, Excalidraw drawings and binary attachments, tolerates going offline, and is **safe by design**: deletions are non-destructive and divergent edits become conflict copies, so nothing is ever silently lost.

## Contents

- [What makes Notabeam different](#-what-makes-notabeam-different)
- [Highlights](#-highlights)
- [Quickstart](#-quickstart)
- [Installation](#-installation)
- [What syncs](#-what-syncs)
- [How it works](#-how-it-works)
- [FAQ](#-faq)
- [Project status & roadmap](#-project-status--roadmap)
- [Privacy & security](#-privacy--security)
- [Contributing & support](#-contributing--support)

## 🎯 What makes Notabeam different

- **Real-time, not scheduled.** Changes propagate the instant you type, over a live WebSocket connection — not on a timer or a manual push.
- **Self-host without the hassle.** One `docker run` or a single binary keeps your notes on a server you own. No CouchDB, no object storage, no multi-step setup.
- **Safe by design.** Deletions are non-destructive (they go to the trash), divergent edits are kept as conflict copies, and offline changes catch up on reconnect — nothing is silently lost.
- **More than Markdown.** Syncs `.md`, `.canvas`, `.excalidraw` and binary attachments, with per-file sync indicators right in the file explorer.
- **Open-core, and going further.** Free self-host today; managed cloud (no server to run) and AI / MCP access to your vault are on the [roadmap](#-project-status--roadmap).

## ✨ Highlights

- **Real-time, not batch** — changes fly the instant you type, over WebSocket. No “sync on a timer”.
- **Self-host in minutes** — one `docker run` or a single binary. No CouchDB cluster, no S3 buckets, no 12-step config.
- **Safe by design** — delete a note on your phone and it won't vanish elsewhere (it goes to the trash). Edited the same note on two devices? Both versions are kept as a conflict copy. Nothing is silently lost.
- **Syncs more than Markdown** — `.md`, `.canvas`, `.excalidraw` and binary attachments (images, PDFs…), de-duplicated by content.
- **Works offline** — edits, deletions and renames made offline catch up in one batch when you reconnect.
- **Per-file sync indicators** — see right in the file explorer what's synced and what's in flight.
- **Yours and private** — data goes only to the server *you* set. No default cloud, no telemetry, no self-updating behind the catalog.

## 🚀 Quickstart

**Self-host, free, in three steps:**

**1. Run the server.** Host the Notabeam server with Docker or a single binary. See the **[self-hosting guide →](https://notabeam.app)** for the exact command and options (VPS with automatic TLS, Kubernetes, or no public domain via a tunnel).

**2. Create a vault token.** Generate a token on your server — it scopes access to your vault.

**3. Install the plugin & connect.** Install **Notabeam** from Obsidian's Community Plugins, open **Settings → Notabeam**, and paste your **server URL** + **token**. Done — your notes sync across every device connected to that vault.

> 🛈 **Don't want to run a server?** **Notabeam Cloud** — fully managed hosting, no setup — is coming soon. [Join the waitlist →](https://notabeam.app)

<!-- TODO(visual): кликабельный YouTube-thumbnail "Set up self-host in 3 minutes" рядом с шагами. -->

## 📦 Installation

<details>
<summary><b>Install options</b> (catalog · BRAT · manual)</summary>

**From Obsidian (recommended, once listed)**
Settings → Community plugins → Browse → search **Notabeam** → Install → Enable.
<!-- После публикации в каталоге: [Install in Obsidian →](obsidian://show-plugin?id=notabeam) -->

**Early access via BRAT**
Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then *Add beta plugin* with:
```
RooTooZ/notabeam-obsidian
```

**Manual**
Download `manifest.json` and `main.js` from the [latest release](https://github.com/RooTooZ/notabeam-obsidian/releases) into `<vault>/.obsidian/plugins/notabeam/`, then enable the plugin.

<!-- TODO(visual): скриншот экрана настроек (URL + токен), light + dark. -->
</details>

## 🗂 What syncs

Markdown (`.md`), `.canvas`, `.excalidraw`, and binary **attachments** (images, PDFs… — de-duplicated by content, with a configurable size limit). Plus: **offline catch-up**, **non-destructive deletes**, and **conflict copies** on divergent edits.

**Per-file sync indicators** appear next to each file in the explorer:

| Indicator | Meaning |
|:---:|---|
| ✓ | Synced |
| ⟳ | Pending / in flight |
| ⚠ | Error (e.g. attachment over the size limit) |

<!-- TODO(visual): скриншот значков синхронизации в проводнике (light + dark). -->

## 🔧 How it works

<!-- TODO(visual): архитектурная SVG-диаграмма (theme-aware): phone + desktop + Obsidian → WebSocket → Your Server → [MCP / Claude — coming soon, пунктиром]. -->

The plugin connects over **WebSocket** to the sync server **you configure** in settings. Notes and metadata travel over that connection, authenticated by a vault **token** and a **device id**. Binary **attachments** are transferred over **HTTP** at `/blob/<hash>` on the same server.

**Your data goes only to the server URL you set** — there is no default or hidden cloud endpoint. Under the hood, sync uses last-write-wins with hybrid logical clocks (LWW + HLC) and keeps conflict copies, so concurrent edits never silently overwrite each other.

## ❓ FAQ

<details>
<summary><b>Will it lose or break my notes?</b></summary>

No — safety is built in. Incoming deletions go to Obsidian's **trash**, not oblivion. When edits diverge, **both versions are kept** (the losing one becomes `file (conflict <timestamp>).md`) — nothing is overwritten silently. Offline edits, deletions and renames catch up on reconnect. We still recommend backups, like any sane setup — just without the all-caps panic.
</details>

<details>
<summary><b>Does it work on mobile?</b></summary>

Yes — desktop and mobile. The plugin is cross-platform (`isDesktopOnly: false`) and uses no Node/filesystem-only APIs.
</details>

<details>
<summary><b>What syncs besides <code>.md</code>?</b></summary>

`.canvas`, `.excalidraw`, and binary attachments (images, PDFs, etc.), in addition to Markdown.
</details>

<details>
<summary><b>Self-host vs Notabeam Cloud — what's the difference?</b></summary>

**Self-host** is available now, free, single-tenant — you run the server and own the data. **Notabeam Cloud** (managed hosting, account + subscription) is coming soon, for people who'd rather not run a server.
</details>

<details>
<summary><b>Is this the official Obsidian Sync? Can I run it alongside one?</b></summary>

No — Notabeam is **not** the official Obsidian Sync and is not affiliated with Obsidian. Don't enable two different sync solutions on the same vault.
</details>

<details>
<summary><b>Is my data private?</b></summary>

Self-host means data goes **only to your server**, at the URL you set. No default or hidden cloud endpoint, no telemetry, and the plugin never updates itself outside the Obsidian catalog. Use `wss://`/`https://` (TLS) for any server reachable over the internet.
</details>

## 🧭 Project status & roadmap

**Works today (self-host, free):**
- Real-time sync of `.md` / `.canvas` / `.excalidraw` + attachments
- Desktop + mobile
- Offline catch-up, non-destructive deletes, conflict copies
- Per-file sync indicators
- No telemetry

**In development** `🔜`
- **Notabeam Cloud** — managed hosting, no server to run
- **End-to-end encryption**
- **AI / MCP access** — let Claude and other assistants read and write your vault, token-scoped and revocable

Notabeam is **open-core**: the plugin and sync core are open source; self-host is free, and the managed cloud is the paid tier. We mark what's coming as 🔜 — never as if it already ships.

## 🔒 Privacy & security

- **No telemetry.** The plugin collects and sends no usage or analytics data.
- **No self-update.** Updates come only through Obsidian's Community Plugins catalog.
- Data is transmitted **only to the server URL you configure**.
- For any internet-reachable server use `wss://` and `https://` (TLS). Plain `ws://` is acceptable only on a trusted local network, at your own risk. The token travels in the WebSocket query and as an HTTP `Bearer` header — always protect it with TLS.
- Notabeam is **not** the official Obsidian Sync. Don't enable two sync solutions on one vault.

## 🤝 Contributing & support

Issues and PRs welcome. Please see `CONTRIBUTING.md` and the issue templates. Questions and ideas → **[Discussions](https://github.com/RooTooZ/notabeam-obsidian/discussions)**.

**License:** [MIT](LICENSE) — free, and yours to keep.

---

<p align="center">
  ⭐ <b>Star this repo if you're waiting for Notabeam Cloud + AI access.</b><br>
  <a href="https://notabeam.app">notabeam.app</a>
</p>
