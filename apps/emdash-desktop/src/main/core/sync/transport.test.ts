/**
 * HttpRelayTransport unit tests (spec #130, ticket #133): fetch wiring, bearer
 * auth and error mapping. The behavioural contract (versions, LWW, tombstones)
 * is covered end-to-end in sync-engine.db.test.ts against the fake relay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRelayTransport } from './transport';

describe('HttpRelayTransport', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('POSTs JSON bodies to the relay base URL with the bearer token', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ cursor: 7, patches: [] }));

    const transport = new HttpRelayTransport('https://relay.example', async () => 'tok-123');
    const result = await transport.pull(5, 100);

    expect(result).toEqual({ cursor: 7, patches: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.example/v1/sync/pull');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init.body as string)).toEqual({ cursor: 5, limit: 100 });
  });

  it('sends the X-Relay-Key gate header on every request when configured', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ cursor: 0, patches: [] }));

    const transport = new HttpRelayTransport(
      'https://relay.example',
      async () => 'tok',
      'pre-shared-key'
    );
    // Authenticated endpoint…
    await transport.pull(0);
    // …and an unauthenticated one (space/join): the gate header still rides.
    fetchMock.mockResolvedValue(
      jsonResponse({ space_id: 's', device_id: 'd', device_token: 't', secret: 'x' })
    );
    await transport.createSpace('main');

    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect((init.headers as Record<string, string>)['x-relay-key']).toBe('pre-shared-key');
    }
  });

  it('omits the X-Relay-Key header when no key is configured', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ cursor: 0, patches: [] }));

    const transport = new HttpRelayTransport('https://relay.example', async () => 'tok');
    await transport.pull(0);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-relay-key']).toBeUndefined();
  });

  it('skips the auth header on the space/join endpoints', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(
      jsonResponse({ space_id: 's', device_id: 'd', device_token: 't', secret: 'x' })
    );

    const transport = new HttpRelayTransport('https://relay.example', async () => 'tok');
    await transport.createSpace('main');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ name: 'main' });
  });

  it('throws RelayHttpError with the relay status on non-2xx responses', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));

    const transport = new HttpRelayTransport('https://relay.example', async () => 'tok');
    await expect(transport.pull(0)).rejects.toMatchObject({
      name: 'RelayHttpError',
      status: 401,
    });
  });

  it('throws RelayHttpError when the relay is unreachable', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const transport = new HttpRelayTransport('https://relay.example', async () => 'tok');
    await expect(transport.push([])).rejects.toMatchObject({
      name: 'RelayHttpError',
      status: 0,
    });
  });
});
