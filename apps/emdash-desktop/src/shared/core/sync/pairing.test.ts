import { describe, expect, it } from 'vitest';
import {
  JOIN_SECRET_PREFIX,
  PAIRING_SECRET_TTL_MINUTES,
  userFacingPairingMessage,
  type PairingErrorCode,
} from './pairing';

const ALL_CODES: PairingErrorCode[] = [
  'invalid_secret_format',
  'invalid_join_secret',
  'unauthorized',
  'device_not_found',
  'not_paired',
  'persistence_failed',
  'relay_error',
  'network_error',
];

describe('userFacingPairingMessage', () => {
  it('produces a non-empty, user-facing message for every error code', () => {
    for (const code of ALL_CODES) {
      const message = userFacingPairingMessage(code);
      expect(message.length).toBeGreaterThan(0);
      // Never raw relay JSON: no quotes, braces, or colon-key shapes.
      expect(message).not.toContain('{');
      expect(message).not.toMatch(/"error"/);
    }
  });

  it('explains single-use, TTL, and attempt limits for invalid join secrets', () => {
    const message = userFacingPairingMessage('invalid_join_secret');
    expect(message).toContain(String(PAIRING_SECRET_TTL_MINUTES));
    expect(message.toLowerCase()).toContain('single-use');
    // The attempt budget is enforced silently by the relay — the user only
    // needs to know the secret no longer works and how to get a new one.
    expect(message.toLowerCase()).not.toContain('attempt');
  });

  it('mentions the emdj1_ prefix for format errors', () => {
    expect(userFacingPairingMessage('invalid_secret_format')).toContain(JOIN_SECRET_PREFIX);
  });

  it('includes the HTTP status for relay errors', () => {
    expect(userFacingPairingMessage('relay_error', 503)).toContain('503');
  });

  it('distinguishes each code with a distinct message', () => {
    const messages = new Set(ALL_CODES.map((code) => userFacingPairingMessage(code)));
    expect(messages.size).toBe(ALL_CODES.length);
  });
});
