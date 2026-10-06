import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHub, parsePrUrl } from "../src/github/api.js";
import { MARKER } from "../src/core/format.js";
import type { Review } from "../src/core/review.js";

const SAMPLE = fs.readFileSync(new URL("../ui/sample/diff.patch", import.meta.url), "utf8");
const REVIEW: Review = JSON.parse(fs.readFileSync(new URL("../ui/sample/review.json", import.meta.url), "utf8"));
const PR = { owner: "o", repo: "r", number: 1, title: "t", author: "a", url: "u", headSha: "abc", draft: false, state: "open", additions: 1, deletions: 0, changedFiles: 1 };

describe("github", () => {
  it("parses PR links and short refs", () => {
    assert.deepEqual(parsePrUrl("https://github.com/codeitronics/ai-pr-reviewer-demo/pull/7/files"), { owner: "codeitronics", repo: "ai-pr-reviewer-demo", number: 7 });
    assert.deepEqual(parsePrUrl("acme/api#12"), { owner: "acme", repo: "api", number: 12 });
    assert.throws(() => parsePrUrl("https://example.com"), /Not a pull request/);
  });

  it("posts inline comments on the head commit, and falls back to a summary on 422", async () => {
    const calls: any[] = [];
    let fail = true;
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (fail && JSON.parse(init.body).comments?.length) {
        fail = false;
        return new Response("Unprocessable", { status: 422 });
      }
      return new Response(JSON.stringify({ html_url: "https://github.com/o/r/pull/1#review" }));
    }) as typeof fetch;
    const res = await new GitHub("t", "https://api.test", fetchImpl).postReview(PR, { ...REVIEW, verdict: "request_changes" });
    assert.equal(res.inline, false);
    assert.equal(calls[0].body.commit_id, "abc");
    assert.equal(calls[0].body.event, "REQUEST_CHANGES");
    assert.ok(calls[0].body.comments.every((c: any) => c.side === "RIGHT" && Number.isInteger(c.line)));
    assert.equal(calls[1].body.comments, undefined);
    assert.match(calls[1].body.body, /### Comments/);
  });

  it("finds this tool's reviews by marker for the history page", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/pulls?")) return new Response(JSON.stringify([{ number: 1, title: "Feature", user: { login: "dev" }, state: "open" }]));
      return new Response(JSON.stringify([
        { body: `${MARKER}\n## AI review\n\n**8 comments**: 3 critical · 4 warning · 1 info · **changes requested**`, state: "CHANGES_REQUESTED", html_url: "h", submitted_at: "2026-10-06T10:00:00Z" },
        { body: "LGTM", state: "APPROVED", html_url: "x", submitted_at: "2026-10-06T11:00:00Z" },
      ]));
    }) as typeof fetch;
    const items = await new GitHub(undefined, "https://api.test", fetchImpl).history("o", "r");
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].comments, items[0].critical, items[0].verdict], [8, 3, "request_changes"]);
  });
});

describe("action", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("reviews the PR from the event and posts one review", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prr-"));
    const event = path.join(dir, "event.json");
    const output = path.join(dir, "output.txt");
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 1, draft: false } }));
    const posted: any[] = [];
    globalThis.fetch = (async (url: string, init: any = {}) => {
      if (url.includes("api.deepseek.com")) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "s", comments: [{ path: "src/app.js", line: 22, severity: "critical", category: "security", title: "SQL injection", body: "b" }] }) } }] }));
      if (url.endsWith("/reviews") && init.method === "POST") {
        posted.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ html_url: "https://github.com/o/r/pull/1#r" }));
      }
      if (url.includes("/contents/")) return new Response("nf", { status: 404 });
      if (init.headers?.accept === "application/vnd.github.v3.diff") return new Response(SAMPLE);
      return new Response(JSON.stringify({ title: "t", user: { login: "u" }, head: { sha: "sha1" }, html_url: "u", state: "open" }));
    }) as typeof fetch;
    Object.assign(process.env, { INPUT_API_KEY: "k", INPUT_PROVIDER: "deepseek", INPUT_GITHUB_TOKEN: "t", INPUT_REQUEST_CHANGES_ON: "critical", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: output });
    const { run } = await import("../src/github/action.js");
    await run();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].event, "REQUEST_CHANGES");
    assert.equal(posted[0].comments[0].line, 22);
    assert.match(fs.readFileSync(output, "utf8"), /critical=1/);
  });
});

describe("ui", () => {
  it("demo: shows the recorded review inline and blocks live reviews", async () => {
    const { createApp } = await import("../src/ui/server.js");
    const server = (await createApp({ demo: true })).listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Changes requested/);
    assert.match(html, /class="comment-row" data-sev="critical"/);
    assert.match(html, /Tests worth adding/);
    assert.equal((await fetch(`${base}/review`, { method: "POST", body: new URLSearchParams({ diff: SAMPLE }) })).status, 403);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    server.close();
  });
});
