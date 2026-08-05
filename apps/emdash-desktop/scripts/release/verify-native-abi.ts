/**
 * Asserts that the native modules inside the packaged app actually load in the Electron that
 * was packaged with them.
 *
 * This is the guard fork release v1.2.8 did not have. electron-builder packages with
 * `npmRebuild: false`, so the `.node` binaries it collects are whatever `pnpm install`
 * compiled — on CI that is the runner's system Node, because apps/emdash-desktop's
 * postinstall deliberately skips electron-rebuild when `CI` is set. Electron keeps its own
 * NODE_MODULE_VERSION namespace (Electron 40 requires 143 where Node 24 produces 137), so a
 * missed rebuild can never accidentally be compatible: the packaged app throws on its first
 * `require('better-sqlite3')` and never opens a window.
 *
 * Nothing else in the pipeline notices. `verify-mac.ts` looks for a module named `sqlite3`,
 * which this app does not use, and only warns when it is absent; `codesign --verify` is happy
 * to sign a bundle that cannot boot.
 *
 * The check is the real thing rather than a proxy: run the packaged Electron binary as Node
 * (`ELECTRON_RUN_AS_NODE=1`, which reports Electron's module version, not the host's) and
 * `dlopen` the packaged `.node` file. If it loads there, it loads in the app.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRODUCT_NAME, RELEASE_DIR } from './lib/config.ts';
import { fail, info, step } from './lib/log.ts';

interface PackagedApp {
  /** The packaged Electron executable, used as the ABI oracle. */
  electronBin: string;
  /** Root of the unpacked asar, where the `.node` files live. */
  unpackedRoot: string;
}

function locatePackagedApp(): PackagedApp | null {
  if (process.platform === 'darwin') {
    const appDir = join(RELEASE_DIR, 'mac-arm64', `${PRODUCT_NAME}.app`);
    return {
      electronBin: join(appDir, 'Contents', 'MacOS', PRODUCT_NAME),
      unpackedRoot: join(appDir, 'Contents', 'Resources', 'app.asar.unpacked'),
    };
  }
  if (process.platform === 'win32') {
    const appDir = join(RELEASE_DIR, 'win-unpacked');
    return {
      electronBin: join(appDir, `${PRODUCT_NAME}.exe`),
      unpackedRoot: join(appDir, 'resources', 'app.asar.unpacked'),
    };
  }
  return null;
}

/** Native modules that must load, relative to the unpacked asar root. */
const REQUIRED_MODULES = [
  join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
];

const app = locatePackagedApp();
if (!app) {
  fail(`No packaged app layout known for platform ${process.platform}`);
}

step('Verifying packaged native modules load in the packaged Electron');

if (!existsSync(app.electronBin)) {
  fail(`Packaged Electron binary not found at ${app.electronBin}`);
}

// Absolute, because the packaged binary runs under the hardened runtime on macOS and dyld
// rejects a relative dlopen path there outright ("relative path not allowed in hardened
// program") — which would fail this check for a reason that has nothing to do with the ABI.
const modulePaths = REQUIRED_MODULES.map((rel) => resolve(app.unpackedRoot, rel));
for (const modulePath of modulePaths) {
  if (!existsSync(modulePath)) {
    fail(`Packaged native module not found at ${modulePath}`);
  }
}

// Printed by the child so the log records which ABI actually judged the modules.
const script = `
const paths = ${JSON.stringify(modulePaths)};
console.log('electron=' + process.versions.electron + ' node=' + process.version +
  ' NODE_MODULE_VERSION=' + process.versions.modules);
let failed = 0;
for (const p of paths) {
  try {
    process.dlopen({ exports: {} }, p);
    console.log('ok ' + p);
  } catch (error) {
    failed++;
    console.log('FAIL ' + p + ' :: ' + String(error && error.message).replace(/\\s+/g, ' '));
  }
}
process.exit(failed === 0 ? 0 : 1);
`;

const result = spawnSync(app.electronBin, ['-e', script], {
  encoding: 'utf-8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

if (result.error) {
  fail(`Could not run the packaged Electron binary: ${result.error.message}`);
}

for (const line of (result.stdout ?? '').trim().split('\n').filter(Boolean)) {
  info(line);
}

if (result.status !== 0) {
  const stderr = (result.stderr ?? '').trim();
  if (stderr) info(stderr);
  fail(
    'Packaged native modules do not load in the packaged Electron. The most likely cause is a ' +
      'missed electron-rebuild: see the --project-root note in rebuild-native.ts.'
  );
}

info(`Verified ${modulePaths.length} packaged native module(s)`);
