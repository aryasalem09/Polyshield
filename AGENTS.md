# Polyshield CLI Codex Instructions

## Project Purpose

Polyshield is a Node.js CLI and runner sandbox project for guarding agent/tool execution.

## Stack

- Runtime: Node.js.
- CLI entry point: `bin/polyshield.js`.
- Core modules: `src/api.js`, `src/config.js`, `src/diff.js`, `src/runner.js`, `src/sandbox.js`, and `src/servers.js`.
- Tests/smoke checks: `sandbox-test.mjs`.
- Packaged artifact/data present: `polyshield-runner.zip` and `youtube-research.sqlite`.

## Commands

- Install: `npm install`
- Start: `npm start`
- Test: `npm test`

## Working Rules

- Treat runner, sandbox, process, network, and filesystem behavior as security-sensitive.
- Do not use real credentials, production services, or private data during tests.
- Do not edit packaged archives or SQLite data unless explicitly requested.
- Keep CLI behavior and test coverage aligned when changing sandbox policy.
- Preserve unrelated user changes and never commit or push unless explicitly asked.

## Codex Subagent Policy

- Codex should use parallel subagents for nontrivial work when there are independent workstreams.
- Fanout must be justified by independent workstreams; prefer 4-8 agents for normal tasks.
- Use 8-12 only for large independent modules, audits, migrations, security sweeps, or test/review passes.
- Do not spawn agents that edit the same file at the same time.
- Keep `max_depth = 1` unless the repo-specific config explains why `2` is justified.
- Always use a read-only scout before major edits.
- Always use independent tester/reviewer agents before claiming completion.
- Use CSV fanout for repeated independent tasks like module-by-module security review, CLI command checks, packaged artifact inventory, or test-case review.

## Recommended Roles

- `repo_scout` for command and module mapping.
- `architect` for sandbox design changes.
- `implementer` for bounded module edits.
- `sandbox_runner_reviewer` and `security_auditor` for runner and filesystem risk.
- `tester`, `reviewer`, and `release_manager` before final handoff.

## Definition of Done

- Relevant CLI/test commands were run or explicitly skipped with a reason.
- Sandbox, filesystem, network, and process risks were reviewed.
- Large/package/data artifacts were not accidentally modified.
- Git status was reviewed before final response.
