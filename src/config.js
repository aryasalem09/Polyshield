// Runner config: ~/.polyshield/runner.json — { url, token, name }.
// The token is the prt_live_... pairing token from the Polyshield dashboard;
// only its SHA-256 hash exists server-side, so this file is the sole copy.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".polyshield");
const CONFIG_PATH = join(CONFIG_DIR, "runner.json");
const TRUST_PATH = join(CONFIG_DIR, "trusted-servers.json");

export function configPath() {
  return CONFIG_PATH;
}

export function loadConfig() {
  // Environment overrides let CI / containers run without a config file.
  const envUrl = process.env.POLYSHIELD_URL;
  const envToken = process.env.POLYSHIELD_RUNNER_TOKEN;
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // no config yet
  }
  return {
    url: envUrl ?? file.url,
    token: envToken ?? file.token,
    name: file.name,
    insecureLocalDev: process.env.POLYSHIELD_INSECURE_LOCAL_DEV === "1" || file.insecureLocalDev === true,
  };
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function loadTrustedServers() {
  try {
    const parsed = JSON.parse(readFileSync(TRUST_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveTrustedServers(trusted) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TRUST_PATH, JSON.stringify(trusted, null, 2) + "\n", { mode: 0o600 });
}

function trustMaterial(server) {
  return {
    id: server.id,
    prefix: server.prefix,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd ?? null,
    envPassthrough: server.envPassthrough ?? [],
    sandbox: server.sandbox ?? null,
  };
}

export function serverTrustFingerprint(server) {
  return createHash("sha256").update(JSON.stringify(trustMaterial(server))).digest("hex");
}

export function trustServerConfig(server) {
  const trusted = loadTrustedServers();
  trusted[server.id] = {
    prefix: server.prefix,
    name: server.name,
    fingerprint: serverTrustFingerprint(server),
    trustedAt: new Date().toISOString(),
  };
  saveTrustedServers(trusted);
}

export function serverTrustState(server, trusted = loadTrustedServers()) {
  const entry = trusted[server.id];
  const fingerprint = serverTrustFingerprint(server);
  if (!entry) return { trusted: false, reason: "new", fingerprint };
  if (entry.fingerprint !== fingerprint) return { trusted: false, reason: "changed", fingerprint };
  return { trusted: true, reason: "trusted", fingerprint };
}
