// The runner sandbox. Cross-platform, honest enforcement:
//   - filesystem scope: cwd is pinned to the scope root and path-like args
//     that escape it are refused before the tool runs.
//   - stripped env: the child gets only declared env + passthrough.
//   - snapshots / undo: copy the scope before a destructive approved call.
//   - dry-run diffs: run a gated call against a copy-on-write copy and diff it.
// Egress firewalling and memory cgroups need OS containers and are the next
// milestone; this module never claims a declared-only constraint is enforced.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { diffTrees } from "./diff.js";

const DATA_DIR = join(homedir(), ".polyshield");
const SNAP_DIR = join(DATA_DIR, "snapshots");
const OVERLAY_DIR = join(DATA_DIR, "overlays");

const IGNORE = new Set([
  ".git", "node_modules", ".next", "dist", "build", ".venv",
  "__pycache__", ".cache", ".turbo", "coverage", ".pytest_cache",
]);
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 20000;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Effective filesystem scope root for a server config. */
export function scopeRootFor(config) {
  const declared = config.sandbox?.fsScope?.[0];
  return resolve(expandHome(declared || config.cwd || process.cwd()));
}

/** Is filesystem scoping actually requested for this server? */
export function scopeEnforced(config) {
  return Array.isArray(config.sandbox?.fsScope) && config.sandbox.fsScope.length > 0;
}

const PATHISH_KEY =
  /(^|_|-)(path|file|filepath|dir|directory|cwd|target|dest|destination|src|source|location|output|input)s?$/i;

function looksLikePath(key, value) {
  if (typeof value !== "string" || !value) return false;
  if (PATHISH_KEY.test(key)) return true;
  if (value.includes("..")) return true;
  if (isAbsolute(value)) return true;
  if (/^[.~][/\\]/.test(value)) return true; // ./  ../  ~/
  return false;
}

/**
 * Refuse a call whose path-like arguments escape the scope root. Heuristic on
 * which args are paths (we don't know the tool's schema), tuned to catch the
 * dangerous cases without flagging arbitrary strings. Lexical containment only
 * — symlink escapes are a known gap closed by container-level scoping later.
 */
export function assertPathArgsInScope(args, root) {
  const base = resolve(root);
  const check = (key, value) => {
    if (!looksLikePath(key, value)) return;
    const resolved = resolve(base, value);
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new Error(
        `Polyshield sandbox: argument "${key}" points outside the allowed scope (${base}).`,
      );
    }
  };

  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") check(k, v);
      else if (v && typeof v === "object") walk(v);
    }
  };

  walk(args);
}

// Vars a child needs just to launch (find its interpreter, temp, home). These
// are NOT credentials, so they survive env stripping — stripEnv removes
// ambient secrets, it must not make the process unspawnable.
const SPAWN_ESSENTIALS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC",
  "HOME", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "LANG", "LC_ALL",
];

/** Build the child environment per the sandbox profile (env stripping). */
export function buildEnv(config) {
  const strip = config.sandbox?.stripEnv === true;
  let env;
  if (strip) {
    env = {};
    for (const key of SPAWN_ESSENTIALS) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  } else {
    env = { ...getDefaultEnvironment() };
  }
  for (const key of config.envPassthrough ?? []) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, config.env ?? {});
  return env;
}

/** Per-call wall-clock limit (ms) from the profile, bounded. */
export function wallLimitMs(config) {
  const v = config.sandbox?.limits?.wallMs;
  return typeof v === "number" && v >= 1000 && v <= 600000 ? v : 50000;
}

let _dockerChecked = false;
let _dockerOk = false;

/** Is Docker usable on this host? Checked once and cached. */
export function dockerAvailable() {
  if (_dockerChecked) return _dockerOk;
  _dockerChecked = true;
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: "ignore",
      timeout: 5000,
    });
    _dockerOk = true;
  } catch {
    _dockerOk = false;
  }
  return _dockerOk;
}

const CONTAINER_IMAGE = process.env.POLYSHIELD_RUNNER_IMAGE || "node:20-alpine";

/**
 * Resolve how to actually launch a server: a plain `command args`, or — when
 * the profile asks for containerization AND Docker is present — a `docker run`
 * that makes egress/memory/fs constraints kernel-ENFORCED rather than merely
 * declared. The declared env (secrets) is passed through with `-e KEY` (values
 * come from the spawn env). Returns { command, args, containerized }.
 */
export function resolveLaunch(config, scopeRoot) {
  const wantContainer = config.sandbox?.containerize === true;
  if (!wantContainer) {
    return { command: config.command, args: config.args ?? [], containerized: false };
  }
  if (!dockerAvailable()) {
    return { command: config.command, args: config.args ?? [], containerized: false, fellBack: true };
  }

  const mem = config.sandbox?.limits?.memMB;
  const net = config.sandbox?.egress?.mode === "none" ? ["--network", "none"] : [];
  const envFlags = Object.keys(config.env ?? {}).flatMap((k) => ["-e", k]);
  const args = [
    "run",
    "-i",
    "--rm",
    ...net,
    ...(mem ? ["--memory", `${mem}m`] : ["--memory", "512m"]),
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${scopeRoot}:/work:rw`,
    "-w",
    "/work",
    ...envFlags,
    CONTAINER_IMAGE,
    config.command,
    ...(config.args ?? []),
  ];
  return { command: "docker", args, containerized: true };
}

function cpFilter(srcRoot) {
  return (source) => source === srcRoot || !IGNORE.has(basename(source));
}

function measure(root) {
  let bytes = 0;
  let count = 0;
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
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        count++;
        if (count > MAX_FILES) return { bytes, count, over: true };
        try {
          bytes += statSync(full).size;
        } catch {
          /* skip */
        }
        if (bytes > MAX_SNAPSHOT_BYTES) return { bytes, count, over: true };
      }
    }
  }
  return { bytes, count, over: false };
}

function relPaths(root) {
  const out = new Set();
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
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        out.add(relative(root, full));
      }
    }
  }
  return out;
}

/**
 * Snapshot the scope root for undo. Throws if the scope is too large to copy
 * safely (caller treats snapshot failure as non-fatal — the call still runs,
 * just without an undo point).
 */
const MAX_SNAPSHOTS_KEPT = 25;

/** Keep only the newest N snapshot dirs so undo history can't fill the disk. */
function pruneSnapshots() {
  try {
    const dirs = readdirSync(SNAP_DIR).sort(); // timestamp-prefixed → chronological
    for (const old of dirs.slice(0, Math.max(0, dirs.length - MAX_SNAPSHOTS_KEPT))) {
      rmSync(join(SNAP_DIR, old), { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

export function snapshot(root) {
  const { bytes, over } = measure(root);
  if (over) {
    throw new Error("scope too large to snapshot safely (over 200MB or 20k files)");
  }
  mkdirSync(SNAP_DIR, { recursive: true });
  const ref = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dest = join(SNAP_DIR, ref);
  cpSync(root, dest, { recursive: true, filter: cpFilter(root) });
  pruneSnapshots();
  return { ref, bytes, scopePath: root };
}

/**
 * Revert the scope root to a snapshot: delete files added since (within the
 * captured set), then copy the snapshot back over. Reverts modifications and
 * additions and recreates deletions, within the non-ignored fileset.
 */
export function restore(ref, root) {
  // Defense in depth: ref is a runner-generated id, but never let one with
  // path separators traverse out of the snapshots dir.
  if (typeof ref !== "string" || !ref || /[\\/]|\.\./.test(ref)) {
    throw new Error("invalid snapshot reference");
  }
  const snap = join(SNAP_DIR, ref);
  if (!existsSync(snap)) throw new Error("snapshot no longer exists on this machine");
  const snapFiles = relPaths(snap);
  for (const rel of relPaths(root)) {
    if (!snapFiles.has(rel)) {
      try {
        rmSync(join(root, rel), { force: true });
      } catch {
        /* best effort */
      }
    }
  }
  cpSync(snap, root, { recursive: true, force: true, filter: cpFilter(snap) });
}

/**
 * Copy-on-write dry run: copy the scope to a throwaway overlay, run the call
 * against a server pinned to the overlay, diff, and clean up. Returns the
 * ApprovalPreview the dashboard renders. `makeOverlayServer(cwd)` builds a
 * fresh ServerProcess pointed at the overlay.
 */
export async function dryRun(makeOverlayServer, rawName, args, root) {
  const { over } = measure(root);
  if (over) {
    return { files: [], truncated: true, note: "Scope too large to dry-run (over 200MB or 20k files)." };
  }
  mkdirSync(OVERLAY_DIR, { recursive: true });
  const overlay = join(OVERLAY_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}`);
  cpSync(root, overlay, { recursive: true, filter: cpFilter(root) });

  const server = makeOverlayServer(overlay);
  let toolErrored = false;
  try {
    if (!(await server.ensureStarted())) {
      return { files: [], note: "Could not start the server for a dry-run." };
    }
    const result = await server.callTool(rawName, args);
    toolErrored = result?.isError === true;
  } catch (err) {
    return { files: [], note: `Dry-run could not execute: ${err?.message ?? err}` };
  } finally {
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
  }

  let preview;
  try {
    preview = diffTrees(root, overlay);
  } catch (err) {
    preview = { files: [], note: `Could not diff the dry-run: ${err?.message ?? err}` };
  } finally {
    try {
      rmSync(overlay, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (toolErrored && !preview.note) {
    preview.note = "Note: the tool reported an error during the dry-run; the diff may be partial.";
  }
  return preview;
}
