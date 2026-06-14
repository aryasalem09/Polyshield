// Minimal directory-tree diff for dry-run previews. No external deps. Walks
// two trees (skipping heavy/ignored dirs), classifies each file as
// added/modified/deleted, and for modified text files produces a compact,
// readable change view (not a minimal edit script — a prefix/suffix trim,
// which is correct and cheap for an approval card).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORE = new Set([
  ".git", "node_modules", ".next", "dist", "build", ".venv",
  "__pycache__", ".cache", ".turbo", "coverage", ".pytest_cache",
]);
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_FILES_REPORTED = 200;
const MAX_DIFF_CHARS_PER_FILE = 4000;
const MAX_TOTAL_DIFF_CHARS = 60000;

function walk(root) {
  const files = new Map(); // relpath -> { size }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        const full = join(dir, e.name);
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        files.set(relative(root, full).split(sep).join("/"), { size, full });
      }
    }
  }
  return files;
}

function isProbablyText(buf) {
  const len = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) suspicious++;
  }
  return suspicious / Math.max(1, len) < 0.3;
}

function readText(full, size) {
  if (size > MAX_CONTENT_BYTES) return null;
  try {
    const buf = readFileSync(full);
    if (!isProbablyText(buf)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function lineChange(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  const lines = [];
  if (pre > 0) lines.push(`  @@ line ${pre + 1} @@`);
  for (const r of removed) lines.push(`- ${r}`);
  for (const ad of added) lines.push(`+ ${ad}`);
  let diff = lines.join("\n");
  if (diff.length > MAX_DIFF_CHARS_PER_FILE) {
    diff = diff.slice(0, MAX_DIFF_CHARS_PER_FILE) + "\n… [diff truncated]";
  }
  return { additions: added.length, deletions: removed.length, diff };
}

/**
 * Diff `newRoot` against `oldRoot`. Returns the ApprovalPreview shape the
 * dashboard renders: { files: [{path, status, additions, deletions, diff}],
 * truncated, note }.
 */
export function diffTrees(oldRoot, newRoot) {
  const oldFiles = walk(oldRoot);
  const newFiles = walk(newRoot);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);

  const files = [];
  let totalDiffChars = 0;
  let truncated = false;

  for (const p of [...paths].sort()) {
    if (files.length >= MAX_FILES_REPORTED) {
      truncated = true;
      break;
    }
    const o = oldFiles.get(p);
    const n = newFiles.get(p);

    if (o && !n) {
      files.push({ path: p, status: "deleted" });
    } else if (!o && n) {
      const text = readText(n.full, n.size);
      const additions = text ? text.split("\n").length : undefined;
      let diff;
      if (text) {
        diff = text
          .split("\n")
          .map((l) => `+ ${l}`)
          .join("\n")
          .slice(0, MAX_DIFF_CHARS_PER_FILE);
      }
      files.push({ path: p, status: "added", additions, diff });
    } else if (o && n) {
      if (o.size === n.size) {
        // same size — compare bytes to decide if it changed
        try {
          if (readFileSync(o.full).equals(readFileSync(n.full))) continue;
        } catch {
          /* fall through to modified */
        }
      }
      const oldText = readText(o.full, o.size);
      const newText = readText(n.full, n.size);
      if (oldText !== null && newText !== null) {
        if (oldText === newText) continue;
        const change = lineChange(oldText, newText);
        totalDiffChars += change.diff.length;
        if (totalDiffChars > MAX_TOTAL_DIFF_CHARS) {
          truncated = true;
          files.push({ path: p, status: "modified", additions: change.additions, deletions: change.deletions });
        } else {
          files.push({ path: p, status: "modified", ...change });
        }
      } else {
        files.push({ path: p, status: "modified", note: "binary" });
      }
    }
  }

  return {
    files,
    truncated,
    note:
      files.length === 0
        ? "The dry-run produced no filesystem changes inside the sandbox scope."
        : undefined,
  };
}
