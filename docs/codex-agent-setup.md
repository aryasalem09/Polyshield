# Codex Agent Setup

## Classification

Polyshield is a Node.js CLI, sandbox runner, and security-oriented tooling repository.

## Agent Settings

- `max_threads = 8`
- `max_depth = 1`
- `job_max_runtime_seconds = 2400`

Eight threads are useful for splitting CLI mapping, sandbox review, API/config changes, tests, docs, security audit, and release hygiene. Depth stays at `1` because sandbox changes should remain coordinated at the top level.

## Custom Agents

- Global agents: `repo_scout`, `architect`, `implementer`, `tester`, `reviewer`, `security_auditor`, `docs_writer`, `release_manager`.
- Project agent: `sandbox_runner_reviewer`.

## Recommended Prompt Pattern

```text
Use parallel subagents.
Goal: [Polyshield CLI task]
Scout CLI/module boundaries first.
Keep edits limited to assigned modules.
Run npm test or explain why it was skipped.
Use security review before finalizing runner or sandbox changes.
```

## CSV Fanout Candidates

- Module-by-module security review.
- CLI command behavior checks.
- Test-case inventories.
- Packaged artifact and large-file review.

## Tasks That Should Not Use Many Agents

- README wording updates.
- One command string fix.
- Small package metadata changes.

## Known Risks

- Runner/sandbox bugs can become filesystem, process, or network exposure.
- `polyshield-runner.zip` and `youtube-research.sqlite` should not be modified accidentally.
- Node process lifecycle issues can be hard to observe without targeted tests.

## Commands Discovered

- `npm start`
- `npm test`

## Validation Performed

This setup pass inspected structure, package scripts, git status, and artifact risks. It did not run tests.
