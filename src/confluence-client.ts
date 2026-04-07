import { requestUrl } from 'obsidian';

export interface ConfluencePage {
  id: string;
  title: string;
  parentId: string | null;
  spaceKey: string;
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
    const response = await requestUrl({
      url,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    });
    if (response.status >= 400) {
      throw new Error(`Confluence API error ${response.status} — ${url}`);
    }
    return response.json as T;
  }

  /** Verifies credentials by fetching the current user. Returns display name on success. */
  async testConnection(): Promise<string> {
    const data = await this.request<{ displayName?: string; email?: string }>(
      `${this.baseUrl}/wiki/rest/api/myself`
    );
    return data.displayName ?? data.email ?? 'unknown user';
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

  async getSpacePages(spaceKey: string): Promise<ConfluencePage[]> {
    type SpacePagesResponse = {
      results: Array<{ id: string; title: string; parentId?: string | null }>;
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
        });
      }

      const next: string | undefined = data._links?.next;
      url = next ? `${this.baseUrl}${next}` : null;
    }

    console.log(`${LOG} fetched ${pages.length} pages total for space "${spaceKey}"`);
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
      results: Array<{ id: string; title: string; parentId?: string | null; spaceKey?: string }>;
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
        });
      }

      const next: string | undefined = data._links?.next;
      url = next ? `${this.baseUrl}${next}` : null;
    }

    return children;
  }

  async fetchBinary(url: string): Promise<ArrayBuffer> {
    console.debug(`${LOG} downloading binary: ${url}`);
    const response = await requestUrl({
      url,
      headers: { Authorization: this.authHeader },
    });
    if (response.status >= 400) {
      throw new Error(`Binary fetch error ${response.status} — ${url}`);
    }
    return response.arrayBuffer;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getAuthHeader(): string {
    return this.authHeader;
  }
}
