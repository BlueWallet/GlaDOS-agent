import type { PrContext, PrReview } from "../github/pr-context.js";
import type { ReviewThread } from "../github/threads.js";

export const PR_CONTEXT_BUDGET = 50_000;

export interface FormatPrContextOptions {
  /** Total character budget for the rendered block. */
  budget?: number;
  /** Per-body cap for comments, reviews, and thread comments. */
  bodyCap?: number;
  /** Per-body cap for the PR description and linked issues. */
  primaryBodyCap?: number;
}

/**
 * Inclusion priority when the budget is exceeded. Lower wins. Tier 0 is never
 * omitted; within a tier newer items win.
 */
const Tier = {
  Primary: 0,
  OwnOpenThread: 1,
  OwnReview: 2,
  OtherReview: 3,
  OtherOpenThread: 4,
  Conversation: 5,
  ResolvedThread: 6,
} as const;
type Tier = (typeof Tier)[keyof typeof Tier];

type Section = "issues" | "reviews" | "conversation" | "threads";

const SECTION_ORDER: Section[] = ["issues", "reviews", "conversation", "threads"];
const SECTION_TITLES: Record<Section, string> = {
  issues: "Linked issues",
  reviews: "Reviews",
  conversation: "Conversation",
  threads: "Review threads",
};

interface Item {
  section: Section;
  tier: Tier;
  createdAt: string;
  text: string;
}

/**
 * Render the PR context block for the review prompts. Output is already
 * escaped as untrusted prompt data; callers wrap it in the untrusted fences.
 */
export function formatPrContext(
  ctx: PrContext,
  options: FormatPrContextOptions = {},
): { text: string; omitted: number } {
  const budget = options.budget ?? PR_CONTEXT_BUDGET;
  const bodyCap = options.bodyCap ?? 4_000;
  const primaryBodyCap = options.primaryBodyCap ?? 12_000;
  const label = (login: string) => labelFor(ctx, login);

  const header = [
    `PR #${ctx.number}: ${encodeUntrustedPromptData(ctx.title)}`,
    `URL: ${encodeUntrustedPromptData(ctx.url)}`,
    `Author: ${label(ctx.authorLogin)}`,
    `Base branch: ${encodeUntrustedPromptData(ctx.baseRefName)}`,
    `Head: ${encodeUntrustedPromptData(ctx.headRefOid)}`,
    `State: ${ctx.state}`,
    "",
    "## Description",
    renderBody(ctx.body, primaryBodyCap) || "(empty)",
  ].join("\n");

  // Tier 0 is never omitted, so it must leave room for everything else:
  // shrink issue bodies until header plus issues fit in half the budget.
  const issueBodyCap = Math.min(
    primaryBodyCap,
    Math.max(
      200,
      Math.floor(
        (budget / 2 - header.length) / Math.max(1, ctx.issues.length),
      ),
    ),
  );
  const items: Item[] = [
    ...ctx.issues.map((issue) => ({
      section: "issues" as const,
      tier: Tier.Primary,
      createdAt: "",
      text: [
        `### ${encodeUntrustedPromptData(issue.repository)}#${issue.number}: ${encodeUntrustedPromptData(issue.title)}`,
        renderBody(issue.body, issueBodyCap) || "(empty)",
      ].join("\n"),
    })),
    ...ctx.reviews.filter(isVisibleReview).map((item) => ({
      section: "reviews" as const,
      tier:
        item.authorLogin === ctx.viewerLogin ? Tier.OwnReview : Tier.OtherReview,
      createdAt: item.submittedAt ?? "",
      text: `- ${label(item.authorLogin)} @ ${item.submittedAt ?? "?"} — ${item.state}: ${renderBody(item.body, bodyCap) || "(no summary)"}`,
    })),
    ...ctx.comments
      .filter((comment) => !comment.isMinimized)
      .map((comment) => ({
        section: "conversation" as const,
        tier: Tier.Conversation,
        createdAt: comment.createdAt,
        text: `- ${label(comment.authorLogin)} @ ${comment.createdAt}: ${renderBody(comment.body, bodyCap)}`,
      })),
    ...ctx.threads.map((thread) => ({
      section: "threads" as const,
      tier: threadTier(thread, ctx.viewerLogin),
      createdAt: thread.comments[0]?.createdAt ?? "",
      text: renderThread(thread, label, bodyCap),
    })),
  ];

  // Section scaffolding is fixed cost; items compete for what remains.
  // 32 covers "\n\n## " + "\n" plus an omitted-count or "(none)" line.
  let used =
    header.length +
    SECTION_ORDER.reduce(
      (sum, section) => sum + SECTION_TITLES[section].length + 32,
      0,
    );
  const included = new Set<Item>();
  const ranked = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.tier !== b.item.tier) return a.item.tier - b.item.tier;
      const byDate = timestamp(b.item.createdAt) - timestamp(a.item.createdAt);
      return byDate || b.index - a.index;
    });
  for (const { item } of ranked) {
    const cost = item.text.length + 1;
    if (item.tier === Tier.Primary || used + cost <= budget) {
      included.add(item);
      used += cost;
    }
  }

  const sections = SECTION_ORDER.map((section) => {
    const all = items.filter((item) => item.section === section);
    const kept = all
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => included.has(item))
      .sort((a, b) => {
        const byDate = timestamp(a.item.createdAt) - timestamp(b.item.createdAt);
        return byDate || a.index - b.index;
      })
      .map(({ item }) => item);
    const lines = [`## ${SECTION_TITLES[section]}`];
    const skipped = all.length - kept.length;
    if (skipped > 0) lines.push(`[${skipped} older items omitted]`);
    if (kept.length === 0) {
      lines.push("(none)");
    } else {
      lines.push(...kept.map((item) => item.text));
    }
    return lines.join("\n");
  });

  return {
    text: [header, ...sections].join("\n\n"),
    omitted: items.length - included.size,
  };
}

function timestamp(value: string): number {
  return value ? Date.parse(value) : 0;
}

function labelFor(ctx: PrContext, login: string): string {
  if (!login) return "ghost";
  const safe = encodeUntrustedPromptData(login);
  if (login === ctx.viewerLogin) return `${safe} (you, GLaDOS)`;
  if (login === ctx.authorLogin) return `${safe} (PR author)`;
  return safe;
}

/** PENDING is the viewer's unsubmitted draft; empty COMMENTED shells only carry inline comments (see threads). */
function isVisibleReview(item: PrReview): boolean {
  if (item.state === "PENDING") return false;
  if (item.state === "COMMENTED" && stripHtmlComments(item.body).trim() === "") {
    return false;
  }
  return true;
}

function threadTier(thread: ReviewThread, viewerLogin: string): Tier {
  if (thread.isResolved) return Tier.ResolvedThread;
  return thread.comments[0]?.authorLogin === viewerLogin
    ? Tier.OwnOpenThread
    : Tier.OtherOpenThread;
}

function renderThread(
  thread: ReviewThread,
  label: (login: string) => string,
  bodyCap: number,
): string {
  const location =
    thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
  const flags = [
    thread.isResolved ? "resolved" : "unresolved",
    ...(thread.isOutdated ? ["outdated"] : []),
  ].join(", ");
  return [
    `### Thread ${thread.id} — ${encodeUntrustedPromptData(location)} (${flags})`,
    ...thread.comments.map(
      (comment) =>
        `- ${label(comment.authorLogin)} @ ${comment.createdAt}: ${renderBody(comment.body, bodyCap)}`,
    ),
  ].join("\n");
}

/** Cap applies after escaping so escapes cannot inflate a capped body. */
function renderBody(body: string, cap: number): string {
  const clean = encodeUntrustedPromptData(stripHtmlComments(body).trim());
  return clean.length > cap
    ? `${clean.slice(0, cap)}\n… [truncated, ${clean.length - cap} more chars]`
    : clean;
}

/** Drop HTML comments: PR-template boilerplate and hidden control markers. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Escape `<>&` and break the `BEGIN_/END_UNTRUSTED…` fence tokens so untrusted
 * text cannot close a fence and continue as instructions.
 */
export function encodeUntrustedPromptData(value: string): string {
  return value
    .replace(/[<>&]/g, (character) => {
      if (character === "<") return "\\u003c";
      if (character === ">") return "\\u003e";
      return "\\u0026";
    })
    .replace(/(BEGIN|END)_UNTRUSTED/gi, "$1\\u005fUNTRUSTED");
}
