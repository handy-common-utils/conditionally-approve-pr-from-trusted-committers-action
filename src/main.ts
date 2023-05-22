import * as core from '@actions/core';
import * as github from '@actions/github';

type GitHub = ReturnType<typeof github.getOctokit>;

async function approveIfAllCommittersAreTrusted(
  config,
  client: GitHub,
  pr: any
) {
  // Get a pull request
  const { data: pullRequest } = await client.rest.pulls.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: pr.number,
  });

  // Get creator of PR
  const pr_user = pullRequest.user?.login;

  core.info(`PR #${pr.number} was opened by ${pr_user}`);

  // Get list of commits on a PR
  const { data: listCommits } = await client.rest.pulls.listCommits({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: pr.number,
  });

  // Get all committers on a PR
  for (let commit of listCommits) {
    // Check if there are committers other than those in trustedCommitters
    if (!config.trustedCommitters[commit.author?.login ?? '!']) {
      core.info(
        `Will not approve PR #${
          pr.number
        } because at least one commit (${commit.sha.substring(
          0,
          7
        )}) was made by ${
          commit.author?.login
        } who is not one of the trusted committers: ${JSON.stringify(
          Object.keys(config.trustedCommitters)
        )}`
      );
      return false;
    }
  }

  core.debug(`Creating approving review for pull request #${pr.number}`);
  await client.rest.pulls.createReview({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: pr.number,
    event: 'APPROVE',
  });
  core.info(`Approved pull request #${pr.number}`);

  return true;
}

async function removeExistingApprovalsIfExist(config, client: GitHub, pr: any) {
  // Get list of all reviews on a PR
  const { data: listReviews } = await client.rest.pulls.listReviews({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: pr.number,
  });

  // Check if there is an approval by those in manageApprovalsForRevewers
  for (let review of listReviews) {
    if (
      config.manageApprovalsForRevewers[review.user?.login ?? '!'] &&
      review.state === `APPROVED`
    ) {
      core.info(`Removing an approval from ${review.user?.login}`);
      await client.rest.pulls.dismissReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr.number,
        review_id: review.id,
        message: `A commit was added after an auto approval`,
      });
      core.info(`Removed approval from ${review.user?.login}`);
    }
  }
}

async function enableAutoMerge(config, client: GitHub, pr: any) {
  const { id } = await client.graphql(`
    query MyQuery {
      repository(name: "${github.context.repo.repo}", owner: "${github.context.repo.owner}") {
        pullRequest(number: ${pr.number}) {
          id
        }
      } 
    }
  `) as any;
  await client.graphql(`
    mutation MyMutation {
      enablePullRequestAutoMerge(input: {pullRequestId: "${id}"}) {
        clientMutationId
      }
    }
  `);
}

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });

    const config = {
      trustedCommitters: core
        .getInput('trusted-committers')
        .split(/,\s*/)
        .reduce((acc, name) => ({ ...acc, [name]: true }), {}),
      manageApprovalsForRevewers: core
        .getInput('manage-approvals-for-reviewers')
        .split(/,\s*/)
        .reduce((acc, name) => ({ ...acc, [name]: true }), {}),
      enableAutoMerge:
        core.getInput('enable-auto-merge').toLocaleLowerCase() === 'true',
    };

    const { pull_request: pr } = github.context.payload;
    if (!pr) {
      throw new Error(
        'Event payload missing `pull_request` - workflow containing this action is supposed to be triggered by `pull_request` or `pull_request_target` event'
      );
    }

    const client = github.getOctokit(token);

    if (!(await approveIfAllCommittersAreTrusted(config, client, pr))) {
      await removeExistingApprovalsIfExist(config, client, pr);
    }
    if (config.enableAutoMerge) {
      await enableAutoMerge(config, client, pr);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

run();
