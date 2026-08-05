/**
 * The fork's single most expensive mistake to ship, so it gets its own guard.
 *
 * `app-update.yml` is written into the bundle at packaging time and there is no
 * `setFeedURL` anywhere in the app, so the feed a build ships with is the feed it uses
 * forever. A fork artifact packaged with the upstream config would advertise
 * generalaction/emdash + releases.emdash.sh, offer upstream's next stable release, and
 * replace the fork's features on install — with no error anywhere, because from the
 * updater's point of view nothing went wrong.
 *
 * Asserting on the embedded manifest rather than on the config file we meant to pass is
 * the point: it catches a mistyped `--config`, a fork config that spread the wrong base,
 * and electron-builder resolving a publisher we did not ask for.
 */

/** The fork's own GitHub release feed; anything else must not reach a fork build. */
const FORK_OWNER = '64ix';
const FORK_REPO = 'emdash';

/** Upstream feeds, both halves of `electron-builder.config.ts`'s `publish` block. */
const UPSTREAM_MARKERS = ['generalaction', 'releases.emdash.sh'];

/**
 * Returns one message per problem found in a packaged `app-update.yml`, or an empty
 * array when the manifest points at the fork and nothing else.
 *
 * Parsed line-wise rather than with a YAML parser: the file is flat, electron-builder
 * writes it, and a dependency-free check runs anywhere in the release pipeline.
 */
export function findUpdateFeedProblems(contents: string): string[] {
  const problems: string[] = [];
  const value = (key: string): string | undefined => {
    for (const line of contents.split('\n')) {
      const match = line.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`));
      if (match) return match[1].replace(/^['"]|['"]$/g, '');
    }
    return undefined;
  };

  const owner = value('owner');
  if (owner !== FORK_OWNER) {
    problems.push(
      `expected "owner: ${FORK_OWNER}", found ${owner === undefined ? 'no owner key' : `"${owner}"`}`
    );
  }

  const repo = value('repo');
  if (repo !== FORK_REPO) {
    problems.push(
      `expected "repo: ${FORK_REPO}", found ${repo === undefined ? 'no repo key' : `"${repo}"`}`
    );
  }

  for (const marker of UPSTREAM_MARKERS) {
    if (contents.includes(marker)) {
      problems.push(`references the upstream update feed ("${marker}")`);
    }
  }

  // An unsigned Windows build that advertises a publisher makes NsisUpdater run
  // verifySignature and reject every update it downloads. See
  // electron-builder.fork.windows.config.ts.
  const publisherName = value('publisherName');
  if (publisherName !== undefined) {
    problems.push(
      `carries "publisherName: ${publisherName}"; fork installers are unsigned, so the updater would refuse every update`
    );
  }

  return problems;
}
