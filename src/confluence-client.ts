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

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authHeader = 'Basic ' + btoa(`${email}:${apiToken}`);
  }

  private async request<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Confluence API error ${response.status} ${response.statusText} for ${url}`);
    }
    return response.json() as Promise<T>;
  }

  async getSpacePages(spaceKey: string): Promise<ConfluencePage[]> {
    type SpacePagesResponse = {
      results: Array<{ id: string; title: string; parentId?: string | null }>;
      _links?: { next?: string };
    };
    const pages: ConfluencePage[] = [];
    let url: string | null =
      `${this.baseUrl}/wiki/api/v2/pages?spaceKey=${encodeURIComponent(spaceKey)}&limit=250`;

    while (url) {
      const data: SpacePagesResponse = await this.request<SpacePagesResponse>(url);

      for (const page of data.results) {
        pages.push({
          id: page.id,
          title: page.title,
          parentId: page.parentId ?? null,
          spaceKey,
        });
      }

      const next: string | undefined = data._links?.next;
      url = next ? `${this.baseUrl}/wiki${next}` : null;
    }

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
      url = next ? `${this.baseUrl}/wiki${next}` : null;
    }

    return children;
  }

  async fetchBinary(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader },
    });
    if (!response.ok) {
      throw new Error(`Binary fetch error ${response.status} for ${url}`);
    }
    return response.arrayBuffer();
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getAuthHeader(): string {
    return this.authHeader;
  }
}
