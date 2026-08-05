import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";

export interface ReviewThreadComment {
  /** GraphQL node id */
  id: string;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewThread {
  /** GraphQL PullRequestReviewThread id (PRRT_…) */
  id: string;
  isResolved: boolean;
  viewerCanResolve: boolean;
  path: string;
  line: number | null;
  comments: ReviewThreadComment[];
}

type Octokit = ReturnType<typeof github.getOctokit>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GqlComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
}

interface GqlThread {
  id: string;
  isResolved: boolean;
  viewerCanResolve: boolean;
  path: string;
  line: number | null;
  comments: {
    pageInfo: PageInfo;
    nodes: GqlComment[];
  };
}

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: PageInfo;
        nodes: GqlThread[];
      };
    } | null;
  } | null;
}

export async function getAuthenticatedLogin(
  githubToken: string,
): Promise<string> {
  const octokit = github.getOctokit(githubToken);
  const { data: user } = await octokit.rest.users.getAuthenticated();
  return user.login;
}

/** Fully paginated PR review threads (threads + comments). */
export async function listReviewThreads(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<ReviewThread[]> {
  const octokit = github.getOctokit(githubToken);
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: ThreadsPage = await octokit.graphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                viewerCanResolve
                path
                line
                comments(first: 50) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    id
                    body
                    createdAt
                    updatedAt
                    author { login }
                  }
                }
              }
            }
          }
        }
      }`,
      {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.prNumber,
        cursor,
      },
    );

    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection) {
      throw new Error(
        `PR not found: ${pr.owner}/${pr.repo}#${pr.prNumber}`,
      );
    }

    for (const node of connection.nodes) {
      threads.push(await materializeThread(octokit, node));
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return threads;
}

/** Load one current thread and its complete edit-aware history. */
export async function getReviewThread(
  githubToken: string,
  threadId: string,
): Promise<ReviewThread | null> {
  const octokit = github.getOctokit(githubToken);
  const data = await octokit.graphql<{ node: GqlThread | null }>(
    `query($id: ID!) {
      node(id: $id) {
        ... on PullRequestReviewThread {
          id
          isResolved
          viewerCanResolve
          path
          line
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              body
              createdAt
              updatedAt
              author { login }
            }
          }
        }
      }
    }`,
    { id: threadId },
  );
  return data.node ? materializeThread(octokit, data.node) : null;
}

async function materializeThread(
  octokit: Octokit,
  node: GqlThread,
): Promise<ReviewThread> {
  return {
    id: node.id,
    isResolved: node.isResolved,
    viewerCanResolve: node.viewerCanResolve,
    path: node.path,
    line: node.line,
    comments: await loadAllComments(octokit, node),
  };
}

async function loadAllComments(
  octokit: Octokit,
  thread: GqlThread,
): Promise<ReviewThreadComment[]> {
  const comments = mapComments(thread.comments.nodes);
  let cursor = thread.comments.pageInfo.hasNextPage
    ? thread.comments.pageInfo.endCursor
    : null;

  while (cursor) {
    const data = await octokit.graphql<{
      node: {
        comments: {
          pageInfo: PageInfo;
          nodes: GqlComment[];
        };
      } | null;
    }>(
      `query($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on PullRequestReviewThread {
            comments(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                body
                createdAt
                updatedAt
                author { login }
              }
            }
          }
        }
      }`,
      { id: thread.id, cursor },
    );

    const connection = data.node?.comments;
    if (!connection) break;
    comments.push(...mapComments(connection.nodes));
    cursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  }

  return sortReviewThreadComments(comments);
}

/** GitHub does not document connection order; normalize before root/last use. */
export function sortReviewThreadComments(
  comments: ReviewThreadComment[],
): ReviewThreadComment[] {
  return comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => {
      const byDate = Date.parse(a.comment.createdAt) - Date.parse(b.comment.createdAt);
      return byDate || a.index - b.index;
    })
    .map(({ comment }) => comment);
}

function mapComments(nodes: GqlComment[]): ReviewThreadComment[] {
  return nodes.map((node) => {
    return {
      id: node.id,
      body: node.body,
      authorLogin: node.author?.login ?? "",
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  });
}

/** Reply directly by GraphQL thread id; avoids deprecated numeric IDs. */
export async function replyToReviewThread(
  githubToken: string,
  threadId: string,
  body: string,
): Promise<void> {
  const octokit = github.getOctokit(githubToken);
  await octokit.graphql(
    `mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(
        input: { pullRequestReviewThreadId: $threadId, body: $body }
      ) {
        comment { id }
      }
    }`,
    { threadId, body },
  );
}

export async function resolveReviewThread(
  githubToken: string,
  threadId: string,
): Promise<void> {
  const octokit = github.getOctokit(githubToken);
  await octokit.graphql(
    `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }`,
    { threadId },
  );
}
