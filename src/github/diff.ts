import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * RIGHT-side line numbers GitHub will accept a review comment on, per file.
 * A line is commentable if it appears in the PR diff as an added (`+`) or
 * context (` `) line — deleted lines live on the LEFT side and are excluded.
 */
export type CommentableLines = Map<string, Set<number>>;

export async function getCommentableLines(
  octokit: Octokit,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<CommentableLines> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.prNumber,
    per_page: 100,
  });

  const map: CommentableLines = new Map();
  for (const file of files) {
    if (!file.patch) continue;
    map.set(file.filename, rightSideLinesFromPatch(file.patch));
  }
  return map;
}

/** Parse a unified-diff patch and collect RIGHT-side (new file) line numbers. */
function rightSideLinesFromPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    if (raw.startsWith("+")) {
      lines.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      // deletion: LEFT side only, does not advance the new-file cursor
    } else {
      // context line: present on the RIGHT side and commentable
      lines.add(newLine);
      newLine++;
    }
  }

  return lines;
}
