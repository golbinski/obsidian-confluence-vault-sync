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

describe('ConfluenceClient space scoping', () => {
  beforeEach(() => {
    requestUrl.mockReset();
  });

  // Regression: the v2 /pages endpoint only accepts `space-id` (numeric); an
  // unrecognized `space-key` param is silently ignored and returns pages across
  // the entire instance. Always scope page fetches by numeric space id.
  it('queries /pages with space-id, not space-key', async () => {
    requestUrl.mockResolvedValueOnce({ json: { results: [], _links: {} } });

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    await client.getSpacePages('123456', 'ENG');

    expect(requestUrl).toHaveBeenCalledTimes(1);
    const calledUrl = requestUrl.mock.calls[0][0].url as string;
    expect(calledUrl).toContain('space-id=123456');
    expect(calledUrl).not.toContain('space-key=');
  });

  it('resolves a space key to its numeric id via getSpaceByKey', async () => {
    requestUrl.mockResolvedValueOnce({
      json: {
        results: [{ id: '987', name: 'Engineering', homepageId: '111' }],
      },
    });

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    const space = await client.getSpaceByKey('ENG');

    expect(space).toEqual({ id: '987', name: 'Engineering', homepageId: '111' });
    const calledUrl = requestUrl.mock.calls[0][0].url as string;
    expect(calledUrl).toContain('keys=ENG');
  });

  it('throws a descriptive error when the space is not found', async () => {
    requestUrl.mockResolvedValueOnce({ json: { results: [] } });

    const client = new ConfluenceClient('https://org.atlassian.net', 'e@x', 'tok');
    await expect(client.getSpaceByKey('MISSING')).rejects.toThrow(/MISSING/);
  });
});
