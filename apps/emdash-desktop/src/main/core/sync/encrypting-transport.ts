/**
 * End-to-end encryption decorator over the sync transport (spec #130, ticket
 * #134).
 *
 * Wraps any `RelayTransport` so that row bodies are AES-256-GCM encrypted
 * before they leave the machine and decrypted on pull. The engine stays
 * crypto-free: it pushes and pulls plaintext JSON bodies through this
 * wrapper, which swaps them for versioned envelopes (`{alg, key_id, nonce,
 * ct}`, see crypto.ts). The relay only ever sees plaintext metadata plus the
 * envelope string.
 *
 * Decryption failures (unknown key_id after a rekey, tampered envelopes,
 * AAD mismatches from relay row/version swaps) never throw: the affected
 * patch is flagged with `decryptError` and the pull continues. The engine
 * records the patch's version and counts it in `skippedUndecryptable`.
 *
 * The wrapper needs the space key (K0 + key_id) from `SpaceKeyStore`; when
 * no key is stored, pushes fail with a clear error and pulls flag every
 * body-carrying patch as undecryptable instead of wedging.
 *
 * The AAD also binds `spaceId` (spec #130 anti-replay hardening): the
 * caller's OWN paired space id is used, never the `space` field a pulled
 * patch carries — a patch's `space` is relay-supplied metadata, exactly like
 * its `key_id`, and using it to build the very AAD that is supposed to
 * authenticate that metadata would defeat the check. A body encrypted for
 * one space and replayed into another therefore fails decryption even if
 * every other AAD field happens to line up.
 */
import { log } from '@main/lib/logger';
import { decryptBody, encryptBody, type SyncCryptoError } from './crypto';
import type { SpaceKey, SpaceKeyStore } from './space-key-store';
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

export class SyncSpaceKeyMissingError extends Error {
  constructor() {
    super('The sync space encryption key is not stored on this machine.');
    this.name = 'SyncSpaceKeyMissingError';
  }
}

/** The minimal key surface the decorator needs (SpaceKeyStore satisfies it). */
export type SpaceKeyReader = Pick<SpaceKeyStore, 'get'>;

export class EncryptingRelayTransport implements RelayTransport {
  constructor(
    private readonly inner: RelayTransport,
    private readonly keys: SpaceKeyReader,
    /** This machine's own paired space id, bound into every AAD. */
    private readonly spaceId: string
  ) {}

  async createSpace(name?: string): Promise<SyncSpaceCreated> {
    return this.inner.createSpace(name);
  }

  async join(joinHash: string, spaceId: string, name?: string): Promise<SyncJoinResult> {
    return this.inner.join(joinHash, spaceId, name);
  }

  async mintJoinSecret(joinHash: string): Promise<{ join_hash: string }> {
    return this.inner.mintJoinSecret(joinHash);
  }

  async listDevices(): Promise<{ devices: SyncDeviceInfo[] }> {
    return this.inner.listDevices();
  }

  async revokeDevice(deviceId: string): Promise<{ device_id: string; revoked: boolean }> {
    return this.inner.revokeDevice(deviceId);
  }

  /** Encrypts every body-carrying mutation before handing it to the inner transport. */
  async push(mutations: SyncMutation[]): Promise<SyncPushResult> {
    const key = await this.requireKey();
    const encrypted = mutations.map((mutation) => {
      if (mutation.body === null || mutation.body === undefined) {
        return mutation;
      }
      const version = mutation.client_version ?? 0;
      return {
        ...mutation,
        client_version: version,
        body: encryptBody(
          key.k0,
          key.keyId,
          {
            spaceId: this.spaceId,
            table: mutation.table,
            pk: mutation.pk,
            version,
            keyId: key.keyId,
          },
          mutation.body
        ),
      };
    });
    return this.inner.push(encrypted);
  }

  /** Decrypts every body-carrying patch; failures are flagged, never thrown. */
  async pull(cursor: number, limit?: number): Promise<SyncPullResult> {
    const result = await this.inner.pull(cursor, limit);
    const keyResult = await this.keys.get();
    const key = keyResult.success ? keyResult.data : null;
    return { ...result, patches: result.patches.map((patch) => this.decryptPatch(patch, key)) };
  }

  async poll(cursor: number, timeoutMs?: number): Promise<SyncPullResult> {
    const result = await this.inner.poll(cursor, timeoutMs);
    const keyResult = await this.keys.get();
    const key = keyResult.success ? keyResult.data : null;
    return { ...result, patches: result.patches.map((patch) => this.decryptPatch(patch, key)) };
  }

  private decryptPatch(patch: SyncPatch, key: SpaceKey | null): SyncPatch {
    if (patch.op !== 'upsert' || patch.body === null) {
      return patch;
    }
    if (key === null) {
      return { ...patch, decryptError: 'no sync space encryption key on this machine' };
    }
    const aad = {
      spaceId: this.spaceId,
      table: patch.table,
      pk: patch.pk,
      version: patch.client_version,
      keyId: key.keyId,
    };
    const decrypted = decryptBody(key.k0, aad, patch.body);
    if (!decrypted.success) {
      log.warn('[sync] skipping patch that failed to decrypt', {
        table: patch.table,
        pk: patch.pk,
        error: decrypted.error.type,
      });
      return { ...patch, decryptError: cryptoErrorMessage(decrypted.error) };
    }
    return { ...patch, body: decrypted.data };
  }

  private async requireKey(): Promise<SpaceKey> {
    const key = await this.keys.get();
    if (!key.success || key.data === null) {
      throw new SyncSpaceKeyMissingError();
    }
    return key.data;
  }
}

/** A terse, non-secret description of a decryption failure for diagnostics. */
function cryptoErrorMessage(error: SyncCryptoError): string {
  switch (error.type) {
    case 'unknown_key_id':
      return 'row is encrypted with a key this machine does not have (the space may have been rekeyed)';
    case 'unsupported_alg':
      return 'row uses an unsupported encryption algorithm';
    case 'malformed_envelope':
      return 'row body is not a valid encrypted envelope';
    case 'aad_mismatch':
      return 'row body failed authentication (tampered, or bound to different row metadata)';
  }
}
