import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

/** A PR conversation comment (GitHub "issue comment"), not a review comment. */
export interface IssueComment {
  /** GraphQL node id (IC_…) */
  id: string;
  body: string;
  authorLogin: string;
  /** GitHub App / bot account. Bot mentions are never answered. */
  authorIsBot: boolean;
  createdAt: string;
  updatedAt: string;
  isMinimized: boolean;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GqlIssueComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  isMinimized: boolean;
  author: { login: string; __typename: string } | null;
}

interface CommentsPage {
  repository: {
    pullRequest: {
      state: PullRequestState;
      comments: {
        pageInfo: PageInfo;
        nodes: GqlIssueComment[];
      };
    } | null;
  } | null;
}

/** Fully paginated PR conversation, oldest first, plus the PR state. */
export async function listPrIssueComments(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<{ state: PullRequestState; comments: IssueComment[] }> {
  const octokit = github.getOctokit(githubToken);
  const comments: IssueComment[] = [];
  let state: PullRequestState = "OPEN";
  let cursor: string | null = null;

  for (;;) {
    const data: CommentsPage = await octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            state
            comments(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                body
                createdAt
                updatedAt
                isMinimized
                author { login __typename }
              }
            }
          }
        }
      }`,
      { owner: pr.owner, repo: pr.repo, number: pr.prNumber, cursor },
    );

    const pull = data.repository?.pullRequest;
    if (!pull) {
      throw new Error(`PR not found: ${pr.owner}/${pr.repo}#${pr.prNumber}`);
    }
    state = pull.state;
    for (const node of pull.comments.nodes) {
      comments.push({
        id: node.id,
        body: node.body,
        authorLogin: node.author?.login ?? "",
        authorIsBot: node.author?.__typename === "Bot",
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        isMinimized: node.isMinimized,
      });
    }

    if (!pull.comments.pageInfo.hasNextPage) break;
    cursor = pull.comments.pageInfo.endCursor;
  }

  return { state, comments: sortByCreatedAt(comments) };
}

/** Post a PR conversation comment. */
export async function createPrIssueComment(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
  body: string,
): Promise<void> {
  const octokit = github.getOctokit(githubToken);
  await octokit.rest.issues.createComment({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.prNumber,
    body,
  });
}

/** GitHub does not document connection order; normalize for snapshots. */
export function sortByCreatedAt<T extends { createdAt: string }>(
  items: T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byDate =
        Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt);
      return byDate || a.index - b.index;
    })
    .map(({ item }) => item);
}
