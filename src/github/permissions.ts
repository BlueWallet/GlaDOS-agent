import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";

export interface PermissionLevel {
  permission?: string;
  role_name?: string;
}

/** Looks up one user's permission on the PR's repository. */
export type PermissionLookup = (login: string) => Promise<PermissionLevel>;

const WRITE_PERMISSIONS = new Set(["admin", "write"]);
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

export function isBotLogin(login: string): boolean {
  return /\[bot\]$/i.test(login);
}

/** Write, maintain, or admin. `permission` folds maintain into write; the role keeps it. */
export function isWriteAccess(data: PermissionLevel): boolean {
  return (
    WRITE_PERMISSIONS.has(data.permission ?? "") ||
    WRITE_ROLES.has(data.role_name ?? "")
  );
}

export function repositoryPermissionLookup(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo">,
): PermissionLookup {
  const octokit = github.getOctokit(githubToken);
  return async (username) => {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: pr.owner,
      repo: pr.repo,
      username,
    });
    return data;
  };
}

/**
 * Lowercase logins whose words count as the owner's: write, maintain, or
 * admin access. Being the PR author is not enough. GLaDOS and bots never
 * count; a lookup that fails counts as untrusted.
 */
export async function loadTrustedLogins(
  lookup: PermissionLookup,
  logins: Iterable<string>,
  gladosLogin: string,
): Promise<Set<string>> {
  const glados = gladosLogin.toLowerCase();
  const eligible = (login: string) =>
    login !== "" && login !== glados && !isBotLogin(login);

  const trusted = new Set<string>();
  const candidates = new Set(
    [...logins].map((login) => login.toLowerCase()).filter(eligible),
  );
  await Promise.all(
    [...candidates].map(async (login) => {
      try {
        if (isWriteAccess(await lookup(login))) trusted.add(login);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Permission lookup failed for ${login}; not trusted: ${message}`);
      }
    }),
  );
  return trusted;
}
