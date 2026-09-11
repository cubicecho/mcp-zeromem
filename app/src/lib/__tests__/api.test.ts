import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, getStatus } from '@/lib/api';
import { getNeedsAuth, setToken, TOKEN_STORAGE_KEY } from '@/lib/auth';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.clear();
    // reset the needsAuth flag from previous tests
    setToken('reset');
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('attaches the bearer token from localStorage', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'secret-token');
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'mcp-zeromem' }));

    await getStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    );
  });

  it('sends no Authorization header without a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await getStatus();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('flags needsAuth and throws an ApiRequestError on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

    await expect(getStatus()).rejects.toMatchObject({ status: 401, message: 'unauthorized' });
    expect(getNeedsAuth()).toBe(true);

    // entering a token clears the flag again
    setToken('new-token');
    expect(getNeedsAuth()).toBe(false);
  });

  it('carries the server detail on other errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom', detail: 'database is locked' }));

    const error = await getStatus().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 500, message: 'boom', detail: 'database is locked' });
  });
});
