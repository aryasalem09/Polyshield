# Polyshield Runner

The local half of [Polyshield](https://github.com/aryasalem09/PolyShield-App): a small daemon that launches your **local stdio MCP servers** (filesystem, git, Playwright, shell, anything `npx`-able) and executes tool calls that have already passed Polyshield's policy engine — allow rules, conditions, and human approvals included.

Your coding agent (Claude Code, Cursor, Codex, Cline, …) talks only to the Polyshield gateway. The gateway decides. The runner executes locally. Your machine never accepts an inbound connection and your agent never gets a direct line to your local tools.

```
agent ──► Polyshield gateway (policy / approvals / audit)
                 ▲   │ job queue (outbound polling only)
                 │   ▼
          polyshield-runner ──► your local stdio MCP servers
                (your machine)
```

## Quickstart

1. In the Polyshield dashboard, open **Servers → Pair local runner** and copy the pairing token (`prt_live_…` — shown once).
2. On the machine that should run your local MCPs:

```bash
npx polyshield-runner pair --token prt_live_... --url https://your-polyshield-app
npx polyshield-runner start
```

3. Register a local stdio server in the dashboard (e.g. command `npx`, args `@playwright/mcp@latest`). Within seconds the runner launches it, discovers its tools, and they appear in your catalog — gated by your policies like any other tool.

`polyshield-runner status` shows what the runner would supervise.

## Security model

- **Outbound only.** The runner polls the control plane over HTTPS. No listening ports, no tunnels, no inbound anything.
- **Hashed pairing token.** Only a SHA-256 hash of your token is stored server-side. Unpair in the dashboard and the token dies instantly.
- **Policy stays in the cloud, execution stays local.** A tool call reaches this machine only after Polyshield's policy engine allowed it (or a human approved it). The runner itself never makes policy decisions, so a compromised agent can't talk it into anything the dashboard didn't permit.
- **Secrets.** Env values for your stdio servers are AES-256-GCM encrypted in Polyshield's vault and released over TLS only to a paired runner; they live in process memory and the child process env, never on disk and never in logs.
- **Kill switch.** Stop the process (or unpair it) and every local tool goes dark for your agents.

## Requirements

Node.js ≥ 18.17. Config lives at `~/.polyshield/runner.json` (override with `POLYSHIELD_URL` / `POLYSHIELD_RUNNER_TOKEN`).
