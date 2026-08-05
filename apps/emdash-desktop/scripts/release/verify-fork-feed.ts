import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_NAME, RELEASE_DIR } from './lib/config.ts';
import { fail, info, step } from './lib/log.ts';
import { findUpdateFeedProblems } from './lib/update-feed.ts';

// Where electron-builder leaves the unpacked bundle for each platform the fork ships.
const FEED_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: join(
    RELEASE_DIR,
    'mac-arm64',
    `${PRODUCT_NAME}.app`,
    'Contents',
    'Resources',
    'app-update.yml'
  ),
  win32: join(RELEASE_DIR, 'win-unpacked', 'resources', 'app-update.yml'),
};

const feedPath = FEED_PATHS[process.platform];
if (!feedPath) {
  fail(`No packaged update feed location known for platform ${process.platform}`);
}

step(`Verifying the update feed embedded in ${feedPath}`);

if (!existsSync(feedPath)) {
  fail(`${feedPath} is missing; the packaged app has no update feed to check`);
}

const contents = readFileSync(feedPath, 'utf-8');
info(contents.trimEnd().split('\n').join('\n    '));

const problems = findUpdateFeedProblems(contents);
if (problems.length > 0) {
  fail(`${feedPath} is not a fork update feed: ${problems.join('; ')}`);
}

info('Update feed points at 64ix/emdash and nothing else');
