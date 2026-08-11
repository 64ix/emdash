import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  composeSpaceSecret,
  constantTimeEqual,
  joinCredentialOf,
  K0_B32_CHARS,
  makeJoinHalf,
  makeK0,
  makeSpaceId,
  makeSpaceSecret,
  makeToken,
  parseJoinCredential,
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

  it('base32 round-trips bytes and is transcription-safe lowercase', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0xff]);
    const encoded = base32Encode(bytes);
    expect(encoded).toMatch(/^[a-z2-7]+$/);
    expect(base32Decode(encoded)).toEqual(bytes);
    expect(base32Decode(encoded.toUpperCase())).toEqual(bytes);
    expect(base32Decode('not base32!')).toBeNull();
    expect(base32Decode('')).toEqual(new Uint8Array(0));
  });

  it('composes pairing secrets with the documented layout and lengths', async () => {
    const spaceId = makeSpaceId();
    const joinHalf = makeJoinHalf();
    const k0 = makeK0();
    expect(joinHalf.length).toBe(16);
    expect(k0.length).toBe(32);

    const secret = await composeSpaceSecret(spaceId, joinHalf, k0);
    // emdj1_ (6) + space (22) + _ (1) + join credential (26) + _ (1) + k0
    // (52) + _ (1) + checksum (7).
    expect(secret.startsWith('emdj1_')).toBe(true);
    expect(secret.length).toBe(6 + 22 + 1 + 26 + 1 + 52 + 1 + 7);
    expect(joinCredentialOf(joinHalf).length).toBe(26);
    expect(joinCredentialOf(k0).length).toBe(K0_B32_CHARS);

    // The halves are positionally fixed so clients and tests can slice them.
    expect(secret.slice(6, 28)).toBe(spaceId);
    expect(secret.slice(29, 55)).toBe(joinCredentialOf(joinHalf));
    expect(secret.slice(56, 108)).toBe(joinCredentialOf(k0));
    // The trailing checksum is 7 base32 chars, distinct per secret (it covers
    // the space id too, which is fresh on every call).
    expect(secret.slice(109)).toMatch(/^[a-z2-7]{7}$/);
  });

  it('makeSpaceSecret mints fresh halves and returns the join credential', async () => {
    const spaceId = makeSpaceId();
    const first = await makeSpaceSecret(spaceId);
    const second = await makeSpaceSecret(spaceId);
    expect(first.secret).toMatch(/^emdj1_/);
    expect(first.credential.length).toBe(26);
    expect(first.secret).not.toBe(second.secret);
    expect(first.credential).not.toBe(second.credential);
    // Same space id both times, but different join half/k0 -> different
    // checksums too.
    expect(first.secret.slice(109)).not.toBe(second.secret.slice(109));
  });

  it('join credentials parse back to exactly 16 bytes and reject malformed input', () => {
    const joinHalf = makeJoinHalf();
    const credential = joinCredentialOf(joinHalf);
    expect(parseJoinCredential(credential).ok).toBe(true);
    expect(base32Decode(credential)?.length).toBe(16);
    // Format validation only: any well-formed 26-char base32 value decodes to
    // 16 bytes. Content tampering is caught by the SHA-256 digest comparison
    // in `join()` (a tampered credential matches no stored digest).
    expect(parseJoinCredential(credential.toUpperCase()).ok).toBe(true);
    expect(parseJoinCredential(credential.slice(0, -1)).ok).toBe(false);
    expect(parseJoinCredential(`${credential}extra`).ok).toBe(false);
    expect(parseJoinCredential('not-a-credential').ok).toBe(false);
    expect(parseJoinCredential(`${credential}!`).ok).toBe(false);
  });

  it('rejects a composeSpaceSecret with wrong half lengths or a bad space id', async () => {
    await expect(composeSpaceSecret('short', makeJoinHalf(), makeK0())).rejects.toThrow();
    await expect(composeSpaceSecret(makeSpaceId(), new Uint8Array(8), makeK0())).rejects.toThrow();
    await expect(
      composeSpaceSecret(makeSpaceId(), makeJoinHalf(), new Uint8Array(16))
    ).rejects.toThrow();
  });

  it('the checksum covers the whole payload: changing any one of space id, join half, or k0 changes it', async () => {
    // The relay never parses a full secret back (only the client does, in
    // apps/emdash-desktop's crypto.ts), so this checks the same property from
    // the minting side: the checksum must depend on EVERY part of the
    // payload, not just a subset, or a typo in the part it ignores would
    // slip through uncaught on the joining client.
    const spaceId = makeSpaceId();
    const joinHalf = makeJoinHalf();
    const k0 = makeK0();
    const secret = await composeSpaceSecret(spaceId, joinHalf, k0);
    const checksum = secret.slice(109);
    expect(checksum).toMatch(/^[a-z2-7]{7}$/);

    const differentSpaceId = await composeSpaceSecret(makeSpaceId(), joinHalf, k0);
    const differentJoinHalf = await composeSpaceSecret(spaceId, makeJoinHalf(), k0);
    const differentK0 = await composeSpaceSecret(spaceId, joinHalf, makeK0());

    expect(differentSpaceId.slice(109)).not.toBe(checksum);
    expect(differentJoinHalf.slice(109)).not.toBe(checksum);
    expect(differentK0.slice(109)).not.toBe(checksum);
  });
});
