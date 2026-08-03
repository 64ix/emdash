import { describe, expect, it } from 'vitest';
import type { ToolStructuredValue } from '@/model';
import {
  buildStructuredResult,
  buildStructuredValue,
  MAX_STRUCTURED_DEPTH,
  MAX_STRUCTURED_ENTRIES,
  MAX_STRUCTURED_NODES,
  MAX_STRUCTURED_SOURCE_CHARS,
  MAX_STRUCTURED_STRING_CHARS,
  structuredLines,
} from './tool-structured';

/** Count every node (including `truncated`/`circular` leaves) in a built tree. */
function countNodes(node: ToolStructuredValue): number {
  if (node.kind === 'object') {
    return 1 + node.entries.reduce((total, entry) => total + countNodes(entry.value), 0);
  }
  if (node.kind === 'array') {
    return 1 + node.items.reduce((total, item) => total + countNodes(item), 0);
  }
  return 1;
}

// ── buildStructuredValue: bare scalars / null / empty containers ─────────────

describe('buildStructuredValue — bare scalars, null, and empty containers', () => {
  it('a bare string', () => {
    expect(buildStructuredValue('hello')).toEqual({
      kind: 'string',
      value: 'hello',
      truncated: false,
    });
  });

  it('a bare number', () => {
    expect(buildStructuredValue(42)).toEqual({ kind: 'number', value: '42' });
  });

  it('a bare boolean', () => {
    expect(buildStructuredValue(false)).toEqual({ kind: 'boolean', value: false });
  });

  it('a bare null', () => {
    expect(buildStructuredValue(null)).toEqual({ kind: 'null' });
  });

  it('an empty object', () => {
    expect(buildStructuredValue({})).toEqual({ kind: 'object', entries: [], omittedEntries: 0 });
  });

  it('a bare empty array', () => {
    expect(buildStructuredValue([])).toEqual({ kind: 'array', items: [], omittedItems: 0 });
  });

  it('undefined is unrepresentable rather than throwing', () => {
    expect(buildStructuredValue(undefined)).toEqual({ kind: 'unrepresentable' });
  });

  it('a function/symbol/bigint value is unrepresentable rather than throwing', () => {
    expect(() => buildStructuredValue(() => {})).not.toThrow();
    expect(buildStructuredValue(() => {})).toEqual({ kind: 'unrepresentable' });
    expect(buildStructuredValue(Symbol('x'))).toEqual({ kind: 'unrepresentable' });
    expect(buildStructuredValue(10n)).toEqual({ kind: 'unrepresentable' });
  });

  it('non-finite numbers (NaN/Infinity) are unrepresentable rather than throwing', () => {
    expect(buildStructuredValue(Number.NaN)).toEqual({ kind: 'unrepresentable' });
    expect(buildStructuredValue(Number.POSITIVE_INFINITY)).toEqual({ kind: 'unrepresentable' });
  });

  it('null nested where an object might be expected is a plain null leaf', () => {
    expect(buildStructuredValue({ a: null })).toEqual({
      kind: 'object',
      entries: [{ key: 'a', value: { kind: 'null' } }],
      omittedEntries: 0,
    });
  });
});

// ── Hostile payloads: cycles, huge fan-out, deep nesting, huge strings ───────

describe('buildStructuredValue — hostile payloads never throw and stay bounded', () => {
  it('a self-referential (circular) object terminates instead of recursing forever', () => {
    // biome-ignore-line — deliberately hostile: cannot occur via JSON.parse.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    expect(() => buildStructuredValue(cyclic)).not.toThrow();
    expect(buildStructuredValue(cyclic)).toEqual({
      kind: 'object',
      entries: [
        { key: 'a', value: { kind: 'number', value: '1' } },
        { key: 'self', value: { kind: 'circular' } },
      ],
      omittedEntries: 0,
    });
  });

  it('a circular array terminates instead of recursing forever', () => {
    const cyclic: unknown[] = ['leaf'];
    cyclic.push(cyclic);

    expect(() => buildStructuredValue(cyclic)).not.toThrow();
    const result = buildStructuredValue(cyclic);
    expect(result).toEqual({
      kind: 'array',
      items: [{ kind: 'string', value: 'leaf', truncated: false }, { kind: 'circular' }],
      omittedItems: 0,
    });
  });

  it('a shared (non-cyclic) reference used twice is not falsely flagged as circular', () => {
    const shared = { x: 1 };
    const value = { first: shared, second: shared };
    const result = buildStructuredValue(value);
    expect(result).toEqual({
      kind: 'object',
      entries: [
        {
          key: 'first',
          value: {
            kind: 'object',
            entries: [{ key: 'x', value: { kind: 'number', value: '1' } }],
            omittedEntries: 0,
          },
        },
        {
          key: 'second',
          value: {
            kind: 'object',
            entries: [{ key: 'x', value: { kind: 'number', value: '1' } }],
            omittedEntries: 0,
          },
        },
      ],
      omittedEntries: 0,
    });
  });

  it('a 10k-key object caps entries and reports the omitted count', () => {
    const huge: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) huge[`k${i}`] = i;

    const result = buildStructuredValue(huge);
    expect(result.kind).toBe('object');
    if (result.kind !== 'object') throw new Error('expected object');
    expect(result.entries).toHaveLength(MAX_STRUCTURED_ENTRIES);
    expect(result.omittedEntries).toBe(10_000 - MAX_STRUCTURED_ENTRIES);
  });

  it('a 10k-item array caps items and reports the omitted count', () => {
    const huge = Array.from({ length: 10_000 }, (_, i) => i);

    const result = buildStructuredValue(huge);
    expect(result.kind).toBe('array');
    if (result.kind !== 'array') throw new Error('expected array');
    expect(result.items).toHaveLength(MAX_STRUCTURED_ENTRIES);
    expect(result.omittedItems).toBe(10_000 - MAX_STRUCTURED_ENTRIES);
  });

  it('50-deep nesting is capped at MAX_STRUCTURED_DEPTH instead of stack-overflowing', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 50; i++) value = [value];

    expect(() => buildStructuredValue(value)).not.toThrow();

    let node = buildStructuredValue(value);
    let depth = 0;
    while (node.kind === 'array' && node.items.length === 1) {
      node = node.items[0];
      depth += 1;
      if (depth > MAX_STRUCTURED_DEPTH + 2) break; // safety valve for the test itself
    }
    expect(node).toEqual({ kind: 'truncated', reason: 'max-depth' });
    expect(depth).toBeLessThanOrEqual(MAX_STRUCTURED_DEPTH + 1);
  });

  it('a huge string value is truncated to MAX_STRUCTURED_STRING_CHARS', () => {
    const huge = 'x'.repeat(50_000);
    const result = buildStructuredValue({ big: huge });
    expect(result.kind).toBe('object');
    if (result.kind !== 'object') throw new Error('expected object');
    const value = result.entries[0].value;
    expect(value).toEqual({
      kind: 'string',
      value: 'x'.repeat(MAX_STRUCTURED_STRING_CHARS),
      truncated: true,
    });
  });

  it('a lone (unpaired) surrogate never bisects into an invalid pair and never throws', () => {
    const lone = '\uD800'.repeat(1000);
    expect(() => buildStructuredValue(lone)).not.toThrow();
    const result = buildStructuredValue(lone);
    expect(result.kind).toBe('string');
    if (result.kind !== 'string') throw new Error('expected string');
    expect(result.truncated).toBe(true);
    expect(Array.from(result.value)).toHaveLength(MAX_STRUCTURED_STRING_CHARS);
  });

  it('a huge object key name is bounded like a value', () => {
    const hugeKey = 'k'.repeat(5000);
    const result = buildStructuredValue({ [hugeKey]: 1 });
    expect(result.kind).toBe('object');
    if (result.kind !== 'object') throw new Error('expected object');
    expect(result.entries[0].key.length).toBeLessThanOrEqual(MAX_STRUCTURED_STRING_CHARS);
  });

  it('a wide-and-deep tree stays bounded by the total node budget', () => {
    // 8 keys per level, 4 levels deep = 1 + 8 + 64 + 512 + 4096 = 4681 real
    // nodes — comfortably below what's cheap to construct in a test, but well
    // past MAX_STRUCTURED_NODES, so deeper branches must degrade to
    // `truncated` leaves rather than the walk exploring every real node.
    function wide(depth: number): unknown {
      if (depth === 0) return 'leaf';
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < 8; i++) obj[`k${i}`] = wide(depth - 1);
      return obj;
    }
    const value = wide(4);
    expect(() => buildStructuredValue(value)).not.toThrow();
  });

  it('the shared node budget bounds width and depth *combined*, not each dimension alone', () => {
    // 10 keys per level, 6 levels deep, every child a genuinely distinct
    // object (no sharing) — individually each axis is well within its own
    // per-dimension limit (10 < MAX_STRUCTURED_ENTRIES, 6 < MAX_STRUCTURED_DEPTH),
    // but combined they would produce (10**6 - 1) / 9 ≈ 111k real objects with
    // no budget at all — only the *shared* node budget, not either dimension
    // alone, keeps the realized tree cheap.
    const width = 10;
    const depth = 6;
    function wideAndDeep(remaining: number): unknown {
      if (remaining === 0) return 'leaf';
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < width; i++) obj[`k${i}`] = wideAndDeep(remaining - 1);
      return obj;
    }
    const value = wideAndDeep(depth);
    const result = buildStructuredValue(value);
    const nodeCount = countNodes(result);
    // The budget is decremented once per *call*, before that call knows
    // whether it will expand further — so a container whose own decrement
    // still leaves it non-negative always finishes fanning out to all of its
    // (already-invoked) children first, even ones that will immediately find
    // the budget exhausted. At most ~MAX_STRUCTURED_NODES calls can ever see
    // a non-negative budget, and each such call can only fan out to at most
    // one level's worth of children — so the realized tree is bounded by
    // roughly budget × max-fan-out, a fixed polynomial ceiling, however deep
    // or wide the *unbounded* input would otherwise have been.
    expect(nodeCount).toBeLessThan(MAX_STRUCTURED_NODES * (width + 1));
    expect(() => structuredLines(result)).not.toThrow();
  });

  it('a diamond-shaped (shared-reference) graph is bounded by the node budget, not exponential in depth', () => {
    // Every level below the root reuses the *same* object reference for all
    // MAX_STRUCTURED_ENTRIES children — legitimate sharing (not a cycle: no
    // node is its own ancestor), the classic shape that blows up to
    // width**depth distinct visits under naive re-traversal with no shared
    // budget. If the ancestor-chain check degraded to quadratic/exponential
    // behavior on this shape, this test would time out rather than merely
    // assert a wrong value.
    let shared: unknown = 'leaf';
    for (let level = 0; level < MAX_STRUCTURED_DEPTH; level++) {
      const next: Record<string, unknown> = {};
      for (let i = 0; i < MAX_STRUCTURED_ENTRIES; i++) next[`k${i}`] = shared;
      shared = next;
    }

    const start = performance.now();
    const result = buildStructuredValue(shared);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(200);
    // Same reasoning as the width+depth test above: bounded by roughly
    // budget × max-fan-out, not by width**depth (which here would be
    // 50**12 — astronomically larger).
    expect(countNodes(result)).toBeLessThan(MAX_STRUCTURED_NODES * (MAX_STRUCTURED_ENTRIES + 1));
    // Shared, non-ancestor reuse is never a false-positive circular result.
    expect(JSON.stringify(result)).not.toContain('"circular"');
  });

  it('a very long array of near-cap strings is bounded by entries-per-level, not by total item count', () => {
    const nearCap = 'x'.repeat(MAX_STRUCTURED_STRING_CHARS - 1);
    const many = Array.from({ length: 5000 }, () => nearCap);
    const result = buildStructuredValue(many);
    expect(result.kind).toBe('array');
    if (result.kind !== 'array') throw new Error('expected array');
    expect(result.items).toHaveLength(MAX_STRUCTURED_ENTRIES);
    expect(result.omittedItems).toBe(5000 - MAX_STRUCTURED_ENTRIES);
  });

  it('deeply nested arrays (not objects) are also capped at MAX_STRUCTURED_DEPTH', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 1000; i++) value = [value];

    expect(() => buildStructuredValue(value)).not.toThrow();
    const result = buildStructuredValue(value);
    expect(countNodes(result)).toBeLessThan(MAX_STRUCTURED_DEPTH + 5);
  });
});

// ── Redaction — defense-in-depth for leaf strings/keys passed in directly ────

describe('buildStructuredValue — redacts secrets in leaf strings and keys', () => {
  it('redacts a vendor-token secret in a nested leaf value regardless of key name', () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const result = buildStructuredValue({ a: { b: { note: secret } } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('redacts a vendor-token secret used as an object key', () => {
    const secretKey = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const result = buildStructuredValue({ [secretKey]: 'value' });
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });
});

// ── buildStructuredResult — the outputText entry point ───────────────────────

describe('buildStructuredResult', () => {
  it('returns undefined for non-string input', () => {
    expect(buildStructuredResult(undefined)).toBeUndefined();
    expect(buildStructuredResult(null)).toBeUndefined();
    expect(buildStructuredResult(42)).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace-only string', () => {
    expect(buildStructuredResult('')).toBeUndefined();
    expect(buildStructuredResult('   \n  ')).toBeUndefined();
  });

  it('returns undefined for malformed JSON, falling back to plain text', () => {
    expect(buildStructuredResult('not json at all')).toBeUndefined();
    expect(buildStructuredResult('{"unterminated": ')).toBeUndefined();
  });

  it('returns undefined for a bare scalar — no structure worth a dedicated view', () => {
    expect(buildStructuredResult('42')).toBeUndefined();
    expect(buildStructuredResult('"just a string"')).toBeUndefined();
    expect(buildStructuredResult('true')).toBeUndefined();
    expect(buildStructuredResult('null')).toBeUndefined();
  });

  it('builds a structured tree for a bare empty array', () => {
    expect(buildStructuredResult('[]')).toEqual({ kind: 'array', items: [], omittedItems: 0 });
  });

  it('builds a structured tree for a real MCP-shaped JSON object', () => {
    const result = buildStructuredResult('{"issues": []}');
    expect(result).toEqual({
      kind: 'object',
      entries: [{ key: 'issues', value: { kind: 'array', items: [], omittedItems: 0 } }],
      omittedEntries: 0,
    });
  });

  it('skips parsing outright for source text past MAX_STRUCTURED_SOURCE_CHARS', () => {
    // A valid, well-formed, deeply-structured JSON array well past the size
    // guard — must not attempt JSON.parse at all, falling back to plain text.
    const huge = `[${Array.from({ length: 50_000 }, (_, i) => `${i}`).join(',')}]`;
    expect(huge.length).toBeGreaterThan(MAX_STRUCTURED_SOURCE_CHARS);
    expect(buildStructuredResult(huge)).toBeUndefined();
  });

  it('a source just under MAX_STRUCTURED_SOURCE_CHARS that parses into an enormous flat array still stays bounded', () => {
    // Just under the size cap, so JSON.parse *is* attempted — but the parsed
    // array has tens of thousands of items; buildStructuredValue's own entry
    // cap (not the size cap) must be what keeps this cheap and bounded.
    const items = Array.from({ length: 90_000 }, (_, i) => i % 10).join(',');
    const raw = `[${items}]`;
    expect(raw.length).toBeLessThan(MAX_STRUCTURED_SOURCE_CHARS);

    const start = performance.now();
    const result = buildStructuredResult(raw);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(500);
    expect(result?.kind).toBe('array');
    if (result?.kind !== 'array') throw new Error('expected array');
    expect(result.items).toHaveLength(MAX_STRUCTURED_ENTRIES);
    expect(result.omittedItems).toBe(90_000 - MAX_STRUCTURED_ENTRIES);
  });

  it('a source just under MAX_STRUCTURED_SOURCE_CHARS with pathological nesting depth never throws', () => {
    // Deeply nested arrays (`[[[...]]]`) rather than a wide flat structure —
    // JSON.parse itself can throw (e.g. a native stack-depth RangeError) on
    // sufficiently deep input; the bare `catch` in buildStructuredResult must
    // still degrade to the safe plain-text fallback rather than propagating.
    let nested = '0';
    while (nested.length < MAX_STRUCTURED_SOURCE_CHARS - 10_000) {
      nested = `[${nested}]`;
    }
    expect(() => buildStructuredResult(nested)).not.toThrow();
  });

  it('redacts a secret keyed by a known secret field name, before parsing', () => {
    const secret = 'plausible-but-not-a-known-vendor-format-0123456789';
    const raw = `{"apiKey":"${secret}"}`;
    const result = buildStructuredResult(raw);
    expect(result).toEqual({
      kind: 'object',
      entries: [
        { key: 'apiKey', value: { kind: 'string', value: '[REDACTED]', truncated: false } },
      ],
      omittedEntries: 0,
    });
  });

  it('redacts a vendor-token secret nested under an innocuous key at any depth', () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const raw = `{"a":{"b":{"c":"${secret}"}}}`;
    const result = buildStructuredResult(raw);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('redacts a vendor-token secret embedded in a JSON key name', () => {
    const secretKey = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const raw = `{"${secretKey}": "value"}`;
    const result = buildStructuredResult(raw);
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });

  it('never throws for genuinely malformed/hostile JSON-ish input', () => {
    expect(() => buildStructuredResult('{{{{{')).not.toThrow();
    expect(() => buildStructuredResult('[1, 2,')).not.toThrow();
    expect(() => buildStructuredResult('\uD800\uD800\uD800')).not.toThrow();
  });
});

// ── structuredLines — bounded text rendering ──────────────────────────────────

describe('structuredLines', () => {
  it('renders an empty object/array as a single line', () => {
    expect(structuredLines({ kind: 'object', entries: [], omittedEntries: 0 })).toEqual(['{}']);
    expect(structuredLines({ kind: 'array', items: [], omittedItems: 0 })).toEqual(['[]']);
  });

  it('renders a nested object across multiple indented lines', () => {
    const tree = buildStructuredValue({ issues: [{ id: 1, title: 'Bug' }] });
    const lines = structuredLines(tree);
    expect(lines).toEqual([
      '{',
      '  "issues": [',
      '    {',
      '      "id": 1,',
      '      "title": "Bug"',
      '    }',
      '  ]',
      '}',
    ]);
  });

  it('reports omitted keys/items as their own muted line', () => {
    const huge: Record<string, number> = {};
    for (let i = 0; i < 60; i++) huge[`k${i}`] = i;
    const lines = structuredLines(buildStructuredValue(huge));
    expect(lines.at(-2)).toMatch(/… 10 more keys omitted/);
    expect(lines.at(-1)).toBe('}');
  });

  it('never throws and stays bounded for a pathologically large tree', () => {
    const huge = Array.from({ length: 10_000 }, (_, i) => ({ i, note: 'x'.repeat(1000) }));
    expect(() => structuredLines(buildStructuredValue(huge))).not.toThrow();
    const lines = structuredLines(buildStructuredValue(huge));
    expect(lines.length).toBeGreaterThan(0);
  });

  it('marks a truncated string value inline', () => {
    const tree = buildStructuredValue({ big: 'x'.repeat(1000) });
    const lines = structuredLines(tree);
    expect(lines[1]).toContain('…');
  });
});
