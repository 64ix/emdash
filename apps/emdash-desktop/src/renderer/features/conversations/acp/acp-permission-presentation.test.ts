import type { ToolCallItem } from '@emdash/core/acp/client';
import { describe, expect, it } from 'vitest';
import {
  buildPermissionCopyText,
  describePermissionOperation,
  PERMISSION_PARAM_MAX_CHARS,
  PERMISSION_TEXT_MAX_CHARS,
  summarizePermissionText,
} from './acp-permission-presentation';

function base(overrides: Partial<ToolCallItem> = {}): {
  id: string;
  seq: number;
  toolCallId: string;
  title: string;
  status: 'pending';
} {
  return {
    id: 'item-1',
    seq: 0,
    toolCallId: 'call-1',
    title: 'Default title',
    status: 'pending',
    ...overrides,
  } as never;
}

describe('describePermissionOperation — command (execute-tool-call)', () => {
  it('normalizes the command, scope, and a defensible (non-guaranteeing) risk cue', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'execute-tool-call',
      command: 'rm -rf ./build',
    } as ToolCallItem);

    expect(detail.kind).toBe('command');
    expect(detail.operationLabel).toBe('Execute command');
    expect(detail.scope).toBe('Task workspace');
    expect(detail.command?.text).toBe('rm -rf ./build');
    expect(detail.command?.truncated).toBe(false);
    expect(detail.params).toEqual([]);
    expect(detail.resources).toEqual([]);
    expect(detail.riskCues).toHaveLength(1);
    // Must describe the mechanism, never assert an unverifiable guarantee.
    expect(detail.riskCues[0]).not.toMatch(/safe|sandbox|cannot (harm|damage)/i);
  });

  it('falls back to the title when the provider omits a normalized command', () => {
    const detail = describePermissionOperation({
      ...base({ title: 'Run the build script' }),
      kind: 'execute-tool-call',
    } as ToolCallItem);

    expect(detail.command?.text).toBe('Run the build script');
  });
});

describe('describePermissionOperation — filesystem operations', () => {
  it('read-tool-call: uses path when present', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'read-tool-call',
      path: 'src/index.ts',
    } as ToolCallItem);

    expect(detail.kind).toBe('read');
    expect(detail.path).toBe('src/index.ts');
    expect(detail.resources).toEqual([{ kind: 'path', path: 'src/index.ts' }]);
  });

  it('read-tool-call: falls back to resource when path is absent', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'read-tool-call',
      resource: 'file:///tmp/notes.txt',
    } as ToolCallItem);

    expect(detail.path).toBe('file:///tmp/notes.txt');
  });

  it('create-file-tool-call: surfaces path and full content', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'create-file-tool-call',
      path: 'src/new-file.ts',
      content: 'export const x = 1;\n',
    } as ToolCallItem);

    expect(detail.kind).toBe('write');
    expect(detail.operationLabel).toBe('Create file');
    expect(detail.path).toBe('src/new-file.ts');
    expect(detail.content?.text).toBe('export const x = 1;\n');
    expect(detail.resources).toEqual([{ kind: 'path', path: 'src/new-file.ts' }]);
  });

  it('modify-file-tool-call: surfaces both sides of the change without claiming safety', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'modify-file-tool-call',
      path: 'src/existing.ts',
      oldText: 'const a = 1;',
      newText: 'const a = 2;',
    } as ToolCallItem);

    expect(detail.kind).toBe('write');
    expect(detail.operationLabel).toBe('Modify file');
    expect(detail.diff?.oldText.text).toBe('const a = 1;');
    expect(detail.diff?.newText.text).toBe('const a = 2;');
  });

  it('delete-file-tool-call: is explicit that Emdash cannot undo it', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'delete-file-tool-call',
      path: 'src/old-file.ts',
    } as ToolCallItem);

    expect(detail.kind).toBe('delete');
    expect(detail.path).toBe('src/old-file.ts');
    expect(detail.riskCues.join(' ')).toMatch(/does not provide an undo/i);
  });
});

describe('describePermissionOperation — generic/inspectable tools', () => {
  it('search-tool-call: surfaces the query as a param', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'search-tool-call',
      query: 'TODO(security)',
    } as ToolCallItem);

    expect(detail.kind).toBe('search');
    expect(detail.params).toEqual([{ label: 'Query', value: 'TODO(security)' }]);
  });

  it('mcp-tool-call: includes server when present and flags unverifiable behavior', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'mcp-tool-call',
      tool: 'run_query',
      server: 'postgres-mcp',
    } as ToolCallItem);

    expect(detail.kind).toBe('mcp');
    expect(detail.scope).toBe('Network (outside the task workspace)');
    expect(detail.params).toEqual([
      { label: 'Tool', value: 'run_query' },
      { label: 'Server', value: 'postgres-mcp' },
    ]);
    expect(detail.riskCues.join(' ')).toMatch(/cannot verify/i);
  });

  it('mcp-tool-call: omits the Server param when the provider does not report one', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'mcp-tool-call',
      tool: 'run_query',
    } as ToolCallItem);

    expect(detail.params).toEqual([{ label: 'Tool', value: 'run_query' }]);
  });

  it('web-fetch-tool-call: surfaces the URL as an affected resource', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'web-fetch-tool-call',
      url: 'https://example.com/data.json',
      pageTitle: 'Example data',
    } as ToolCallItem);

    expect(detail.kind).toBe('fetch');
    expect(detail.resources).toEqual([
      { kind: 'url', url: 'https://example.com/data.json' },
    ]);
    expect(detail.params).toEqual([
      { label: 'URL', value: 'https://example.com/data.json' },
      { label: 'Page title', value: 'Example data' },
    ]);
  });

  it('spawn-subagent-tool-call: notes background execution when reported', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'spawn-subagent-tool-call',
      name: 'refactor-helper',
      background: true,
    } as ToolCallItem);

    expect(detail.kind).toBe('subagent');
    expect(detail.params).toEqual([
      { label: 'Name', value: 'refactor-helper' },
      { label: 'Background', value: 'Yes' },
    ]);
  });

  it('create-plan-tool-call: has no params or resources', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'create-plan-tool-call',
      planId: 'plan-1',
    } as ToolCallItem);

    expect(detail.kind).toBe('plan');
    expect(detail.params).toEqual([]);
  });

  it('unknown-tool-call: surfaces the raw tool kind and warns the reviewer explicitly', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'unknown-tool-call',
      name: 'some_custom_tool',
      toolKind: 'vendor.custom',
    } as ToolCallItem);

    expect(detail.kind).toBe('unknown');
    expect(detail.rawToolKind).toBe('vendor.custom');
    expect(detail.params).toEqual([
      { label: 'Tool', value: 'some_custom_tool' },
      { label: 'Raw kind', value: 'vendor.custom' },
    ]);
    expect(detail.riskCues.join(' ')).toMatch(/does not recognize/i);
  });

  it('unknown-tool-call: degrades safely when toolKind is null', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'unknown-tool-call',
      name: 'mystery',
      toolKind: null,
    } as ToolCallItem);

    expect(detail.rawToolKind).toBeNull();
    expect(detail.params).toEqual([{ label: 'Tool', value: 'mystery' }]);
  });
});

describe('summarizePermissionText — redaction and bounding', () => {
  it('redacts a secret pattern before display, never partially through truncation', () => {
    const block = summarizePermissionText('curl -H "Authorization: Bearer sk-ant-abcdef0123456789ABCDEF"');
    expect(block.text).not.toContain('sk-ant-abcdef0123456789ABCDEF');
    expect(block.text).toContain('[REDACTED');
    expect(block.fullText).not.toContain('sk-ant-abcdef0123456789ABCDEF');
  });

  it('bounds long text explicitly, exposing the omitted character count', () => {
    const long = 'a'.repeat(PERMISSION_TEXT_MAX_CHARS + 500);
    const block = summarizePermissionText(long);

    expect(block.truncated).toBe(true);
    expect(block.omittedChars).toBe(500);
    expect(block.text).toHaveLength(PERMISSION_TEXT_MAX_CHARS);
    // The full (redacted) text must remain available in full for Copy — a
    // "Copy" action that only ever returns the bounded view would silently
    // hide the rest of what the user is approving.
    expect(block.fullText).toHaveLength(long.length);
  });

  it('never bisects a surrogate pair at the truncation boundary', () => {
    const emoji = '😀'; // astral-plane, 2 UTF-16 code units / 1 code point
    const long = emoji.repeat(PERMISSION_TEXT_MAX_CHARS + 10);
    const block = summarizePermissionText(long);

    expect(block.truncated).toBe(true);
    // Every returned code point must be a complete, valid character — no lone
    // surrogate half.
    expect(Array.from(block.text).every((ch) => ch === emoji)).toBe(true);
  });

  it('degrades to an empty block for undefined/null input rather than throwing', () => {
    expect(summarizePermissionText(undefined).text).toBe('');
    expect(summarizePermissionText(null).text).toBe('');
  });
});

describe('param redaction and bounding', () => {
  it('redacts secrets embedded in a param value (e.g. a URL query string)', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'web-fetch-tool-call',
      url: 'https://api.example.com/v1?api_key=super-secret-value-123',
    } as ToolCallItem);

    const urlParam = detail.params.find((p) => p.label === 'URL');
    expect(urlParam?.value).not.toContain('super-secret-value-123');
  });

  it('bounds an oversized param value to PERMISSION_PARAM_MAX_CHARS', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'search-tool-call',
      query: 'x'.repeat(PERMISSION_PARAM_MAX_CHARS + 50),
    } as ToolCallItem);

    expect(detail.params[0]?.value).toHaveLength(PERMISSION_PARAM_MAX_CHARS);
  });
});

describe('buildPermissionCopyText', () => {
  it('includes the full (untruncated) command text, never the bounded view', () => {
    const long = 'echo '.padEnd(PERMISSION_TEXT_MAX_CHARS + 200, 'x');
    const detail = describePermissionOperation({
      ...base(),
      kind: 'execute-tool-call',
      command: long,
    } as ToolCallItem);

    const copy = buildPermissionCopyText(detail);
    expect(copy).toContain(long);
  });

  it('includes path, params, resources, and risk cues for a filesystem operation', () => {
    const detail = describePermissionOperation({
      ...base(),
      kind: 'delete-file-tool-call',
      path: 'src/old-file.ts',
    } as ToolCallItem);

    const copy = buildPermissionCopyText(detail);
    expect(copy).toContain('Delete file');
    expect(copy).toContain('Path: src/old-file.ts');
    expect(copy).toContain('Resource: src/old-file.ts');
    expect(copy).toMatch(/does not provide an undo/i);
  });
});
