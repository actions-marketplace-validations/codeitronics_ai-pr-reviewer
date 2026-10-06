// Parses a unified diff into files and the lines GitHub will accept review comments on.
//
// GitHub's "create review" API rejects the whole review (422) if any comment points at a line that isn't
// part of the diff, so everything downstream validates against `commentable` before posting.

export interface DiffLine {
  /** Line number in the new file (undefined for deleted lines). */
  newLine?: number;
  oldLine?: number;
  kind: "add" | "del" | "ctx";
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
  /** New-file line numbers that can carry a comment (added or context lines on the RIGHT side). */
  commentable: Set<number>;
  /** Added lines only: where the change actually is. */
  added: Set<number>;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldN = 0;
  let newN = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = { path: m?.[2] ?? "", oldPath: m?.[1], status: "modified", binary: false, hunks: [], commentable: new Set(), added: new Set() };
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
      // "\ No newline at end of file" and anything else is ignored.
    }
  }
  return files.filter((f) => f.path);
}

/** Files nobody wants reviewed line by line. */
export const DEFAULT_IGNORE = [
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
  "**/*.svg",
];

/** Minimal glob matcher: **, *, ? and exact segments. */
export function matches(path: string, pattern: string): boolean {
  // Placeholders first, so the regex fragments we insert aren't rewritten by later steps.
  const re = pattern
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "\u0003")
    .replace(/\?/g, "\u0004")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0002/g, ".*")
    .replace(/\u0003/g, "[^/]*")
    .replace(/\u0004/g, "[^/]");
  return new RegExp(`^${re}$`).test(path);
}

export interface Selection {
  files: DiffFile[];
  skipped: { path: string; reason: string }[];
  truncated: boolean;
}

/**
 * Picks the files to send to the model: drops deleted, binary and ignored files, then keeps whole files
 * until the character budget runs out (smallest changes first, so one huge file can't crowd out the rest).
 */
export function selectFiles(files: DiffFile[], { ignore = DEFAULT_IGNORE, maxChars = 60_000 } = {}): Selection {
  const skipped: Selection["skipped"] = [];
  const candidates: { f: DiffFile; size: number }[] = [];
  for (const f of files) {
    if (f.status === "deleted") skipped.push({ path: f.path, reason: "deleted" });
    else if (f.binary) skipped.push({ path: f.path, reason: "binary" });
    else if (ignore.some((p) => matches(f.path, p))) skipped.push({ path: f.path, reason: "ignored" });
    else if (!f.added.size) skipped.push({ path: f.path, reason: "no added lines" });
    else candidates.push({ f, size: render([f]).length });
  }
  candidates.sort((a, b) => a.size - b.size);
  const out: DiffFile[] = [];
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

/**
 * Renders files for the model with explicit new-file line numbers, so the model can cite real lines:
 *
 *   ### src/app.ts (modified)
 *     41   const user = await db.find(id);
 *   + 42   if (!user) return res.status(404).end();
 *   -      return user;
 */
export function render(files: DiffFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`### ${f.path} (${f.status})`);
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) {
        const n = l.newLine !== undefined ? String(l.newLine).padStart(5) : "     ";
        out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${n}  ${l.text}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}
