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
  herbalistEnabled: boolean;
  herbalistBinaryPath: string;
  herbalistIndexScope: 'vault' | 'confluence';
  herbalistModel: string;
}

export const DEFAULT_SETTINGS: ConfluenceVaultSyncSettings = {
  confluenceBaseUrl: '',
  confluenceEmail: '',
  confluenceApiToken: '',
  encryptApiToken: false,
  maxImageDownloadSizeKb: 500,
  syncConcurrency: 5,
  syncTargets: [],
  herbalistEnabled: false,
  herbalistBinaryPath: '',
  herbalistIndexScope: 'confluence',
  herbalistModel: 'bge-small-en-v1.5',
};
