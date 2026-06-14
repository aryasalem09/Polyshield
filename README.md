# Polyshield Runner

The local half of [Polyshield](https://polyshield.vercel.app/): a small daemon that launches your **local stdio MCP servers** (filesystem, git, Playwright, shell, anything `npx`-able) and executes tool calls that have already passed Polyshield's policy engine — allow rules, conditions, and human approvals included.

Your coding agent (Claude Code, Cursor, Codex, Cline, …) talks only to the Polyshield gateway. The gateway decides. The runner executes locally, inside a sandbox. Your machine never accepts an inbound connection and your agent never gets a direct line to your local tools.

```
agent ──► Polyshield gateway (policy / approvals / audit)
                 ▲   │ job queue (outbound polling only)
                 │   ▼
          polyshield runner ──► sandbox ──► your local stdio MCP servers
                (your machine)
```

## Quickstart

1. In the Polyshield dashboard, open **Servers → Pair local runner** and copy the pairing token (`prt_live_…` — shown once).
2. On the machine that should run your local MCPs:

```bash
npx polyshield pair --token prt_live_... --url https://your-polyshield-app
npx polyshield start
```

3. Register a local stdio server in the dashboard (e.g. command `npx`, args `@playwright/mcp@latest`). Within seconds the runner launches it, discovers its tools, and they appear in your catalog — gated by your policies like any other tool.

`npx polyshield status` shows what the runner would supervise.

## The sandbox

Each stdio server runs under a **sandbox profile** you set per-server in the dashboard. What the runner enforces on every platform:

- **Filesystem scope** — the server is launched with its working directory pinned to an allowlisted root, and path-like arguments that escape that root are refused before the tool runs.
- **Snapshots / undo** — before an approved destructive call, the runner snapshots the scoped directory. "The agent broke my repo" is one click of **Undo** in the dashboard.
- **Dry-run diffs** — a gated call can be executed first against a copy-on-write copy of the directory, so the approval card shows the *actual* file diff, not just JSON arguments. (Only offered for filesystem-confined servers — `egress: none` — so the dry-run can't fire a real external side effect.)
- **Stripped environment** — by default the child process gets only the env you declared (vaulted secrets) plus the host vars you explicitly pass through; ambient host credentials are not inherited.
- **Wall-clock limit** — a per-call timeout kills a hung or runaway tool.

Hard kernel-level jailing (true filesystem chroot, network egress firewalling, memory cgroups) needs OS-level containers and is the next milestone; on a bare host those constraints are **declared and audited** rather than kernel-enforced. The runner never pretends a declared constraint is an enforced one — `polyshield status` and the dashboard show which is which.

## Security model

- **Outbound only.** The runner polls the control plane over HTTPS. No listening ports, no tunnels, no inbound anything.
- **Hashed pairing token.** Only a SHA-256 hash of your token is stored server-side. Unpair in the dashboard and the token dies instantly.
- **Policy stays in the cloud, execution stays local.** A tool call reaches this machine only after Polyshield's policy engine allowed it (or a human approved it). The runner never makes policy decisions, so a compromised agent can't talk it into anything the dashboard didn't permit.
- **Secrets.** Env values for your stdio servers are AES-256-GCM encrypted in Polyshield's vault and released over TLS only to a paired runner; they live in process memory and the child process env, never on disk and never in logs.
- **Kill switch.** Stop the process (or unpair it) and every local tool goes dark for your agents.

## Requirements

Node.js ≥ 18.17. Config lives at `~/.polyshield/runner.json` (override with `POLYSHIELD_URL` / `POLYSHIELD_RUNNER_TOKEN`). Snapshots live under `~/.polyshield/snapshots/`.
