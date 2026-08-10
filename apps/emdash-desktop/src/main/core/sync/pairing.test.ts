import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { JOIN_SECRET_PREFIX, userFacingPairingMessage } from '@shared/core/sync/pairing';
import type { RelayApiError, RelayAuthApi, RelayDeviceInfo, RelayJoinResult } from './auth-api';
import {
  composeSpaceSecret,
  joinCredentialOf,
  keyIdOf,
  mintJoinHalf,
  mintK0,
  parseSpaceSecret,
} from './crypto';
import { joinDeepLink, PairingService } from './pairing';
import { SpaceKeyStore } from './space-key-store';
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
 * A fake `RelayAuthApi` implementing the relay's pairing semantics from
 * apps/sync-relay/src/service.ts (spec #130, ticket #134): pairing secrets
 * are two-half (`emdj1_<space>_<join b32>_<k0 b32>`), the relay stores only
 * the SHA-256 of the join credential, join presents the credential + space
 * id, and the join-secret endpoint registers a client-minted digest.
 * Secrets are single-use, TTL-bounded (15 min), and attempt-limited (5).
 * `now` is injectable so tests can expire secrets deterministically.
 */
class FakeRelayAuthApi implements RelayAuthApi {
  readonly ttlMs = 15 * 60_000;
  readonly maxAttempts = 5;

  constructor(private now = 1_800_000_000_000) {}

  /** Errors forced on the next call of each kind (undefined = behave normally). */
  forced: Partial<
    Record<
      'createSpace' | 'joinSpace' | 'mintSecret' | 'listDevices' | 'revokeDevice' | 'deleteSpace',
      RelayApiError
    >
  > = {};

  /** Counts of calls, for asserting the client used the stored bearer token. */
  calls: Record<
    'createSpace' | 'joinSpace' | 'mintSecret' | 'listDevices' | 'revokeDevice' | 'deleteSpace',
    number
  > = {
    createSpace: 0,
    joinSpace: 0,
    mintSecret: 0,
    listDevices: 0,
    revokeDevice: 0,
    deleteSpace: 0,
  };

  /** Devices by id: token, space, name, revoked. */
  readonly devices = new Map<
    string,
    { token: string; spaceId: string; name: string; revoked: boolean }
  >();

  /** Pending join credentials per space, keyed by their sha256 hex digest. */
  readonly pendingSecrets = new Map<
    string,
    Map<string, { attemptsLeft: number; used: boolean; expiresAt: number }>
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
    return { deviceId, deviceToken: token, spaceId };
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

  /** Registers a client-minted join credential for a space, relay-style. */
  private registerCredential(spaceId: string, credential: string): void {
    const digest = this.sha256Hex(credential);
    const pending = this.pendingSecrets.get(spaceId) ?? new Map();
    pending.set(digest, {
      attemptsLeft: this.maxAttempts,
      used: false,
      expiresAt: this.now + this.ttlMs,
    });
    this.pendingSecrets.set(spaceId, pending);
  }

  /** Composes a fresh two-half secret for a space (as the creating device's client does). */
  private mintSecretFor(spaceId: string): string {
    const secret = composeSpaceSecret(spaceId, mintJoinHalf(), mintK0());
    const parts = parseSpaceSecret(secret)!;
    this.registerCredential(spaceId, joinCredentialOf(parts.joinHalf));
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

  async joinSpace(
    joinHash: string,
    spaceId: string,
    name: string
  ): Promise<Result<RelayJoinResult, RelayApiError>> {
    this.calls.joinSpace += 1;
    const forced = this.forced.joinSpace;
    if (forced) return err(forced);

    // The real relay (service.ts `join`) hashes the presented credential and
    // compares against the stored digests of the named space.
    const presentedSha = this.sha256Hex(joinHash);
    const pending = this.pendingSecrets.get(spaceId);
    const matched = pending?.get(presentedSha) ?? null;
    if (matched === null) {
      // Charge the oldest pending credential of the space, like the relay.
      if (pending !== undefined) {
        const oldest = pending.values().next().value;
        if (oldest !== undefined) {
          oldest.attemptsLeft -= 1;
          if (oldest.attemptsLeft <= 0) pending.delete([...pending.keys()][0]!);
        }
      }
      return err({ type: 'invalid_join_secret', message: 'invalid join secret' });
    }
    const stale = matched.used || matched.attemptsLeft <= 0 || matched.expiresAt <= this.now;
    if (stale) {
      pending!.delete(presentedSha);
      return err({ type: 'invalid_join_secret', message: 'invalid join secret' });
    }
    matched.used = true;
    const device = this.registerDevice(spaceId, name);
    return ok({ deviceId: device.deviceId, deviceToken: device.deviceToken, spaceId });
  }

  async mintJoinSecret(
    token: string,
    joinHash: string
  ): Promise<Result<{ join_hash: string }, RelayApiError>> {
    this.calls.mintSecret += 1;
    const forced = this.forced.mintSecret;
    if (forced) return err(forced);
    const auth = this.authenticate(token);
    if (auth === null) {
      return err({ type: 'unauthorized', message: 'unauthorized' });
    }
    // The digest was computed client-side; the relay stores it verbatim.
    const pending = this.pendingSecrets.get(auth.spaceId) ?? new Map();
    pending.set(joinHash, {
      attemptsLeft: this.maxAttempts,
      used: false,
      expiresAt: this.now + this.ttlMs,
    });
    this.pendingSecrets.set(auth.spaceId, pending);
    return ok({ join_hash: joinHash });
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

  /** Mirrors the relay's `deleteSpace`: wipes every device + pending secret of the space. */
  async deleteSpace(token: string): Promise<Result<void, RelayApiError>> {
    this.calls.deleteSpace += 1;
    const forced = this.forced.deleteSpace;
    if (forced) return err(forced);
    const auth = this.authenticate(token);
    if (auth === null) {
      return err({ type: 'unauthorized', message: 'unauthorized' });
    }
    for (const [deviceId, device] of this.devices) {
      if (device.spaceId === auth.spaceId) this.devices.delete(deviceId);
    }
    this.pendingSecrets.delete(auth.spaceId);
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
  return new PairingService(
    api,
    new SyncCredentialsStore(store),
    new SpaceKeyStore(store),
    async () => ({
      deviceId: 'test-device-uuid-0000',
      deviceName: 'test-host',
    })
  );
}

async function storedKeyId(store: FakeSecretStore): Promise<string | null> {
  const key = await new SpaceKeyStore(store).get();
  return key.success && key.data !== null ? key.data.keyId : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PairingService', () => {
  it('createSpace stores the device token and the space key, and returns a deep link', async () => {
    const api = new FakeRelayAuthApi();
    const store = new FakeSecretStore();
    const service = makeService(api, store);

    const result = await service.createSpace('office-mac');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    // Two-half format: emdj1_<space>_<join b32>_<k0 b32>.
    expect(result.data.secret).toMatch(/^emdj1_[A-Za-z0-9_-]{22}_[a-z2-7]{26}_[a-z2-7]{52}$/);
    expect(result.data.deepLink).toBe(
      `emdash://join?secret=${encodeURIComponent(result.data.secret)}`
    );

    const credential = await new SyncCredentialsStore(store).get();
    expect(credential.success && credential.data?.token).toBeTruthy();
    if (!credential.success || credential.data === null) return;
    expect(credential.data.spaceId).toBe(result.data.spaceId);

    // The space key (K0) is stored and its key id derives from the secret.
    const keyId = await storedKeyId(store);
    const parts = parseSpaceSecret(result.data.secret);
    expect(keyId).toBe(parts !== null ? keyIdOf(parts.k0) : null);

    const state = await service.getState();
    expect(state.success).toBe(true);
    if (!state.success) return;
    expect(state.data).toEqual({
      paired: true,
      spaceId: result.data.spaceId,
      deviceName: 'office-mac',
    });
  });

  it('joinSpace derives the join credential and K0 from the secret; both machines share K0', async () => {
    const api = new FakeRelayAuthApi();
    const firstStore = new FakeSecretStore();
    const created = await makeService(api, firstStore).createSpace('first-machine');
    if (!created.success) throw new Error('create failed');

    const secondStore = new FakeSecretStore();
    const joined = await makeService(api, secondStore).joinSpace(
      created.data.secret,
      'second-machine'
    );

    expect(joined.success).toBe(true);
    if (!joined.success) return;
    expect(joined.data.spaceId).toBe(created.data.spaceId);
    // The fake relay only matches against sha256 of the join credential —
    // the join succeeded, so the client derivation matches the relay's.
    const stored = await new SyncCredentialsStore(secondStore).get();
    expect(stored.success && stored.data?.spaceId).toBe(created.data.spaceId);
    expect(api.calls.joinSpace).toBe(1);

    // Two-client K0 invariant: machine B derived the IDENTICAL key from the
    // pasted secret (same key_id as machine A, which got K0 from the relay).
    expect(await storedKeyId(secondStore)).toBe(await storedKeyId(firstStore));
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

  it('refuses to join a different space while already paired (no silent overwrite)', async () => {
    const api = new FakeRelayAuthApi();
    const spaceA = await makeService(api, new FakeSecretStore()).createSpace('a');
    const spaceB = await makeService(api, new FakeSecretStore()).createSpace('b');
    if (!spaceA.success || !spaceB.success) throw new Error('create failed');

    const machine = makeService(api, new FakeSecretStore());
    expect((await machine.joinSpace(spaceA.data.secret, 'm')).success).toBe(true);
    const joinsBefore = api.calls.joinSpace;

    const cross = await machine.joinSpace(spaceB.data.secret, 'm');
    expect(cross.success).toBe(false);
    if (cross.success) return;
    expect(cross.error.code).toBe('already_paired');
    // The guard runs before touching the relay — no join attempt is made.
    expect(api.calls.joinSpace).toBe(joinsBefore);
  });

  it('rejects an expired secret with the same clear message (TTL)', async () => {
    const now = 1_800_000_000_000;
    const api = new FakeRelayAuthApi(now);
    const created = await makeService(api, new FakeSecretStore()).createSpace('first');
    if (!created.success) throw new Error('create failed');

    // A second relay view of the same space, after the TTL elapsed.
    const expiredApi = new FakeRelayAuthApi(now + api.ttlMs + 1);
    for (const [spaceId, pending] of api.pendingSecrets) {
      expiredApi.pendingSecrets.set(spaceId, new Map(pending));
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

    const pending = [...api.pendingSecrets.get(created.data.spaceId)!.values()][0]!;
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

  it('mints a secret client-side: a second device joins while K0 stays identical', async () => {
    const api = new FakeRelayAuthApi();
    const store = new FakeSecretStore();
    const service = makeService(api, store);
    const created = await service.createSpace('first');
    if (!created.success) throw new Error('create failed');
    const keyIdBefore = await storedKeyId(store);
    expect(keyIdBefore).not.toBeNull();

    const minted = await service.mintSecret();
    expect(minted.success).toBe(true);
    if (!minted.success) return;
    expect(minted.data.secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    expect(minted.data.secret).not.toBe(created.data.secret);
    expect(minted.data.deepLink).toBe(
      `emdash://join?secret=${encodeURIComponent(minted.data.secret)}`
    );
    expect(api.calls.mintSecret).toBe(1);

    // The spec's "add another device later" story: the minted secret joins
    // successfully, and the minting machine's K0 is unchanged.
    const joined = await makeService(api, new FakeSecretStore()).joinSpace(
      minted.data.secret,
      'second'
    );
    expect(joined.success).toBe(true);
    expect(await storedKeyId(store)).toBe(keyIdBefore);
  });

  it('fails with not_paired when no token or no key is stored, without calling the relay', async () => {
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

    const deleted = await service.deleteSpace();
    expect(deleted.success).toBe(false);
    if (deleted.success) return;
    expect(deleted.error.code).toBe('not_paired');
    expect(api.calls.deleteSpace).toBe(0);
  });

  it('lists devices including the self flag', async () => {
    const api = new FakeRelayAuthApi();
    const service = makeService(api, new FakeSecretStore());
    const created = await service.createSpace('first');
    if (!created.success) throw new Error('create failed');

    const joined = await makeService(api, new FakeSecretStore()).joinSpace(
      created.data.secret,
      'second'
    );
    expect(joined.success).toBe(true);

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
    const created = await service.createSpace('first');
    if (!created.success) throw new Error('create failed');

    const secondService = makeService(api, new FakeSecretStore());
    const joined = await secondService.joinSpace(created.data.secret, 'second');
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

  it('deleteSpace deletes the relay space, then clears the local credential and space key', async () => {
    const api = new FakeRelayAuthApi();
    const store = new FakeSecretStore();
    const service = makeService(api, store);
    const created = await service.createSpace('first');
    if (!created.success) throw new Error('create failed');
    expect(await storedKeyId(store)).not.toBeNull();

    const deleted = await service.deleteSpace();
    expect(deleted.success).toBe(true);
    expect(api.calls.deleteSpace).toBe(1);

    // Local credential and space key are both gone: the machine is un-paired.
    const credential = await new SyncCredentialsStore(store).get();
    expect(credential.success && credential.data).toBeNull();
    expect(await storedKeyId(store)).toBeNull();

    const state = await service.getState();
    expect(state.success).toBe(true);
    if (!state.success) return;
    expect(state.data).toEqual({ paired: false, spaceId: null, deviceName: null });
  });

  it('deleteSpace leaves the local credential and space key intact when the relay call fails', async () => {
    const api = new FakeRelayAuthApi();
    const store = new FakeSecretStore();
    const service = makeService(api, store);
    const created = await service.createSpace('first');
    if (!created.success) throw new Error('create failed');
    const keyIdBefore = await storedKeyId(store);

    api.forced.deleteSpace = { type: 'network_error', message: 'fetch failed' };
    const deleted = await service.deleteSpace();
    expect(deleted.success).toBe(false);
    if (deleted.success) return;
    expect(deleted.error.code).toBe('network_error');

    // Nothing was cleared locally: the machine can retry the delete.
    const credential = await new SyncCredentialsStore(store).get();
    expect(credential.success && credential.data?.spaceId).toBe(created.data.spaceId);
    expect(await storedKeyId(store)).toBe(keyIdBefore);
  });
});

describe('joinDeepLink', () => {
  it('builds an emdash://join URL carrying the full secret', () => {
    const secret = composeSpaceSecret('AB12-34_CD56-78_EF90-1', mintJoinHalf(), mintK0());
    const link = joinDeepLink(secret);
    expect(link.startsWith('emdash://join?secret=')).toBe(true);
    expect(decodeURIComponent(link.slice('emdash://join?secret='.length))).toBe(secret);
  });

  it('parses the encoded deep-link value into the same halves', () => {
    const secret = composeSpaceSecret('AB12-34_CD56-78_EF90-1', mintJoinHalf(), mintK0());
    const rawValue = joinDeepLink(secret).split('?secret=')[1]!;
    const fromLink = parseSpaceSecret(decodeURIComponent(rawValue));
    const direct = parseSpaceSecret(secret);
    expect(fromLink).not.toBeNull();
    expect(fromLink?.spaceId).toBe(direct?.spaceId);
    expect(Buffer.from(fromLink!.k0).equals(Buffer.from(direct!.k0))).toBe(true);
  });
});
