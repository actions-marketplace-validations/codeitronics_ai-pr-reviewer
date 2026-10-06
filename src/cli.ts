import fs from "node:fs/promises";
import { Command, Option } from "commander";
import pc from "picocolors";
import { resolveAI } from "./core/llm.js";
import { reviewDiff, SEVERITIES, type Review, type Severity } from "./core/review.js";
import { GitHub, parsePrUrl } from "./github/api.js";

const VERSION = "1.0.0";
const ICON: Record<Severity, string> = { critical: pc.red("● critical"), warning: pc.yellow("● warning "), info: pc.blue("● info    ") };

export async function run(argv: string[]) {
  const program = new Command().name("ai-pr-reviewer").description("AI code review for pull requests: CLI, GitHub Action and web UI.").version(VERSION);

  program
    .command("review <target>")
    .description("Review a pull request (URL or owner/repo#123), a .diff/.patch file, or - for stdin")
    .addOption(new Option("--provider <provider>", "AI provider (default: first key found, DeepSeek first)").choices(["deepseek", "anthropic", "openai", "gemini"]))
    .option("--model <model>", "model override")
    .option("--severity <list>", "severities to report", "info,warning,critical")
    .addOption(new Option("--request-changes-on <severity>", "verdict threshold").choices(["never", ...SEVERITIES]).default("never"))
    .option("--ignore <globs>", "extra glob patterns to skip, comma separated", "")
    .option("--post", "post the review to the pull request (needs GITHUB_TOKEN with write access)")
    .option("--json", "print the review as JSON")
    .action(review);

  program
    .command("ui")
    .description("Open the web UI: review a PR or diff with inline comments, and browse review history")
    .option("-p, --port <port>", "port", "4600")
    .option("--host <host>", "host", "127.0.0.1")
    .action(async (o) => {
      const { startServer } = await import("./ui/server.js");
      await startServer({ port: Number(o.port), host: o.host });
    });

  await program.parseAsync(argv);
}

async function review(target: string, o: any) {
  const ai = resolveAI({ provider: o.provider, model: o.model });
  if (!ai) throw new Error("No AI key found. Set DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY).");
  const gh = new GitHub(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  let diff: string;
  let pr: Awaited<ReturnType<GitHub["pr"]>> | null = null;
  if (target === "-") diff = await readStdin();
  else if (/\.(diff|patch)$/.test(target)) diff = await fs.readFile(target, "utf8");
  else {
    const ref = parsePrUrl(target);
    pr = await gh.pr(ref);
    diff = await gh.diff(ref);
  }
  if (!o.json) process.stderr.write(pc.dim(`Reviewing ${pr ? `${pr.owner}/${pr.repo}#${pr.number} "${pr.title}"` : target} with ${ai.provider} (${ai.model})…\n`));
  const r = await reviewDiff(diff, ai, {
    include: String(o.severity).split(",").map((s) => s.trim()).filter((s): s is Severity => (SEVERITIES as string[]).includes(s)),
    requestChangesOn: o.requestChangesOn,
    ignore: String(o.ignore).split(",").map((s) => s.trim()).filter(Boolean),
  });
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else print(r);
  if (o.post) {
    if (!pr) throw new Error("--post needs a pull request link, not a diff file.");
    const posted = await gh.postReview(pr, r);
    console.log(`\n${pc.green("✓")} Posted to ${posted.url}${posted.inline ? "" : pc.yellow(" (summary only: GitHub rejected inline placement)")}`);
  }
}

function print(r: Review) {
  console.log(`\n${pc.bold("Summary")}  ${r.summary}\n`);
  for (const c of r.comments) {
    console.log(`${ICON[c.severity]}  ${pc.bold(`${c.path}:${c.line}`)}  ${c.title} ${pc.dim(`[${c.category}]`)}`);
    console.log(`            ${c.body}`);
    if (c.suggestion) console.log(pc.green(c.suggestion.split("\n").map((l) => `            + ${l}`).join("\n")));
  }
  for (const c of r.unplaced) console.log(`${ICON[c.severity]}  ${pc.dim(`${c.path} (not on a changed line)`)}  ${c.title}`);
  if (r.tests.length) {
    console.log(`\n${pc.bold("Tests worth adding")}`);
    for (const t of r.tests) console.log(`  • ${t.name}${t.path ? pc.dim(` (${t.path})`) : ""}: ${t.why}`);
  }
  const n = (s: Severity) => r.comments.filter((c) => c.severity === s).length;
  console.log(`\n${r.comments.length} comments: ${n("critical")} critical, ${n("warning")} warning, ${n("info")} info · verdict: ${r.verdict === "request_changes" ? pc.red("changes requested") : "comment"}`);
  if (r.stats.skipped.length) console.log(pc.dim(`Skipped: ${r.stats.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
