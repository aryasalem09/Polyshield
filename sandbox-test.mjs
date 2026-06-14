// Deterministic unit test for the sandbox primitives (snapshot/restore,
// path-scope enforcement, dry-run diff). Run: node sandbox-test.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPathArgsInScope,
  snapshot,
  restore,
} from "./src/sandbox.js";
import { diffTrees } from "./src/diff.js";

let pass = 0,
  fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

// ---- snapshot + restore (undo) ----
const scope = mkdtempSync(join(tmpdir(), "ps-scope-"));
writeFileSync(join(scope, "a.txt"), "original-a\n");
writeFileSync(join(scope, "keep.txt"), "keep\n");
mkdirSync(join(scope, "sub"));
writeFileSync(join(scope, "sub", "c.txt"), "original-c\n");

const snap = snapshot(scope);
check("snapshot returns a ref + bytes", !!snap.ref && snap.bytes > 0, JSON.stringify(snap));

// Mutate: modify a.txt, add b.txt, delete keep.txt, modify nested.
writeFileSync(join(scope, "a.txt"), "MODIFIED-a\n");
writeFileSync(join(scope, "b.txt"), "new-b\n");
rmSync(join(scope, "keep.txt"));
writeFileSync(join(scope, "sub", "c.txt"), "MODIFIED-c\n");

restore(snap.ref, scope);

check("restore reverts a modification", readFileSync(join(scope, "a.txt"), "utf8") === "original-a\n");
check("restore removes an added file", !existsSync(join(scope, "b.txt")));
check("restore recreates a deleted file", existsSync(join(scope, "keep.txt")));
check("restore reverts a nested file", readFileSync(join(scope, "sub", "c.txt"), "utf8") === "original-c\n");

// ---- path-scope enforcement ----
const allow = (p) => {
  try {
    assertPathArgsInScope({ path: p }, scope);
    return true;
  } catch {
    return false;
  }
};
check("in-scope relative path allowed", allow("a.txt") === true);
check("nested in-scope path allowed", allow("sub/c.txt") === true);
check("parent-escape path refused", allow("../evil.txt") === false);
check("absolute-outside path refused", allow("C:\\Windows\\System32\\x.txt") === false || allow("/etc/passwd") === false);
check("deep traversal refused", allow("sub/../../escape.txt") === false);

const allowStruct = (args) => {
  try {
    assertPathArgsInScope(args, scope);
    return true;
  } catch {
    return false;
  }
};
check("deeply nested escape path refused", allowStruct({ options: { nested: { file: "../evil.txt" } } }) === false);
check("array escape path refused", allowStruct({ files: ["../evil.txt"] }) === false);
check("array of objects escape path refused", allowStruct({ args: [{ file: "../evil.txt" }] }) === false);
check("array in-scope path allowed", allowStruct({ files: ["a.txt"] }) === true);

// ---- dry-run diff shape ----
const overlay = mkdtempSync(join(tmpdir(), "ps-overlay-"));
writeFileSync(join(overlay, "a.txt"), "original-a\nplus a line\n"); // modified
writeFileSync(join(overlay, "keep.txt"), "keep\n"); // unchanged
writeFileSync(join(overlay, "added.txt"), "brand new\n"); // added
// (sub/c.txt absent in overlay → deleted)
const diff = diffTrees(scope, overlay);
const byPath = Object.fromEntries((diff.files ?? []).map((f) => [f.path, f.status]));
check("diff detects modified file", byPath["a.txt"] === "modified", JSON.stringify(byPath));
check("diff detects added file", byPath["added.txt"] === "added", JSON.stringify(byPath));
check("diff detects deleted nested file", byPath["sub/c.txt"] === "deleted", JSON.stringify(byPath));
check("diff ignores unchanged file", byPath["keep.txt"] === undefined, JSON.stringify(byPath));
const aFile = diff.files.find((f) => f.path === "a.txt");
check("modified file has a unified diff", typeof aFile?.diff === "string" && aFile.diff.includes("+ plus a line"), aFile?.diff);

// cleanup
rmSync(scope, { recursive: true, force: true });
rmSync(overlay, { recursive: true, force: true });
try {
  rmSync(join(process.env.USERPROFILE || process.env.HOME, ".polyshield", "snapshots", snap.ref), {
    recursive: true,
    force: true,
  });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
