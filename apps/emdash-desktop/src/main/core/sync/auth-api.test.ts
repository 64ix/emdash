/**
 * HttpRelayAuthApi tests (spec #130, ticket #135): request wiring (URL, body,
 * headers) and — most importantly — the error mapping. A 404 must only become
 * `device_not_found` when the relay itself says so (`device not found in this
 * space`, i.e. a cross-space revoke); a bare 404 from anything that is not the
 * relay (wrong URL, web page, unknown route) is a `relay_error`, otherwise a
 * misconfigured URL would tell the user their device was removed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRelayAuthApi } from './auth-api';

describe('HttpRelayAuthApi', () => {
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

  const endpoint = async () => ({ baseUrl: 'https://relay.example', relayKey: 'key-1' });

  function makeApi(): HttpRelayAuthApi {
    return new HttpRelayAuthApi(endpoint);
  }

  it('POSTs to /v1/space without a bearer token and returns the created space', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(
      jsonResponse({ space_id: 's1', device_id: 'd1', device_token: 'tok', secret: 'emdj1_x' })
    );

    const result = await makeApi().createSpace('main');

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.example/v1/space');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-relay-key')).toBe('key-1');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'main' });
  });

  it('sends the bearer token on authenticated endpoints', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ devices: [] }));

    const result = await makeApi().listDevices('tok-9');

    expect(result.success).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-9');
  });

  it('maps a relay `device not found in this space` 404 to device_not_found', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ error: 'device not found in this space' }, 404));

    const result = await makeApi().revokeDevice('tok', 'other-space-device');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('device_not_found');
  });

  it('maps a bare 404 (unknown route) to relay_error, not device_not_found', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not_found' }, 404));

    const result = await makeApi().createSpace('main');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('relay_error');
    expect(result.error.status).toBe(404);
  });

  it('maps a non-JSON 404 (e.g. a web page, not the relay) to relay_error', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(
      new Response('<!DOCTYPE html><html><body>404</body></html>', { status: 404 })
    );

    const result = await makeApi().createSpace('main');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('relay_error');
    expect(result.error.status).toBe(404);
  });

  it('maps 401 with `invalid join secret` to invalid_join_secret', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid join secret' }, 401));

    const result = await makeApi().joinSpace('hash', 'space-id', 'name');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('invalid_join_secret');
  });

  it('maps any other 401 to unauthorized', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    const result = await makeApi().listDevices('revoked-token');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('unauthorized');
  });

  it('maps 5xx responses to relay_error with the status', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));

    const result = await makeApi().createSpace('main');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('relay_error');
    expect(result.error.status).toBe(503);
  });

  it('maps network failures to network_error', async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await makeApi().createSpace('main');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('network_error');
  });
});
