"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ConfluenceVaultSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");

// src/settings.ts
var DEFAULT_SETTINGS = {
  confluenceBaseUrl: "",
  confluenceEmail: "",
  confluenceApiToken: "",
  maxImageDownloadSizeKb: 500,
  syncTargets: []
};

// src/sync-engine.ts
var import_obsidian = require("obsidian");

// src/confluence-client.ts
var ConfluenceClient = class {
  constructor(baseUrl, email, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeader = "Basic " + btoa(`${email}:${apiToken}`);
  }
  async request(url) {
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`Confluence API error ${response.status} ${response.statusText} for ${url}`);
    }
    return response.json();
  }
  async getSpacePages(spaceKey) {
    var _a, _b;
    const pages = [];
    let url = `${this.baseUrl}/wiki/api/v2/pages?spaceKey=${encodeURIComponent(spaceKey)}&limit=250`;
    while (url) {
      const data = await this.request(url);
      for (const page of data.results) {
        pages.push({
          id: page.id,
          title: page.title,
          parentId: (_a = page.parentId) != null ? _a : null,
          spaceKey
        });
      }
      const next = (_b = data._links) == null ? void 0 : _b.next;
      url = next ? `${this.baseUrl}/wiki${next}` : null;
    }
    return pages;
  }
  async getPageBody(pageId) {
    const data = await this.request(`${this.baseUrl}/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`);
    return JSON.parse(data.body.atlas_doc_format.value);
  }
  async getPageChildren(pageId) {
    var _a, _b, _c;
    const children = [];
    let url = `${this.baseUrl}/wiki/api/v2/pages/${pageId}/children?limit=250`;
    while (url) {
      const data = await this.request(url);
      for (const page of data.results) {
        children.push({
          id: page.id,
          title: page.title,
          parentId: (_a = page.parentId) != null ? _a : pageId,
          spaceKey: (_b = page.spaceKey) != null ? _b : ""
        });
      }
      const next = (_c = data._links) == null ? void 0 : _c.next;
      url = next ? `${this.baseUrl}/wiki${next}` : null;
    }
    return children;
  }
  async fetchBinary(url) {
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader }
    });
    if (!response.ok) {
      throw new Error(`Binary fetch error ${response.status} for ${url}`);
    }
    return response.arrayBuffer();
  }
  getBaseUrl() {
    return this.baseUrl;
  }
  getAuthHeader() {
    return this.authHeader;
  }
};

// src/adf-converter.ts
var AdfConverter = class {
  constructor(pageIndex, baseUrl) {
    this.pageIndex = pageIndex;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  convert(node) {
    return this.visitNode(node, 0);
  }
  visitNode(node, listDepth) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r;
    switch (node.type) {
      case "doc":
        return this.visitChildren(node, listDepth);
      case "paragraph":
        return this.visitChildren(node, listDepth) + "\n\n";
      case "heading": {
        const level = (_b = (_a = node.attrs) == null ? void 0 : _a.level) != null ? _b : 1;
        const hashes = "#".repeat(Math.min(level, 6));
        return `${hashes} ${this.visitChildren(node, listDepth)}

`;
      }
      case "bulletList":
        return this.visitListItems(node, listDepth, false) + "\n";
      case "orderedList":
        return this.visitListItems(node, listDepth, true) + "\n";
      case "listItem": {
        const content = this.visitChildren(node, listDepth + 1).replace(/\n\n$/, "").replace(/\n\n/g, "\n");
        return content;
      }
      case "codeBlock": {
        const lang = (_d = (_c = node.attrs) == null ? void 0 : _c.language) != null ? _d : "";
        const code = this.visitChildren(node, listDepth);
        return `\`\`\`${lang}
${code}
\`\`\`

`;
      }
      case "blockquote": {
        const inner = this.visitChildren(node, listDepth);
        return inner.split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
      }
      case "rule":
        return "---\n\n";
      case "table":
        return this.visitTable(node) + "\n";
      case "text":
        return this.applyMarks((_e = node.text) != null ? _e : "", (_f = node.marks) != null ? _f : []);
      case "hardBreak":
        return "\n";
      case "inlineCard": {
        const url = (_h = (_g = node.attrs) == null ? void 0 : _g.url) != null ? _h : "";
        return this.rewriteConfluenceLink(url);
      }
      case "mediaSingle":
      case "media":
        return this.visitChildren(node, listDepth);
      case "expand": {
        const title = (_j = (_i = node.attrs) == null ? void 0 : _i.title) != null ? _j : "";
        const inner = this.visitChildren(node, listDepth).trim();
        const lines = [`> ${title}`, ...inner.split("\n").map((l) => `> ${l}`)];
        return lines.join("\n") + "\n\n";
      }
      case "mention": {
        const name = (_n = (_m = (_k = node.attrs) == null ? void 0 : _k.text) != null ? _m : (_l = node.attrs) == null ? void 0 : _l.displayName) != null ? _n : "";
        return `@${name}`;
      }
      case "emoji": {
        const text = (_p = (_o = node.attrs) == null ? void 0 : _o.text) != null ? _p : "";
        if (text)
          return text;
        const shortName = (_r = (_q = node.attrs) == null ? void 0 : _q.shortName) != null ? _r : "";
        return shortName ? `:${shortName.replace(/:/g, "")}:` : "";
      }
      default:
        return this.visitChildren(node, listDepth);
    }
  }
  visitChildren(node, listDepth) {
    if (!node.content)
      return "";
    return node.content.map((child) => this.visitNode(child, listDepth)).join("");
  }
  visitListItems(node, listDepth, ordered) {
    var _a;
    const indent = "  ".repeat(listDepth);
    const items = (_a = node.content) != null ? _a : [];
    return items.map((item, idx) => {
      const prefix = ordered ? `${idx + 1}. ` : "- ";
      const content = this.visitNode(item, listDepth);
      const lines = content.split("\n");
      const firstLine = `${indent}${prefix}${lines[0]}`;
      const rest = lines.slice(1).map((l) => l.trim() ? `${indent}  ${l}` : l).join("\n");
      return rest ? `${firstLine}
${rest}` : firstLine;
    }).join("\n");
  }
  visitTable(node) {
    var _a, _b, _c;
    const rows = (_a = node.content) != null ? _a : [];
    const renderedRows = rows.map((row) => this.visitTableRow(row));
    if (renderedRows.length === 0)
      return "";
    const lines = [];
    lines.push(renderedRows[0]);
    const firstRow = rows[0];
    const colCount = (_c = (_b = firstRow.content) == null ? void 0 : _b.length) != null ? _c : 1;
    lines.push("| " + Array(colCount).fill("---").join(" | ") + " |");
    for (let i = 1; i < renderedRows.length; i++) {
      lines.push(renderedRows[i]);
    }
    return lines.join("\n");
  }
  visitTableRow(node) {
    var _a;
    const cells = (_a = node.content) != null ? _a : [];
    const cellContents = cells.map((cell) => {
      const inner = this.visitChildren(cell, 0).replace(/\n+/g, " ").trim();
      return inner;
    });
    return "| " + cellContents.join(" | ") + " |";
  }
  applyMarks(text, marks) {
    var _a, _b;
    let result = text;
    for (const mark of marks) {
      switch (mark.type) {
        case "strong":
          result = `**${result}**`;
          break;
        case "em":
          result = `_${result}_`;
          break;
        case "code":
          result = `\`${result}\``;
          break;
        case "strike":
          result = `~~${result}~~`;
          break;
        case "link": {
          const href = (_b = (_a = mark.attrs) == null ? void 0 : _a.href) != null ? _b : "";
          result = `[${result}](${this.rewriteConfluenceLink(href)})`;
          break;
        }
        case "subsup":
          break;
        case "underline":
          break;
        case "textColor":
          break;
      }
    }
    return result;
  }
  rewriteConfluenceLink(url) {
    var _a, _b;
    const pattern = new RegExp(
      `(?:${escapeRegex(this.baseUrl)})?/wiki/spaces/[^/]+/pages/(\\d+)`
    );
    const match = url.match(pattern);
    if (match) {
      const pageId = match[1];
      const vaultPath = this.pageIndex.get(pageId);
      if (vaultPath) {
        const filename = (_b = (_a = vaultPath.split("/").pop()) == null ? void 0 : _a.replace(/\.md$/, "")) != null ? _b : vaultPath;
        return `[[${filename}]]`;
      }
    }
    return url;
  }
};
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/image-downloader.ts
var ImageDownloader = class {
  constructor(client, vault, maxImageDownloadSizeKb) {
    this.client = client;
    this.vault = vault;
    this.maxSizeBytes = maxImageDownloadSizeKb * 1024;
  }
  async handleMedia(pageId, mediaId, syncFolderPath) {
    var _a;
    const baseUrl = this.client.getBaseUrl();
    const authHeader = this.client.getAuthHeader();
    const url = `${baseUrl}/wiki/rest/api/content/${pageId}/child/attachment?filename=&mediaType=&expand=metadata,extensions`;
    const response = await fetch(url, {
      headers: { Authorization: authHeader, Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Attachment metadata error ${response.status} for page ${pageId}`);
    }
    const data = await response.json();
    const attachment = (_a = data.results.find((a) => {
      return a.metadata.mediaType.startsWith("image/");
    })) != null ? _a : data.results[0];
    if (!attachment) {
      return `[attachment](${baseUrl}/wiki/spaces)`;
    }
    const mediaType = attachment.metadata.mediaType;
    const fileSize = attachment.extensions.fileSize;
    const downloadPath = attachment._links.download;
    const downloadUrl = `${baseUrl}${downloadPath}`;
    const filename = attachment.title;
    if (mediaType.startsWith("image/")) {
      if (fileSize <= this.maxSizeBytes) {
        const binary = await this.client.fetchBinary(downloadUrl);
        const attachmentsDir = `${syncFolderPath}/attachments`;
        const filePath = `${attachmentsDir}/${filename}`;
        try {
          await this.vault.adapter.mkdir(attachmentsDir);
        } catch (e) {
        }
        await this.vault.adapter.writeBinary(filePath, binary);
        return `![[${filename}]]`;
      } else {
        return `![${filename}](${downloadUrl})`;
      }
    } else {
      return `[${filename}](${downloadUrl})`;
    }
  }
};

// src/sync-engine.ts
var fs = __toESM(require("fs"));
function sanitizeTitle(title) {
  return title.replace(/[/:?*|\\<>"]/g, "-");
}
function buildTree(pages) {
  const nodeMap = /* @__PURE__ */ new Map();
  for (const page of pages) {
    nodeMap.set(page.id, { page, children: [] });
  }
  const roots = [];
  for (const page of pages) {
    const node = nodeMap.get(page.id);
    if (page.parentId && nodeMap.has(page.parentId)) {
      nodeMap.get(page.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
function computePaths(nodes, parentPath, pathMap) {
  for (const node of nodes) {
    const sanitized = sanitizeTitle(node.page.title);
    if (node.children.length > 0) {
      const folderPath = `${parentPath}/${sanitized}`;
      const filePath = `${folderPath}/index.md`;
      pathMap.set(node.page.id, filePath);
      computePaths(node.children, folderPath, pathMap);
    } else {
      const filePath = `${parentPath}/${sanitized}.md`;
      pathMap.set(node.page.id, filePath);
    }
  }
}
async function removeRecursive(vault, path) {
  try {
    const stat = await vault.adapter.stat(path);
    if (!stat)
      return;
    if (stat.type === "folder") {
      const listed = await vault.adapter.list(path);
      for (const file of listed.files) {
        try {
          const abs = vault.adapter.getFullPath(file);
          fs.chmodSync(abs, 420);
        } catch (e) {
        }
        await vault.adapter.remove(file);
      }
      for (const folder of listed.folders) {
        await removeRecursive(vault, folder);
      }
      if (path !== path) {
        try {
          await vault.adapter.rmdir(path, true);
        } catch (e) {
        }
      }
    } else {
      try {
        const abs = vault.adapter.getFullPath(path);
        fs.chmodSync(abs, 420);
      } catch (e) {
      }
      await vault.adapter.remove(path);
    }
  } catch (e) {
  }
}
async function wipeSyncFolder(vault, syncFolderPath) {
  try {
    const listed = await vault.adapter.list(syncFolderPath);
    for (const file of listed.files) {
      try {
        const abs = vault.adapter.getFullPath(file);
        fs.chmodSync(abs, 420);
      } catch (e) {
      }
      await vault.adapter.remove(file);
    }
    for (const folder of listed.folders) {
      const name = folder.split("/").pop();
      if (name === "attachments") {
        await wipeAttachmentsFolder(vault, folder);
      } else {
        await removeRecursive(vault, folder);
      }
    }
  } catch (e) {
  }
}
async function wipeAttachmentsFolder(vault, attachmentsPath) {
  try {
    const listed = await vault.adapter.list(attachmentsPath);
    for (const file of listed.files) {
      try {
        const abs = vault.adapter.getFullPath(file);
        fs.chmodSync(abs, 420);
      } catch (e) {
      }
      await vault.adapter.remove(file);
    }
  } catch (e) {
  }
}
function buildFrontmatter(pageId, baseUrl, spaceKey, title) {
  const url = `${baseUrl}/wiki/spaces/${spaceKey}/pages/${pageId}`;
  const lastSynced = (/* @__PURE__ */ new Date()).toISOString();
  return [
    "---",
    `confluence-id: "${pageId}"`,
    `confluence-url: "${url}"`,
    `confluence-title: "${title.replace(/"/g, '\\"')}"`,
    `space: "${spaceKey}"`,
    `last-synced: "${lastSynced}"`,
    `read-only: true`,
    "---",
    ""
  ].join("\n");
}
async function runSyncForTarget(target, settings, vault) {
  const { spaceKey, syncFolderPath } = target;
  const { confluenceBaseUrl, confluenceEmail, confluenceApiToken, maxImageDownloadSizeKb } = settings;
  new import_obsidian.Notice(`Syncing ${spaceKey}\u2026`);
  const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);
  const imageDownloader = new ImageDownloader(client, vault, maxImageDownloadSizeKb);
  const pages = await client.getSpacePages(spaceKey);
  const tree = buildTree(pages);
  const pathMap = /* @__PURE__ */ new Map();
  computePaths(tree, syncFolderPath, pathMap);
  await wipeSyncFolder(vault, syncFolderPath);
  try {
    await vault.adapter.mkdir(syncFolderPath);
  } catch (e) {
  }
  const converter = new AdfConverter(pathMap, confluenceBaseUrl);
  let syncedCount = 0;
  for (const page of pages) {
    const vaultPath = pathMap.get(page.id);
    if (!vaultPath)
      continue;
    try {
      const adf = await client.getPageBody(page.id);
      const dir = vaultPath.split("/").slice(0, -1).join("/");
      if (dir) {
        try {
          await vault.adapter.mkdir(dir);
        } catch (e) {
        }
      }
      const markdown = await resolveMediaNodes(adf, page.id, syncFolderPath, imageDownloader, converter);
      const frontmatter = buildFrontmatter(page.id, confluenceBaseUrl, spaceKey, page.title);
      const content = frontmatter + markdown;
      await vault.adapter.write(vaultPath, content);
      try {
        const abs = vault.adapter.getFullPath(vaultPath);
        fs.chmodSync(abs, 292);
      } catch (e) {
      }
      syncedCount++;
    } catch (err) {
      console.warn(`[Confluence Vault Sync] Failed to sync page ${page.id} "${page.title}":`, err);
    }
  }
  return syncedCount;
}
async function resolveMediaNodes(adf, pageId, syncFolderPath, imageDownloader, converter) {
  const mediaReplacements = /* @__PURE__ */ new Map();
  async function collectMedia(node) {
    var _a, _b;
    if (node.type === "media") {
      const mediaId = (_b = (_a = node.attrs) == null ? void 0 : _a.id) != null ? _b : "";
      if (mediaId && !mediaReplacements.has(mediaId)) {
        try {
          const result = await imageDownloader.handleMedia(pageId, mediaId, syncFolderPath);
          mediaReplacements.set(mediaId, result);
        } catch (err) {
          console.warn(`[Confluence Vault Sync] Failed to download media ${mediaId}:`, err);
          mediaReplacements.set(mediaId, `[attachment unavailable]`);
        }
      }
    }
    if (node.content) {
      for (const child of node.content) {
        await collectMedia(child);
      }
    }
  }
  await collectMedia(adf);
  function replaceMedia(node) {
    var _a, _b, _c;
    if (node.type === "media") {
      const mediaId = (_b = (_a = node.attrs) == null ? void 0 : _a.id) != null ? _b : "";
      const replacement = (_c = mediaReplacements.get(mediaId)) != null ? _c : "[attachment]";
      return { type: "text", text: replacement };
    }
    if (node.content) {
      return { ...node, content: node.content.map(replaceMedia) };
    }
    return node;
  }
  const resolvedAdf = replaceMedia(adf);
  return converter.convert(resolvedAdf);
}

// main.ts
var ConfluenceVaultSyncPlugin = class extends import_obsidian2.Plugin {
  async onload() {
    await this.loadSettings();
    this.addRibbonIcon("refresh-cw", "Sync Confluence", () => {
      this.syncAll();
    });
    this.addCommand({
      id: "sync-confluence",
      name: "Sync Confluence",
      callback: () => {
        this.syncAll();
      }
    });
    this.addSettingTab(new ConfluenceVaultSyncSettingTab(this.app, this));
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof import_obsidian2.TFolder) {
          const target = this.settings.syncTargets.find(
            (t) => t.syncFolderPath === file.path
          );
          if (target) {
            menu.addItem((item) => {
              item.setTitle("Pull Confluence").setIcon("refresh-cw").onClick(() => this.syncTarget(target));
            });
          }
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        const isManaged = this.settings.syncTargets.some(
          (t) => file.path.startsWith(t.syncFolderPath + "/")
        );
        if (isManaged) {
          new import_obsidian2.Notice(
            "This file is managed by Confluence Vault Sync and cannot be edited."
          );
          this.app.vault.adapter.read(file.path).then((content) => {
            this.app.vault.adapter.write(file.path, content);
          }).catch(() => {
          });
        }
      })
    );
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  validateSettings() {
    const missing = [];
    if (!this.settings.confluenceBaseUrl)
      missing.push("Confluence Base URL");
    if (!this.settings.confluenceEmail)
      missing.push("Confluence Email");
    if (!this.settings.confluenceApiToken)
      missing.push("Confluence API Token");
    if (this.settings.syncTargets.length === 0)
      missing.push("at least one Sync Target");
    return missing;
  }
  async syncAll() {
    const missing = this.validateSettings();
    if (missing.length > 0) {
      new import_obsidian2.Notice(`Confluence Vault Sync: missing settings \u2014 ${missing.join(", ")}`);
      return;
    }
    let totalPages = 0;
    const targets = this.settings.syncTargets;
    try {
      for (const target of targets) {
        const count = await runSyncForTarget(target, this.settings, this.app.vault);
        totalPages += count;
      }
      new import_obsidian2.Notice(
        `Sync complete \u2014 ${targets.length} space${targets.length !== 1 ? "s" : ""}, ${totalPages} pages synced`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new import_obsidian2.Notice(`Sync failed: ${message}`);
    }
  }
  async syncTarget(target) {
    const missing = this.validateSettings();
    const settingsOnly = missing.filter((m) => m !== "at least one Sync Target");
    if (settingsOnly.length > 0) {
      new import_obsidian2.Notice(`Confluence Vault Sync: missing settings \u2014 ${settingsOnly.join(", ")}`);
      return;
    }
    try {
      const count = await runSyncForTarget(target, this.settings, this.app.vault);
      new import_obsidian2.Notice(`Sync complete \u2014 ${target.spaceKey}: ${count} pages synced`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new import_obsidian2.Notice(`Sync failed: ${message}`);
    }
  }
};
var ConfluenceVaultSyncSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Confluence Vault Sync" });
    new import_obsidian2.Setting(containerEl).setName("Confluence Base URL").setDesc("e.g. https://yourorg.atlassian.net").addText(
      (text) => text.setPlaceholder("https://yourorg.atlassian.net").setValue(this.plugin.settings.confluenceBaseUrl).onChange(async (value) => {
        this.plugin.settings.confluenceBaseUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Confluence Email").setDesc("Your Atlassian account email").addText(
      (text) => text.setPlaceholder("you@example.com").setValue(this.plugin.settings.confluenceEmail).onChange(async (value) => {
        this.plugin.settings.confluenceEmail = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Confluence API Token").setDesc("Atlassian API token (stored in plugin data)").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022").setValue(this.plugin.settings.confluenceApiToken).onChange(async (value) => {
        this.plugin.settings.confluenceApiToken = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Max image download size (KB)").setDesc("Images at or below this size are downloaded locally").addText(
      (text) => text.setPlaceholder("500").setValue(String(this.plugin.settings.maxImageDownloadSizeKb)).onChange(async (value) => {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num > 0) {
          this.plugin.settings.maxImageDownloadSizeKb = num;
          await this.plugin.saveSettings();
        }
      })
    );
    containerEl.createEl("h3", { text: "Sync Targets" });
    const tableContainer = containerEl.createDiv();
    this.renderSyncTargetsTable(tableContainer);
  }
  renderSyncTargetsTable(container) {
    container.empty();
    const table = container.createEl("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Space Key" });
    headerRow.createEl("th", { text: "Vault Folder Path" });
    headerRow.createEl("th", { text: "" });
    const tbody = table.createEl("tbody");
    for (let i = 0; i < this.plugin.settings.syncTargets.length; i++) {
      const target = this.plugin.settings.syncTargets[i];
      const row = tbody.createEl("tr");
      const keyCell = row.createEl("td");
      const keyInput = keyCell.createEl("input", { type: "text" });
      keyInput.value = target.spaceKey;
      keyInput.placeholder = "ENG";
      keyInput.style.width = "100%";
      keyInput.addEventListener("change", async () => {
        this.plugin.settings.syncTargets[i].spaceKey = keyInput.value.trim();
        await this.plugin.saveSettings();
      });
      const pathCell = row.createEl("td");
      const pathInput = pathCell.createEl("input", { type: "text" });
      pathInput.value = target.syncFolderPath;
      pathInput.placeholder = "confluence/eng";
      pathInput.style.width = "100%";
      pathInput.addEventListener("change", async () => {
        this.plugin.settings.syncTargets[i].syncFolderPath = pathInput.value.trim();
        await this.plugin.saveSettings();
      });
      const removeCell = row.createEl("td");
      const removeBtn = removeCell.createEl("button", { text: "\xD7" });
      removeBtn.style.cursor = "pointer";
      removeBtn.addEventListener("click", async () => {
        this.plugin.settings.syncTargets.splice(i, 1);
        await this.plugin.saveSettings();
        this.renderSyncTargetsTable(container);
      });
    }
    const addBtn = container.createEl("button", { text: "Add sync target" });
    addBtn.style.marginTop = "8px";
    addBtn.addEventListener("click", async () => {
      this.plugin.settings.syncTargets.push({ spaceKey: "", syncFolderPath: "" });
      await this.plugin.saveSettings();
      this.renderSyncTargetsTable(container);
    });
  }
};
