import { RequestError } from "@octokit/request-error";
import {
  listNotifications,
  markNotificationDone,
} from "../github/notifications.js";
import { parsePullRequest, subjectUrlToWebUrl } from "../github/pr.js";
import { processReviewRequest } from "../review/process.js";

const token = process.env.GLADOS_TOKEN;
if (!token) {
  console.error("Set GLADOS_TOKEN first:");
  console.error("  export GLADOS_TOKEN='ghp_...'");
  process.exit(1);
}

const cursorApiKey = process.env.CURSOR_API_KEY;
if (!cursorApiKey) {
  console.error("Set CURSOR_API_KEY first:");
  console.error("  export CURSOR_API_KEY='cursor_...'");
  process.exit(1);
}

const showAll = process.argv.includes("--all");

try {
  const { login, notifications } = await listNotifications(token, showAll);

  console.log(`Notifications for @${login}${showAll ? " (including read)" : ""}\n`);

  if (notifications.length === 0) {
    console.log("No notifications.");
    process.exit(0);
  }

  for (const n of notifications.filter((n) => n.reason === "review_requested")) {
    const unread = n.unread ? "unread" : "read";
    const repo = n.repository?.full_name ?? "?";
    const title = n.subject?.title ?? "(no title)";
    const pr = parsePullRequest(n);

    console.log(`[${unread}] ${n.reason} · ${n.subject?.type ?? "?"}`);
    console.log(`  ${repo} — ${title}`);
    if (pr) {
      console.log(`  ${pr.prUrl}`);
    } else if (n.subject?.url) {
      console.log(`  ${subjectUrlToWebUrl(n.subject.url)}`);
    }
    console.log();
    const ok = await processReviewRequest(n, { githubToken: token, cursorApiKey });
    if (ok) {
      await markNotificationDone(token, n.id);
    }
  }

  console.log(`${notifications.length} notification(s)`);
} catch (err) {
  if (err instanceof RequestError) {
    console.error(`GitHub API error (${err.status}): ${err.message}`);
    process.exit(1);
  }
  throw err;
}
