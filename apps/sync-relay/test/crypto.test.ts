import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  makeJoinSecret,
  makeToken,
  parseJoinSecret,
  parseToken,
  sha256Hex,
} from '../src/crypto';
import { tamperLastChar } from './tamper';

describe('crypto', () => {
  it('sha256Hex produces a deterministic 64-character lowercase hex digest', async () => {
    const digest = await sha256Hex('hello');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await sha256Hex('hello'));
    expect(digest).not.toBe(await sha256Hex('hello!'));
  });

  it('constantTimeEqual accepts equal buffers and rejects differing or length-mismatched buffers', () => {
    const a = new TextEncoder().encode('same-value');
    expect(constantTimeEqual(a, new TextEncoder().encode('same-value'))).toBe(true);
    expect(constantTimeEqual(a, new TextEncoder().encode('same-valuE'))).toBe(false);
    expect(constantTimeEqual(a, new TextEncoder().encode('short'))).toBe(false);
    expect(constantTimeEqual(a, new TextEncoder().encode('same-value-longer'))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  it('device tokens parse back and are unique per mint', async () => {
    const token = await makeToken();
    const parsed = await parseToken(token);
    expect(parsed.ok).toBe(true);
    const again = await makeToken();
    expect(again).not.toBe(token);
  });

  it('rejects tokens with a tampered checksum, wrong prefix, or wrong length', async () => {
    const token = await makeToken();
    expect((await parseToken(tamperLastChar(token))).ok).toBe(false);
    expect((await parseToken(`emdv9_${token.slice(6)}`)).ok).toBe(false);
    expect((await parseToken(token.slice(0, -2))).ok).toBe(false);
    expect((await parseToken(`${token}extra`)).ok).toBe(false);
    expect((await parseToken('not-a-token')).ok).toBe(false);
  });

  it('join secrets embed the space id and reject tampering', async () => {
    const spaceId = '0123456789abcdefghijkl'; // 22-char base64url space id
    const secret = await makeJoinSecret(spaceId);
    const parsed = await parseJoinSecret(secret);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spaceId).toBe(spaceId);
    }
    expect((await parseJoinSecret(tamperLastChar(secret))).ok).toBe(false);
    expect((await parseJoinSecret('not-a-secret')).ok).toBe(false);
    expect((await parseJoinSecret(secret.slice(0, -3))).ok).toBe(false);
  });
});
