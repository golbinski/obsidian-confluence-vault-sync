# Confluence Vault Sync

An [Obsidian](https://obsidian.md) plugin that syncs one or more Confluence Cloud spaces into read-only vault folders, and optionally pushes local edits back to Confluence.

## Features

- **Pull from Confluence** — fetches an entire space hierarchy and converts Atlassian Document Format (ADF) to Markdown, preserving page nesting as folders.
- **Incremental syncs** — skips pages that have not changed since the last sync, using Confluence version timestamps.
- **Image attachments** — downloads inline images below a configurable size limit into an `attachments/` folder.
- **Read-only enforcement** — synced files are locked; Obsidian edits are reverted automatically until you explicitly unlock a file.
- **Write-back (Confluence Changes pane)** — unlock a page, edit it locally, and push the Markdown back to Confluence as ADF. Detects conflicts when the remote page was updated after your last sync.
- **Manifest** — writes a `manifest.json` inside each sync folder with the full page tree, labels, vault paths, and Confluence URLs.
- **Multiple sync targets** — map any number of Confluence spaces to separate vault folders.
- **Parallel sync** — configurable concurrency for faster syncs on large spaces.

## Requirements

- Obsidian 1.4.0 or later (desktop only).
- A Confluence Cloud instance with API access.
- An [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) for your account.

## Installation

This plugin is not yet listed in the Obsidian community plugin browser. Install it manually:

1. Build the plugin:
   ```bash
   npm install
   npm run build
   ```
2. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/confluence-vault-sync/`.
3. In Obsidian, go to **Settings → Community plugins**, enable community plugins if prompted, and toggle **Confluence Vault Sync** on.

## Configuration

Open **Settings → Confluence Vault Sync** and fill in:

| Setting | Description |
|---|---|
| Confluence Base URL | Your Atlassian site URL, e.g. `https://yourorg.atlassian.net` |
| Confluence Email | The email address of your Atlassian account |
| Confluence API Token | An API token generated at id.atlassian.com |
| Max image download size (KB) | Images at or below this size are saved locally (default: 500 KB) |
| Sync concurrency | Pages fetched in parallel, 1–20 (default: 5) |

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

Synced files include YAML frontmatter with `confluence-id`, `confluence-url`, `confluence-title`, `space`, `last-synced`, and `read-only: true`.

### Writing back to Confluence

1. Open the **Confluence Changes** pane via the ribbon icon or the **Open Confluence Changes** command.
2. Click **Unlock** next to a page to make it editable.
3. Edit the file in Obsidian.
4. Return to the pane and click **Push** to send your changes back to Confluence.
   - If the page was updated remotely since your last sync, a conflict dialog lets you choose to force-push or cancel.
5. Click **Relock** to restore read-only protection without pushing.

> **Note:** Pages that contain embedded images cannot be pushed back to Confluence (image upload is not supported).

## How it works

1. The plugin fetches all pages in a space via the Confluence REST API and builds a page tree rooted at the space home page.
2. Page hierarchy maps to vault folder structure: parent pages with children become folders with an `index.md`; leaf pages become plain `.md` files.
3. Page bodies are fetched as ADF and converted to Markdown. Media nodes are resolved to local attachment files or placeholder text.
4. Files removed from Confluence are deleted from the vault; empty folders are pruned.
5. A `manifest.json` is written at the root of each sync folder after every sync.

## License

[MIT](LICENSE)
