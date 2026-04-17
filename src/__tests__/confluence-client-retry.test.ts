import { describe, it, expect, vi, beforeEach } from 'vitest';

// Swap the obsidian mock's `requestUrl` with a vi.fn we can control per-test.
// `vi.hoisted` runs before `vi.mock` is hoisted, so the fn is available in the factory.
const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));

vi.mock('obsidian', () => ({
  requestUrl,
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  ItemView: class {},
  Modal: class {},
  Setting: class {},
  ButtonComponent: class {},
  TFolder: class {},
}));

// Import AFTER the mock is registered
import { ConfluenceClient } from '../confluence-client';

function httpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

describe('ConfluenceClient retry', () => {
  beforeEach(() => {
    requestUrl.mockReset();
  });

  it('retries a 5xx response and returns on eventual success', async () => {
    requestUrl
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce({ json: { displayName: 'Alice' } });

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    const name = await client.testConnection();

    expect(name).toBe('Alice');
    expect(requestUrl).toHaveBeenCalledTimes(3);
  });

  it('retries a 429 response', async () => {
    requestUrl
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ json: { displayName: 'Bob' } });

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    const name = await client.testConnection();

    expect(name).toBe('Bob');
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 401 (non-retryable status)', async () => {
    requestUrl.mockRejectedValue(httpError(401));

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    await expect(client.testConnection()).rejects.toThrow();
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 404 (non-retryable status)', async () => {
    requestUrl.mockRejectedValue(httpError(404));

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    await expect(client.testConnection()).rejects.toThrow();
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_RETRIES+1 attempts on persistent 5xx', async () => {
    requestUrl.mockRejectedValue(httpError(500));

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    await expect(client.testConnection()).rejects.toThrow();
    // Initial attempt + 3 retries = 4 total
    expect(requestUrl).toHaveBeenCalledTimes(4);
  });
});
