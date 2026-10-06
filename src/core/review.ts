// The review engine: diff in, validated review out. Knows nothing about GitHub.
import { completeJSON, type AI } from "./llm.js";
import { DEFAULT_IGNORE, parseDiff, render, selectFiles, type DiffFile } from "./diff.js";

export type Severity = "info" | "warning" | "critical";
export const SEVERITIES: Severity[] = ["info", "warning", "critical"];
export const CATEGORIES = ["bug", "security", "performance", "maintainability", "tests"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ReviewComment {
  path: string;
  line: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  /** Replacement for the commented line(s), rendered as a GitHub suggestion block. */
  suggestion?: string;
  /** Set when the model's line wasn't in the diff and we moved the comment to the nearest changed line. */
  movedFrom?: number;
}

export interface TestSuggestion {
  path?: string;
  name: string;
  why: string;
}

export interface Review {
  summary: string;
  verdict: "comment" | "request_changes";
  comments: ReviewComment[];
  /** Comments whose line couldn't be placed on the diff; shown in the summary instead. */
  unplaced: ReviewComment[];
  tests: TestSuggestion[];
  stats: { files: number; reviewedFiles: number; skipped: { path: string; reason: string }[]; truncated: boolean };
  model: { provider: string; model: string };
}

export interface ReviewOptions {
  /** Minimum severities to keep, e.g. ["warning", "critical"]. */
  include?: Severity[];
  /** Ask for changes (block merge) when a comment at or above this severity is found. "never" by default. */
  requestChangesOn?: Severity | "never";
  ignore?: string[];
  maxChars?: number;
  /** Extra project-specific guidance, e.g. from .github/ai-review.md. */
  instructions?: string;
  maxComments?: number;
  fetchImpl?: typeof fetch;
}

const SYSTEM = `You are a senior engineer reviewing a pull request. Be useful, specific and brief.

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

export async function reviewDiff(diff: string, ai: AI, opts: ReviewOptions = {}): Promise<Review> {
  const files = parseDiff(diff);
  const sel = selectFiles(files, { ignore: [...DEFAULT_IGNORE, ...(opts.ignore ?? [])], maxChars: opts.maxChars ?? 60_000 });
  const base = { files: files.length, reviewedFiles: sel.files.length, skipped: sel.skipped, truncated: sel.truncated };
  if (!sel.files.length) {
    return { summary: "Nothing to review: no changed source files after filtering.", verdict: "comment", comments: [], unplaced: [], tests: [], stats: base, model: { provider: ai.provider, model: ai.model } };
  }
  const user = [
    opts.instructions ? `Project guidance from the maintainers:\n${opts.instructions.slice(0, 4000)}\n` : "",
    sel.truncated ? "Note: the diff was too large; some files are omitted and listed as skipped.\n" : "",
    "Diff:\n",
    render(sel.files),
  ].join("\n");
  const raw = await completeJSON(ai, SYSTEM, user, { fetchImpl: opts.fetchImpl });
  return finalize(raw, sel.files, base, ai, opts);
}

/** Validates and normalises the model's output against the diff. Exported for tests. */
export function finalize(raw: unknown, files: DiffFile[], stats: Review["stats"], ai: Pick<AI, "provider" | "model">, opts: ReviewOptions = {}): Review {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r) ? r : Array.isArray(r.comments) ? r.comments : Array.isArray(r.reviews) ? r.reviews : Array.isArray(r.issues) ? r.issues : [];
  const include = new Set(opts.include ?? SEVERITIES);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const comments: ReviewComment[] = [];
  const unplaced: ReviewComment[] = [];
  const seen = new Set<string>();

  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const severity = (SEVERITIES as string[]).includes(String(item.severity)) ? (item.severity as Severity) : "info";
    if (!include.has(severity)) continue;
    const category = (CATEGORIES as readonly string[]).includes(String(item.category)) ? (item.category as Category) : "bug";
    const path = String(item.path ?? item.file ?? "").replace(/^[ab]\//, "");
    const want = Number(item.line ?? item.lineNumber);
    const body = String(item.body ?? item.comment ?? "").trim();
    const title = String(item.title ?? "").trim() || body.split(/[.!?]\s/)[0].slice(0, 80);
    if (!body) continue;
    const suggestion = typeof item.suggestion === "string" && item.suggestion.trim() ? item.suggestion.replace(/\n+$/, "") : undefined;
    const c: ReviewComment = { path, line: want, severity, category, title, body, suggestion };

    const file = byPath.get(path) ?? [...byPath.values()].find((f) => f.path.endsWith("/" + path));
    if (file) c.path = file.path;
    const placed = file && Number.isInteger(want) ? place(file, want) : undefined;
    if (placed === undefined) {
      unplaced.push(c);
      continue;
    }
    if (placed !== want) {
      c.movedFrom = want;
      c.line = placed;
      c.suggestion = undefined; // a suggestion written for another line would replace the wrong code
    }
    if (c.suggestion && file) c.suggestion = reindent(c.suggestion, lineText(file, c.line));
    const key = `${c.path}:${c.line}:${c.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    comments.push(c);
  }

  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  comments.sort((a, b) => rank(b.severity) - rank(a.severity) || a.path.localeCompare(b.path) || a.line - b.line);
  const max = opts.maxComments ?? 25;
  const overflow = comments.splice(max);
  const threshold = opts.requestChangesOn ?? "never";
  const blocking = threshold !== "never" && comments.some((c) => rank(c.severity) >= rank(threshold));
  const tests = (Array.isArray(r.tests) ? r.tests : [])
    .filter((t: any) => t && t.name)
    .slice(0, 5)
    .map((t: any) => ({ path: t.path ? String(t.path) : undefined, name: String(t.name), why: String(t.why ?? "") }));

  return {
    summary: String(r.summary ?? "").trim() || "Review complete.",
    verdict: blocking ? "request_changes" : "comment",
    comments,
    unplaced: [...unplaced, ...overflow],
    tests,
    stats,
    model: { provider: ai.provider, model: ai.model },
  };
}

function lineText(file: DiffFile, line: number): string | undefined {
  for (const h of file.hunks) for (const l of h.lines) if (l.newLine === line && l.kind !== "del") return l.text;
  return undefined;
}

/**
 * Models usually return suggestion code without its original indentation, which GitHub would apply as-is.
 * Shift the block so its least-indented line matches the indentation of the line being replaced.
 */
export function reindent(suggestion: string, original: string | undefined): string {
  if (original === undefined) return suggestion;
  const indent = /^\s*/.exec(original)![0];
  const lines = suggestion.split("\n");
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  if (!Number.isFinite(min)) return suggestion;
  return lines.map((l) => (l.trim() ? indent + l.slice(min) : l)).join("\n");
}

/** The model's line if GitHub will accept it, else the nearest added line within 3 lines, else undefined. */
function place(file: DiffFile, line: number): number | undefined {
  if (file.commentable.has(line)) return line;
  let best: number | undefined;
  for (const n of file.added) {
    const d = Math.abs(n - line);
    if (d <= 3 && (best === undefined || d < Math.abs(best - line))) best = n;
  }
  return best;
}
