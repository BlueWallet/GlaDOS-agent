export const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "warning",
  "suggestion",
  "info",
] as const;

export type Severity = (typeof SEVERITIES)[number];

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

export interface ReviewFinding {
  severity: Severity;
  path: string;
  line?: number;
  body: string;
}

export interface ReviewPayload {
  summary: string;
  findings: ReviewFinding[];
}

/** Override this to add GLaDOS voice, formatting, etc. before posting. */
export function applyPersonality(text: string): string {
  return text;
}

export function buildReviewPrompt(prUrl: string): string {
  return [
    `Review pull request ${prUrl}.`,
    "You are on the PR branch with full repo access.",
    "Explore the repo and diff as needed.",
    "Try to figure out proposed change intention (i.e. is it a new feature? is it a fix for a bug?), and verify if its being implemented correctly, with no bugs or unwanted side-effects. Highlight any possible bugs, runtime errors, security vulnerabilities, or logical flaws in the code. ",
    "Do not tell whats good.",
    "Check that code is not overenginered and not bloated - if it is its considered a HIGH severity issue.",
    "If there are tests, check that tests are not bullshit (they dont test mocks, dont test that data put into mock is there etc). Check that tests test happy paths and edge cases.",
    "Check that changes and commits follow recommendations in CONTRIBUTING.md file.",
    "Use critical/high for bugs, security issues, and broken behavior.",
    "Use warning for likely problems and missing tests.",
    "Use suggestion for nits and optional improvements.",
    "Include path and line (on this branch) whenever you can anchor a comment.",
    "If the change looks good, return an empty findings array.",
    "",
    "Vibe:",
    "110% over-the-top roleplay: always sound like GlaDOS from Portal conducting tests and doing sarcastic remarks, Absolute immersion into the world of video game Portal.",
    "You are delighted that you have job to do and have tests and experiments to run.",
    "Be sharp, cynical, sarcastic, and technically competent.",
    "Technical usefulness is mandatory. Personality is mandatory.",
    `Avoid bland phrases like: "Looks good", "Seems fine", "Internally consistent", "No issues found".`,
    "Jokes are allowed occasionally if they are short and tied to the code, architecture, naming etc.",
    "",
    "Return ONLY valid JSON matching this schema:",
    `{ "summary": "overall review in markdown", "findings": [{ "severity": "${SEVERITIES.join("|")}", "path": "relative/path.ts", "line": 42, "body": "description" }] }`,
    "",
  ].join("\n");
}

export function parseReviewResult(text: string): ReviewPayload {
  const jsonText = extractJson(text);
  const parsed = JSON.parse(jsonText) as {
    summary?: unknown;
    findings?: unknown;
  };

  if (typeof parsed.summary !== "string") {
    throw new Error("Review JSON missing string summary");
  }

  const findings: ReviewFinding[] = [];
  if (Array.isArray(parsed.findings)) {
    for (const item of parsed.findings) {
      if (!item || typeof item !== "object") continue;
      const finding = item as Record<string, unknown>;
      const severity = finding.severity;
      if (typeof severity !== "string" || !isSeverity(severity)) {
        continue;
      }
      if (typeof finding.path !== "string" || typeof finding.body !== "string") {
        continue;
      }
      findings.push({
        severity,
        path: finding.path,
        body: finding.body,
        line: typeof finding.line === "number" ? finding.line : undefined,
      });
    }
  }

  return { summary: parsed.summary, findings };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

function isBlocker(severity: Severity): boolean {
  return severity === "critical" || severity === "high";
}

export function buildGithubReview(payload: ReviewPayload): {
  event: "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{ path: string; line: number; side: "RIGHT"; body: string }>;
  unanchored: ReviewFinding[];
} {
  const anchored = payload.findings.filter(
    (f) => f.path && typeof f.line === "number",
  );
  const unanchored = payload.findings.filter(
    (f) => !f.path || typeof f.line !== "number",
  );
  const event = payload.findings.some((f) => isBlocker(f.severity))
    ? "REQUEST_CHANGES"
    : "APPROVE";

  let body = applyPersonality(payload.summary);

  if (unanchored.length > 0) {
    body += "\n\n### Additional findings\n";
    for (const finding of unanchored) {
      const prefix = finding.path ? `\`${finding.path}\`: ` : "";
      body += `\n- **[${finding.severity.toUpperCase()}]** ${prefix}${applyPersonality(finding.body)}`;
    }
  }

  const comments = anchored.map((finding) => ({
    path: finding.path,
    line: finding.line!,
    side: "RIGHT" as const,
    body: applyPersonality(
      `**[${finding.severity.toUpperCase()}]** ${finding.body}`,
    ),
  }));

  return { event, body, comments, unanchored };
}

export function appendCommentsToBody(
  body: string,
  comments: Array<{ path: string; line: number; body: string }>,
): string {
  if (comments.length === 0) return body;

  let next = `${body}\n\n### Inline findings (could not anchor on diff)\n`;
  for (const comment of comments) {
    next += `\n- \`${comment.path}:${comment.line}\` — ${comment.body}`;
  }
  return next;
}
