# Security Notes

## Local Web App

- The server binds to `127.0.0.1` by default.
- The API can start local Agent processes. Do not expose port `4178` to an untrusted
  network.
- GitHub read-only tokens entered in the browser stay in `localStorage`; they are never
  written into the repository.

## Agent Boundaries

- Reviewer providers run with read-only tools.
- Builder and Fixer are the only write-capable roles.
- DSH Pi review subagents cannot run shell commands.
- AgentFlow requires a Git repository before creating an isolated worktree.
- Human approval does not imply automatic merge.

## Credentials

Never commit:

- model API keys or OAuth tokens
- GitHub PATs
- `.env` files
- Pi/Codex/DSH credential stores
- agent session logs or run directories

The root `.gitignore` covers the main local credential and runtime locations.

## Command Execution

Verification commands are supplied explicitly by the user and run through the configured
shell. Treat task repositories and their configuration as trusted input.
