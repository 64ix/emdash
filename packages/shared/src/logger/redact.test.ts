import { describe, expect, it } from 'vitest';
import { redactAll, redactPii, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('redacts authorization headers', () => {
    expect(redactSecrets('authorization: Bearer abc123')).toContain('[REDACTED]');
  });

  it('redacts api_key= assignment', () => {
    expect(redactSecrets('api_key=super-secret-key')).toContain('[REDACTED]');
  });

  it('redacts token field', () => {
    expect(redactSecrets('token: ghp_123456')).toContain('[REDACTED]');
  });

  it('redacts GitHub tokens', () => {
    expect(redactSecrets('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toContain(
      '[REDACTED_GITHUB_TOKEN]'
    );
  });

  it('redacts OpenAI keys', () => {
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED_OPENAI_KEY]');
  });

  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED_PEM_BLOCK]');
  });

  describe('JSON-quoted values with escapes (issue #57)', () => {
    it('fully redacts a value containing an escaped quote mid-value', () => {
      const input = '{"apiKey": "abc\\"def"}';
      const result = redactSecrets(input);
      expect(result).toBe('{"apiKey": "[REDACTED]"}');
      expect(result).not.toContain('def');
      expect(result).not.toContain('abc');
    });

    it('fully redacts a value with a trailing (escaped) backslash', () => {
      const input = '{"apiKey": "abc\\\\"}';
      const result = redactSecrets(input);
      expect(result).toBe('{"apiKey": "[REDACTED]"}');
      expect(result).not.toContain('abc');
    });

    it('fully redacts a value that is only an escaped quote', () => {
      const input = '{"apiKey": "\\""}';
      const result = redactSecrets(input);
      expect(result).toBe('{"apiKey": "[REDACTED]"}');
    });

    it('redacts every secret key in a multi-line JSON blob when one value has an escape', () => {
      const input = [
        '{',
        '  "token": "plain-value",',
        '  "apiKey": "abc\\"def",',
        '  "password": "p@ss\\\\word"',
        '}',
      ].join('\n');
      const result = redactSecrets(input);
      expect(result).not.toContain('plain-value');
      expect(result).not.toContain('abc');
      expect(result).not.toContain('def');
      // The secret value 'p@ss\word' must be gone; 'password' the *key name* is
      // expected to remain (only values are redacted), so assert on the whole
      // secret value rather than the substring 'word' (which 'password' contains).
      expect(result).not.toContain('p@ss\\word');
      expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
    });

    it('leaves a non-secret key with an escaped value untouched', () => {
      const input = '{"note": "abc\\"def", "other": "x\\\\y"}';
      const result = redactSecrets(input);
      expect(result).toBe(input);
    });

    it('does not corrupt surrounding JSON when the redacted value contained escapes', () => {
      const input = '{"apiKey": "abc\\"def", "user": "alice"}';
      const result = redactSecrets(input);
      expect(() => JSON.parse(result)).not.toThrow();
      const parsed = JSON.parse(result);
      expect(parsed.apiKey).toBe('[REDACTED]');
      expect(parsed.user).toBe('alice');
    });

    it('redacts the basic escaped \\"key\\":\\"value\\" form', () => {
      const input = '{\\"apiKey\\":\\"secretvalue\\"}';
      const result = redactSecrets(input);
      expect(result).toBe('{\\"apiKey\\":\\"[REDACTED]\\"}');
      expect(result).not.toContain('secretvalue');
    });

    it('stays linear on an adversarial run of quotes and backslashes (no catastrophic backtracking)', () => {
      const adversarial = `"apiKey":"${'\\\\'.repeat(50000)}${'\\"'.repeat(50000)}unterminated`;
      const start = Date.now();
      redactSecrets(adversarial);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});

describe('redactPii', () => {
  it('redacts email addresses', () => {
    expect(redactPii('person@example.com')).toContain('[REDACTED_EMAIL]');
  });

  it('redacts /Users/ paths', () => {
    expect(redactPii('/Users/alice/projects')).toContain('[REDACTED_USER]');
  });

  it('redacts /home/ paths', () => {
    expect(redactPii('/home/bob/work')).toContain('[REDACTED_USER]');
  });

  it('redacts IPv4 addresses', () => {
    expect(redactPii('192.168.1.25')).toContain('[REDACTED_IP]');
  });

  it('redacts credentials in DSNs', () => {
    expect(redactPii('postgres://user:pass@host/db')).toContain('[REDACTED_CREDENTIALS]');
  });
});

describe('redactAll', () => {
  it('applies both secret and PII redaction', () => {
    const input = 'token: abc\nemail person@example.com';
    const result = redactAll(input);
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('[REDACTED_EMAIL]');
  });
});
