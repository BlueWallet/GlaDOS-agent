import * as github from "@actions/github";
import type { NotificationThread } from "../types.js";

export async function listNotifications(
  token: string,
  all: boolean,
): Promise<{ login: string; notifications: NotificationThread[] }> {
  const octokit = github.getOctokit(token);
  const { data: user } = await octokit.rest.users.getAuthenticated();
  const notifications = await octokit.paginate(
    octokit.rest.activity.listNotificationsForAuthenticatedUser,
    { all, per_page: 100 },
  );
  return { login: user.login, notifications };
}
