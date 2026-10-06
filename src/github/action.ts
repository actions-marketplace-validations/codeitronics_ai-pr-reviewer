// GitHub Action entry point. Bundled to dist/action.js (no node_modules at runtime).
import fs from "node:fs";
import path from "node:path";
import { resolveAI } from "../core/llm.js";
import { reviewDiff, SEVERITIES, type Severity } from "../core/review.js";
import { GitHub } from "./api.js";

const input = (name: string, fallback = "") => (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim() || fallback;
const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const setOutput = (name: string, value: string) => {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};
const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export async function run(env = process.env): Promise<void> {
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const pull = event.pull_request;
  if (!pull) {
    console.log("::notice::Not a pull_request event; nothing to review.");
    return;
  }
  if (pull.draft && input("skip_drafts", "true") === "true") {
    console.log("::notice::Draft pull request; skipping (set skip_drafts: false to review drafts).");
    return;
  }
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  const ai = resolveAI({ provider: input("provider", "deepseek"), key: input("api_key"), model: input("model") }, env);
  if (!ai) throw new Error("No AI key: set the api_key input (e.g. api_key: ${{ secrets.DEEPSEEK_API_KEY }}).");

  const gh = new GitHub(input("github_token") || env.GITHUB_TOKEN, env.GITHUB_API_URL || "https://api.github.com");
  const ref = { owner, repo, number: pull.number };
  const pr = await gh.pr(ref);
  const diff = await gh.diff(ref);

  const include = list(input("include_severity", "info,warning,critical")).filter((s): s is Severity => (SEVERITIES as string[]).includes(s));
  const threshold = input("request_changes_on", "never");
  const guidePath = input("instructions_file", ".github/ai-review.md");
  const guideLocal = env.GITHUB_WORKSPACE ? path.join(env.GITHUB_WORKSPACE, guidePath) : guidePath;
  const instructions = fs.existsSync(guideLocal) ? fs.readFileSync(guideLocal, "utf8") : (await gh.file(owner, repo, guidePath, pr.headSha)) ?? undefined;

  console.log(`Reviewing ${owner}/${repo}#${pr.number} "${pr.title}" with ${ai.provider} (${ai.model})…`);
  const review = await reviewDiff(diff, ai, {
    include,
    requestChangesOn: threshold === "never" || !(SEVERITIES as string[]).includes(threshold) ? "never" : (threshold as Severity),
    ignore: list(input("ignore")),
    maxChars: Number(input("max_diff_chars", "60000")),
    maxComments: Number(input("max_comments", "25")),
    instructions,
  });

  const posted = await gh.postReview(pr, review);
  const critical = review.comments.filter((c) => c.severity === "critical").length;
  console.log(`Posted ${review.comments.length} comment(s) (${critical} critical)${posted.inline ? "" : " as a summary (GitHub rejected inline placement)"}: ${posted.url}`);
  for (const c of review.comments) {
    const level = c.severity === "critical" ? "error" : c.severity === "warning" ? "warning" : "notice";
    console.log(`::${level} file=${c.path},line=${c.line},title=${escape(c.title)}::${escape(c.body)}`);
  }
  setOutput("comments", String(review.comments.length));
  setOutput("critical", String(critical));
  setOutput("verdict", review.verdict);
  setOutput("review_url", posted.url);
  if (critical && input("fail_on_critical", "false") === "true") process.exitCode = 1;
}

// Runs only inside GitHub Actions, so tests can import run() without side effects.
if (process.env.GITHUB_ACTIONS === "true") {
  run().catch((err) => {
    console.log(`::error::${escape(err?.message ?? String(err))}`);
    process.exitCode = 1;
  });
}
