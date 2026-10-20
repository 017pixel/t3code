const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;

function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

async function assertCommitOnDefaultBranch({ github, context, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${sha}...${defaultBranch}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

async function assertReleaseSource({ github, context, releaseChannel }) {
  if (releaseChannel === "preview") return;
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

async function listActiveReleaseRuns({ github, context, event }) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: "release.yml",
    event,
    per_page: 30,
  });
  return data.workflow_runs.filter((run) => run.status !== "completed" && run.id !== context.runId);
}

async function shouldReleaseNightly({ github, context, core, now = Date.now() }) {
  // Manual runs queue apart from scheduled ones, so one can be building now.
  // Leave the release to it; the six-hour gap covers the runs after it.
  const [manualRun] = await listActiveReleaseRuns({ github, context, event: "workflow_dispatch" });
  if (manualRun) {
    core.info(`Manual release run ${manualRun.html_url} is active. Skipping.`);
    return false;
  }

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

const isStarted = (job) => job?.status === "in_progress" || job?.status === "completed";
const hasFailed = (job) => ["failure", "cancelled", "timed_out"].includes(job.conclusion);

// A manual nightly takes over from scheduled nightlies, so it never waits
// behind one. A healthy scheduled run building the same commit is left to
// finish and the manual run stands down. Any other is canceled, unless it is
// already publishing: publishers are never interrupted, and a manual run needs
// far longer to reach its own publish step. That includes runs still deciding
// whether to build, which may have checked for manual runs before this one
// existed. Returns whether to build.
async function takeOverScheduledNightlies({ github, context, core }) {
  for (const run of await listActiveReleaseRuns({ github, context, event: "schedule" })) {
    const { data } = await github.rest.actions.listJobsForWorkflowRun({
      ...context.repo,
      run_id: run.id,
      filter: "latest",
      per_page: 100,
    });
    const preflight = data.jobs.find((job) => job.name === "Preflight");
    if (preflight?.conclusion === "skipped") continue;

    if (preflight && run.head_sha === context.sha && !data.jobs.some(hasFailed)) {
      core.notice(`Scheduled run ${run.html_url} already builds ${context.sha}. Skipping.`);
      return false;
    }
    if (isStarted(data.jobs.find((job) => job.name === "Publish GitHub Release"))) {
      core.info(`Scheduled run ${run.html_url} is publishing. Leaving it to finish.`);
      continue;
    }
    try {
      await github.rest.actions.cancelWorkflowRun({ ...context.repo, run_id: run.id });
      core.notice(`Canceled scheduled run ${run.html_url} in favor of this one.`);
    } catch (error) {
      // GitHub refuses to cancel a run that finished after it was listed.
      if (error.status !== 409) throw error;
    }
  }
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
  shouldReleaseNightly,
  takeOverScheduledNightlies,
  resolveLatestNightlyCommit,
};
