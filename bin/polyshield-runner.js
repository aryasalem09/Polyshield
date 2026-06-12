#!/usr/bin/env node
// Polyshield local runner CLI.
//   polyshield-runner pair --token prt_live_... --url https://your-polyshield.app
//   polyshield-runner start
//   polyshield-runner status
import { configPath, loadConfig, saveConfig } from "../src/config.js";
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
  console.log(`polyshield-runner v${VERSION}

The Polyshield local runner launches your local stdio MCP servers and
executes policy-approved tool calls from your Polyshield gateway. It only
dials out — nothing connects to your machine.

Usage:
  polyshield-runner pair --token <prt_live_...> --url <https://your-polyshield-app>
  polyshield-runner start
  polyshield-runner status

Pair tokens are created in the Polyshield dashboard (Servers → Pair local
runner). Config is stored at ${configPath()}.
Env overrides: POLYSHIELD_URL, POLYSHIELD_RUNNER_TOKEN.`);
}

function requireConfig() {
  const config = loadConfig();
  if (!config.url || !config.token) {
    console.error(
      "Not paired yet. Run:\n  polyshield-runner pair --token <prt_live_...> --url <https://your-polyshield-app>",
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
    const config = { url, token, name: flags.name };
    try {
      const servers = await checkOnce(config);
      saveConfig(config);
      console.log(`Paired ✔  (${servers.length} stdio server(s) registered for this project)`);
      console.log(`Config saved to ${configPath()}`);
      console.log("Start the runner with:  polyshield-runner start");
    } catch (err) {
      console.error(`Pairing failed: ${err?.message ?? err}`);
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
        console.log(`  ${s.prefix}  ${s.name}  →  ${s.command} ${(s.args ?? []).join(" ")}`);
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
