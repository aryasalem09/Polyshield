#!/usr/bin/env node
// Polyshield local runner CLI.
//   polyshield pair --token prt_live_... --url https://your-polyshield.app
//   polyshield start
//   polyshield status
import { configPath, loadConfig, saveConfig, trustServerConfig } from "../src/config.js";
import { checkOnce, runLoop, VERSION } from "../src/runner.js";

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return flags;
}

function help() {
  console.log(`polyshield v${VERSION}

The Polyshield local runner launches your local stdio MCP servers and
executes policy-approved tool calls from your Polyshield gateway. It only
dials out — nothing connects to your machine — and runs each server inside a
sandbox (filesystem scope, stripped environment, snapshots for undo).

Usage:
  polyshield pair --token <prt_live_...> --url <https://your-polyshield-app>
  polyshield trust
  polyshield start
  polyshield status

Pair tokens are created in the Polyshield dashboard (Servers → Pair local
runner). Config is stored at ${configPath()}.
Env overrides: POLYSHIELD_URL, POLYSHIELD_RUNNER_TOKEN.
For loopback-only local testing, add --insecure-local-dev or set
POLYSHIELD_INSECURE_LOCAL_DEV=1.`);
}

function requireConfig() {
  const config = loadConfig();
  if (!config.url || !config.token) {
    console.error(
      "Not paired yet. Run:\n  polyshield pair --token <prt_live_...> --url <https://your-polyshield-app>",
    );
    process.exit(1);
  }
  return config;
}

const [, , command, ...rest] = process.argv;
const flags = parseFlags(rest);

switch (command) {
  case "pair": {
    const token = flags.token;
    const url = flags.url;
    if (!token || !url) {
      console.error("pair needs both --token and --url.");
      process.exit(1);
    }
    if (!token.startsWith("prt_")) {
      console.error("That doesn't look like a runner token (expected prt_live_...).");
      process.exit(1);
    }
    const config = { url, token, name: flags.name, insecureLocalDev: flags["insecure-local-dev"] === "true" };
    try {
      const servers = await checkOnce(config);
      saveConfig(config);
      console.log(`Paired ✔  (${servers.length} stdio server(s) registered for this project)`);
      console.log(`Config saved to ${configPath()}`);
      console.log("Start the runner with:  polyshield start");
    } catch (err) {
      console.error(`Pairing failed: ${err?.message ?? err}`);
      process.exit(1);
    }
    break;
  }

  case "trust": {
    const config = requireConfig();
    try {
      const servers = await checkOnce(config);
      if (servers.length === 0) {
        console.log("No stdio servers registered to trust.");
        break;
      }
      for (const s of servers) {
        trustServerConfig(s);
        console.log(
          `Trusted ${s.prefix} (${s.name}) → ${s.command} with ${(s.args ?? []).length} configured arg(s).`,
        );
      }
      console.log("Start or restart the runner for trusted configs to take effect.");
    } catch (err) {
      console.error(`Trust failed: ${err?.message ?? err}`);
      process.exit(1);
    }
    break;
  }

  case "start": {
    const config = requireConfig();
    try {
      await runLoop(config);
    } catch (err) {
      console.error(`Runner stopped: ${err?.message ?? err}`);
      process.exit(1);
    }
    break;
  }

  case "status": {
    const config = requireConfig();
    try {
      const servers = await checkOnce(config);
      console.log(`Connected to ${new URL(config.url).host} ✔`);
      if (servers.length === 0) {
        console.log("No stdio servers registered. Add one in the Polyshield dashboard.");
      }
      for (const s of servers) {
        const scope = s.sandbox?.fsScope?.length ? `  [${s.sandbox.fsScope.length} scope(s)]` : "";
        console.log(`  ${s.prefix}  ${s.name}  →  ${s.command} (${(s.args ?? []).length} arg(s))${scope}`);
      }
    } catch (err) {
      console.error(`Status check failed: ${err?.message ?? err}`);
      process.exit(1);
    }
    break;
  }

  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
    break;

  default:
    help();
    process.exit(command ? 1 : 0);
}
