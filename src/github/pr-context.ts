import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";
import {
  listPrIssueComments,
  sortByCreatedAt,
  type IssueComment,
  type PullRequestState,
} from "./comments.js";
import { listReviewThreads, type ReviewThread } from "./threads.js";

export type PrReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export interface PrReview {
  id: string;
  state: PrReviewState;
  body: string;
  authorLogin: string;
  submittedAt: string | null;
}

export interface LinkedIssue {
  number: number;
  /** owner/name — closing references may live in another repository. */
  repository: string;
  title: string;
  body: string;
}

/** Everything the review agent is told about a PR besides the checkout. */
export interface PrContext {
  viewerLogin: string;
  number: number;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  headRefOid: string;
  authorLogin: string;
  state: PullRequestState;
  issues: LinkedIssue[];
  reviews: PrReview[];
  comments: IssueComment[];
  threads: ReviewThread[];
}

type Octokit = ReturnType<typeof github.getOctokit>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CorePage {
  viewer: { login: string };
  repository: {
    pullRequest: {
      title: string;
      body: string;
      baseRefName: string;
      headRefOid: string;
      state: PullRequestState;
      author: { login: string } | null;
    } | null;
  } | null;
}

interface IssuesPage {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        pageInfo: PageInfo;
        nodes: Array<{
          number: number;
          title: string;
          body: string;
          repository: { nameWithOwner: string };
        }>;
      };
    } | null;
  } | null;
}

interface ReviewsPage {
  repository: {
    pullRequest: {
      reviews: {
        pageInfo: PageInfo;
        nodes: Array<{
          id: string;
          state: PrReviewState;
          body: string;
          submittedAt: string | null;
          author: { login: string } | null;
        }>;
      };
    } | null;
  } | null;
}

export async function fetchPrContext(
  githubToken: string,
  pr: PullRequestRef,
): Promise<PrContext> {
  const octokit = github.getOctokit(githubToken);
  const [core, issues, reviews, conversation, threads] = await Promise.all([
    fetchCore(octokit, pr),
    listLinkedIssues(octokit, pr),
    listReviews(octokit, pr),
    listPrIssueComments(githubToken, pr),
    listReviewThreads(githubToken, pr),
  ]);

  return {
    viewerLogin: core.viewer.login,
    number: pr.prNumber,
    url: pr.prUrl,
    title: core.pull.title,
    body: core.pull.body,
    baseRefName: core.pull.baseRefName,
    headRefOid: core.pull.headRefOid,
    authorLogin: core.pull.author?.login ?? "ghost",
    state: core.pull.state,
    issues,
    reviews,
    comments: conversation.comments,
    threads,
  };
}

async function fetchCore(
  octokit: Octokit,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<{
  viewer: CorePage["viewer"];
  pull: NonNullable<NonNullable<CorePage["repository"]>["pullRequest"]>;
}> {
  const data: CorePage = await octokit.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      viewer { login }
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          title
          body
          baseRefName
          headRefOid
          state
          author { login }
        }
      }
    }`,
    { owner: pr.owner, repo: pr.repo, number: pr.prNumber },
  );
  const pull = data.repository?.pullRequest;
  if (!pull) {
    throw new Error(`PR not found: ${pr.owner}/${pr.repo}#${pr.prNumber}`);
  }
  return { viewer: data.viewer, pull };
}

/** Issues linked by closing keywords or the Development sidebar, fully paginated. */
async function listLinkedIssues(
  octokit: Octokit,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<LinkedIssue[]> {
  const issues: LinkedIssue[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: IssuesPage = await octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                number
                title
                body
                repository { nameWithOwner }
              }
            }
          }
        }
      }`,
      { owner: pr.owner, repo: pr.repo, number: pr.prNumber, cursor },
    );

    const connection = data.repository?.pullRequest?.closingIssuesReferences;
    if (!connection) {
      throw new Error(`PR not found: ${pr.owner}/${pr.repo}#${pr.prNumber}`);
    }
    for (const node of connection.nodes) {
      issues.push({
        number: node.number,
        repository: node.repository.nameWithOwner,
        title: node.title,
        body: node.body,
      });
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return issues;
}

/** Fully paginated reviews, oldest first. Includes the viewer's own PENDING review. */
async function listReviews(
  octokit: Octokit,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<PrReview[]> {
  const reviews: Array<PrReview & { createdAt: string }> = [];
  let cursor: string | null = null;

  for (;;) {
    const data: ReviewsPage = await octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviews(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                state
                body
                submittedAt
                author { login }
              }
            }
          }
        }
      }`,
      { owner: pr.owner, repo: pr.repo, number: pr.prNumber, cursor },
    );

    const connection = data.repository?.pullRequest?.reviews;
    if (!connection) {
      throw new Error(`PR not found: ${pr.owner}/${pr.repo}#${pr.prNumber}`);
    }
    for (const node of connection.nodes) {
      reviews.push({
        id: node.id,
        state: node.state,
        body: node.body,
        authorLogin: node.author?.login ?? "ghost",
        submittedAt: node.submittedAt,
        // Pending reviews have no submittedAt; sort them last.
        createdAt: node.submittedAt ?? "9999-12-31T00:00:00Z",
      });
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return sortByCreatedAt(reviews).map(({ createdAt: _, ...review }) => review);
}
