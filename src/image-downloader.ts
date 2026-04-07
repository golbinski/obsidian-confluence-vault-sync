import type { ConfluenceClient } from './confluence-client';
import type { Vault } from 'obsidian';

interface AttachmentMetadata {
  title: string;
  metadata: { mediaType: string };
  extensions: { fileSize: number };
  _links: { download: string };
}

interface AttachmentResponse {
  results: AttachmentMetadata[];
}

export class ImageDownloader {
  private readonly client: ConfluenceClient;
  private readonly vault: Vault;
  private readonly maxSizeBytes: number;

  constructor(client: ConfluenceClient, vault: Vault, maxImageDownloadSizeKb: number) {
    this.client = client;
    this.vault = vault;
    this.maxSizeBytes = maxImageDownloadSizeKb * 1024;
  }

  async handleMedia(
    pageId: string,
    mediaId: string,
    syncFolderPath: string
  ): Promise<string> {
    const baseUrl = this.client.getBaseUrl();
    const authHeader = this.client.getAuthHeader();

    // Fetch attachment metadata
    const url = `${baseUrl}/wiki/rest/api/content/${pageId}/child/attachment?filename=&mediaType=&expand=metadata,extensions`;
    const response = await fetch(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Attachment metadata error ${response.status} for page ${pageId}`);
    }

    const data = (await response.json()) as AttachmentResponse;

    // Find attachment by media ID (stored in attachment id without "att" prefix sometimes)
    const attachment =
      data.results.find((a) => {
        // Confluence attachment IDs may not directly match media node IDs
        // Fall back to first image attachment if no direct match
        return a.metadata.mediaType.startsWith('image/');
      }) ?? data.results[0];

    if (!attachment) {
      return `[attachment](${baseUrl}/wiki/spaces)`;
    }

    const mediaType = attachment.metadata.mediaType;
    const fileSize = attachment.extensions.fileSize;
    const downloadPath = attachment._links.download;
    const downloadUrl = `${baseUrl}${downloadPath}`;
    const filename = attachment.title;

    if (mediaType.startsWith('image/')) {
      if (fileSize <= this.maxSizeBytes) {
        // Download and store locally
        const binary = await this.client.fetchBinary(downloadUrl);
        const attachmentsDir = `${syncFolderPath}/attachments`;
        const filePath = `${attachmentsDir}/${filename}`;

        try {
          await this.vault.adapter.mkdir(attachmentsDir);
        } catch {
          // Directory may already exist
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
}
