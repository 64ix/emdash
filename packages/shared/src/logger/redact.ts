/**
 * String-based redaction: scans the serialized log line for secrets and PII.
 * Applied in the file transport as a defense-in-depth backstop for variadic
 * call sites that may embed secrets in message text or raw Error strings.
 *
 * Also exports DEFAULT_REDACT_PATHS for structural (field-path) redaction
 * via pino/fast-redact.
 */

type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

const SECRET_KEY_NAMES =
  'authorization|api[_-]?key|token|password|passphrase|secret|access[_-]?token|refresh[_-]?token|client[_-]?secret';

// Matches the key/quote/separator portion of a JSON-quoted secret: handles both
// "key":"value" and escaped \"key\":\"value\" forms (the latter shows up when a
// serialized JSON payload is itself embedded as a string in the log line). The
// value itself is intentionally NOT matched here — see findJsonStringEnd below —
// because a regex character class cannot correctly model JSON string escaping
// (an escaped quote or a backslash inside the value would truncate the match).
const JSON_KEY_PATTERN = new RegExp(
  `(\\\\?")(${SECRET_KEY_NAMES})(\\\\?")(\\s*:\\s*)(\\\\?")`,
  'gi'
);

/**
 * Scans forward from just after a JSON string's opening quote to find the
 * matching closing quote, honoring backslash escaping so an escaped quote
 * (\") or a literal backslash inside the value never terminates the scan
 * early. `quoteToken` is the exact opening delimiter that was matched — `"`
 * for plain JSON, or `\"` for JSON escaped one level deeper (embedded in an
 * outer string). Runs in a single linear pass (no backtracking) and returns
 * the index just past the closing quote token, or -1 if the string never
 * closes.
 *
 * Also bails (-1) on a raw control character (code point < 0x20, e.g. a
 * literal, unescaped newline). Valid JSON strings must escape control
 * characters, so hitting one bare means this isn't really a well-formed JSON
 * string value — the "closing quote" we'd otherwise find further along may
 * belong to unrelated, later content (for instance a different key's
 * genuinely-closed value). Treating that stray quote as our own close would
 * consume it, stripping the opening delimiter a subsequent real secret needs
 * to match and letting it slip through unredacted. Bailing here keeps that
 * later occurrence intact for the caller to find on its own.
 */
function findJsonStringEnd(input: string, start: number, quoteToken: string): number {
  let i = start;
  while (i < input.length) {
    if (input.startsWith(quoteToken, i)) {
      return i + quoteToken.length;
    }
    if (input.charCodeAt(i) < 0x20) {
      return -1;
    }
    if (input[i] === '\\') {
      // Backslash escape: skip it and whatever it escapes together, so an
      // escaped quote (or backslash) in the value can never look like a
      // closing delimiter.
      i += 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Redacts JSON-quoted secret values (see JSON_KEY_PATTERN) using a small
 * scanner rather than a single regex, since the value can legitimately
 * contain escaped quotes and backslashes that a `[^"\\]*`-style character
 * class would stop at prematurely — leaving the tail of the secret in clear
 * text. Non-secret keys and values without a real closing quote are left
 * untouched.
 *
 * Known limitation, not a regression: the doubly-escaped key form
 * (`\"key\":\"value\"`, i.e. this whole JSON fragment embedded one level
 * deeper inside an outer string) combined with an escape *inside* that same
 * value is ambiguous for a scanner where one backslash always consumes
 * exactly the next character — disambiguating it correctly needs escape-depth
 * tracking, not a bigger quoteToken. In that combined case this scanner
 * closes at the first escaped-looking boundary and leaves the remainder of
 * the value in clear text, same shape as the original bug, just one nesting
 * level in. The old single-regex approach redacted nothing at all for that
 * combination (the character class never matched through the escape), so
 * this is strictly less exposure, not more — but it is not a full fix.
 */
function redactJsonQuotedSecrets(value: string): string {
  JSON_KEY_PATTERN.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_KEY_PATTERN.exec(value)) !== null) {
    const [full, openQuote, keyName, closeQuote, separator, valueQuote] = match;
    const valueStart = match.index + full.length;
    const valueEnd = findJsonStringEnd(value, valueStart, valueQuote);
    if (valueEnd === -1) {
      // No matching closing quote — malformed/truncated input. Don't touch it
      // rather than risk redacting past the intended boundary.
      JSON_KEY_PATTERN.lastIndex = valueStart;
      continue;
    }
    result += value.slice(lastIndex, match.index);
    result += `${openQuote}${keyName}${closeQuote}${separator}${openQuote}[REDACTED]${openQuote}`;
    lastIndex = valueEnd;
    JSON_KEY_PATTERN.lastIndex = valueEnd;
  }
  result += value.slice(lastIndex);
  return result;
}

const SECRET_PATTERNS: Array<[RegExp, RedactionReplacement]> = [
  // Unquoted: key=value or key: bearer value
  [
    new RegExp(`\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(?:bearer\\s+)?[^\\s,"'}]+`, 'gi'),
    '$1$2[REDACTED]',
  ],
  // PEM blocks (private keys)
  [/-----BEGIN[^-\n]{1,40}-----[\s\S]+?-----END[^-\n]{1,40}-----/g, '[REDACTED_PEM_BLOCK]'],
  // Known token prefixes — order matters: vendor-specific before generic
  [/\bgh[opsu]_[A-Za-z0-9]{36,255}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_GITLAB_TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{36,}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_STRIPE_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
];

const PII_PATTERNS: Array<[RegExp, RedactionReplacement]> = [
  // Any scheme://user:pass@ — covers postgres, mongodb, redis, mysql, amqp, https…
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/?#@]+:[^\s@/?#]+@/gi, '$1[REDACTED_CREDENTIALS]@'],
  [/\b(git|hg|svn)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1@[REDACTED_HOST]'],
  [/\b(?:[A-F0-9]{2}:){5}[A-F0-9]{2}\b/gi, '[REDACTED_MAC]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]'],
  [/\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi, '[REDACTED_IP]'],
  [/\/Users\/[^\s/]+/gi, '/Users/[REDACTED_USER]'],
  [/\/home\/[^\s/]+/g, '/home/[REDACTED_USER]'],
  [/[A-Z]:\\Users\\[^\s\\]+/gi, (match) => `${match.slice(0, 9)}[REDACTED_USER]`],
];

function applyRedactions(value: string, patterns: Array<[RegExp, RedactionReplacement]>): string {
  return patterns.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement as string),
    value
  );
}

export function redactSecrets(value: string): string {
  return applyRedactions(redactJsonQuotedSecrets(value), SECRET_PATTERNS);
}

export function redactPii(value: string): string {
  return applyRedactions(value, PII_PATTERNS);
}

export function redactAll(value: string): string {
  return redactPii(redactSecrets(value));
}

/**
 * Field-path list for structural (pino/fast-redact) redaction.
 * Redacts well-known sensitive field names from structured log objects.
 * Used as the `redact` option in createPinoLogger.
 */
export const DEFAULT_REDACT_PATHS: string[] = [
  'token',
  'password',
  'secret',
  'passphrase',
  '*.token',
  '*.password',
  '*.secret',
  '*.passphrase',
  'authorization',
  'req.headers.authorization',
  'request.headers.authorization',
  '*.authorization',
  'set-cookie',
  'headers["set-cookie"]',
  'apiKey',
  'api_key',
  '*.apiKey',
  '*.api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  'clientSecret',
  'client_secret',
  '*.clientSecret',
  '*.client_secret',
  'sessionToken',
  'session_token',
  '*.sessionToken',
  '*.session_token',
];
