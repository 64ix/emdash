import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Configuration } from 'electron-builder';
import base from './electron-builder.config.ts';

// electron is declared as a range ("^40.7.0") and pnpm hoists it to the workspace
// root, so electron-builder cannot infer the version and aborts. The release
// pipeline resolves it in scripts/release/build.ts; the plain CLI does not, which is
// why `pnpm run package:mac` fails locally. Resolve it here so this config works
// with a bare `electron-builder --config`.
const electronVersion = createRequire(import.meta.url)('electron/package.json').version;

// Personal fork builds: same packaging as stable, but the update feed points at
// 64ix/emdash instead of upstream. Without this override a locally packaged fork
// build checks generalaction/emdash + releases.emdash.sh and offers upstream
// releases, which would silently replace the fork's features on install.
//
// `releaseType: 'release'` (not 'draft') is required: electron-updater cannot see
// draft releases.
// .npmrc sets node-linker=hoisted, so most packages live in the workspace root
// node_modules and electron-builder collects them from there. glob resolves to 7.2.3
// at the root (a transitive dep), which shadows the 13.0.6 the app declares, and
// @emdash/core/dist imports `globIterate` — a named export glob 7 does not have, so
// the packaged app dies at ESM instantiation before app.whenReady():
//
//   SyntaxError: Named export 'globIterate' not found. The requested module 'glob'
//   is a CommonJS module...
//
// @emdash/core publishes only `dist`, so its own node_modules/glob is not packaged.
// Put the app-local glob 13 where Node looks first when resolving from
// node_modules/@emdash/core/dist/*.mjs, leaving the root copy for its own consumers.
// Both consumers get a nested copy next to them rather than replacing the root one,
// which stays available for whoever actually wants glob 7. A pre-flight audit of every
// named import in out/main and the main-process packages found glob to be the only
// broken specifier, so these two mappings cover the whole surface.
// Packages electron-builder's collector drops entirely under the hoisted layout. Each
// one is a declared runtime dependency of something already packaged, so the app dies
// on `Cannot find module` at boot. Found by auditing every packaged package.json
// against what is resolvable from its location inside the asar.
const MISSING_AT_ROOT = [
  '@exodus/bytes', // whatwg-url 16
  'is-docker', // open
  'is-wsl', // open
  'minipass', // glob 13
  'path-scurry', // glob 13
  'punycode', // tr46
];

// The hoisted layout's second failure mode: when two versions of a package coexist,
// pnpm keeps the loser out of the root — either nested under its consumer
// (node_modules/<pkg>/node_modules/<dep>) or in the importing workspace package's own
// node_modules (apps/emdash-desktop/node_modules, packages/*/node_modules) — and
// electron-builder's collector flattens all of that away, so packaged consumers
// resolve the wrong major (node-fetch 2 getting whatwg-url 16, @emdash/core getting
// glob 7, ...). Walk the runtime dependency graph with Node's own upward resolution
// and re-add every non-root node_modules directory it traverses, preserving pnpm's
// on-disk conflict resolution wholesale. Copies are recursive, so mapping a package's
// node_modules also carries any deeper nesting inside it.
const appDir = import.meta.dirname;
const workspaceRoot = path.resolve(appDir, '..', '..');
const appPkg = createRequire(import.meta.url)('./package.json');

const findPkgDir = (fromDir: string, name: string): string | null => {
  let cur = fromDir;
  while (true) {
    const candidate = path.join(cur, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (cur === workspaceRoot) return null;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
};

const nestedMappings: { from: string; to: string }[] = [];
const seenDirs = new Set<string>();
const mappedTos = new Set<string>();
const queue: Array<{ fromDir: string; name: string }> = Object.keys(appPkg.dependencies ?? {}).map(
  (name) => ({ fromDir: appDir, name })
);

while (queue.length > 0) {
  // Breadth-first with realpath dedup: workspace symlinks (@emdash/* -> packages/*)
  // otherwise produce endless @emdash/x/node_modules/@emdash/y/... chains, and BFS
  // guarantees each package is mapped at its shortest asar path.
  const item = queue.shift();
  if (item === undefined) continue;
  const pkgDir = findPkgDir(item.fromDir, item.name);
  if (pkgDir === null) continue;
  const realDir = fs.realpathSync(pkgDir);
  if (seenDirs.has(realDir)) continue;
  seenDirs.add(realDir);

  // Map this package's own node_modules unless it already sits at the workspace root
  // (the only tree electron-builder collects correctly on its own).
  const nested = path.join(pkgDir, 'node_modules');
  const rel = path.relative(workspaceRoot, pkgDir);
  const isRootLevel = rel === path.join('node_modules', item.name);
  if (!isRootLevel || fs.existsSync(nested)) {
    // Compute where this package lives inside the asar: strip the physical prefix
    // down to a plain node_modules/<name> chain. App-local and workspace-package
    // trees are reached through the app's node_modules symlinks, so their `rel`
    // already reads node_modules/... relative to the app dir instead.
    const relFromApp = path.relative(appDir, pkgDir);
    const asarPkgPath = relFromApp.startsWith('node_modules')
      ? relFromApp
      : rel.startsWith('node_modules')
        ? rel
        : null;
    if (asarPkgPath !== null && fs.existsSync(nested)) {
      const to = path.join(asarPkgPath, 'node_modules');
      if (!mappedTos.has(to)) {
        mappedTos.add(to);
        nestedMappings.push({ from: path.relative(appDir, nested), to });
      }
    }
  }

  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  for (const dep of [
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.optionalDependencies ?? {}),
  ]) {
    queue.push({ fromDir: pkgDir, name: dep });
  }
}

// Third failure mode: a root-level package whose only consumers are nested (say,
// open 11 living under codex-acp) is invisible to the collector — it followed the
// root-level consumer's version (open 8) and never asked for open 11's dependency
// closure, so default-browser & co. are absent from the asar. Approximate the
// collector as "resolution from the root only" and explicitly map every root-level
// package the real resolution walk reaches that the approximation does not.
const collectorSees = new Set<string>();
{
  const walk = (deps: string[]) => {
    for (const name of deps) {
      if (collectorSees.has(name)) continue;
      // The collector resolves at the workspace root or the app level (that is how
      // @emdash/* symlinks get packaged), but never inside nested node_modules.
      const candidates = [
        path.join(workspaceRoot, 'node_modules', name, 'package.json'),
        path.join(appDir, 'node_modules', name, 'package.json'),
      ];
      const pkgJsonPath = candidates.find((c) => fs.existsSync(c));
      if (pkgJsonPath === undefined) continue;
      collectorSees.add(name);
      const pj = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      walk([...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.optionalDependencies ?? {})]);
    }
  };
  walk(Object.keys(appPkg.dependencies ?? {}));
}
for (const name of MISSING_AT_ROOT) mappedTos.add(path.join('node_modules', name));
for (const realDir of seenDirs) {
  const rel = path.relative(workspaceRoot, realDir);
  const parts = rel.split(path.sep);
  const isRootLevel =
    parts[0] === 'node_modules' && parts.length === (parts[1]?.startsWith('@') ? 3 : 2);
  if (!isRootLevel) continue;
  const name = parts.slice(1).join('/');
  if (collectorSees.has(name)) continue;
  const to = path.join('node_modules', name);
  if (mappedTos.has(to)) continue;
  mappedTos.add(to);
  nestedMappings.push({ from: path.relative(appDir, realDir), to });
}

const files = [
  ...(base.files as string[]),
  // The app's own main bundle (out/main) imports glob 13 named exports; the root
  // carries glob 7 / minimatch 3, so give out/main its resolution-priority copies.
  { from: 'node_modules/glob', to: 'out/main/node_modules/glob' },
  { from: 'node_modules/minimatch', to: 'out/main/node_modules/minimatch' },
  ...MISSING_AT_ROOT.map((name) => ({
    from: `../../node_modules/${name}`,
    to: `node_modules/${name}`,
  })),
  ...nestedMappings,
];

const config: Configuration = {
  ...base,
  electronVersion,
  files,
  publish: [
    {
      provider: 'github',
      owner: '64ix',
      repo: 'emdash',
      releaseType: 'release',
    },
  ],
};

export default config;
