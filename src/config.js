// Runner config: ~/.polyshield/runner.json — { url, token, name }.
// The token is the prt_live_... pairing token from the Polyshield dashboard;
// only its SHA-256 hash exists server-side, so this file is the sole copy.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".polyshield");
const CONFIG_PATH = join(CONFIG_DIR, "runner.json");

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
  };
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
