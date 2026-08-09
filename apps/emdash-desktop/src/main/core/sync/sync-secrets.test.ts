import { describe, expect, it } from 'vitest';
import { SYNC_ENCRYPTION_KEY_SECRET_KEY, SYNC_TOKEN_SECRET_KEY } from './sync-secrets';

describe('sync-secrets reserved keys', () => {
  it('reserves distinct app_secrets keys for the sync credential and encryption key', () => {
    expect(SYNC_TOKEN_SECRET_KEY).toBe('sync-token');
    expect(SYNC_ENCRYPTION_KEY_SECRET_KEY).toBe('sync-encryption-key');
    expect(SYNC_TOKEN_SECRET_KEY).not.toBe(SYNC_ENCRYPTION_KEY_SECRET_KEY);
  });

  it('does not collide with the account session secret key', () => {
    expect(SYNC_TOKEN_SECRET_KEY).not.toBe('emdash-account-token');
  });
});
