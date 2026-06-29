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
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { diffTrees } from "./diff.js";

const DATA_DIR = join(homedir(), ".polyshield");
const SNAP_DIR = join(DATA_DIR, "snapshots");
const SNAP_META_DIR = join(DATA_DIR, "snapshot-meta");
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
const SHELLISH_KEY = /(^|_|-)(command|cmd|script|shell|exec|executable|program)$/i;

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
 * dangerous cases without flagging arbitrary strings. Existing paths and their
 * closest existing parent are realpath-checked so symlink escapes fail closed.
 */
export function assertPathArgsInScope(args, root, options = {}) {
  const base = resolve(root);
  const baseReal = safeRealpath(base);
  const check = (key, value) => {
    if (!options.allowShellCommandArgs && SHELLISH_KEY.test(key) && typeof value === "string") {
      throw new Error(
        `Polyshield sandbox: shell-like argument "${key}" requires a containerized sandbox.`,
      );
    }
    if (!looksLikePath(key, value)) return;
    const resolved = resolve(base, expandHome(value));
    if (!inside(base, resolved) || !inside(baseReal, realpathAnchor(resolved))) {
      throw new Error(
        `Polyshield sandbox: argument "${key}" points outside the allowed scope (${base}).`,
      );
    }
  };
  // Walk the WHOLE argument tree — strings, arrays, and nested objects — so a
  // path hidden in an array (e.g. read_multiple_files paths:[...]) or one level
  // deeper can't slip past. Array items inherit their container key, so a
  // pathish key like "paths"/"files" is still honored. Depth-bounded.
  const walk = (key, value, depth) => {
    if (depth > 8) throw new Error("Polyshield sandbox: argument tree too deep.");
    if (typeof value === "string") check(key, value);
    else if (Array.isArray(value)) for (const item of value) walk(key, item, depth + 1);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(k, v, depth + 1);
    }
  };
  walk("", args ?? {}, 0);
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function realpathAnchor(path) {
  let cur = resolve(path);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return safeRealpath(cur);
}

/** Map a path that lives under `fromRoot` to the equivalent path under `toRoot`. */
export function remapPath(value, fromRoot, toRoot) {
  if (typeof value !== "string" || !value) return value;
  const expanded = expandHome(value);
  const from = resolve(fromRoot);
  // Only remap GENUINE filesystem paths — an absolute path, an explicit
  // ./ ../ ~/ path, or one already under the scope. Bare flags ("-y") and
  // package names ("@scope/pkg") must pass through untouched, or we'd mangle
  // the server's own launch args into nonexistent overlay paths.
  const pathish = isAbsolute(expanded) || /^[.~][/\\]/.test(expanded) || expanded.startsWith(from);
  if (!pathish) return value;
  const resolved = resolve(from, expanded);
  if (resolved === from) return toRoot;
  if (resolved.startsWith(from + sep)) return join(toRoot, relative(from, resolved));
  return value; // outside scope — leave it; the scope check will refuse it
}

/**
 * Deep-remap path-like string args from `fromRoot` to `toRoot`. Used for the
 * dry-run: the agent's absolute paths point at the real scope, so we rewrite
 * them onto the copy-on-write overlay before executing, so the dry-run writes
 * land in the throwaway copy (and the diff is real) instead of the live files.
 */
export function remapArgs(args, fromRoot, toRoot) {
  const walk = (key, value, depth) => {
    if (depth > 8) throw new Error("Polyshield sandbox: argument tree too deep.");
    if (typeof value === "string") return looksLikePath(key, value) ? remapPath(value, fromRoot, toRoot) : value;
    if (Array.isArray(value)) return value.map((v) => walk(key, v, depth + 1));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(k, v, depth + 1);
      return out;
    }
    return value;
  };
  return walk("", args ?? {}, 0);
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

export function snapshot(root, options = {}) {
  const { bytes, over } = measure(root);
  if (over) {
    throw new Error("scope too large to snapshot safely (over 200MB or 20k files)");
  }
  mkdirSync(SNAP_DIR, { recursive: true });
  mkdirSync(SNAP_META_DIR, { recursive: true });
  const ref = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dest = join(SNAP_DIR, ref);
  cpSync(root, dest, { recursive: true, filter: cpFilter(root) });
  writeFileSync(
    join(SNAP_META_DIR, `${ref}.json`),
    JSON.stringify(
      {
        ref,
        serverId: options.serverId ?? null,
        scopePath: safeRealpath(root),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  pruneSnapshots();
  return { ref, bytes, scopePath: root };
}

/**
 * Revert the scope root to a snapshot: delete files added since (within the
 * captured set), then copy the snapshot back over. Reverts modifications and
 * additions and recreates deletions, within the non-ignored fileset.
 */
export function restore(ref, root, options = {}) {
  // Defense in depth: ref is a runner-generated id, but never let one with
  // path separators traverse out of the snapshots dir.
  if (typeof ref !== "string" || !ref || /[\\/]|\.\./.test(ref)) {
    throw new Error("invalid snapshot reference");
  }
  const snap = join(SNAP_DIR, ref);
  if (!existsSync(snap)) throw new Error("snapshot no longer exists on this machine");
  const meta = readSnapshotMeta(ref);
  if (options.serverId && meta.serverId && meta.serverId !== options.serverId) {
    throw new Error("snapshot server mismatch; refusing unsafe restore");
  }
  const requestedRoot = safeRealpath(root);
  if (meta.scopePath !== requestedRoot) {
    throw new Error("snapshot scope mismatch; refusing to restore into a different directory");
  }
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

function readSnapshotMeta(ref) {
  try {
    const meta = JSON.parse(readFileSync(join(SNAP_META_DIR, `${ref}.json`), "utf8"));
    if (meta?.ref !== ref || typeof meta.scopePath !== "string") {
      throw new Error("invalid snapshot metadata");
    }
    return meta;
  } catch (err) {
    if (err instanceof Error && err.message === "invalid snapshot metadata") throw err;
    throw new Error("snapshot metadata missing; refusing unsafe restore");
  }
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
    const result = await server.callTool(rawName, remapArgs(args, root, overlay));
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
