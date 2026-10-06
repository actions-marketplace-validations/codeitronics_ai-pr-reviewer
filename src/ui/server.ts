import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Handlebars from "handlebars";
import pc from "picocolors";
import { parseDiff, type DiffFile } from "../core/diff.js";
import { resolveAI } from "../core/llm.js";
import { reviewDiff, SEVERITIES, type Review, type ReviewComment } from "../core/review.js";
import { GitHub, parsePrUrl, type HistoryItem, type PRInfo } from "../github/api.js";

/** The ui/ folder (views, static, sample) sits at the package root, both from src/ and from the dist bundle. */
function uiDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "ui", "views"))) return path.join(dir, "ui");
    dir = path.dirname(dir);
  }
  throw new Error("ui/ folder not found");
}

interface Row {
  kind: "add" | "del" | "ctx" | "hunk";
  oldLine?: number;
  newLine?: number;
  text: string;
  comments: ReviewComment[];
}

/** Diff + review → rows per file, with each comment attached under its line. */
export function viewModel(diff: string, review: Review) {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of review.comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const files = parseDiff(diff).map((f: DiffFile) => {
    const comments = byFile.get(f.path) ?? [];
    const rows: Row[] = [];
    for (const h of f.hunks) {
      rows.push({ kind: "hunk", text: h.header, comments: [] });
      for (const l of h.lines) rows.push({ kind: l.kind, oldLine: l.oldLine, newLine: l.newLine, text: l.text, comments: l.newLine !== undefined && l.kind !== "del" ? comments.filter((c) => c.line === l.newLine) : [] });
    }
    return { path: f.path, status: f.status, rows, count: comments.length };
  });
  const n = (s: string) => review.comments.filter((c) => c.severity === s).length;
  return { files: files.filter((f) => f.rows.length), counts: { critical: n("critical"), warning: n("warning"), info: n("info"), total: review.comments.length } };
}

export async function createApp({ demo = process.env.PR_REVIEWER_DEMO === "1", root = (process.env.ROOT_PATH || "").replace(/\/$/, "") } = {}) {
  const UI = uiDir();
  const hbs = Handlebars.create();
  hbs.registerHelper("eq", (a: unknown, b: unknown) => a === b);
  hbs.registerHelper("ago", (iso: string) => ago(iso));
  hbs.registerHelper("upper", (s: string) => String(s).toUpperCase());
  const views: Record<string, HandlebarsTemplateDelegate> = {};
  for (const f of fs.readdirSync(path.join(UI, "views"))) {
    const src = fs.readFileSync(path.join(UI, "views", f), "utf8");
    const tpl = hbs.compile(src, { preventIndent: true });
    if (f.startsWith("_")) hbs.registerPartial(f.slice(1, -4), tpl);
    views[f.slice(0, -4)] = tpl;
  }
  const sample = {
    diff: fs.readFileSync(path.join(UI, "sample", "diff.patch"), "utf8"),
    review: JSON.parse(fs.readFileSync(path.join(UI, "sample", "review.json"), "utf8")) as Review,
    pr: JSON.parse(fs.readFileSync(path.join(UI, "sample", "pr.json"), "utf8")) as PRInfo,
  };
  // Changes whenever the stylesheet or script changes, so browsers never use a stale cached copy.
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
  const results = new Map<string, { diff: string; review: Review; pr: PRInfo | null; at: number }>();
  const historyCache = new Map<string, { at: number; items: HistoryItem[]; error?: string }>();
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

  const page = (res: express.Response, view: string, data: Record<string, unknown>) =>
    res.send(views.layout({ ...data, root, demo, assetVersion, body: views[view]({ ...data, root, demo }) }));
  const showResult = (res: express.Response, r: { diff: string; review: Review; pr: PRInfo | null }, id: string | null, extra: Record<string, unknown> = {}) =>
    page(res, "result", { title: r.pr ? `#${r.pr.number} ${r.pr.title}` : "Review", nav: "review", ...r, id, vm: viewModel(r.diff, r.review), canPost: !demo && !!token && !!r.pr && !!id, ...extra });

  app.get("/", (_req, res) => {
    if (demo) return showResult(res, sample, null, { isSample: true });
    page(res, "review", { title: "Review", nav: "review", ai, token: !!token });
  });
  app.get("/sample", (_req, res) => showResult(res, sample, null, { isSample: true }));

  app.post("/review", async (req, res) => {
    if (demo) return res.status(403).send("The public demo shows a recorded review. Run it on your own PRs with `npx @codeitronics/ai-pr-reviewer ui` and your own AI key.");
    try {
      if (!ai) throw new Error("No AI key found. Set DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) and restart.");
      let pr: PRInfo | null = null;
      let diff = String(req.body.diff ?? "");
      if (req.body.target?.trim()) {
        const ref = parsePrUrl(req.body.target);
        pr = await gh.pr(ref);
        diff = await gh.diff(ref);
      }
      if (!diff.trim()) throw new Error("Paste a pull request link or a diff.");
      const review = await reviewDiff(diff, ai, {
        include: SEVERITIES.filter((s) => req.body[`sev_${s}`] === "on"),
        requestChangesOn: SEVERITIES.includes(req.body.requestChangesOn) ? req.body.requestChangesOn : "never",
      });
      const id = crypto.randomBytes(6).toString("hex");
      results.set(id, { diff, review, pr, at: Date.now() });
      for (const [k, v] of results) if (Date.now() - v.at > 6 * 3600 * 1000) results.delete(k);
      res.redirect(303, `${root}/r/${id}`);
    } catch (err: any) {
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
    } catch (err: any) {
      showResult(res, r, req.params.id, { postError: err.message });
    }
  });

  app.get("/history", async (req, res) => {
    const repos = String(req.query.repos ?? defaultRepos).split(/[\s,]+/).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 5);
    const key = repos.join(",");
    let cached = historyCache.get(key);
    if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
      try {
        const items = (await Promise.all(repos.map((r) => gh.history(r.split("/")[0], r.split("/")[1])))).flat().sort((a, b) => b.at.localeCompare(a.at));
        cached = { at: Date.now(), items };
      } catch (err: any) {
        cached = { at: Date.now(), items: [], error: err.message };
      }
      historyCache.set(key, cached);
    }
    const items = cached.items;
    const sum = (k: "critical" | "warning" | "info" | "comments") => items.reduce((n, i) => n + (i[k] ?? 0), 0);
    page(res, "history", {
      title: "History", nav: "history", repos: key, items, error: cached.error, token: !!token,
      stats: { reviews: items.length, prs: new Set(items.map((i) => `${i.repo}#${i.number}`)).size, comments: sum("comments"), critical: sum("critical"), warning: sum("warning"), blocked: items.filter((i) => i.verdict === "request_changes").length },
    });
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true, demo }));
  app.use((_req, res) => res.status(404).send("Not found"));
  return app;
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export async function startServer({ port = 4600, host = "127.0.0.1" } = {}) {
  const app = await createApp();
  await new Promise<void>((resolve) => app.listen(port, host, () => resolve()));
  console.log(`${pc.green("✓")} AI PR Reviewer UI on ${pc.bold(`http://${host}:${port}`)}${process.env.PR_REVIEWER_DEMO === "1" ? " (demo mode)" : ""}`);
}
