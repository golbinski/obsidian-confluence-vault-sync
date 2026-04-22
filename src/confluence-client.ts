import { requestUrl } from 'obsidian';

export interface ConfluencePage {
  id: string;
  title: string;
  parentId: string | null;
  parentType: string | null; // "page", "folder", or null for space roots
  contentType: 'page' | 'folder' | 'unknown'; // entity type in Confluence
  spaceKey: string;
  versionDate: string; // ISO timestamp of last modification from Confluence
}

export interface AdfDocument {
  version: number;
  type: 'doc';
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

const LOG = '[Confluence Vault Sync]';

// Retry settings for transient failures (429 rate-limit, 5xx server errors).
// Base backoff grows exponentially: 500ms, 1000ms, 2000ms — with jitter.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  getStatus: (err: unknown) => number | undefined = (e) => (e as { status?: number }).status
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = getStatus(err);
      if (attempt >= MAX_RETRIES || !isRetryableStatus(status)) throw err;
      // Exponential backoff with full jitter
      const max = BASE_BACKOFF_MS * Math.pow(2, attempt);
      const delay = Math.floor(Math.random() * max);
      console.debug(`${LOG} retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (status ${status}) — ${label}`);
      await sleep(delay);
      attempt++;
    }
  }
}

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authHeader = 'Basic ' + btoa(`${email}:${apiToken}`);
  }

  private async request<T>(url: string): Promise<T> {
    console.debug(`${LOG} GET ${url}`);
    try {
      const response = await withRetry(`GET ${url}`, () =>
        requestUrl({
          url,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
          },
        })
      );
      return response.json as T;
    } catch (err) {
      // requestUrl throws on non-2xx; extract status from the error if present
      const status = (err as { status?: number }).status;
      throw new Error(
        `Confluence API error${status ? ` ${status}` : ''} — ${url}`
      );
    }
  }

  /** Verifies credentials by fetching the current user. Returns display name on success. */
  async testConnection(): Promise<string> {
    const data = await this.request<{ displayName?: string; publicName?: string }>(
      `${this.baseUrl}/wiki/rest/api/user/current`
    );
    return data.displayName ?? data.publicName ?? 'unknown user';
  }

  /**
   * Look up a space by its key and return its numeric id, display name, and
   * home-page id. The numeric `id` is required for scoping v2 `/pages` queries
   * (the v2 API does NOT accept `space-key` — passing it silently fetches
   * pages across the entire instance).
   */
  async getSpaceByKey(
    spaceKey: string
  ): Promise<{ id: string; name: string; homepageId: string | null }> {
    const data = await this.request<{
      results: Array<{ id: string; name: string; homepageId?: string | null }>;
    }>(`${this.baseUrl}/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`);
    const space = data.results[0];
    if (!space) {
      throw new Error(`Space "${spaceKey}" not found or not accessible`);
    }
    return { id: space.id, name: space.name, homepageId: space.homepageId ?? null };
  }

  /** Verifies that a space with the given key exists and is accessible. Returns the space name. */
  async checkSpaceAccess(spaceKey: string): Promise<string> {
    return (await this.getSpaceByKey(spaceKey)).name;
  }

  /**
   * Fetch all pages in a space. The v2 `/pages` endpoint is scoped by numeric
   * `space-id`; callers must resolve the space key via `getSpaceByKey` first.
   * The original `spaceKey` is echoed back into each `ConfluencePage.spaceKey`.
   */
  async getSpacePages(spaceId: string, spaceKey: string): Promise<ConfluencePage[]> {
    type SpacePagesResponse = {
      results: Array<{
        id: string;
        title: string;
        parentId?: string | null;
        parentType?: string | null;
        version?: { createdAt?: string };
      }>;
      _links?: { next?: string };
    };
    const pages: ConfluencePage[] = [];
    let url: string | null =
      `${this.baseUrl}/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&limit=250`;

    while (url) {
      const data: SpacePagesResponse = await this.request<SpacePagesResponse>(url);
      console.debug(`${LOG} fetched ${data.results.length} pages (total so far: ${pages.length + data.results.length})`);

      for (const page of data.results) {
        pages.push({
          id: page.id,
          title: page.title,
          parentId: page.parentId ?? null,
          parentType: page.parentType ?? null,
          contentType: 'page',
          spaceKey,
          versionDate: page.version?.createdAt ?? new Date(0).toISOString(),
        });
      }

      const next: string | undefined = data._links?.next;
      url = next ? `${this.baseUrl}${next}` : null;
    }

    console.debug(`${LOG} fetched ${pages.length} pages total for space "${spaceKey}"`);
    return pages;
  }

  /** Fetch a Confluence Folder entity by ID via the v2 folders endpoint. */
  async getFolderById(
    id: string
  ): Promise<{ id: string; title: string; parentId: string | null; parentType: string | null } | null> {
    try {
      const data = await this.request<{
        id: string;
        title: string;
        parentId?: string | null;
        parentType?: string | null;
      }>(`${this.baseUrl}/wiki/api/v2/folders/${id}`);
      return {
        id: data.id,
        title: data.title,
        parentId: data.parentId ?? null,
        parentType: data.parentType ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fallback: fetch any content entity by ID via the v1 REST API.
   * Used when the content type is unknown or not covered by v2 endpoints.
   * Returns null if the content is inaccessible or not found.
   */
  async getContentById(
    id: string
  ): Promise<{ id: string; title: string; parentId: string | null; parentType: string | null } | null> {
    try {
      const data = await this.request<{
        id: string;
        title: string;
        type?: string;
        ancestors?: Array<{ id: string }>;
      }>(`${this.baseUrl}/wiki/rest/api/content/${id}?expand=ancestors`);
      const parentId = data.ancestors?.at(-1)?.id ?? null;
      return { id: data.id, title: data.title, parentId, parentType: null };
    } catch {
      return null;
    }
  }

  async getPageBody(pageId: string): Promise<AdfDocument> {
    const data = await this.request<{
      body: { atlas_doc_format: { value: string } };
    }>(`${this.baseUrl}/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`);
    return JSON.parse(data.body.atlas_doc_format.value) as AdfDocument;
  }

  async getPageChildren(pageId: string): Promise<ConfluencePage[]> {
    type ChildrenResponse = {
      results: Array<{
        id: string;
        title: string;
        parentId?: string | null;
        spaceKey?: string;
        version?: { createdAt?: string };
      }>;
      _links?: { next?: string };
    };
    const children: ConfluencePage[] = [];
    let url: string | null =
      `${this.baseUrl}/wiki/api/v2/pages/${pageId}/children?limit=250`;

    while (url) {
      const data: ChildrenResponse = await this.request<ChildrenResponse>(url);

      for (const page of data.results) {
        children.push({
          id: page.id,
          title: page.title,
          parentId: page.parentId ?? pageId,
          parentType: 'page',
          contentType: 'page',
          spaceKey: page.spaceKey ?? '',
          versionDate: page.version?.createdAt ?? new Date(0).toISOString(),
        });
      }

      const next: string | undefined = data._links?.next;
      url = next ? `${this.baseUrl}${next}` : null;
    }

    return children;
  }

  async fetchBinary(url: string): Promise<ArrayBuffer> {
    console.debug(`${LOG} downloading binary: ${url}`);
    try {
      const response = await withRetry(`binary ${url}`, () =>
        requestUrl({
          url,
          headers: { Authorization: this.authHeader },
        })
      );
      return response.arrayBuffer;
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new Error(`Binary fetch error${status ? ` ${status}` : ''} — ${url}`);
    }
  }

  /** Returns the names of all labels attached to a page. */
  async getPageLabels(pageId: string): Promise<string[]> {
    type LabelsResponse = {
      results: Array<{ name: string }>;
      _links?: { next?: string };
    };
    const labels: string[] = [];
    let url: string | null =
      `${this.baseUrl}/wiki/api/v2/pages/${pageId}/labels?limit=250`;

    while (url) {
      const data: LabelsResponse = await this.request<LabelsResponse>(url);
      for (const label of data.results) labels.push(label.name);
      const next: string | undefined = data._links?.next;
      url = next ? `${this.baseUrl}${next}` : null;
    }

    return labels;
  }

  /** Returns the current version number, last-updated timestamp, and title of a page. */
  async getPageCurrentVersion(pageId: string): Promise<{ version: number; updatedAt: string; title: string }> {
    const data = await this.request<{
      title: string;
      version: { number: number; createdAt: string };
    }>(`${this.baseUrl}/wiki/api/v2/pages/${pageId}`);
    return { version: data.version.number, updatedAt: data.version.createdAt, title: data.title };
  }

  /** Updates a page's title and body in Confluence. currentVersion is the version to base off. */
  async updatePage(
    pageId: string,
    title: string,
    adf: AdfDocument,
    currentVersion: number
  ): Promise<void> {
    console.debug(`${LOG} updating page ${pageId} "${title}" (base version ${currentVersion})`);
    try {
      await withRetry(`PUT page ${pageId}`, () =>
        requestUrl({
          url: `${this.baseUrl}/wiki/api/v2/pages/${pageId}`,
          method: 'PUT',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: pageId,
            status: 'current',
            title,
            body: {
              representation: 'atlas_doc_format',
              value: JSON.stringify(adf),
            },
            version: {
              number: currentVersion + 1,
              message: 'Updated via Obsidian Confluence Vault Sync',
            },
          }),
        })
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new Error(`Failed to update page ${pageId}${status ? ` (${status})` : ''}`);
    }
  }

  async createPage(
    spaceKey: string,
    parentId: string,
    title: string,
    adf: AdfDocument,
  ): Promise<{ pageId: string; url: string }> {
    console.debug(`${LOG} creating page "${title}" under parent ${parentId} in space ${spaceKey}`);
    // Use the v1 REST API for page creation — the v2 POST /pages endpoint returns
    // 400 INVALID_MESSAGE when body.representation is "atlas_doc_format".
    // v1 accepts atlas_doc_format via body.atlas_doc_format reliably.
    const requestBody = {
      type: 'page',
      status: 'current',
      title,
      space: { key: spaceKey },
      ancestors: [{ id: parentId }],
      body: {
        atlas_doc_format: {
          value: JSON.stringify(adf),
          representation: 'atlas_doc_format',
        },
      },
    };
    try {
      const res = await withRetry(`POST page "${title}"`, () =>
        requestUrl({
          url: `${this.baseUrl}/wiki/rest/api/content`,
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        })
      );
      const json = res.json as { id: string; _links: { base: string; webui: string } };
      console.debug(`${LOG} created page ${json.id} "${title}"`);
      const base = json._links.base ?? this.baseUrl;
      return { pageId: json.id, url: `${base}${json._links.webui}` };
    } catch (err) {
      const status = (err as { status?: number }).status;
      const responseText = (err as { responseText?: string }).responseText ?? '';
      console.error(
        `${LOG} createPage failed — status=${status ?? 'unknown'} space=${spaceKey} parentId=${parentId} title="${title}"`,
        responseText ? `\nConfluence response: ${responseText}` : '',
        '\nRequest body:', JSON.stringify(requestBody, null, 2),
      );
      throw new Error(`Failed to create page "${title}"${status ? ` (${status})` : ''}`);
    }
  }

  /**
   * Move a page to be a child of targetId using the v1 API.
   * Required when targetId is a Confluence folder entity — the v2 createPage
   * endpoint rejects folder IDs as parentId (returns 500, CONFCLOUD-79677).
   */
  async movePage(pageId: string, targetId: string): Promise<void> {
    console.debug(`${LOG} moving page ${pageId} → under ${targetId}`);
    try {
      await withRetry(`move page ${pageId}`, () =>
        requestUrl({
          url: `${this.baseUrl}/wiki/rest/api/content/${pageId}/move/append/${targetId}`,
          method: 'PUT',
          headers: { Authorization: this.authHeader },
        })
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new Error(`Failed to move page ${pageId} under ${targetId}${status ? ` (${status})` : ''}`);
    }
  }

  /**
   * Upload a file as an attachment to a Confluence page.
   * Returns the media ID (UUID) and collection string needed to reference the
   * attachment in an ADF media node.
   *
   * Media UUID resolution order:
   *   1. `extensions.fileId` (available in some Confluence Cloud versions)
   *   2. `fileId=` query parameter in `_links.download` URL
   *   3. Raw `id` field as fallback (may be `att12345` on older instances)
   */
  async uploadAttachment(
    pageId: string,
    filename: string,
    data: ArrayBuffer,
    mimeType: string
  ): Promise<{ mediaId: string; collection: string }> {
    const url = `${this.baseUrl}/wiki/rest/api/content/${pageId}/child/attachment`;

    const formData = new FormData();
    formData.append('file', new Blob([data], { type: mimeType }), filename);
    formData.append('minorEdit', 'true');

    const json = await withRetry(
      `POST attachment ${filename}`,
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'X-Atlassian-Token': 'no-check',
          },
          body: formData,
        });
        if (!response.ok) {
          const err = new Error(
            `Attachment upload failed: ${response.status} ${response.statusText}`
          ) as Error & { status: number };
          err.status = response.status;
          throw err;
        }
        return (await response.json()) as { results?: AttachmentUploadResult[] };
      }
    );
    const att = json.results?.[0];
    if (!att) throw new Error('Confluence returned no attachment in upload response');

    const mediaId = resolveMediaId(att);
    return { mediaId, collection: `contentId-${pageId}` };
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getAuthHeader(): string {
    return this.authHeader;
  }
}

// ---------------------------------------------------------------------------
// Attachment upload helpers
// ---------------------------------------------------------------------------

interface AttachmentUploadResult {
  id: string;
  extensions?: { fileId?: string };
  _links?: { download?: string };
}

function resolveMediaId(att: AttachmentUploadResult): string {
  // Prefer explicit fileId field (newer Confluence Cloud)
  if (att.extensions?.fileId) return att.extensions.fileId;

  // Parse from download URL query param: ?fileId=<UUID>
  const downloadUrl = att._links?.download ?? '';
  const match = downloadUrl.match(/[?&]fileId=([0-9a-f-]{36})/i);
  if (match) return match[1];

  // Fallback to raw id (may work on some instances)
  return att.id;
}
