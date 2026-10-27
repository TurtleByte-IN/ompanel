const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;

function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

async function isCommitOnDefaultBranch({ github, context, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${sha}...${defaultBranch}`,
    per_page: 1,
  });
  return {
    contained: comparison.status === "ahead" || comparison.status === "identical",
    comparison,
    defaultBranch,
  };
}

async function assertCommitOnDefaultBranch({ github, context, sha }) {
  const { contained, comparison, defaultBranch } = await isCommitOnDefaultBranch({
    github,
    context,
    sha,
  });
  if (!contained) {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

// A pushed prerelease tag (`v1.2.3-rc.1`) is a release candidate: like a preview it may come
// from any commit, never becomes the latest release, and is never what a stable or nightly
// install updates to. Plain `vX.Y.Z` tags still have to be on the default branch.
const isPrereleaseTagPush = (context) =>
  context.eventName === "push" && /^refs\/tags\/v\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(context.ref);

// Only reviewed code is signed or published to npm: a build of a commit on the default branch.
// Previews and release candidates cut from other commits build unsigned. The `release`
// environment's required reviewers are the real guard, since a tagged commit can edit this check.
async function mayReleaseSign({ github, context, releaseChannel, sha }) {
  if (releaseChannel === "preview") return false;
  return (await isCommitOnDefaultBranch({ github, context, sha })).contained;
}

async function assertReleaseSource({ github, context, releaseChannel }) {
  if (releaseChannel === "preview") return;
  if (releaseChannel === "stable" && isPrereleaseTagPush(context)) return;
  if (releaseChannel !== "stable" && releaseChannel !== "nightly") {
    throw new Error(`Unsupported release channel: ${releaseChannel}`);
  }

  const defaultBranch = repositoryDefaultBranch(context);
  if (context.eventName === "workflow_dispatch" && context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error(
      `${releaseChannel} releases must be dispatched from ${defaultBranch}; selected ${context.ref}. Use the preview channel for branch builds.`,
    );
  }

  await assertCommitOnDefaultBranch({ github, context, sha: context.sha });
}

const isNightlyTag = (tag) => /^v.*-nightly\./.test(tag) || tag.startsWith("nightly-v");

async function findLatestNightly({ github, context }) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  return releases
    .filter((release) => !release.draft && release.published_at && isNightlyTag(release.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

async function shouldReleaseNightly({ github, context, core, now = Date.now() }) {
  const lastNightly = await findLatestNightly({ github, context });

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  if (now - Date.parse(lastNightly.published_at) < MINIMUM_RELEASE_GAP_MS) {
    core.info(`Nightly ${lastNightly.tag_name} was published less than six hours ago. Skipping.`);
    return false;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${lastNightly.tag_name}...${context.sha}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead") {
    core.info(
      `Candidate commit is ${comparison.status} relative to ${lastNightly.tag_name}. Skipping.`,
    );
    return false;
  }

  core.info(`New commits since ${lastNightly.tag_name}, and the six-hour gap has passed.`);
  return true;
}

async function resolveLatestNightlyCommit({ github, context, core }) {
  const lastNightly = await findLatestNightly({ github, context });
  if (!lastNightly) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  const tag = lastNightly.tag_name;
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  const version = /^(?:nightly-)?v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
  if (!version) {
    throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
  }

  core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
  return { tag, sha: commit.sha, version };
}

module.exports = {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  mayReleaseSign,
  shouldReleaseNightly,
  resolveLatestNightlyCommit,
};
