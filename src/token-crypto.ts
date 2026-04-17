const ENC_PREFIX = 'enc:';

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function getSafeStorage(): SafeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const remote = require('@electron/remote') as { safeStorage: SafeStorage };
    return remote.safeStorage ?? null;
  } catch {
    return null;
  }
}

/** Returns true if OS-level encryption is available on this platform. */
export function isEncryptionAvailable(): boolean {
  const ss = getSafeStorage();
  return ss?.isEncryptionAvailable() ?? false;
}

/**
 * Encrypt a plaintext token.
 * Returns an `enc:<base64>` string, or the original plaintext if encryption
 * is unavailable on this platform.
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) return plaintext;
  const ss = getSafeStorage();
  if (!ss?.isEncryptionAvailable()) return plaintext;
  try {
    return ENC_PREFIX + ss.encryptString(plaintext).toString('base64');
  } catch {
    return plaintext;
  }
}

/**
 * Decrypt a stored token value.
 * Handles both `enc:<base64>` (encrypted) and plain strings (legacy / fallback).
 * Returns an empty string if decryption fails.
 */
export function decryptToken(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const ss = getSafeStorage();
  if (!ss) return '';
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return ss.decryptString(buf);
  } catch {
    return '';
  }
}
