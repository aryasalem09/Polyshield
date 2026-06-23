// Deterministic unit test for the sandbox primitives (snapshot/restore,
// path-scope enforcement, dry-run diff). Run: node sandbox-test.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "./src/api.js";
import { serverTrustFingerprint, serverTrustState } from "./src/config.js";
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
const otherScope = mkdtempSync(join(tmpdir(), "ps-other-"));
writeFileSync(join(scope, "a.txt"), "original-a\n");
writeFileSync(join(scope, "keep.txt"), "keep\n");
mkdirSync(join(scope, "sub"));
writeFileSync(join(scope, "sub", "c.txt"), "original-c\n");
writeFileSync(join(otherScope, "other.txt"), "do-not-touch\n");

const snap = snapshot(scope, { serverId: "server-a" });
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
check("restore refuses a different target root", (() => {
  try {
    restore(snap.ref, otherScope, { serverId: "server-a" });
    return false;
  } catch {
    return readFileSync(join(otherScope, "other.txt"), "utf8") === "do-not-touch\n";
  }
})());
check("restore refuses a different server id", (() => {
  try {
    restore(snap.ref, scope, { serverId: "server-b" });
    return false;
  } catch {
    return true;
  }
})());

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
check("argument tree too deep refused", (() => {
  try {
    let deep = { path: "../escape.txt" };
    for (let i = 0; i < 10; i++) {
      deep = { nested: deep };
    }
    assertPathArgsInScope(deep, scope);
    return false;
  } catch (e) {
    return e.message.includes("argument tree too deep");
  }
})());
check("nested path arrays refused", (() => {
  try {
    assertPathArgsInScope({ paths: ["a.txt", "../escape.txt"] }, scope);
    return false;
  } catch {
    return true;
  }
})());
check("host shell command args refused", (() => {
  try {
    assertPathArgsInScope({ command: "type C:\\Windows\\win.ini" }, scope);
    return false;
  } catch {
    return true;
  }
})());
check("symlink directory escape refused when supported", (() => {
  const outside = mkdtempSync(join(tmpdir(), "ps-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  try {
    symlinkSync(outside, join(scope, "outside-link"), "junction");
    assertPathArgsInScope({ path: "outside-link/secret.txt" }, scope);
    return false;
  } catch (err) {
    if (!existsSync(join(scope, "outside-link"))) return true; // symlink creation unsupported here
    return true;
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(scope, "outside-link"), { recursive: true, force: true });
  }
})());

// ---- control-plane URL safety ----
check("https control-plane accepted", (() => {
  try {
    new ControlPlane("https://polyshield.example", "prt_live_test", "test");
    return true;
  } catch {
    return false;
  }
})());
check("non-loopback http control-plane refused", (() => {
  try {
    new ControlPlane("http://example.com", "prt_live_test", "test");
    return false;
  } catch {
    return true;
  }
})());
check("loopback http requires explicit local-dev opt-in", (() => {
  try {
    new ControlPlane("http://127.0.0.1:3000", "prt_live_test", "test");
    return false;
  } catch {
    return true;
  }
})());
check("loopback http accepted with explicit local-dev opt-in", (() => {
  try {
    new ControlPlane("http://127.0.0.1:3000", "prt_live_test", "test", { insecureLocalDev: true });
    return true;
  } catch {
    return false;
  }
})());

// ---- local trust fingerprints ----
const serverCfg = {
  id: "server-1",
  prefix: "fs",
  name: "Filesystem",
  command: "npx",
  args: ["@modelcontextprotocol/server-filesystem", scope],
  cwd: scope,
  envPassthrough: [],
  sandbox: { fsScope: [scope], egress: { mode: "none", allow: [] } },
};
const trusted = {
  "server-1": { fingerprint: serverTrustFingerprint(serverCfg) },
};
check("trusted server config accepted", serverTrustState(serverCfg, trusted).trusted === true);
check("changed server config rejected", serverTrustState({ ...serverCfg, args: ["malicious"] }, trusted).trusted === false);

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
rmSync(otherScope, { recursive: true, force: true });
rmSync(overlay, { recursive: true, force: true });
try {
  rmSync(join(homedir(), ".polyshield", "snapshots", snap.ref), {
    recursive: true,
    force: true,
  });
  rmSync(join(homedir(), ".polyshield", "snapshot-meta", `${snap.ref}.json`), { force: true });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
