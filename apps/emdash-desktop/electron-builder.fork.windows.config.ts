import type { Configuration } from 'electron-builder';
import forkConfig from './electron-builder.fork.config.ts';

// Personal fork Windows builds intentionally remain unsigned until the fork owns a
// Windows code-signing certificate. Removing the upstream Azure configuration also
// prevents electron-updater from embedding General Action as the expected publisher.
const config: Configuration = {
  ...forkConfig,
  win: {
    ...forkConfig.win,
    azureSignOptions: undefined,
    signExecutable: false,
  },
};

export default config;
