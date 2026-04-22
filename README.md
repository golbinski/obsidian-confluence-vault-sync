# Confluence Vault Sync

An [Obsidian](https://obsidian.md) plugin that syncs one or more Confluence Cloud spaces into read-only vault folders, and optionally pushes local edits back to Confluence.

## Features

- **Pull from Confluence** — fetches an entire space hierarchy and converts Atlassian Document Format (ADF) to Markdown, preserving page nesting as folders.
- **Granular pull** — right-click any subfolder to pull only that subtree, or right-click a single `.md` file to pull just that page, without triggering a full space sync.
- **Resync gate** — a full-space sync is blocked if any file in that space is unlocked, preventing accidental overwrites of in-progress edits.
- **Incremental syncs** — skips pages that have not changed since the last sync, using Confluence version timestamps.
- **Image attachments** — downloads inline images below a configurable size limit into an `attachments/` folder.
- **Read-only enforcement** — synced files are locked; Obsidian edits are reverted automatically until you explicitly unlock a file.
- **Token encryption** — optionally encrypts the Confluence API token at rest using the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service), so it cannot be read from `data.json` by other apps or AI vault agents.
- **Confluence Changes pane** — a sidebar panel mirroring the vault folder hierarchy, showing the status of every synced page. Unlock, edit, and push changes back to Confluence with three-way merge. Conflicts are written as standard diff3 markers for manual resolution.
- **Publish new pages** — create a new `.md` file anywhere inside a sync folder and publish it to Confluence directly from the Changes pane. The plugin resolves the correct parent page from the folder structure, handles Confluence folder entities automatically, and writes the assigned page ID back into the file's frontmatter.
- **Remote polling** — optionally poll Confluence on a configurable interval and display a pending-changes badge in the Changes pane when remote pages have been updated since the last sync.
- **Semantic search** — optional Herbalist integration provides AI-powered semantic search across synced Confluence content directly from a sidebar panel.
- **Manifest** — writes a `manifest.json` inside each sync folder describing the vault state: page tree, labels, vault paths, and Confluence URLs. Updated incrementally on granular pulls.
- **Multiple sync targets** — map any number of Confluence spaces to separate vault folders.
- **Parallel sync** — configurable concurrency for faster syncs on large spaces.

## Requirements

- Obsidian 1.4.0 or later (desktop only).
- A Confluence Cloud instance with API access.
- An [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) for your account.

## Recommended companion plugins

These community plugins are not required but improve the experience with synced content:

| Plugin | Why it helps |
|---|---|
| [Automatic Table of Contents](https://obsidian.md/plugins?id=automatic-table-of-contents) | Confluence pages with a TOC macro sync as a ` ```table-of-contents ``` ` code block. This plugin renders it as a live, auto-updating table of contents in reading mode. |
| [Folder notes](https://obsidian.md/plugins?id=folder-notes) | Parent Confluence pages (those with children) sync as `index.md` files inside a folder. The Folder notes plugin makes the folder and its index file behave as a single navigable note, matching the Confluence page tree layout. |

## Installation

This plugin is not yet listed in the Obsidian community plugin browser. Install it manually:

1. Download `confluence-vault-sync.zip` from the [latest release](../../releases/latest).
2. Unzip it into `<vault>/.obsidian/plugins/confluence-vault-sync/`.
3. In Obsidian, go to **Settings → Community plugins**, enable community plugins if prompted, and toggle **Confluence Vault Sync** on.

Alternatively, build from source:

1. ```bash
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/confluence-vault-sync/`.
3. Enable the plugin as above.

## Configuration

Open **Settings → Confluence Vault Sync** and fill in:

| Setting | Description |
|---|---|
| Confluence Base URL | Your Atlassian site URL, e.g. `https://yourorg.atlassian.net` |
| Confluence Email | The email address of your Atlassian account |
| Confluence API Token | An API token generated at id.atlassian.com |
| Encrypt API token | Encrypts the token at rest using the OS keychain. Recommended if you use AI agents that can read your vault. Toggling re-encrypts or decrypts automatically. |
| Max image download size (KB) | Images at or below this size are saved locally (default: 500 KB) |
| Sync concurrency | Pages fetched in parallel, 1–20 (default: 5) |
| Enable polling | Periodically check Confluence for remote changes (off by default) |
| Check interval | How often to poll: 5, 15, 30, or 60 minutes |

Under **Sync Targets**, add one row per space:

| Column | Description |
|---|---|
| Space Key | The Confluence space key, e.g. `ENG` |
| Vault Folder Path | Destination folder inside your vault, e.g. `confluence/eng` |

Use **Test connection** to verify your credentials and confirm access to each configured space before running a sync.

## Usage

### Pulling from Confluence

- Click the **refresh** ribbon icon, or run the command **Sync Confluence** from the command palette.
- Right-click any configured sync folder in the file explorer and choose **Pull Confluence** to sync only that space.
- Right-click any **subfolder** inside a sync folder and choose **Pull this folder** to sync only that subtree.
- Right-click any synced **`.md` file** and choose **Pull this page** to refresh only that single page.

> **Note:** A full-space sync is blocked if any file in that space is currently unlocked. Use granular pull (subfolder or single page) to pull updates without affecting your in-progress edits.

Synced files include YAML frontmatter with `confluence-id`, `confluence-url`, `confluence-title`, `space`, `last-synced`, and `read-only: true`.

### Confluence Changes pane

Open the pane via the ribbon icon (↑ cloud) or the **Open Confluence Changes** command. The pane has two sections:

**CHANGES** — a flat list of all pages with local edits or new files not yet in Confluence, shown at the top for quick access. The currently active note appears first. Page names are colour-coded: green = locally modified, red = new (not yet published).

**Space tree** — the full folder hierarchy for each configured space, collapsed by default. Folders auto-expand to reveal the active note. Click a folder to toggle it; use the expand/collapse icons next to the space name to open or close all folders at once.

Each page row shows icon buttons on the right:

| Icon | Action |
|---|---|
| 🔓 | Unlock — makes the file editable and saves a snapshot for three-way merge |
| 🔒 | Relock — restores read-only protection. Shows a confirmation dialog if the file has unsaved changes |
| ☁↑ | Push — sends local edits to Confluence via three-way merge. Conflict markers are written into the file if needed; resolve them and push again |
| ☁+ | Publish — creates a new Confluence page from a locally created `.md` file |

If polling is enabled and Confluence has pages updated since the last sync, a **N pending changes** badge appears at the top of the pane. Click it to trigger a sync.

> **Note:** Pages with unsupported embedded content (Lucid, Miro, draw.io, and other custom macros without a URL) are marked *unsupported* and cannot be pushed. Inline images round-trip normally — new local images are uploaded as Confluence attachments on push.

### Publishing new pages

1. Create a new `.md` file anywhere inside a sync folder.
2. Open the Changes pane — the file appears in red under **CHANGES** and in its folder in the tree.
3. Click the ☁+ button to publish. The plugin walks up the folder hierarchy to find the correct Confluence parent page, handles Confluence folder entities transparently, creates the page, and writes `confluence-id` and related frontmatter back into the file.

## Known limitations

The ADF ↔ Markdown conversion is intentionally lossy for constructs Markdown cannot represent. These degrade on round-trip:

- **Text styling** — underline, text color, subscript, and superscript marks are dropped; only the text remains. If you push a page after it was pulled, those marks are not restored.
- **Extension macros without a URL** — Lucid, Miro, draw.io, and other custom macros that do not expose a URL in their parameters render as a `[key]` placeholder. Pushing a page that contains such macros is blocked by the unsupported-content gate.
- **Extension macros with a URL** — rendered as a clickable `[key](url)` link. The macro itself is not reconstructed on push; the page becomes push-blocked so the remote embed is preserved.
- **`expand` panels** — rendered as a blockquote with the title on the first line; the collapsible structure is lost.
- **Confluence link anchors** — links to `#section` fragments on another page are rewritten to a plain wikilink; the anchor is dropped.
- **Mentions and emoji** — rendered as `@Name` and `:shortName:` text respectively, without rebuilding the original ADF node on push.

For any page containing unsupported content, the Confluence Changes pane shows an *unsupported* label and disables the push action. Use Confluence directly to edit those pages.

## How it works

1. The plugin fetches all pages in a space via the Confluence REST API and builds a page tree rooted at the space home page.
2. Page hierarchy maps to vault folder structure: parent pages with children become folders with an `index.md`; leaf pages become plain `.md` files.
3. Page bodies are fetched as ADF and converted to Markdown. Media nodes are resolved to local attachment files or placeholder text.
4. Files removed from Confluence are deleted from the vault; empty folders are pruned.
5. A `manifest.json` is written at the root of each sync folder after every sync.

## License

[MIT](LICENSE)
