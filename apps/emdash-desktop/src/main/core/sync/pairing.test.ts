import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { JOIN_SECRET_PREFIX, userFacingPairingMessage } from '@shared/core/sync/pairing';
import type { RelayApiError, RelayAuthApi, RelayDeviceInfo, RelayJoinResult } from './auth-api';
import { deriveJoinHash, joinDeepLink, PairingService } from './pairing';
import { SyncCredentialsStore } from './sync-credentials';

// `pairing.ts` logs through the main-process logger, whose import chain pulls
// in `electron` (unavailable in plain-Node tests) — mock it like other
// main-core node tests do. The device-identity import chain also reaches
// `@main/db/client` (and from there `electron`); the tests inject a fake
// identity, so the mock is never used at runtime.
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@main/db/client', () => ({
  get db() {
    throw new Error('no db in pairing node tests');
  },
}));

// ---------------------------------------------------------------------------
// In-memory doubles
// ---------------------------------------------------------------------------

/** In-memory stand-in for the safeStorage-backed `app_secrets` store. */
class FakeSecretStore {
  values = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setSecret(key: string, secret: string): Promise<void> {
    this.values.set(key, secret);
  }

  async deleteSecret(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/**
 * A fake `RelayAuthApi` that implements the relay's pairing semantics from
 * apps/sync-relay/src/service.ts: secrets are matched by SHA-256 of the full
 * credential, are single-use, TTL-bounded (15 min), and attempt-limited (5);
 * tokens are scoped to one space and revoked tokens are refused. `now` is
 * injectable so tests can expire secrets deterministically.
 */
class FakeRelayAuthApi implements RelayAuthApi {
  readonly ttlMs = 15 * 60_000;
  readonly maxAttempts = 5;

  constructor(private now = 1_800_000_000_000) {}

  /** Errors forced on the next call of each kind (undefined = behave normally). */
  forced: Partial<
    Record<
      'createSpace' | 'joinSpace' | 'mintSecret' | 'listDevices' | 'revokeDevice',
      RelayApiError
    >
  > = {};

  /** Counts of calls, for asserting the client used the stored bearer token. */
  calls: Record<
    'createSpace' | 'joinSpace' | 'mintSecret' | 'listDevices' | 'revokeDevice',
    number
  > = { createSpace: 0, joinSpace: 0, mintSecret: 0, listDevices: 0, revokeDevice: 0 };

  /** Devices by id: token, space, name, revoked. */
  readonly devices = new Map<
    string,
    { token: string; spaceId: string; name: string; revoked: boolean }
  >();

  /** Pending secrets by raw secret string. */
  readonly pendingSecrets = new Map<
    string,
    { spaceId: string; attemptsLeft: number; used: boolean; expiresAt: number }
  >();

  private seq = 0;

  private makeId(length: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += alphabet[this.seq++ % alphabet.length];
    }
    return out;
  }

  private sha256Hex(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  private makeToken(): string {
    return `emdv1_${this.makeId(43)}_${this.makeId(6)}`;
  }

  private registerDevice(spaceId: string, name: string): RelayJoinResult {
    const token = this.makeToken();
    const deviceId = this.makeId(16);
    this.devices.set(deviceId, { token, spaceId, name, revoked: false });
    return { deviceId, deviceToken: token };
  }

  private authenticate(token: string): { spaceId: string } | null {
    for (const device of this.devices.values()) {
      if (device.token === token) {
        if (device.revoked) return null;
        return { spaceId: device.spaceId };
      }
    }
    return null;
  }

  private mintSecretFor(spaceId: string): string {
    const secret = `emdj1_${spaceId}_${this.makeId(22)}_${this.makeId(6)}`;
    this.pendingSecrets.set(secret, {
      spaceId,
      attemptsLeft: this.maxAttempts,
      used: false,
      expiresAt: this.now + this.ttlMs,
    });
    return secret;
  }

  async createSpace(name: string): Promise<Result<RelaySpaceCreated, RelayApiError>> {
    this.calls.createSpace += 1;
    const forced = this.forced.createSpace;
    if (forced) return err(forced);
    const spaceId = this.makeId(22);
    const secret = this.mintSecretFor(spaceId);
    const device = this.registerDevice(spaceId, name);
    return ok({ spaceId, deviceId: device.deviceId, deviceToken: device.deviceToken, secret });
  }

  async joinSpace(joinHash: string, name: string): Promise<Result<RelayJoinResult, RelayApiError>> {
    this.calls.joinSpace += 1;
    const forced = this.forced.joinSpace;
    if (forced) return err(forced);

    // The real relay matches the presented hash against stored digests of the
    // pending secrets — the join only succeeds if the client derived the
    // exact same hash the relay would compute.
    let matched: string | null = null;
    for (const [secret, _pending] of this.pendingSecrets) {
      if (this.sha256Hex(secret) === joinHash) {
        matched = secret;
        break;
      }
    }
    if (matched === null) {
      return err({ type: 'invalid_join_secret', message: 'invalid join secret' });
    }
    const pending = this.pendingSecrets.get(matched)!;
    const stale = pending.used || pending.attemptsLeft <= 0 || pending.expiresAt <= this.now;
    if (stale) {
      this.pendingSecrets.delete(matched);
      return err({ type: 'invalid_join_secret', message: 'invalid join secret' });
    }
    pending.used = true;
    const device = this.registerDevice(pending.spaceId, name);
    return ok({ deviceId: device.deviceId, deviceToken: device.deviceToken });
  }

  async mintJoinSecret(token: string): Promise<Result<{ secret: string }, RelayApiError>> {
    this.calls.mintSecret += 1;
    const forced = this.forced.mintSecret;
    if (forced) return err(forced);
    const auth = this.authenticate(token);
    if (auth === null) {
      return err({ type: 'unauthorized', message: 'unauthorized' });
    }
    return ok({ secret: this.mintSecretFor(auth.spaceId) });
  }

  async listDevices(token: string): Promise<Result<RelayDeviceInfo[], RelayApiError>> {
    this.calls.listDevices += 1;
    const forced = this.forced.listDevices;
    if (forced) return err(forced);
    const auth = this.authenticate(token);
    if (auth === null) {
      return err({ type: 'unauthorized', message: 'unauthorized' });
    }
    const devices: RelayDeviceInfo[] = [];
    for (const [deviceId, device] of this.devices) {
      if (device.spaceId !== auth.spaceId) continue;
      devices.push({
        deviceId,
        name: device.name,
        createdAt: 0,
        lastSeenAt: null,
        revoked: device.revoked,
        revokedAt: null,
        self: device.token === token,
      });
    }
    return ok(devices);
  }

  async revokeDevice(token: string, deviceId: string): Promise<Result<void, RelayApiError>> {
    this.calls.revokeDevice += 1;
    const forced = this.forced.revokeDevice;
    if (forced) return err(forced);
    const auth = this.authenticate(token);
    if (auth === null) {
      return err({ type: 'unauthorized', message: 'unauthorized' });
    }
    const device = this.devices.get(deviceId);
    if (device === undefined || device.spaceId !== auth.spaceId) {
      return err({ type: 'device_not_found', message: 'device not found in this space' });
    }
    device.revoked = true;
    return ok();
  }
}

type RelaySpaceCreated = {
  spaceId: string;
  deviceId: string;
  deviceToken: string;
  secret: string;
};

function makeService(api: FakeRelayAuthApi, store: FakeSecretStore): PairingService {
  return new PairingService(api, new SyncCredentialsStore(store), async () => ({
    deviceId: 'test-device-uuid-0000',
    deviceName: 'test-host',
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PairingService', () => {
  it('createSpace stores the device token machine-locally and returns a deep link', async () => {
    const api = new FakeRelayAuthApi();
    const store = new FakeSecretStore();
    const service = makeService(api, store);

    const result = await service.createSpace('office-mac');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    expect(result.data.deepLink).toBe(
      `emdash://join?secret=${encodeURIComponent(result.data.secret)}`
    );

    const credential = await new SyncCredentialsStore(store).get();
    expect(credential.success && credential.data?.token).toBeTruthy();
    if (!credential.success || credential.data === null) return;
    expect(credential.data.spaceId).toBe(result.data.spaceId);

    const state = await service.getState();
    expect(state.success).toBe(true);
    if (!state.success) return;
    expect(state.data).toEqual({
      paired: true,
      spaceId: result.data.spaceId,
      deviceName: 'office-mac',
    });
  });

  it('joinSpace derives the join hash from the minted secret and stores the issued token', async () => {
    const api = new FakeRelayAuthApi();
    const created = await makeService(api, new FakeSecretStore()).createSpace('first-machine');
    if (!created.success) throw new Error('create failed');

    const secondStore = new FakeSecretStore();
    const joined = await makeService(api, secondStore).joinSpace(
      created.data.secret,
      'second-machine'
    );

    expect(joined.success).toBe(true);
    if (!joined.success) return;
    expect(joined.data.spaceId).toBe(created.data.spaceId);
    // The fake relay only matches against sha256 of the minted secret — the
    // join succeeded, so the client derivation matches the relay's.
    const stored = await new SyncCredentialsStore(secondStore).get();
    expect(stored.success && stored.data?.spaceId).toBe(created.data.spaceId);
    expect(api.calls.joinSpace).toBe(1);
  });

  it('rejects a single-use secret on the second join', async () => {
    const api = new FakeRelayAuthApi();
    const created = await makeService(api, new FakeSecretStore()).createSpace('first');
    if (!created.success) throw new Error('create failed');

    const service = makeService(api, new FakeSecretStore());
    const firstJoin = await service.joinSpace(created.data.secret, 'second');
    expect(firstJoin.success).toBe(true);

    const secondJoin = await service.joinSpace(created.data.secret, 'third');
    expect(secondJoin.success).toBe(false);
    if (secondJoin.success) return;
    expect(secondJoin.error.code).toBe('invalid_join_secret');
    expect(secondJoin.error.message).toBe(userFacingPairingMessage('invalid_join_secret'));
  });

  it('rejects an expired secret with the same clear message (TTL)', async () => {
    const now = 1_800_000_000_000;
    const api = new FakeRelayAuthApi(now);
    const created = await makeService(api, new FakeSecretStore()).createSpace('first');
    if (!created.success) throw new Error('create failed');

    // A second relay view of the same space, after the TTL elapsed.
    const expiredApi = new FakeRelayAuthApi(now + api.ttlMs + 1);
    for (const [secret, pending] of api.pendingSecrets) {
      expiredApi.pendingSecrets.set(secret, { ...pending });
    }
    const join = await makeService(expiredApi, new FakeSecretStore()).joinSpace(
      created.data.secret,
      'second'
    );
    expect(join.success).toBe(false);
    if (join.success) return;
    expect(join.error.code).toBe('invalid_join_secret');
    expect(join.error.message).toBe(userFacingPairingMessage('invalid_join_secret'));
  });

  it('rejects a secret whose attempt budget is exhausted', async () => {
    const api = new FakeRelayAuthApi();
    const created = await makeService(api, new FakeSecretStore()).createSpace('first');
    if (!created.success) throw new Error('create failed');

    const pending = api.pendingSecrets.get(created.data.secret)!;
    pending.attemptsLeft = 0;

    const join = await makeService(api, new FakeSecretStore()).joinSpace(
      created.data.secret,
      'second'
    );
    expect(join.success).toBe(false);
    if (join.success) return;
    expect(join.error.code).toBe('invalid_join_secret');
  });

  it('rejects a malformed secret locally without calling the relay', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());

    const join = await service.joinSpace('emdv1_some-token-not-a-secret', 'second');
    expect(join.success).toBe(false);
    if (join.success) return;
    expect(join.error.code).toBe('invalid_secret_format');
    expect(api.calls.joinSpace).toBe(0);
  });

  it('mints a fresh secret with the stored token, usable by a second device', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());
    const created = await service.createSpace('first');
    if (!created.success) throw new Error('create failed');

    const minted = await service.mintSecret();
    expect(minted.success).toBe(true);
    if (!minted.success) return;
    expect(minted.data.secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    expect(minted.data.secret).not.toBe(created.data.secret);
    expect(minted.data.deepLink).toBe(
      `emdash://join?secret=${encodeURIComponent(minted.data.secret)}`
    );
    expect(api.calls.mintSecret).toBe(1);

    const joined = await makeService(api, new FakeSecretStore()).joinSpace(
      minted.data.secret,
      'second'
    );
    expect(joined.success).toBe(true);
  });

  it('fails with not_paired when no token is stored, without calling the relay', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());

    const minted = await service.mintSecret();
    expect(minted.success).toBe(false);
    if (minted.success) return;
    expect(minted.error.code).toBe('not_paired');
    expect(api.calls.mintSecret).toBe(0);

    const devices = await service.listDevices();
    expect(devices.success).toBe(false);
    if (devices.success) return;
    expect(devices.error.code).toBe('not_paired');
    expect(api.calls.listDevices).toBe(0);
  });

  it('lists devices including the self flag', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());
    await service.createSpace('first');

    const second = await makeService(api, new FakeSecretStore()).joinSpace(
      [...api.pendingSecrets.keys()][0]!,
      'second'
    );
    expect(second.success).toBe(true);

    const listed = await service.listDevices();
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data).toHaveLength(2);
    const self = listed.data.find((device) => device.self);
    expect(self?.name).toBe('first');
    const other = listed.data.find((device) => !device.self);
    expect(other?.name).toBe('second');
  });

  it('revokes a device by id with the stored token and maps unknown devices', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());
    await service.createSpace('first');

    const secondService = makeService(api, new FakeSecretStore());
    const joined = await secondService.joinSpace([...api.pendingSecrets.keys()][0]!, 'second');
    if (!joined.success) throw new Error('join failed');

    const missing = await service.revokeDevice('no-such-device');
    expect(missing.success).toBe(false);
    if (missing.success) return;
    expect(missing.error.code).toBe('device_not_found');
    expect(missing.error.message).toBe(userFacingPairingMessage('device_not_found'));

    const listed = await service.listDevices();
    if (!listed.success) throw new Error('list failed');
    const secondDevice = listed.data.find((device) => device.name === 'second')!;
    const okRevoke = await service.revokeDevice(secondDevice.deviceId);
    expect(okRevoke.success).toBe(true);

    const relisted = await service.listDevices();
    if (!relisted.success) throw new Error('relist failed');
    expect(relisted.data.find((device) => device.name === 'second')?.revoked).toBe(true);
  });

  it('maps relay unauthorized to a clear user-facing message after self-revocation', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());
    await service.createSpace('first');

    const listed = await service.listDevices();
    if (!listed.success) throw new Error('list failed');
    const self = listed.data.find((device) => device.self)!;
    await service.revokeDevice(self.deviceId);

    const after = await service.listDevices();
    expect(after.success).toBe(false);
    if (after.success) return;
    expect(after.error.code).toBe('unauthorized');
    expect(after.error.message).toBe(userFacingPairingMessage('unauthorized'));
  });

  it('maps relay 4xx JSON errors to typed failures, never raw JSON', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());

    api.forced.createSpace = { type: 'relay_error', status: 503, message: 'boom' };
    const created = await service.createSpace('first');
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error.code).toBe('relay_error');
    expect(created.error.status).toBe(503);
    expect(created.error.message).toBe(userFacingPairingMessage('relay_error', 503));
    expect(created.error.message).not.toContain('boom');

    api.forced.createSpace = { type: 'network_error', message: 'fetch failed' };
    const network = await service.createSpace('first');
    expect(network.success).toBe(false);
    if (network.success) return;
    expect(network.error.code).toBe('network_error');
    expect(network.error.message).toBe(userFacingPairingMessage('network_error'));
    expect(network.error.message).not.toContain('fetch failed');
  });
});

describe('joinDeepLink', () => {
  it('builds an emdash://join URL carrying the full secret', () => {
    const secret = 'emdj1_AB12-34_CD56-78_-aBcDeF';
    const link = joinDeepLink(secret);
    expect(link.startsWith('emdash://join?secret=')).toBe(true);
    expect(decodeURIComponent(link.slice('emdash://join?secret='.length))).toBe(secret);
  });

  it('derives the same join hash for the encoded deep-link value', () => {
    const secret = 'emdj1_AB12-34_CD56-78_-aBcDeF';
    const rawValue = joinDeepLink(secret).split('?secret=')[1]!;
    expect(deriveJoinHash(decodeURIComponent(rawValue))).toBe(deriveJoinHash(secret));
  });
});
