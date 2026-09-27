---
description: Bring a module's docs in line with current code — DOCUMENTATION.md / README.md catch-up via the docs-writer specialist
---

Scope, if any: $ARGUMENTS (module path, package name, or leave empty to propose from recent changes)

The maintainer wants documentation updated without a full PR cycle. Run this as a conversation:

1. **Choose the target.** If the argument names a module/package, use it. Otherwise propose 3–5 candidates from recent worktree/main activity that own a `DOCUMENTATION.md` or `README.md` (search `git log --since`, open PRs touching docs-adjacent code). Ask which to take — or accept "all recent" for a batch.
2. **Verify reality first.** For each target, read the current `DOCUMENTATION.md`/`README.md` and the owning code. Note every stale claim, missing invariant, and broken path/command. Docs that disagree with code are worse than missing docs.
3. **Fan out `docs-writer`.** Dispatch the `docs-writer` subagent (`.opencode/agent/docs-writer.md`) with the file list, the drift you found, and the instruction to follow `writing-for-agents` + `communication-style`. It returns edited docs only — no code changes, no changelog edits.
4. **Review the diff.** Read every hunk yourself. Confirm: one source of truth preserved, no invented commands/paths, no CHANGELOG/`changelog/*` (except an explicitly requested `unreleased.md` line), voice matches local precedent. Reject or amend anything that restates what the environment already answers.
5. **Validate.** Run `bun run docs:validate` when docs scripts are in scope; fix only findings you introduced.
6. **Close the loop.** Report files touched and what changed. Never commit or push without being asked.

If no docs drift exists for the proposed targets, say so in two sentences and stop — a clean result is valid.
