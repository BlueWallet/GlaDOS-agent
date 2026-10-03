import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewPrompt,
  buildVerifyPrompt,
  buildVoicePrompt,
  mergeVerifiedFindings,
  parseReviewResult,
  parseVerifiedReviewResult,
  type ReviewFinding,
  type ReviewPayload,
  type VerifiedReviewPayload,
} from "./payload.js";

const draft: ReviewPayload = {
  summary: "Local delete no longer waits on a remote unsubscribe.",
  findings: [
    {
      severity: "high",
      path: "src/storage.ts",
      line: 20,
      body: "save() is assumed to throw; callers treat false as persist failure.",
    },
    {
      severity: "medium",
      path: "src/storage.ts",
      line: 40,
      body: "Cleanup is fire-and-forget; the caller navigates away on true.",
    },
  ],
};

test("draft prompt is dry, strict, and covers the full review checklist", () => {
  const prompt = buildReviewPrompt("https://example.test/pr/1", "settled notes");

  for (const category of [
    /Plan alignment/,
    /Code quality/,
    /Architecture/,
    /Testing/,
    /Production readiness/,
  ]) {
    assert.match(prompt, category);
  }
  assert.match(prompt, /Report every critical and high issue/i);
  assert.match(prompt, /high: .*test gaps/i);
  assert.match(prompt, /silence is not permission/i);
  assert.doesNotMatch(prompt, /residual risk/i);
  assert.doesNotMatch(prompt, /missing niceties/i);
  assert.doesNotMatch(prompt, /is the correct result/i);
  assert.match(prompt, /package managers|install dependencies/i);
  assert.match(prompt, /stated (design|intention)/i);
  assert.match(prompt, /read the called functions/i);
  assert.match(prompt, /pre-existing/i);
  assert.match(prompt, /settled notes/);
  assert.match(prompt, /dry technical/i);

  assert.doesNotMatch(prompt, /do not tell whats good/i);
  assert.doesNotMatch(prompt, /overenginered/i);
  assert.doesNotMatch(prompt, /110% over-the-top/i);
  assert.doesNotMatch(prompt, /Portal/);
  assert.doesNotMatch(prompt, /Avoid bland phrases/i);
});

test("verify prompt checks candidates and applies voice only after verification", () => {
  const prompt = buildVerifyPrompt(
    "https://example.test/pr/1",
    draft,
    "settled notes",
  );

  assert.match(prompt, /src\/storage\.ts/);
  assert.match(prompt, /save\(\) is assumed to throw/);
  assert.match(prompt, /Do not add findings/i);
  assert.match(prompt, /only with concrete disproof/i);
  assert.match(prompt, /If in doubt, keep/i);
  assert.match(prompt, /additional context below rules it out/i);
  assert.doesNotMatch(
    buildVerifyPrompt("https://example.test/pr/1", draft),
    /additional context below/i,
  );
  assert.match(prompt, /"dropped": \[/);
  assert.match(prompt, /stated (design|intention)/i);
  assert.match(prompt, /called functions|callees/i);
  assert.match(prompt, /package managers|install dependencies/i);
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /"candidate": 0/);
  assert.match(prompt, /settled notes/);
  assert.match(prompt, /GlaDOS/);
  assert.match(prompt, /Portal/);
  assert.match(prompt, /110% over-the-top/i);
  assert.match(prompt, /Avoid bland phrases/i);
});

test("voice prompt rewrites a clean draft without reopening the review", () => {
  const prompt = buildVoicePrompt("https://example.test/pr/1", {
    summary: "No defects found.",
    findings: [],
  });

  assert.match(prompt, /empty findings array/i);
  assert.match(prompt, /Do NOT add findings/i);
  assert.match(prompt, /No defects found/);
  assert.match(prompt, /110% over-the-top/i);
  assert.match(prompt, /Portal/);
});

test("mergeVerifiedFindings restores the exact candidate anchor and allows rewrite", () => {
  const verified: VerifiedReviewPayload = {
    summary: "One real persist bug remains.",
    findings: [
      {
        candidate: 0,
        severity: "medium",
        body: "After reading save(), it swallows errors; this finding still holds for a different reason.",
        evidence: "src/storage.ts save() catches and returns false; callers retry.",
      },
    ],
  };

  const merged = mergeVerifiedFindings(draft, verified);
  assert.equal(merged.summary, verified.summary);
  assert.deepEqual(
    merged.findings.map((f: ReviewFinding) => ({
      path: f.path,
      line: f.line,
      severity: f.severity,
    })),
    [{ path: "src/storage.ts", line: 20, severity: "medium" }],
  );
  assert.match(merged.findings[0]!.body, /swallows errors/);
});

test("mergeVerifiedFindings keeps a blocker's severity when lowered without evidence", () => {
  for (const evidence of [undefined, "", "\u200b\u202e \n"]) {
    const merged = mergeVerifiedFindings(draft, {
      summary: "Downgraded.",
      findings: [{ candidate: 0, severity: "low", body: "Probably fine.", evidence }],
    });
    assert.equal(merged.findings[0]?.severity, "high");
    assert.match(merged.findings[0]!.body, /Probably fine/);
  }
});

test("mergeVerifiedFindings will not raise severity above the draft", () => {
  const merged = mergeVerifiedFindings(draft, {
    summary: "Unchanged.",
    findings: [
      {
        candidate: 1,
        severity: "critical",
        body: "Still just fire-and-forget.",
      },
    ],
  });
  assert.equal(merged.findings[0]?.severity, "medium");
});

test("mergeVerifiedFindings may drop every candidate when blockers are disproven", () => {
  const merged = mergeVerifiedFindings(draft, {
    summary: "Invented critical defect.",
    findings: [],
    dropped: [
      { candidate: 0, evidence: "src/storage.ts save() returns false, never throws." },
    ],
  });
  assert.equal(merged.findings.length, 0);
  assert.doesNotMatch(merged.summary, /invented critical defect/i);
  assert.match(merged.summary, /no candidate defects survived/i);
});

test("mergeVerifiedFindings restores blockers dropped without evidence", () => {
  for (const dropped of [undefined, [], [{ candidate: 0, evidence: "  " }]]) {
    const merged = mergeVerifiedFindings(draft, {
      summary: "No candidate survived.",
      findings: [],
      dropped,
    });
    assert.deepEqual(merged.findings, [draft.findings[0]]);
    assert.match(merged.summary, /1 blocking finding could not be disproven/);
    assert.doesNotMatch(merged.summary, /No candidate survived/);
  }
});

test("mergeVerifiedFindings rejects inconsistent dropped ids", () => {
  const evidence = "src/storage.ts shows otherwise.";
  const cases: Array<[VerifiedReviewPayload, RegExp]> = [
    [{ summary: "", findings: [], dropped: [{ candidate: 9, evidence }] }, /unknown candidate/i],
    [
      {
        summary: "",
        findings: [],
        dropped: [
          { candidate: 0, evidence },
          { candidate: 0, evidence },
        ],
      },
      /duplicate candidate/i,
    ],
    [
      {
        summary: "",
        findings: [{ candidate: 0, severity: "high", body: "Kept." }],
        dropped: [{ candidate: 0, evidence }],
      },
      /both kept and dropped/i,
    ],
  ];
  for (const [verified, error] of cases) {
    assert.throws(() => mergeVerifiedFindings(draft, verified), error);
  }
});

test("mergeVerifiedFindings appends restored blockers after kept findings", () => {
  const merged = mergeVerifiedFindings(draft, {
    summary: "Cleanup is sloppy.",
    findings: [{ candidate: 1, severity: "medium", body: "Fire-and-forget." }],
  });
  assert.deepEqual(
    merged.findings.map((f: ReviewFinding) => [f.line, f.severity]),
    [
      [40, "medium"],
      [20, "high"],
    ],
  );
  assert.match(merged.summary, /^Cleanup is sloppy\.\n\n1 blocking finding/);
});

test("mergeVerifiedFindings rejects unknown and duplicate candidate ids", () => {
  assert.throws(
    () =>
      mergeVerifiedFindings(draft, {
        summary: "Unknown.",
        findings: [{ candidate: 9, severity: "low", body: "Unknown candidate." }],
      }),
    /unknown candidate/i,
  );

  assert.throws(
    () =>
      mergeVerifiedFindings(draft, {
        summary: "Duplicate.",
        findings: [
          { candidate: 0, severity: "low", body: "First." },
          { candidate: 0, severity: "low", body: "Second." },
        ],
      }),
    /duplicate candidate/i,
  );
});

test("parseReviewResult still accepts the shared review schema", () => {
  const parsed = parseReviewResult(`\`\`\`json
{"summary":"ok","findings":[{"severity":"low","path":"a.ts","line":3,"body":"note"}]}
\`\`\``);
  assert.equal(parsed.summary, "ok");
  assert.equal(parsed.findings[0]?.line, 3);
});

test("review parsers reject malformed findings instead of silently approving", () => {
  assert.throws(
    () => parseReviewResult('{"summary":"bad","findings":{}}'),
    /findings array/i,
  );
  assert.throws(
    () =>
      parseReviewResult(
        '{"summary":"bad","findings":[{"severity":"high","path":"a.ts"}]}',
      ),
    /invalid finding/i,
  );
  assert.throws(
    () => parseVerifiedReviewResult('{"summary":"bad","findings":{}}'),
    /findings array/i,
  );
});

test("parseVerifiedReviewResult accepts candidate ids and rejects malformed rows", () => {
  const parsed = parseVerifiedReviewResult(
    '{"summary":"verified","findings":[{"candidate":1,"severity":"low","body":"kept"}]}',
  );
  assert.deepEqual(parsed.findings, [
    { candidate: 1, severity: "low", body: "kept" },
  ]);
  assert.deepEqual(parsed.dropped, []);

  const withDropped = parseVerifiedReviewResult(
    '{"summary":"verified","findings":[],"dropped":[{"candidate":0,"evidence":"a.ts returns early"}]}',
  );
  assert.deepEqual(withDropped.dropped, [
    { candidate: 0, evidence: "a.ts returns early" },
  ]);
  assert.throws(
    () =>
      parseVerifiedReviewResult(
        '{"summary":"bad","findings":[],"dropped":[{"candidate":0}]}',
      ),
    /invalid dropped candidate/i,
  );
  assert.throws(
    () =>
      parseVerifiedReviewResult(
        '{"summary":"bad","findings":[],"dropped":[{"candidate":-1,"evidence":"x"}]}',
      ),
    /invalid dropped candidate/i,
  );

  assert.throws(
    () =>
      parseVerifiedReviewResult(
        '{"summary":"bad","findings":[{"candidate":-1,"severity":"low","body":"bad"}]}',
      ),
    /invalid verified finding/i,
  );
});
