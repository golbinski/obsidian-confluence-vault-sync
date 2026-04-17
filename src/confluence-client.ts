import { requestUrl } from 'obsidian';

export interface ConfluencePage {
  id: string;
  title: string;
  parentId: string | null;
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
      const response = await requestUrl({
        url,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
        },
      });
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

  /** Verifies that a space with the given key exists and is accessible. Returns the space name. */
  async checkSpaceAccess(spaceKey: string): Promise<string> {
    const data = await this.request<{ results: Array<{ name: string }> }>(
      `${this.baseUrl}/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`
    );
    if (!data.results.length) {
      throw new Error(`Space "${spaceKey}" not found or not accessible`);
    }
    return data.results[0].name;
  }

  /** Returns the ID of the space's designated home (root) page. */
  async getSpaceHomePageId(spaceKey: string): Promise<string | null> {
    const data = await this.request<{
      results: Array<{ homepageId?: string }>;
    }>(`${this.baseUrl}/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`);
    return data.results[0]?.homepageId ?? null;
  }

  async getSpacePages(spaceKey: string): Promise<ConfluencePage[]> {
    type SpacePagesResponse = {
      results: Array<{
        id: string;
        title: string;
        parentId?: string | null;
        version?: { createdAt?: string };
      }>;
      _links?: { next?: string };
    };
    const pages: ConfluencePage[] = [];
    let url: string | null =
      `${this.baseUrl}/wiki/api/v2/pages?space-key=${encodeURIComponent(spaceKey)}&limit=250`;

    while (url) {
      const data: SpacePagesResponse = await this.request<SpacePagesResponse>(url);
      console.debug(`${LOG} fetched ${data.results.length} pages (total so far: ${pages.length + data.results.length})`);

      for (const page of data.results) {
        pages.push({
          id: page.id,
          title: page.title,
          parentId: page.parentId ?? null,
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
      const response = await requestUrl({
        url,
        headers: { Authorization: this.authHeader },
      });
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
      await requestUrl({
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
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new Error(`Failed to update page ${pageId}${status ? ` (${status})` : ''}`);
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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'X-Atlassian-Token': 'no-check',
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Attachment upload failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as { results?: AttachmentUploadResult[] };
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
