import { cwd } from 'node:process';
import { parseArgs } from 'node:util';
import { rebuild } from '@electron/rebuild';
import { NATIVE_MODULES } from './lib/config.ts';
import { exec } from './lib/exec.ts';
import { fail, info, step } from './lib/log.ts';

const { values } = parseArgs({
  options: {
    arch: { type: 'string' },
    'deploy-dir': { type: 'string' },
    'project-root': { type: 'string' },
  },
  strict: true,
});

const arch = values.arch;
if (!arch || !['arm64', 'x64'].includes(arch)) {
  fail('Usage: rebuild-native.ts --arch arm64|x64 [--deploy-dir <path>] [--project-root <path>]');
}

const deployDir = values['deploy-dir'];
const buildPath = deployDir ?? cwd();

// @electron/rebuild needs two things to agree, and under pnpm's hoisted linker no single
// directory provides both: the package.json whose prod dependencies name the native modules
// (that is the app's), and the node_modules tree they physically live in (that is the
// workspace root's, because they are hoisted out of the app). Given only buildPath it uses it
// for both, so the app directory yields "not installed" and the workspace root yields "not a
// dependency" — either way it silently rebuilds nothing and exits 0 in about a second.
//
// `--deploy-dir` sidesteps this because `pnpm deploy --legacy --prod` writes a self-contained
// tree where both are true at once. Packaging in place (see .github/workflows/release-fork.yml,
// which must use the fork config, whose file mappings are relative to the app directory) has
// to say so explicitly instead.
//
// Getting this wrong is invisible until runtime: electron-builder runs with npmRebuild false,
// so whatever `pnpm install` compiled for the CI runner's system Node gets packaged as is, and
// Electron keeps its own NODE_MODULE_VERSION namespace — Electron 40 wants 143 where Node 24
// produces 137, so they can never coincidentally match. The packaged app then dies on its
// first `require('better-sqlite3')`. Fork release v1.2.8 shipped exactly that.
const projectRootPath = values['project-root'] ?? buildPath;

const electronVersion = exec('node -p "require(\'electron/package.json\').version"');
step(`Rebuilding native modules for ${arch} (Electron ${electronVersion})`);
info(`buildPath: ${buildPath}`);
info(`projectRootPath: ${projectRootPath}`);

await rebuild({
  buildPath,
  projectRootPath,
  electronVersion,
  arch,
  onlyModules: NATIVE_MODULES,
  force: true,
  buildFromSource: true,
});

info(`Native modules rebuilt for ${arch}`);
