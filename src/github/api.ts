// Just the GitHub REST calls we need, over fetch.
import { commentBody, MARKER, summaryBody } from "../core/format.js";
import type { Review } from "../core/review.js";

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PRInfo extends PRRef {
  title: string;
  author: string;
  url: string;
  headSha: string;
  draft: boolean;
  state: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export function parsePrUrl(input: string): PRRef {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(input) ?? /^([^/\s]+)\/([^/#\s]+)#(\d+)$/.exec(input.trim());
  if (!m) throw new Error(`Not a pull request link: ${input}. Use https://github.com/owner/repo/pull/123 or owner/repo#123.`);
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) };
}

export class GitHub {
  constructor(private token?: string, private base = "https://api.github.com", private fetchImpl: typeof fetch = fetch) {}

  private async req(path: string, init: RequestInit & { accept?: string } = {}) {
    const res = await this.fetchImpl(this.base + path, {
      ...init,
      headers: {
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "codeitronics-ai-pr-reviewer",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 404 && !this.token ? " (private repos need a token)" : res.status === 403 && /rate limit/i.test(text) ? " (GitHub rate limit; add a token)" : "";
      throw Object.assign(new Error(`GitHub ${init.method ?? "GET"} ${path} → ${res.status}${hint}: ${text.slice(0, 200)}`), { status: res.status });
    }
    return res;
  }

  async pr({ owner, repo, number }: PRRef): Promise<PRInfo> {
    const d: any = await (await this.req(`/repos/${owner}/${repo}/pulls/${number}`)).json();
    return {
      owner, repo, number,
      title: d.title, author: d.user?.login, url: d.html_url, headSha: d.head?.sha, draft: !!d.draft, state: d.merged_at ? "merged" : d.state,
      additions: d.additions, deletions: d.deletions, changedFiles: d.changed_files,
    };
  }

  async diff({ owner, repo, number }: PRRef): Promise<string> {
    return (await this.req(`/repos/${owner}/${repo}/pulls/${number}`, { accept: "application/vnd.github.v3.diff" })).text();
  }

  async file(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    try {
      const res = await this.req(`/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`, { accept: "application/vnd.github.raw+json" });
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
  async postReview(pr: PRInfo, review: Review): Promise<{ url: string; inline: boolean }> {
    const event = review.verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
    const comments = review.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: commentBody(c) }));
    const post = (body: unknown) => this.req(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, { method: "POST", body: JSON.stringify(body) });
    try {
      const res: any = await (await post({ commit_id: pr.headSha, event, body: summaryBody(review), comments })).json();
      return { url: res.html_url, inline: true };
    } catch (err: any) {
      if (err.status !== 422 || !comments.length) throw err;
      const res: any = await (await post({ commit_id: pr.headSha, event, body: summaryBody(review, { inlinePosted: false }) })).json();
      return { url: res.html_url, inline: false };
    }
  }

  /** Reviews this tool posted on a repo's recent pull requests (found by the hidden marker). */
  async history(owner: string, repo: string, { prs = 20 } = {}) {
    const pulls: any[] = await (await this.req(`/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${prs}`)).json();
    const out: HistoryItem[] = [];
    for (const p of pulls) {
      const reviews: any[] = await (await this.req(`/repos/${owner}/${repo}/pulls/${p.number}/reviews?per_page=100`)).json();
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
          info: counts ? Number(counts[4]) : null,
        });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
}

export interface HistoryItem {
  repo: string;
  number: number;
  title: string;
  author: string;
  prState: string;
  url: string;
  at: string;
  verdict: "comment" | "request_changes";
  comments: number | null;
  critical: number | null;
  warning: number | null;
  info: number | null;
}
