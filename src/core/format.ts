// Markdown for GitHub: the review summary and each inline comment.
import type { Review, ReviewComment } from "./review.js";

/** Hidden marker so the history page can find reviews this tool posted. */
export const MARKER = "<!-- codeitronics-ai-pr-reviewer -->";

const ICON: Record<string, string> = { critical: "🔴", warning: "🟠", info: "🔵" };

export function commentBody(c: ReviewComment): string {
  const lines = [`${ICON[c.severity]} **${c.severity.toUpperCase()}** · ${c.category} · **${c.title}**`, "", c.body];
  if (c.suggestion) lines.push("", "```suggestion", c.suggestion, "```");
  if (c.movedFrom) lines.push("", `<sub>The model pointed at line ${c.movedFrom}; moved to the nearest changed line.</sub>`);
  return lines.join("\n");
}

export function summaryBody(r: Review, { inlinePosted = true } = {}): string {
  const count = (s: string) => r.comments.filter((c) => c.severity === s).length;
  const out = [
    MARKER,
    `## AI review`,
    "",
    r.summary,
    "",
    `**${r.comments.length} comment${r.comments.length === 1 ? "" : "s"}**: ${count("critical")} critical · ${count("warning")} warning · ${count("info")} info${r.verdict === "request_changes" ? " · **changes requested**" : ""}`,
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
  out.push("", `<sub>[AI PR Reviewer](https://github.com/codeitronics/ai-pr-reviewer) by CodeITronics · ${r.model.provider} ${r.model.model} · AI can be wrong: treat this as a second pair of eyes, not a verdict.</sub>`);
  return out.join("\n");
}
