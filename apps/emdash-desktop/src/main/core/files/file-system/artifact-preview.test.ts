import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileSystem } from '@emdash/core/files';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let appTempRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => appTempRoot),
  },
  clipboard: { readImage: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
}));

const { previewLocalArtifact } = await import('./artifact-preview');

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  appTempRoot = '';
});

async function makeRoots() {
  const base = await mkdtemp(path.join(tmpdir(), 'emdash-artifact-preview-'));
  roots.push(base);
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  const appTemp = path.join(base, 'app-temp');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(appTemp, { recursive: true });
  appTempRoot = appTemp;
  return { base, workspace, outside, appTemp };
}

const fileSystem = new FileSystem();

describe('previewLocalArtifact — trusted workspace root', () => {
  it('previews a real PNG inside the workspace', async () => {
    const { workspace } = await makeRoots();
    const filePath = path.join(workspace, 'chart.png');
    await writeFile(filePath, PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });

    expect(result.status).toBe('ok');
    expect(result).toMatchObject({ status: 'ok', kind: 'image', mimeType: 'image/png' });
  });

  it('previews a text file via a workspace-relative candidate path', async () => {
    const { workspace } = await makeRoots();
    await writeFile(path.join(workspace, 'notes.md'), '# hello');

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: 'notes.md',
      confirmed: false,
    });

    expect(result).toMatchObject({ status: 'ok', kind: 'text', contentType: 'markdown', content: '# hello' });
  });

  it('denies a missing file with an explicit reason', async () => {
    const { workspace } = await makeRoots();
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: path.join(workspace, 'missing.png'),
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'missing' });
  });

  it('denies a directory path', async () => {
    const { workspace } = await makeRoots();
    const dirPath = path.join(workspace, 'a-directory.png');
    await mkdir(dirPath);
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: dirPath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'directory' });
  });

  it('denies an oversized image without loading it fully', async () => {
    const { workspace } = await makeRoots();
    const filePath = path.join(workspace, 'huge.png');
    const oversized = Buffer.concat([
      PNG_BYTES,
      Buffer.alloc(10 * 1024 * 1024, 0x41), // pad past the 10 MiB cap
    ]);
    await writeFile(filePath, oversized);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'oversized' });
  });

  it('denies a .png file whose bytes are not really an image (extension spoofing)', async () => {
    const { workspace } = await makeRoots();
    const filePath = path.join(workspace, 'evil.png');
    await writeFile(filePath, '<html><script>alert(1)</script></html>');

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'type-mismatch' });
  });

  it('denies an unsupported content type outright (no confirmation offered)', async () => {
    const { workspace } = await makeRoots();
    const filePath = path.join(workspace, 'installer.exe');
    await writeFile(filePath, 'MZ...');

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'unsupported-content' });
  });

  it('denies a symlink inside the workspace that escapes to a target outside it', async () => {
    const { workspace, outside } = await makeRoots();
    const outsideFile = path.join(outside, 'secret.png');
    await writeFile(outsideFile, PNG_BYTES);
    const linkPath = path.join(workspace, 'escape.png');
    await symlink(outsideFile, linkPath, 'file');

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: linkPath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'symlink-escape' });
  });

  it('refuses relative traversal outright, without ever offering confirmation', async () => {
    const { workspace, outside } = await makeRoots();
    await writeFile(path.join(outside, 'chart.png'), PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: '../outside/chart.png',
      confirmed: true, // even pre-confirmed, traversal must be refused
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'traversal' });
  });

  it('refuses relative traversal that walks past the drive/root anchor entirely', async () => {
    const { workspace } = await makeRoots();
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: '../../../../../../../../../../etc/passwd',
      confirmed: true,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'traversal' });
  });

  it('refuses percent-encoded traversal', async () => {
    const { workspace, outside } = await makeRoots();
    await writeFile(path.join(outside, 'chart.png'), PNG_BYTES);
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: '..%2foutside%2fchart.png',
      confirmed: true,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'traversal' });
  });

  it('is not fooled by double-encoded traversal (decodes exactly once)', async () => {
    const { workspace } = await makeRoots();
    // %252e%252e decodes once to the literal text "%2e%2e" — never to "..".
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: 'docs/%252e%252e/chart.png',
      confirmed: false,
    });
    // Resolves to a literal (nonexistent) path inside the workspace, not a traversal.
    expect(result).toMatchObject({ status: 'denied', reason: 'missing' });
  });
});

describe('previewLocalArtifact — prefix-sibling workspace roots are not confused', () => {
  it('does not treat a sibling directory that merely shares a name prefix as in-workspace', async () => {
    const { base, workspace } = await makeRoots();
    const evilSibling = `${workspace}-evil`;
    await mkdir(evilSibling, { recursive: true });
    roots.push(evilSibling);
    await writeFile(path.join(evilSibling, 'chart.png'), PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: path.join(evilSibling, 'chart.png'),
      confirmed: false,
    });
    // Not workspace-trusted — falls to the outside-root bucket, which requires confirmation.
    expect(result).toMatchObject({ status: 'needs-confirmation', kind: 'image' });
    void base;
  });
});

describe('previewLocalArtifact — outside every trusted root', () => {
  it('requires confirmation for a supported artifact before reading any bytes', async () => {
    const { workspace, outside } = await makeRoots();
    const filePath = path.join(outside, 'chart.png');
    await writeFile(filePath, PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });
    expect(result).toEqual({ status: 'needs-confirmation', kind: 'image', resolvedPath: filePath });
  });

  it('reads and previews once confirmed', async () => {
    const { workspace, outside } = await makeRoots();
    const filePath = path.join(outside, 'chart.png');
    await writeFile(filePath, PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: true,
    });
    expect(result).toMatchObject({ status: 'ok', kind: 'image' });
  });

  it('denies an unsupported type outright regardless of the confirmed flag', async () => {
    const { workspace, outside } = await makeRoots();
    const filePath = path.join(outside, 'doc.pdf');
    await writeFile(filePath, '%PDF-1.4');

    for (const confirmed of [false, true]) {
      const result = await previewLocalArtifact({
        workspacePath: workspace,
        fileSystem,
        candidatePath: filePath,
        confirmed,
      });
      expect(result).toMatchObject({ status: 'denied', reason: 'unsupported-content' });
    }
  });

  it('still denies missing/oversized/type-mismatch after confirmation', async () => {
    const { workspace, outside } = await makeRoots();
    const missingPath = path.join(outside, 'missing.png');
    const missing = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: missingPath,
      confirmed: true,
    });
    expect(missing).toMatchObject({ status: 'denied', reason: 'missing' });

    const mismatchPath = path.join(outside, 'evil.png');
    await writeFile(mismatchPath, '<html></html>');
    const mismatch = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: mismatchPath,
      confirmed: true,
    });
    expect(mismatch).toMatchObject({ status: 'denied', reason: 'type-mismatch' });
  });
});

describe('previewLocalArtifact — trusted app-managed temp root', () => {
  it('previews a real emdash-drop-prefixed artifact directly in the temp root', async () => {
    const { workspace, appTemp } = await makeRoots();
    const filePath = path.join(appTemp, 'emdash-drop-abc123.png');
    await writeFile(filePath, PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'ok', kind: 'image' });
  });

  it('does not trust a temp-root file without the app-owned prefix', async () => {
    const { workspace, appTemp } = await makeRoots();
    const filePath = path.join(appTemp, 'not-ours.png');
    await writeFile(filePath, PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'needs-confirmation', kind: 'image' });
  });

  it('does not trust a nested subdirectory of the temp root', async () => {
    const { workspace, appTemp } = await makeRoots();
    const nested = path.join(appTemp, 'sub');
    await mkdir(nested);
    const filePath = path.join(nested, 'emdash-drop-abc123.png');
    await writeFile(filePath, PNG_BYTES);

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: filePath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'needs-confirmation', kind: 'image' });
  });

  it('still enforces symlink-escape for a claimed app-temp path', async () => {
    const { workspace, appTemp, outside } = await makeRoots();
    const outsideFile = path.join(outside, 'secret.png');
    await writeFile(outsideFile, PNG_BYTES);
    const linkPath = path.join(appTemp, 'emdash-drop-escape.png');
    await symlink(outsideFile, linkPath, 'file');

    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: linkPath,
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'symlink-escape' });
  });
});

describe('previewLocalArtifact — platform path forms', () => {
  it('treats a Windows drive-letter absolute path outside a POSIX workspace as needing confirmation, not a crash', async () => {
    const { workspace } = await makeRoots();
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: 'C:\\Users\\dev\\chart.png',
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'needs-confirmation', kind: 'image' });
  });

  it('treats a UNC path as outside the workspace, needing confirmation rather than a crash', async () => {
    const { workspace } = await makeRoots();
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: '\\\\server\\share\\chart.png',
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'needs-confirmation', kind: 'image' });
  });

  it('rejects a path containing a null byte', async () => {
    const { workspace } = await makeRoots();
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: 'chart\u0000.png',
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'invalid-path' });
  });

  it('rejects an empty candidate path', async () => {
    const { workspace } = await makeRoots();
    const result = await previewLocalArtifact({
      workspacePath: workspace,
      fileSystem,
      candidatePath: '',
      confirmed: false,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'invalid-path' });
  });
});
