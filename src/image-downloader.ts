import { requestUrl } from 'obsidian';
import type { ConfluenceClient } from './confluence-client';
import type { Vault } from 'obsidian';

interface AttachmentMetadata {
  title: string;
  metadata: { mediaType: string };
  extensions: { fileSize: number; fileId?: string };
  _links: { download: string };
}

interface AttachmentResponse {
  results: AttachmentMetadata[];
}

export interface MediaHandleResult {
  /** Markdown representation to embed in the vault file. */
  markdown: string;
  /** Local filename of the downloaded file, or null if not downloaded. */
  filename: string | null;
  /** MIME type of the attachment, or null if unavailable. */
  mimeType: string | null;
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
  ): Promise<MediaHandleResult> {
    const baseUrl = this.client.getBaseUrl();
    const authHeader = this.client.getAuthHeader();

    const url = `${baseUrl}/wiki/rest/api/content/${pageId}/child/attachment?expand=metadata,extensions`;
    let response;
    try {
      response = await requestUrl({
        url,
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new Error(`Attachment metadata error${status ? ` ${status}` : ''} for page ${pageId}`);
    }

    const data = response.json as AttachmentResponse;

    // Find the specific attachment matching mediaId. Confluence stores the file
    // UUID in extensions.fileId (newer Cloud) or as a fileId= query param in
    // the download URL (older). Fall back to the first image if no exact match
    // (e.g. page has only one image and mediaId resolution differs).
    const findByMediaId = (results: AttachmentMetadata[]): AttachmentMetadata | undefined =>
      results.find((a) => {
        if (a.extensions?.fileId === mediaId) return true;
        const match = a._links?.download?.match(/[?&]fileId=([0-9a-f-]{36})/i);
        return match?.[1] === mediaId;
      });

    const attachment =
      findByMediaId(data.results) ??
      data.results.find((a) => a.metadata.mediaType.startsWith('image/')) ??
      data.results[0];

    if (!attachment) {
      return { markdown: `[attachment](${baseUrl}/wiki/spaces)`, filename: null, mimeType: null };
    }

    const mediaType = attachment.metadata.mediaType;
    const fileSize = attachment.extensions.fileSize;
    const rawDownload = attachment._links.download;
    // Confluence sometimes returns download paths without the /wiki prefix;
    // normalise to always include it so the constructed URL resolves correctly.
    const downloadPath = rawDownload.startsWith('/wiki/') ? rawDownload : `/wiki${rawDownload}`;
    const downloadUrl = `${baseUrl}${downloadPath}`;
    const filename = attachment.title;

    if (mediaType.startsWith('image/')) {
      if (fileSize <= this.maxSizeBytes) {
        let binary: ArrayBuffer;
        try {
          binary = await this.client.fetchBinary(downloadUrl);
        } catch (err) {
          console.warn(
            `[Confluence Vault Sync] media download failed for "${filename}" (${mediaType}, ${fileSize}B)`,
            `rawDownload=${rawDownload}`,
            err
          );
          return { markdown: `![${filename}](${downloadUrl})`, filename: null, mimeType: null };
        }
        const attachmentsDir = `${syncFolderPath}/attachments`;
        const filePath = `${attachmentsDir}/${filename}`;

        try {
          await this.vault.adapter.mkdir(attachmentsDir);
        } catch {
          // Already exists
        }

        await this.vault.adapter.writeBinary(filePath, binary);
        return { markdown: `![[${filename}]]`, filename, mimeType: mediaType };
      } else {
        // Too large to download — link only, no local copy
        return { markdown: `![${filename}](${downloadUrl})`, filename: null, mimeType: null };
      }
    } else {
      return { markdown: `[${filename}](${downloadUrl})`, filename: null, mimeType: null };
    }
  }
}
