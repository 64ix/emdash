/**
 * EncryptingRelayTransport tests (spec #130, ticket #134): the decorator
 * turns plaintext bodies into versioned envelopes at push and back at pull,
 * never lets plaintext reach the inner transport, and flags (never throws)
 * patches that fail to decrypt so the engine can continue the pull.
 */
import { describe, expect, it, vi } from 'vitest';
import { decryptBody, encryptBody, keyIdOf, mintK0, parseEnvelope } from './crypto';
import { EncryptingRelayTransport, SyncSpaceKeyMissingError } from './encrypting-transport';
import { SpaceKeyStore } from './space-key-store';
import type {
  RelayTransport,
  SyncDeviceInfo,
  SyncJoinResult,
  SyncMutation,
  SyncPatch,
  SyncPullResult,
  SyncPushResult,
  SyncSpaceCreated,
} from './transport';

vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** In-memory stand-in for the safeStorage-backed secret store. */
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

interface FakeRow {
  version: number;
  client_version: number;
  body: string | null;
  deleted: boolean;
}

/** Records everything the decorator sends; serves patches verbatim. */
class FakeInnerTransport implements RelayTransport {
  readonly pushed: SyncMutation[][] = [];
  readonly rows = new Map<string, FakeRow>();
  private seq = 0;

  async createSpace(_name?: string): Promise<SyncSpaceCreated> {
    return { space_id: 's', device_id: 'd', device_token: 't', secret: 'x' };
  }

  async join(joinHash: string, spaceId: string, _name?: string): Promise<SyncJoinResult> {
    return { device_id: 'd2', device_token: 't2', space_id: spaceId };
  }

  async mintJoinSecret(joinHash: string): Promise<{ join_hash: string }> {
    return { join_hash: joinHash };
  }

  async listDevices(): Promise<{ devices: SyncDeviceInfo[] }> {
    return { devices: [] };
  }

  async revokeDevice(deviceId: string): Promise<{ device_id: string; revoked: boolean }> {
    return { device_id: deviceId, revoked: true };
  }

  async push(mutations: SyncMutation[]): Promise<SyncPushResult> {
    this.pushed.push(mutations);
    const results: SyncPushResult['results'] = [];
    for (const mutation of mutations) {
      this.seq += 1;
      this.rows.set(`${mutation.table}:${mutation.pk}`, {
        version: this.seq,
        client_version: mutation.client_version,
        body: mutation.body ?? null,
        deleted: mutation.op === 'delete',
      });
      results.push({ table: mutation.table, pk: mutation.pk, version: this.seq });
    }
    return { results };
  }

  async pull(cursor: number, _limit?: number): Promise<SyncPullResult> {
    const patches: SyncPatch[] = [];
    for (const [key, row] of this.rows) {
      if (row.version <= cursor) continue;
      const [table, ...pkParts] = key.split(':');
      patches.push({
        space: 's',
        table: table!,
        pk: pkParts.join(':'),
        version: row.version,
        client_version: row.client_version,
        op: row.deleted ? 'delete' : 'upsert',
        deleted: row.deleted,
        body: row.body,
      });
    }
    patches.sort((a, b) => a.version - b.version);
    return { cursor: patches.length > 0 ? patches[patches.length - 1]!.version : cursor, patches };
  }

  async poll(cursor: number, timeoutMs?: number): Promise<SyncPullResult> {
    return this.pull(cursor, timeoutMs);
  }
}

function makeKeys(k0 = mintK0()): { store: SpaceKeyStore; keyId: string; k0: Uint8Array } {
  const store = new SpaceKeyStore(new FakeSecretStore());
  void store.set(k0);
  return { store, keyId: keyIdOf(k0), k0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EncryptingRelayTransport', () => {
  it('encrypts upsert bodies into versioned envelopes before the inner transport', async () => {
    const inner = new FakeInnerTransport();
    const { store } = makeKeys();
    const transport = new EncryptingRelayTransport(inner, store);

    const plaintext = JSON.stringify({
      deviceId: 'a',
      columns: { name: 'Repo', secret: 's3cr3t' },
    });
    await transport.push([
      { table: 'projects', pk: 'p1', client_version: 0, body: plaintext, op: 'upsert' },
      { table: 'projects', pk: 'p2', client_version: 5, body: 'other', op: 'upsert' },
      { table: 'projects', pk: 'p1', client_version: 3, body: null, op: 'delete' },
    ]);

    expect(inner.pushed).toHaveLength(1);
    const [upsert1, upsert2, tombstone] = inner.pushed[0]!;
    // Deletes have no body: pass through untouched.
    expect(tombstone.body).toBeNull();
    // Upserts carry envelopes — never the plaintext.
    for (const mutation of [upsert1, upsert2]) {
      const envelope = parseEnvelope(mutation.body!);
      expect(envelope.success).toBe(true);
      if (envelope.success) {
        expect(envelope.data.alg).toBe('AES-256-GCM');
        expect(envelope.data.key_id.length).toBe(16);
      }
    }
    const wire = upsert1!.body!;
    expect(wire).not.toContain('Repo');
    expect(wire).not.toContain('s3cr3t');
    expect(wire).not.toContain('"columns"');
    // The client_version is forwarded so the decrypting side can bind it.
    expect(upsert2!.client_version).toBe(5);
  });

  it('fails the push with a clear error when no space key is stored', async () => {
    const inner = new FakeInnerTransport();
    const transport = new EncryptingRelayTransport(inner, new SpaceKeyStore(new FakeSecretStore()));

    await expect(
      transport.push([{ table: 't', pk: 'a', client_version: 0, body: 'x', op: 'upsert' }])
    ).rejects.toBeInstanceOf(SyncSpaceKeyMissingError);
    expect(inner.pushed).toHaveLength(0);
  });

  it('decrypts pulled envelopes back to the original plaintext bodies', async () => {
    const inner = new FakeInnerTransport();
    const { store, keyId, k0 } = makeKeys();
    const transport = new EncryptingRelayTransport(inner, store);

    const plaintext = JSON.stringify({ deviceId: 'a', columns: { name: 'Repo' } });
    // A pushes (encrypted) through the decorator...
    await transport.push([
      { table: 'projects', pk: 'p1', client_version: 0, body: plaintext, op: 'upsert' },
    ]);
    // ...and B pulls the envelope and decrypts it back to the same string.
    const pulled = await transport.pull(0);
    expect(pulled.patches).toHaveLength(1);
    expect(pulled.patches[0]!.body).toBe(plaintext);

    // The relay-side stored body is the envelope itself — never the
    // plaintext — and it decrypts with the shared key.
    const stored = inner.rows.get('projects:p1')?.body;
    expect(stored).not.toBe(plaintext);
    const envelope = parseEnvelope(stored!);
    expect(envelope.success).toBe(true);
    if (envelope.success) {
      expect(envelope.data.alg).toBe('AES-256-GCM');
      expect(envelope.data.key_id).toBe(keyId);
    }
    const decrypted = decryptBody(k0, { table: 'projects', pk: 'p1', version: 0, keyId }, stored!);
    expect(decrypted.success && decrypted.data).toBe(plaintext);
  });

  it('flags unknown-key_id patches and continues decrypting the rest', async () => {
    const inner = new FakeInnerTransport();
    const { store, keyId, k0 } = makeKeys();

    // Seed: one patch encrypted under the local key, one under a foreign key
    // (another machine rekeyed), one tampered.
    const local = encryptBody(k0, keyId, { table: 't', pk: 'a', version: 1, keyId }, 'good');
    const foreignK0 = mintK0();
    const foreignKeyId = keyIdOf(foreignK0);
    const foreign = encryptBody(
      foreignK0,
      foreignKeyId,
      { table: 't', pk: 'b', version: 1, keyId: foreignKeyId },
      'foreign'
    );
    const tamperedEnvelope = parseEnvelope(
      encryptBody(k0, keyId, { table: 't', pk: 'c', version: 1, keyId }, 'tampered')
    );
    if (!tamperedEnvelope.success) throw new Error('seed envelope did not parse');
    const bits = Buffer.from(tamperedEnvelope.data.ct, 'base64url');
    bits[0] = bits[0]! ^ 1;
    const tampered = JSON.stringify({ ...tamperedEnvelope.data, ct: bits.toString('base64url') });

    inner.rows.set('t:a', { version: 1, client_version: 1, body: local, deleted: false });
    inner.rows.set('t:b', { version: 2, client_version: 1, body: foreign, deleted: false });
    inner.rows.set('t:c', { version: 3, client_version: 1, body: tampered, deleted: false });

    const transport = new EncryptingRelayTransport(inner, store);
    const result = await transport.pull(0);

    expect(result.patches).toHaveLength(3);
    const good = result.patches.find((p) => p.pk === 'a');
    const unknown = result.patches.find((p) => p.pk === 'b');
    const tamperedPatch = result.patches.find((p) => p.pk === 'c');
    expect(good?.body).toBe('good');
    expect(good?.decryptError).toBeUndefined();
    expect(unknown?.decryptError).toContain('key');
    expect(tamperedPatch?.decryptError).toContain('authenticat');
  });

  it('flags every body-carrying patch when no space key is stored', async () => {
    const inner = new FakeInnerTransport();
    inner.rows.set('t:a', { version: 1, client_version: 0, body: '{"enc":1}', deleted: false });
    inner.rows.set('t:b', { version: 2, client_version: 0, body: null, deleted: true });

    const transport = new EncryptingRelayTransport(inner, new SpaceKeyStore(new FakeSecretStore()));
    const result = await transport.pull(0);

    const upsert = result.patches.find((p) => p.pk === 'a');
    const tombstone = result.patches.find((p) => p.pk === 'b');
    expect(upsert?.decryptError).toContain('key');
    expect(upsert?.body).toBe('{"enc":1}');
    // Tombstones carry no body and are never flagged.
    expect(tombstone?.decryptError).toBeUndefined();
  });

  it('decrypts on poll like on pull', async () => {
    const inner = new FakeInnerTransport();
    const { store } = makeKeys();
    const transport = new EncryptingRelayTransport(inner, store);
    await transport.push([
      { table: 't', pk: 'a', client_version: 0, body: 'polled', op: 'upsert' },
    ]);

    const result = await transport.poll(0);
    expect(result.patches[0]?.body).toBe('polled');
  });

  it('passes pairing methods through unencrypted', async () => {
    const inner = new FakeInnerTransport();
    const { store } = makeKeys();
    const transport = new EncryptingRelayTransport(inner, store);

    const created = await transport.createSpace('main');
    expect(created.secret).toBe('x');
    const joined = await transport.join('cred', 'space-1', 'laptop');
    expect(joined.space_id).toBe('space-1');
    const minted = await transport.mintJoinSecret('digest');
    expect(minted.join_hash).toBe('digest');
    expect((await transport.listDevices()).devices).toEqual([]);
    expect((await transport.revokeDevice('d')).revoked).toBe(true);
  });
});
