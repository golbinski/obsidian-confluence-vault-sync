export interface SyncTarget {
  spaceKey: string;
  syncFolderPath: string;
}

export interface ConfluenceVaultSyncSettings {
  confluenceBaseUrl: string;
  confluenceEmail: string;
  confluenceApiToken: string;
  encryptApiToken: boolean;
  maxImageDownloadSizeKb: number;
  syncConcurrency: number;
  syncTargets: SyncTarget[];
}

export const DEFAULT_SETTINGS: ConfluenceVaultSyncSettings = {
  confluenceBaseUrl: '',
  confluenceEmail: '',
  confluenceApiToken: '',
  encryptApiToken: false,
  maxImageDownloadSizeKb: 500,
  syncConcurrency: 5,
  syncTargets: [],
};
