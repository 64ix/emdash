import type { Configuration } from 'electron-builder';
import forkConfig from './electron-builder.fork.config.ts';

// Personal fork Windows builds intentionally remain unsigned until the fork owns a
// Windows code-signing certificate. Everything else — including the 64ix/emdash update
// feed — comes from the fork config; only the signing surface changes here.
//
// `azureSignOptions` carries upstream's `publisherName: 'General Action, Inc.'`, and
// with `verifyUpdateCodeSignature` left at its default electron-builder resolves a
// publisher name and writes it into app-update.yml. NsisUpdater then runs
// verifySignature against it and refuses every update, because our installers carry no
// signature at all. Dropping the Azure block alone is not enough to guarantee that: the
// signtool manager it falls back to would happily derive a name from any CSC_* material
// that showed up in the environment, so state the intent instead of relying on its
// absence. With no publisher name in app-update.yml the updater skips verification,
// which is the only way an unsigned build can update itself.
const config: Configuration = {
  ...forkConfig,
  win: {
    ...forkConfig.win,
    azureSignOptions: undefined,
    signExecutable: false,
    verifyUpdateCodeSignature: false,
  },
};

export default config;
