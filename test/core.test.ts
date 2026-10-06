import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { matches, parseDiff, render, selectFiles } from "../src/core/diff.js";
import { finalize, reviewDiff } from "../src/core/review.js";
import { commentBody, MARKER, summaryBody } from "../src/core/format.js";
import { parseJSON, resolveAI } from "../src/core/llm.js";

const SAMPLE = fs.readFileSync(new URL("../ui/sample/diff.patch", import.meta.url), "utf8");

const LOCK = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,2 @@
 {
+  "x": 1
`;

describe("diff", () => {
  it("parses files, added lines and commentable lines with real new-file numbers", () => {
    const [f] = parseDiff(SAMPLE);
    assert.equal(f.path, "src/app.js");
    assert.equal(f.status, "modified");
    assert.ok(f.added.has(22) && f.added.has(38), "the injected query and logged key are added lines");
    assert.ok(f.commentable.has(1), "context lines are commentable");
    assert.ok(!f.added.has(1));
  });

  it("renders explicit line numbers for the model", () => {
    const out = render(parseDiff(SAMPLE));
    assert.match(out, /^\+\s+22\s+ {4}const rows = await query\(`SELECT \* FROM orders WHERE customer = '\$\{customer\}'/m);
  });

  it("matches globs, skips lockfiles and respects the size budget", () => {
    assert.ok(matches("package-lock.json", "**/package-lock.json"));
    assert.ok(matches("web/dist/app.js", "**/dist/**"));
    assert.ok(!matches("src/dist.ts", "**/dist/**"));
    assert.ok(matches("a/b.min.js", "**/*.min.js"));
    const sel = selectFiles(parseDiff(SAMPLE + LOCK));
    assert.deepEqual(sel.files.map((f) => f.path), ["src/app.js"]);
    assert.equal(sel.skipped[0].reason, "ignored");
    const tiny = selectFiles(parseDiff(SAMPLE), { maxChars: 50 });
    assert.equal(tiny.files.length, 0);
    assert.equal(tiny.truncated, true);
  });
});

describe("finalize", () => {
  const files = parseDiff(SAMPLE);
  const stats = { files: 1, reviewedFiles: 1, skipped: [], truncated: false };
  const ai = { provider: "deepseek" as const, model: "deepseek-chat" };
  const c = (o: Record<string, unknown>) => ({ path: "src/app.js", severity: "warning", category: "bug", title: "t", body: "b", ...o });

  it("keeps valid lines, snaps near misses, and moves the rest to unplaced", () => {
    // A diff whose only change is line 10, with no context: line 12 isn't in the diff but is within 3 of line 10.
    const snapFiles = parseDiff("diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -9,0 +10,1 @@\n+const risky = eval(input);\n");
    const snapped = finalize({ comments: [{ path: "x.js", line: 12, severity: "critical", category: "security", title: "near", body: "b", suggestion: "x" }] }, snapFiles, stats, ai);
    assert.equal(snapped.comments[0].line, 10);
    const near = snapped.comments[0];
    assert.equal(near.movedFrom, 12);
    const r = finalize({ summary: "s", comments: [c({ line: 22 }), c({ line: 200, title: "far" }), c({ path: "nope.js", line: 3, title: "other file" })] }, files, stats, ai);
    assert.deepEqual(r.comments.map((x) => x.line), [22]);
    assert.equal(near.suggestion, undefined, "suggestions are dropped when a comment moves");
    assert.deepEqual(r.unplaced.map((x) => x.title).sort(), ["far", "other file"]);
  });

  it("accepts the shapes models actually return", () => {
    for (const shape of [{ comments: [c({ line: 22 })] }, { reviews: [c({ line: 22 })] }, { issues: [c({ line: 22 })] }, [c({ line: 22 })]]) {
      assert.equal(finalize(shape, files, stats, ai).comments.length, 1);
    }
    assert.equal(finalize({ comments: [{ file: "src/app.js", lineNumber: 22, comment: "legacy keys", severity: "critical" }] }, files, stats, ai).comments[0].severity, "critical");
    assert.equal(finalize("garbage", files, stats, ai).comments.length, 0);
  });

  it("filters severities, sets the verdict, dedupes and caps comments", () => {
    const raw = { comments: [c({ line: 22, severity: "critical" }), c({ line: 22, severity: "critical" }), c({ line: 23, severity: "info", title: "i" })] };
    const r = finalize(raw, files, stats, ai, { include: ["critical", "warning"], requestChangesOn: "critical" });
    assert.equal(r.comments.length, 1);
    assert.equal(r.verdict, "request_changes");
    assert.equal(finalize(raw, files, stats, ai, { requestChangesOn: "never" }).verdict, "comment");
    const many = { comments: Array.from({ length: 30 }, (_, i) => c({ line: 18 + (i % 25), title: `t${i}` })) };
    const capped = finalize(many, files, stats, ai, { maxComments: 5 });
    assert.equal(capped.comments.length, 5);
    assert.ok(capped.unplaced.length >= 20);
  });
});

describe("format", () => {
  it("adds the history marker, counts, tests and a suggestion block", () => {
    const r = JSON.parse(fs.readFileSync(new URL("../ui/sample/review.json", import.meta.url), "utf8"));
    const s = summaryBody(r);
    assert.ok(s.startsWith(MARKER));
    assert.match(s, /\*\*\d+ comments\*\*: \d+ critical · \d+ warning · \d+ info/);
    assert.match(s, /### Tests worth adding/);
    assert.match(commentBody({ path: "a", line: 1, severity: "critical", category: "security", title: "T", body: "B", suggestion: "fixed();" }), /```suggestion\nfixed\(\);\n```/);
  });
});

describe("llm", () => {
  it("parses fenced or chatty JSON", () => {
    assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJSON('Here you go: {"a":2} hope it helps'), { a: 2 });
  });

  it("resolves providers and keys", () => {
    assert.equal(resolveAI({}, { OPENAI_API_KEY: "o", DEEPSEEK_API_KEY: "d" })!.provider, "deepseek");
    assert.equal(resolveAI({ provider: "anthropic", key: "k" }, {})!.model, "claude-sonnet-5-5");
    assert.equal(resolveAI({}, {}), null);
    assert.throws(() => resolveAI({ provider: "gemini" }, {}), /GEMINI_API_KEY/);
  });

  it("sends the numbered diff and returns a validated review", async () => {
    let body: any;
    const fetchImpl = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "ok", comments: [c22()], tests: [{ name: "t", why: "w" }] }) } }] }));
    }) as typeof fetch;
    const r = await reviewDiff(SAMPLE, { provider: "deepseek", key: "k", model: "m" }, { fetchImpl, instructions: "Prefer parameterised queries." });
    assert.match(body.messages[1].content, /Prefer parameterised queries/);
    assert.match(body.messages[1].content, /\+\s+22 /);
    assert.equal(body.response_format.type, "json_object");
    assert.equal(r.comments[0].line, 22);
    assert.equal(r.tests.length, 1);
  });
});

const c22 = () => ({ path: "src/app.js", line: 22, severity: "critical", category: "security", title: "SQL injection", body: "b" });
