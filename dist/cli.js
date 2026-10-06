var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/llm.ts
function resolveAI(opts = {}, env = process.env) {
  const wanted = opts.provider || env.AI_PROVIDER;
  if (wanted) {
    if (!isProvider(wanted)) throw new Error(`Unknown provider "${wanted}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`);
    const key = opts.key || env[PROVIDERS[wanted].env];
    if (!key) throw new Error(`No API key for ${wanted}: pass api_key or set ${PROVIDERS[wanted].env}.`);
    return { provider: wanted, key, model: opts.model || env.AI_MODEL || PROVIDERS[wanted].model };
  }
  for (const p of Object.keys(PROVIDERS)) {
    const key = env[PROVIDERS[p].env];
    if (key) return { provider: p, key, model: opts.model || env.AI_MODEL || PROVIDERS[p].model };
  }
  return null;
}
async function completeJSON(ai, system, user, { fetchImpl = fetch, maxTokens = 6e3 } = {}) {
  let url;
  let headers;
  let body;
  let pick;
  if (ai.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = { "x-api-key": ai.key, "anthropic-version": "2023-06-01" };
    body = { model: ai.model, max_tokens: maxTokens, temperature: 0.2, system, messages: [{ role: "user", content: user }] };
    pick = (d) => d.content?.filter((b) => b.type === "text").map((b) => b.text).join("");
  } else if (ai.provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
    headers = { "x-goog-api-key": ai.key };
    body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2, responseMimeType: "application/json" } };
    pick = (d) => d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  } else {
    url = ai.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
    headers = { authorization: `Bearer ${ai.key}` };
    body = {
      model: ai.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      // Low temperature for consistent severities; OpenAI's GPT-5 models only accept their default temperature.
      ...ai.provider === "deepseek" ? { max_tokens: maxTokens, temperature: 0.2 } : { max_completion_tokens: maxTokens }
    };
    pick = (d) => d.choices?.[0]?.message?.content;
  }
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${ai.provider} returned ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  const text = pick(data);
  if (!text) throw new Error(`${ai.provider} returned no text.`);
  return parseJSON(text);
}
function parseJSON(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("The model's reply wasn't valid JSON.");
  }
}
var PROVIDERS, isProvider;
var init_llm = __esm({
  "src/core/llm.ts"() {
    "use strict";
    PROVIDERS = {
      deepseek: { env: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
      anthropic: { env: "ANTHROPIC_API_KEY", model: "claude-sonnet-5-5" },
      openai: { env: "OPENAI_API_KEY", model: "gpt-5-mini" },
      gemini: { env: "GEMINI_API_KEY", model: "gemini-2.5-flash" }
    };
    isProvider = (p) => p in PROVIDERS;
  }
});

// src/core/diff.ts
function parseDiff(diff) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldN = 0;
  let newN = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = { path: m?.[2] ?? "", oldPath: m?.[1], status: "modified", binary: false, hunks: [], commentable: /* @__PURE__ */ new Set(), added: /* @__PURE__ */ new Set() };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("new file mode")) file.status = "added";
    else if (raw.startsWith("deleted file mode")) file.status = "deleted";
    else if (raw.startsWith("rename from ")) file.status = "renamed";
    else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") file.binary = true;
    else if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") file.path = p.replace(/^b\//, "");
    } else if (raw.startsWith("--- ")) {
      continue;
    } else if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldN = Number(m?.[1] ?? 0);
      newN = Number(m?.[2] ?? 0);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      const c = raw[0];
      const text = raw.slice(1);
      if (c === "+") {
        hunk.lines.push({ kind: "add", newLine: newN, text });
        file.commentable.add(newN);
        file.added.add(newN);
        newN++;
      } else if (c === "-") {
        hunk.lines.push({ kind: "del", oldLine: oldN, text });
        oldN++;
      } else if (c === " " || raw === "") {
        if (raw === "" && hunk.lines.length === 0) continue;
        hunk.lines.push({ kind: "ctx", oldLine: oldN, newLine: newN, text });
        file.commentable.add(newN);
        oldN++;
        newN++;
      }
    }
  }
  return files.filter((f) => f.path);
}
function matches(path2, pattern) {
  const re = pattern.replace(/\*\*\//g, "").replace(/\*\*/g, "").replace(/\*/g, "").replace(/\?/g, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*").replace(/\u0003/g, "[^/]*").replace(/\u0004/g, "[^/]");
  return new RegExp(`^${re}$`).test(path2);
}
function selectFiles(files, { ignore = DEFAULT_IGNORE, maxChars = 6e4 } = {}) {
  const skipped = [];
  const candidates = [];
  for (const f of files) {
    if (f.status === "deleted") skipped.push({ path: f.path, reason: "deleted" });
    else if (f.binary) skipped.push({ path: f.path, reason: "binary" });
    else if (ignore.some((p) => matches(f.path, p))) skipped.push({ path: f.path, reason: "ignored" });
    else if (!f.added.size) skipped.push({ path: f.path, reason: "no added lines" });
    else candidates.push({ f, size: render([f]).length });
  }
  candidates.sort((a, b) => a.size - b.size);
  const out = [];
  let used = 0;
  let truncated = false;
  for (const c of candidates) {
    if (used + c.size > maxChars) {
      skipped.push({ path: c.f.path, reason: "over the size budget" });
      truncated = true;
      continue;
    }
    used += c.size;
    out.push(c.f);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, skipped, truncated };
}
function render(files) {
  const out = [];
  for (const f of files) {
    out.push(`### ${f.path} (${f.status})`);
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) {
        const n = l.newLine !== void 0 ? String(l.newLine).padStart(5) : "     ";
        out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${n}  ${l.text}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}
var DEFAULT_IGNORE;
var init_diff = __esm({
  "src/core/diff.ts"() {
    "use strict";
    DEFAULT_IGNORE = [
      "**/package-lock.json",
      "**/yarn.lock",
      "**/pnpm-lock.yaml",
      "**/uv.lock",
      "**/poetry.lock",
      "**/Cargo.lock",
      "**/*.min.js",
      "**/*.map",
      "**/dist/**",
      "**/build/**",
      "**/vendor/**",
      "**/*.snap",
      "**/*.svg"
    ];
  }
});

// src/core/review.ts
async function reviewDiff(diff, ai, opts = {}) {
  const files = parseDiff(diff);
  const sel = selectFiles(files, { ignore: [...DEFAULT_IGNORE, ...opts.ignore ?? []], maxChars: opts.maxChars ?? 6e4 });
  const base = { files: files.length, reviewedFiles: sel.files.length, skipped: sel.skipped, truncated: sel.truncated };
  if (!sel.files.length) {
    return { summary: "Nothing to review: no changed source files after filtering.", verdict: "comment", comments: [], unplaced: [], tests: [], stats: base, model: { provider: ai.provider, model: ai.model } };
  }
  const user = [
    opts.instructions ? `Project guidance from the maintainers:
${opts.instructions.slice(0, 4e3)}
` : "",
    sel.truncated ? "Note: the diff was too large; some files are omitted and listed as skipped.\n" : "",
    "Diff:\n",
    render(sel.files)
  ].join("\n");
  const raw = await completeJSON(ai, SYSTEM, user, { fetchImpl: opts.fetchImpl });
  return finalize(raw, sel.files, base, ai, opts);
}
function finalize(raw, files, stats, ai, opts = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const list = Array.isArray(r) ? r : Array.isArray(r.comments) ? r.comments : Array.isArray(r.reviews) ? r.reviews : Array.isArray(r.issues) ? r.issues : [];
  const include = new Set(opts.include ?? SEVERITIES);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const comments = [];
  const unplaced = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const severity = SEVERITIES.includes(String(item.severity)) ? item.severity : "info";
    if (!include.has(severity)) continue;
    const category = CATEGORIES.includes(String(item.category)) ? item.category : "bug";
    const path2 = String(item.path ?? item.file ?? "").replace(/^[ab]\//, "");
    const want = Number(item.line ?? item.lineNumber);
    const body = String(item.body ?? item.comment ?? "").trim();
    const title = String(item.title ?? "").trim() || body.split(/[.!?]\s/)[0].slice(0, 80);
    if (!body) continue;
    const suggestion = typeof item.suggestion === "string" && item.suggestion.trim() ? item.suggestion.replace(/\n+$/, "") : void 0;
    const c = { path: path2, line: want, severity, category, title, body, suggestion };
    const file = byPath.get(path2) ?? [...byPath.values()].find((f) => f.path.endsWith("/" + path2));
    if (file) c.path = file.path;
    const placed = file && Number.isInteger(want) ? place(file, want) : void 0;
    if (placed === void 0) {
      unplaced.push(c);
      continue;
    }
    if (placed !== want) {
      c.movedFrom = want;
      c.line = placed;
      c.suggestion = void 0;
    }
    const key = `${c.path}:${c.line}:${c.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    comments.push(c);
  }
  const rank = (s) => SEVERITIES.indexOf(s);
  comments.sort((a, b) => rank(b.severity) - rank(a.severity) || a.path.localeCompare(b.path) || a.line - b.line);
  const max = opts.maxComments ?? 25;
  const overflow = comments.splice(max);
  const threshold = opts.requestChangesOn ?? "never";
  const blocking = threshold !== "never" && comments.some((c) => rank(c.severity) >= rank(threshold));
  const tests = (Array.isArray(r.tests) ? r.tests : []).filter((t) => t && t.name).slice(0, 5).map((t) => ({ path: t.path ? String(t.path) : void 0, name: String(t.name), why: String(t.why ?? "") }));
  return {
    summary: String(r.summary ?? "").trim() || "Review complete.",
    verdict: blocking ? "request_changes" : "comment",
    comments,
    unplaced: [...unplaced, ...overflow],
    tests,
    stats,
    model: { provider: ai.provider, model: ai.model }
  };
}
function place(file, line) {
  if (file.commentable.has(line)) return line;
  let best;
  for (const n of file.added) {
    const d = Math.abs(n - line);
    if (d <= 3 && (best === void 0 || d < Math.abs(best - line))) best = n;
  }
  return best;
}
var SEVERITIES, CATEGORIES, SYSTEM;
var init_review = __esm({
  "src/core/review.ts"() {
    "use strict";
    init_llm();
    init_diff();
    SEVERITIES = ["info", "warning", "critical"];
    CATEGORIES = ["bug", "security", "performance", "maintainability", "tests"];
    SYSTEM = `You are a senior engineer reviewing a pull request. Be useful, specific and brief.

Report only real problems a careful reviewer would raise: bugs, security issues (injection, secrets, auth, unsafe input),
data loss, race conditions, missing error handling that can crash or corrupt, clear performance problems, and maintainability
issues that will cause bugs. Do not comment on formatting, naming taste or anything a linter would catch.
Do not praise. Do not repeat the code back. If the change is fine, return no comments.

Each line of the diff is prefixed with its marker (+ added, - removed, space context) and the NEW-file line number.
Comment only on lines that have a new-file number, and prefer added (+) lines. Use exactly that number.

Severity, applied strictly:
- critical: exploitable security issues (injection, auth bypass, secrets or credentials written to logs or responses,
  missing authorization), data loss or corruption, or a crash on a normal request path.
- warning: a likely bug or risky pattern that isn't immediately exploitable (missing await, missing null check on an
  unusual path, unvalidated input with limited impact, race conditions, off-by-one errors).
- info: worth knowing, low risk (performance on small data, minor robustness).
When unsure between two levels, choose the higher one for security findings.

The summary must attribute each problem to the right function, route or file. Do not mix up which code has which issue.

Also suggest the most important missing tests for the changed behaviour (at most 5), naming the case and why it matters,
in the project's existing test framework if one is visible.

Respond with JSON only:
{
  "summary": "2-4 sentences: what the PR does and the main risks",
  "comments": [
    { "path": "file path as shown", "line": 42, "severity": "critical|warning|info",
      "category": "bug|security|performance|maintainability|tests",
      "title": "short headline", "body": "what is wrong and why, in 1-3 sentences",
      "suggestion": "optional: the corrected line(s) only, no diff markers" }
  ],
  "tests": [ { "path": "optional test file", "name": "test case", "why": "what it protects" } ]
}`;
  }
});

// src/core/format.ts
function commentBody(c) {
  const lines = [`${ICON[c.severity]} **${c.severity.toUpperCase()}** \xB7 ${c.category} \xB7 **${c.title}**`, "", c.body];
  if (c.suggestion) lines.push("", "```suggestion", c.suggestion, "```");
  if (c.movedFrom) lines.push("", `<sub>The model pointed at line ${c.movedFrom}; moved to the nearest changed line.</sub>`);
  return lines.join("\n");
}
function summaryBody(r, { inlinePosted = true } = {}) {
  const count = (s) => r.comments.filter((c) => c.severity === s).length;
  const out = [
    MARKER,
    `## AI review`,
    "",
    r.summary,
    "",
    `**${r.comments.length} comment${r.comments.length === 1 ? "" : "s"}**: ${count("critical")} critical \xB7 ${count("warning")} warning \xB7 ${count("info")} info${r.verdict === "request_changes" ? " \xB7 **changes requested**" : ""}`
  ];
  if (!inlinePosted && r.comments.length) {
    out.push("", "### Comments", "");
    for (const c of r.comments) out.push(`- ${ICON[c.severity]} \`${c.path}:${c.line}\` **${c.title}**: ${c.body}`);
  }
  if (r.unplaced.length) {
    out.push("", "<details><summary>More findings (" + r.unplaced.length + ")</summary>", "");
    for (const c of r.unplaced) out.push(`- ${ICON[c.severity]} \`${c.path}${Number.isFinite(c.line) ? ":" + c.line : ""}\` **${c.title}**: ${c.body}`);
    out.push("", "</details>");
  }
  if (r.tests.length) {
    out.push("", "### Tests worth adding", "");
    for (const t of r.tests) out.push(`- **${t.name}**${t.path ? ` (\`${t.path}\`)` : ""}: ${t.why}`);
  }
  const skipped = r.stats.skipped.filter((s) => s.reason !== "ignored");
  if (skipped.length || r.stats.truncated) {
    out.push("", `<sub>Reviewed ${r.stats.reviewedFiles} of ${r.stats.files} files.${r.stats.truncated ? " The diff was larger than the review budget." : ""} Skipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}</sub>`);
  }
  out.push("", `<sub>[AI PR Reviewer](https://github.com/codeitronics/ai-pr-reviewer) by CodeITronics \xB7 ${r.model.provider} ${r.model.model} \xB7 AI can be wrong: treat this as a second pair of eyes, not a verdict.</sub>`);
  return out.join("\n");
}
var MARKER, ICON;
var init_format = __esm({
  "src/core/format.ts"() {
    "use strict";
    MARKER = "<!-- codeitronics-ai-pr-reviewer -->";
    ICON = { critical: "\u{1F534}", warning: "\u{1F7E0}", info: "\u{1F535}" };
  }
});

// src/github/api.ts
function parsePrUrl(input) {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(input) ?? /^([^/\s]+)\/([^/#\s]+)#(\d+)$/.exec(input.trim());
  if (!m) throw new Error(`Not a pull request link: ${input}. Use https://github.com/owner/repo/pull/123 or owner/repo#123.`);
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) };
}
var GitHub;
var init_api = __esm({
  "src/github/api.ts"() {
    "use strict";
    init_format();
    GitHub = class {
      constructor(token, base = "https://api.github.com", fetchImpl = fetch) {
        this.token = token;
        this.base = base;
        this.fetchImpl = fetchImpl;
      }
      token;
      base;
      fetchImpl;
      async req(path2, init = {}) {
        const res = await this.fetchImpl(this.base + path2, {
          ...init,
          headers: {
            accept: init.accept ?? "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "codeitronics-ai-pr-reviewer",
            ...this.token ? { authorization: `Bearer ${this.token}` } : {},
            ...init.body ? { "content-type": "application/json" } : {}
          }
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const hint = res.status === 404 && !this.token ? " (private repos need a token)" : res.status === 403 && /rate limit/i.test(text) ? " (GitHub rate limit; add a token)" : "";
          throw Object.assign(new Error(`GitHub ${init.method ?? "GET"} ${path2} \u2192 ${res.status}${hint}: ${text.slice(0, 200)}`), { status: res.status });
        }
        return res;
      }
      async pr({ owner, repo, number }) {
        const d = await (await this.req(`/repos/${owner}/${repo}/pulls/${number}`)).json();
        return {
          owner,
          repo,
          number,
          title: d.title,
          author: d.user?.login,
          url: d.html_url,
          headSha: d.head?.sha,
          draft: !!d.draft,
          state: d.merged_at ? "merged" : d.state,
          additions: d.additions,
          deletions: d.deletions,
          changedFiles: d.changed_files
        };
      }
      async diff({ owner, repo, number }) {
        return (await this.req(`/repos/${owner}/${repo}/pulls/${number}`, { accept: "application/vnd.github.v3.diff" })).text();
      }
      async file(owner, repo, path2, ref) {
        try {
          const res = await this.req(`/repos/${owner}/${repo}/contents/${path2}${ref ? `?ref=${ref}` : ""}`, { accept: "application/vnd.github.raw+json" });
          return await res.text();
        } catch {
          return null;
        }
      }
      /**
       * Posts the review as one GitHub review with inline comments. If GitHub rejects the inline comments (422,
       * e.g. a line outside the diff after a force-push), it falls back to a summary-only review, so the
       * findings are never lost.
       */
      async postReview(pr, review2) {
        const event = review2.verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
        const comments = review2.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: commentBody(c) }));
        const post = (body) => this.req(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, { method: "POST", body: JSON.stringify(body) });
        try {
          const res = await (await post({ commit_id: pr.headSha, event, body: summaryBody(review2), comments })).json();
          return { url: res.html_url, inline: true };
        } catch (err) {
          if (err.status !== 422 || !comments.length) throw err;
          const res = await (await post({ commit_id: pr.headSha, event, body: summaryBody(review2, { inlinePosted: false }) })).json();
          return { url: res.html_url, inline: false };
        }
      }
      /** Reviews this tool posted on a repo's recent pull requests (found by the hidden marker). */
      async history(owner, repo, { prs = 20 } = {}) {
        const pulls = await (await this.req(`/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${prs}`)).json();
        const out = [];
        for (const p of pulls) {
          const reviews = await (await this.req(`/repos/${owner}/${repo}/pulls/${p.number}/reviews?per_page=100`)).json();
          for (const r of reviews.filter((x) => typeof x.body === "string" && x.body.includes(MARKER))) {
            const counts = /(\d+) comments?\*\*: (\d+) critical · (\d+) warning · (\d+) info/.exec(r.body);
            out.push({
              repo: `${owner}/${repo}`,
              number: p.number,
              title: p.title,
              author: p.user?.login,
              prState: p.merged_at ? "merged" : p.state,
              url: r.html_url,
              at: r.submitted_at,
              verdict: r.state === "CHANGES_REQUESTED" ? "request_changes" : "comment",
              comments: counts ? Number(counts[1]) : null,
              critical: counts ? Number(counts[2]) : null,
              warning: counts ? Number(counts[3]) : null,
              info: counts ? Number(counts[4]) : null
            });
          }
        }
        return out.sort((a, b) => b.at.localeCompare(a.at));
      }
    };
  }
});

// src/ui/server.ts
var server_exports = {};
__export(server_exports, {
  createApp: () => createApp,
  startServer: () => startServer,
  viewModel: () => viewModel
});
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Handlebars from "handlebars";
import pc from "picocolors";
function uiDir() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "ui", "views"))) return path.join(dir, "ui");
    dir = path.dirname(dir);
  }
  throw new Error("ui/ folder not found");
}
function viewModel(diff, review2) {
  const byFile = /* @__PURE__ */ new Map();
  for (const c of review2.comments) byFile.set(c.path, [...byFile.get(c.path) ?? [], c]);
  const files = parseDiff(diff).map((f) => {
    const comments = byFile.get(f.path) ?? [];
    const rows = [];
    for (const h of f.hunks) {
      rows.push({ kind: "hunk", text: h.header, comments: [] });
      for (const l of h.lines) rows.push({ kind: l.kind, oldLine: l.oldLine, newLine: l.newLine, text: l.text, comments: l.newLine !== void 0 && l.kind !== "del" ? comments.filter((c) => c.line === l.newLine) : [] });
    }
    return { path: f.path, status: f.status, rows, count: comments.length };
  });
  const n = (s) => review2.comments.filter((c) => c.severity === s).length;
  return { files: files.filter((f) => f.rows.length), counts: { critical: n("critical"), warning: n("warning"), info: n("info"), total: review2.comments.length } };
}
async function createApp({ demo = process.env.PR_REVIEWER_DEMO === "1", root = (process.env.ROOT_PATH || "").replace(/\/$/, "") } = {}) {
  const UI = uiDir();
  const hbs = Handlebars.create();
  hbs.registerHelper("eq", (a, b) => a === b);
  hbs.registerHelper("ago", (iso) => ago(iso));
  hbs.registerHelper("upper", (s) => String(s).toUpperCase());
  const views = {};
  for (const f of fs.readdirSync(path.join(UI, "views"))) {
    const src = fs.readFileSync(path.join(UI, "views", f), "utf8");
    const tpl = hbs.compile(src, { preventIndent: true });
    if (f.startsWith("_")) hbs.registerPartial(f.slice(1, -4), tpl);
    views[f.slice(0, -4)] = tpl;
  }
  const sample = {
    diff: fs.readFileSync(path.join(UI, "sample", "diff.patch"), "utf8"),
    review: JSON.parse(fs.readFileSync(path.join(UI, "sample", "review.json"), "utf8")),
    pr: JSON.parse(fs.readFileSync(path.join(UI, "sample", "pr.json"), "utf8"))
  };
  const assetVersion = crypto.createHash("sha1").update(fs.readFileSync(path.join(UI, "static", "app.css"))).update(fs.readFileSync(path.join(UI, "static", "app.js"))).digest("hex").slice(0, 8);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const gh = new GitHub(token);
  const ai = (() => {
    try {
      return resolveAI();
    } catch {
      return null;
    }
  })();
  const results = /* @__PURE__ */ new Map();
  const historyCache = /* @__PURE__ */ new Map();
  const defaultRepos = process.env.REVIEW_REPOS || "codeitronics/ai-pr-reviewer-demo";
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));
  app.use((_req, res, next) => {
    res.set({ "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY" });
    next();
  });
  app.use("/static", express.static(path.join(UI, "static"), { maxAge: "1h" }));
  const page = (res, view, data) => res.send(views.layout({ ...data, root, demo, assetVersion, body: views[view]({ ...data, root, demo }) }));
  const showResult = (res, r, id, extra = {}) => page(res, "result", { title: r.pr ? `#${r.pr.number} ${r.pr.title}` : "Review", nav: "review", ...r, id, vm: viewModel(r.diff, r.review), canPost: !demo && !!token && !!r.pr && !!id, ...extra });
  app.get("/", (_req, res) => {
    if (demo) return showResult(res, sample, null, { isSample: true });
    page(res, "review", { title: "Review", nav: "review", ai, token: !!token });
  });
  app.get("/sample", (_req, res) => showResult(res, sample, null, { isSample: true }));
  app.post("/review", async (req, res) => {
    if (demo) return res.status(403).send("The public demo shows a recorded review. Run it on your own PRs with `npx @codeitronics/ai-pr-reviewer ui` and your own AI key.");
    try {
      if (!ai) throw new Error("No AI key found. Set DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) and restart.");
      let pr = null;
      let diff = String(req.body.diff ?? "");
      if (req.body.target?.trim()) {
        const ref = parsePrUrl(req.body.target);
        pr = await gh.pr(ref);
        diff = await gh.diff(ref);
      }
      if (!diff.trim()) throw new Error("Paste a pull request link or a diff.");
      const review2 = await reviewDiff(diff, ai, {
        include: SEVERITIES.filter((s) => req.body[`sev_${s}`] === "on"),
        requestChangesOn: SEVERITIES.includes(req.body.requestChangesOn) ? req.body.requestChangesOn : "never"
      });
      const id = crypto.randomBytes(6).toString("hex");
      results.set(id, { diff, review: review2, pr, at: Date.now() });
      for (const [k, v] of results) if (Date.now() - v.at > 6 * 3600 * 1e3) results.delete(k);
      res.redirect(303, `${root}/r/${id}`);
    } catch (err) {
      page(res, "review", { title: "Review", nav: "review", ai, token: !!token, error: err.message, target: req.body.target, diff: req.body.diff });
    }
  });
  app.get("/r/:id", (req, res) => {
    const r = results.get(req.params.id);
    if (!r) return res.redirect(303, `${root}/`);
    showResult(res, r, req.params.id);
  });
  app.post("/r/:id/post", async (req, res) => {
    const r = results.get(req.params.id);
    if (demo || !r?.pr || !token) return res.status(403).send("Posting needs a pull request review and GITHUB_TOKEN.");
    try {
      const posted = await gh.postReview(r.pr, r.review);
      showResult(res, r, req.params.id, { posted });
    } catch (err) {
      showResult(res, r, req.params.id, { postError: err.message });
    }
  });
  app.get("/history", async (req, res) => {
    const repos = String(req.query.repos ?? defaultRepos).split(/[\s,]+/).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 5);
    const key = repos.join(",");
    let cached = historyCache.get(key);
    if (!cached || Date.now() - cached.at > 10 * 60 * 1e3) {
      try {
        const items2 = (await Promise.all(repos.map((r) => gh.history(r.split("/")[0], r.split("/")[1])))).flat().sort((a, b) => b.at.localeCompare(a.at));
        cached = { at: Date.now(), items: items2 };
      } catch (err) {
        cached = { at: Date.now(), items: [], error: err.message };
      }
      historyCache.set(key, cached);
    }
    const items = cached.items;
    const sum = (k) => items.reduce((n, i) => n + (i[k] ?? 0), 0);
    page(res, "history", {
      title: "History",
      nav: "history",
      repos: key,
      items,
      error: cached.error,
      token: !!token,
      stats: { reviews: items.length, prs: new Set(items.map((i) => `${i.repo}#${i.number}`)).size, comments: sum("comments"), critical: sum("critical"), warning: sum("warning"), blocked: items.filter((i) => i.verdict === "request_changes").length }
    });
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true, demo }));
  app.use((_req, res) => res.status(404).send("Not found"));
  return app;
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1e3;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
async function startServer({ port = 4600, host = "127.0.0.1" } = {}) {
  const app = await createApp();
  await new Promise((resolve) => app.listen(port, host, () => resolve()));
  console.log(`${pc.green("\u2713")} AI PR Reviewer UI on ${pc.bold(`http://${host}:${port}`)}${process.env.PR_REVIEWER_DEMO === "1" ? " (demo mode)" : ""}`);
}
var init_server = __esm({
  "src/ui/server.ts"() {
    "use strict";
    init_diff();
    init_llm();
    init_review();
    init_api();
  }
});

// src/cli.ts
init_llm();
init_review();
init_api();
import fs2 from "node:fs/promises";
import { Command, Option } from "commander";
import pc2 from "picocolors";
var VERSION = "1.0.1";
var ICON2 = { critical: pc2.red("\u25CF critical"), warning: pc2.yellow("\u25CF warning "), info: pc2.blue("\u25CF info    ") };
async function run(argv) {
  const program = new Command().name("ai-pr-reviewer").description("AI code review for pull requests: CLI, GitHub Action and web UI.").version(VERSION);
  program.command("review <target>").description("Review a pull request (URL or owner/repo#123), a .diff/.patch file, or - for stdin").addOption(new Option("--provider <provider>", "AI provider (default: first key found, DeepSeek first)").choices(["deepseek", "anthropic", "openai", "gemini"])).option("--model <model>", "model override").option("--severity <list>", "severities to report", "info,warning,critical").addOption(new Option("--request-changes-on <severity>", "verdict threshold").choices(["never", ...SEVERITIES]).default("never")).option("--ignore <globs>", "extra glob patterns to skip, comma separated", "").option("--post", "post the review to the pull request (needs GITHUB_TOKEN with write access)").option("--json", "print the review as JSON").action(review);
  program.command("ui").description("Open the web UI: review a PR or diff with inline comments, and browse review history").option("-p, --port <port>", "port", "4600").option("--host <host>", "host", "127.0.0.1").action(async (o) => {
    const { startServer: startServer2 } = await Promise.resolve().then(() => (init_server(), server_exports));
    await startServer2({ port: Number(o.port), host: o.host });
  });
  await program.parseAsync(argv);
}
async function review(target, o) {
  const ai = resolveAI({ provider: o.provider, model: o.model });
  if (!ai) throw new Error("No AI key found. Set DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).");
  const gh = new GitHub(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  let diff;
  let pr = null;
  if (target === "-") diff = await readStdin();
  else if (/\.(diff|patch)$/.test(target)) diff = await fs2.readFile(target, "utf8");
  else {
    const ref = parsePrUrl(target);
    pr = await gh.pr(ref);
    diff = await gh.diff(ref);
  }
  if (!o.json) process.stderr.write(pc2.dim(`Reviewing ${pr ? `${pr.owner}/${pr.repo}#${pr.number} "${pr.title}"` : target} with ${ai.provider} (${ai.model})\u2026
`));
  const r = await reviewDiff(diff, ai, {
    include: String(o.severity).split(",").map((s) => s.trim()).filter((s) => SEVERITIES.includes(s)),
    requestChangesOn: o.requestChangesOn,
    ignore: String(o.ignore).split(",").map((s) => s.trim()).filter(Boolean)
  });
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else print(r);
  if (o.post) {
    if (!pr) throw new Error("--post needs a pull request link, not a diff file.");
    const posted = await gh.postReview(pr, r);
    console.log(`
${pc2.green("\u2713")} Posted to ${posted.url}${posted.inline ? "" : pc2.yellow(" (summary only: GitHub rejected inline placement)")}`);
  }
}
function print(r) {
  console.log(`
${pc2.bold("Summary")}  ${r.summary}
`);
  for (const c of r.comments) {
    console.log(`${ICON2[c.severity]}  ${pc2.bold(`${c.path}:${c.line}`)}  ${c.title} ${pc2.dim(`[${c.category}]`)}`);
    console.log(`            ${c.body}`);
    if (c.suggestion) console.log(pc2.green(c.suggestion.split("\n").map((l) => `            + ${l}`).join("\n")));
  }
  for (const c of r.unplaced) console.log(`${ICON2[c.severity]}  ${pc2.dim(`${c.path} (not on a changed line)`)}  ${c.title}`);
  if (r.tests.length) {
    console.log(`
${pc2.bold("Tests worth adding")}`);
    for (const t of r.tests) console.log(`  \u2022 ${t.name}${t.path ? pc2.dim(` (${t.path})`) : ""}: ${t.why}`);
  }
  const n = (s) => r.comments.filter((c) => c.severity === s).length;
  console.log(`
${r.comments.length} comments: ${n("critical")} critical, ${n("warning")} warning, ${n("info")} info \xB7 verdict: ${r.verdict === "request_changes" ? pc2.red("changes requested") : "comment"}`);
  if (r.stats.skipped.length) console.log(pc2.dim(`Skipped: ${r.stats.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`));
}
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
export {
  run
};
