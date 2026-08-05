import { RequestError } from "@octokit/request-error";
import {
  listNotifications,
  markNotificationDone,
} from "../github/notifications.js";
import {
  listReviewRequestedPullRequests,
  pullRequestRefFromNotification,
  subjectUrlToWebUrl,
} from "../github/pr.js";
import { processPrReview } from "../review/process.js";
import { processPrThreadReplies } from "../review/thread-process.js";

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
  const [{ login, notifications }, reviewRequestedPrs] = await Promise.all([
    listNotifications(token, showAll),
    listReviewRequestedPullRequests(token),
  ]);

  for (const pr of reviewRequestedPrs) {
    console.log(`  ${pr.owner}/${pr.repo} #${pr.prNumber}`);
    console.log(`  ${pr.prUrl}`);
    await processPrReview(pr, {
      githubToken: token,
      cursorApiKey,
    });
    console.log();
  }

  console.log(`Notifications for @${login}${showAll ? " (including read)" : ""}\n`);

  for (const n of notifications) {
    const unread = n.unread ? "unread" : "read";
    const repo = n.repository?.full_name ?? "?";
    const title = n.subject?.title ?? "(no title)";

    console.log(`[${unread}] ${n.reason} · ${n.subject?.type ?? "?"}`);
    console.log(`  ${repo} — ${title}`);
    if (n.subject?.url) {
      console.log(`  ${subjectUrlToWebUrl(n.subject.url)}`);
    }

    // GitHub coalesces all activity for a PR into one notification. Use the
    // notification only as a wake-up and inspect all GLaDOS threads remotely.
    const notifiedPr = pullRequestRefFromNotification(
      n.subject?.type,
      n.subject?.url,
    );
    if (notifiedPr) {
      console.log(
        `  Checking review threads on ${notifiedPr.owner}/${notifiedPr.repo}#${notifiedPr.prNumber}`,
      );
      const ok = await processPrThreadReplies(notifiedPr, {
        githubToken: token,
        cursorApiKey,
      });
      if (ok) {
        await markNotificationDone(token, n.id);
      } else {
        console.error("  Leaving notification for retry");
      }
      continue;
    }

    // See: https://docs.github.com/en/rest/activity/notifications?apiVersion=2022-11-28#about-notifications
    switch (n.reason) {
      case "assign": // You were assigned to the issue.
      case "mention": // You were specifically @mentioned in the content.
      default:
        await markNotificationDone(token, n.id);
        break;
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
